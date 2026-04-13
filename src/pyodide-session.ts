import type { CommandContext, ExecResult } from "just-bash/browser"
import { ObservableInMemoryFs } from "./observable-in-memory-fs"

/**
 * Pyodide version loaded from CDN.
 * Update this when upgrading to a newer Pyodide release.
 */
const PYODIDE_VERSION = "0.27.7"
const PYODIDE_CDN_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`

const PYTHON_VERSION = "3.13"

const PIP_USAGE = [
    "Usage: pip <command> [options]",
    "",
    "Commands:",
    "  install <pkg>   Install packages",
    "  list            List installed packages",
    "  show <pkg>      Show information about a package",
    "  uninstall <pkg> Uninstall packages",
    "  --version       Show pip version",
].join("\n")

/**
 * Minimal type for the Pyodide API surface we use.
 * We dynamically import pyodide from CDN so there's no compile-time package.
 */
interface PyodideAPI {
    version: string
    FS: EmscriptenFS
    runPython(code: string, options?: { globals?: unknown }): unknown
    runPythonAsync(code: string, options?: { globals?: unknown }): Promise<unknown>
    loadPackagesFromImports(code: string, options?: { messageCallback?: (msg: string) => void; errorCallback?: (msg: string) => void }): Promise<unknown>
    loadPackage(names: string | string[], options?: { messageCallback?: (msg: string) => void; errorCallback?: (msg: string) => void }): Promise<unknown>
    setStdout(options: { batched: (msg: string) => void }): void
    setStderr(options: { batched: (msg: string) => void }): void
    setStdin(options: { stdin: () => string | null }): void
    globals: { get(name: string): unknown }
}

/** Minimal Emscripten FS type surface */
interface EmscriptenFS {
    mkdir(path: string): void
    writeFile(path: string, data: string | Uint8Array, opts?: { encoding?: string }): void
    readFile(path: string, opts?: { encoding?: string }): string | Uint8Array
    readdir(path: string): string[]
    stat(path: string): { mode: number; size: number }
    unlink(path: string): void
    rmdir(path: string): void
    isDir(mode: number): boolean
    isFile(mode: number): boolean
}

/**
 * Recursively sync files from ObservableInMemoryFs → Pyodide's Emscripten FS.
 * Creates directories as needed and writes all files.
 */
async function syncToEmscriptenFS(
    srcFs: ObservableInMemoryFs,
    emFs: EmscriptenFS,
    srcPath: string,
    emPath: string,
): Promise<void> {
    // Ensure target directory exists in Emscripten FS
    try {
        emFs.stat(emPath)
    } catch {
        emFs.mkdir(emPath)
    }

    let entries: string[]
    try {
        entries = await srcFs.readdir(srcPath)
    } catch {
        return
    }

    for (const entry of entries) {
        const srcChild = srcPath === "/" ? `/${entry}` : `${srcPath}/${entry}`
        const emChild = emPath === "/" ? `/${entry}` : `${emPath}/${entry}`

        try {
            const stat = await srcFs.stat(srcChild)
            if (stat.isDirectory) {
                await syncToEmscriptenFS(srcFs, emFs, srcChild, emChild)
            } else {
                const content = await srcFs.readFileBuffer(srcChild)
                emFs.writeFile(emChild, content)
            }
        } catch {
            // Skip files that can't be read
        }
    }
}

/**
 * Recursively sync files from Pyodide's Emscripten FS → ObservableInMemoryFs.
 * Only syncs files that differ or are new.
 */
async function syncFromEmscriptenFS(
    emFs: EmscriptenFS,
    dstFs: ObservableInMemoryFs,
    emPath: string,
    dstPath: string,
): Promise<void> {
    let entries: string[]
    try {
        entries = emFs.readdir(emPath).filter((e: string) => e !== "." && e !== "..")
    } catch {
        return
    }

    for (const entry of entries) {
        const emChild = emPath === "/" ? `/${entry}` : `${emPath}/${entry}`
        const dstChild = dstPath === "/" ? `/${entry}` : `${dstPath}/${entry}`

        try {
            const stat = emFs.stat(emChild)
            if (emFs.isDir(stat.mode)) {
                dstFs.mkdirSync(dstChild, { recursive: true })
                await syncFromEmscriptenFS(emFs, dstFs, emChild, dstChild)
            } else if (emFs.isFile(stat.mode)) {
                const content = emFs.readFile(emChild) as Uint8Array
                dstFs.writeFileSync(dstChild, content)
            }
        } catch {
            // Skip entries we can't read
        }
    }
}

export class PyodideSession {
    private pyodide: PyodideAPI | null = null
    private initPromise: Promise<void> | null = null
    private stdoutWriter?: (data: string) => void

    constructor(private readonly fs: ObservableInMemoryFs) {}

    private async ensureInitialized(): Promise<void> {
        if (this.pyodide) return
        if (this.initPromise) {
            await this.initPromise
            return
        }

        this.initPromise = (async () => {
            const { loadPyodide } = await import(
                /* webpackIgnore: true */
                `${PYODIDE_CDN_URL}pyodide.mjs`
            ) as { loadPyodide: (opts?: Record<string, unknown>) => Promise<PyodideAPI> }

            this.pyodide = await loadPyodide({
                indexURL: PYODIDE_CDN_URL,
                packages: ["micropip"],
            })

            // Set up the workspace directory in Pyodide FS
            try {
                this.pyodide.FS.mkdir("/workspace")
            } catch {
                // May already exist
            }
        })()

        await this.initPromise
    }

    private async syncWorkspaceToEmscriptenFS(cwd: string): Promise<void> {
        if (!this.pyodide) return

        // Determine the workspace root to sync
        // Sync the root path that contains cwd
        const workspaceRoot = this.getWorkspaceRoot(cwd)
        await syncToEmscriptenFS(this.fs, this.pyodide.FS, workspaceRoot, workspaceRoot)
    }

    private async syncWorkspaceFromEmscriptenFS(cwd: string): Promise<void> {
        if (!this.pyodide) return

        const workspaceRoot = this.getWorkspaceRoot(cwd)
        await syncFromEmscriptenFS(this.pyodide.FS, this.fs, workspaceRoot, workspaceRoot)
    }

    private getWorkspaceRoot(cwd: string): string {
        // Use the first path component under root as workspace root
        // e.g. /workspace/project → /workspace
        const parts = cwd.split("/").filter(Boolean)
        return parts.length > 0 ? `/${parts[0]}` : "/workspace"
    }

    setStdoutWriter(writer: ((data: string) => void) | undefined): void {
        this.stdoutWriter = writer
    }

    async executePython(args: string[], ctx: CommandContext): Promise<ExecResult> {
        const cwd = ctx.cwd

        const invocation = parsePythonArgs(args)

        if (invocation.kind === "version") {
            return { stdout: `Python ${PYTHON_VERSION}\n`, stderr: "", exitCode: 0 }
        }

        if (invocation.kind === "help") {
            return {
                stdout: "usage: python3 [option] ... [-c cmd | -m mod | file | -] [arg] ...\n" +
                    "Supported modes: python3 <file>, python3 -c <code>, python3 --version\n",
                stderr: "",
                exitCode: 0,
            }
        }

        if (invocation.kind === "error") {
            return { stdout: "", stderr: invocation.message + "\n", exitCode: 1 }
        }

        await this.ensureInitialized()
        const pyodide = this.pyodide!

        // Sync filesystem before execution
        this.syncWorkspaceToEmscriptenFS(cwd)

        let stdout = ""
        let stderr = ""

        pyodide.setStdout({
            batched: (msg: string) => {
                stdout += msg + "\n"
                this.stdoutWriter?.(msg + "\n")
            },
        })
        pyodide.setStderr({
            batched: (msg: string) => {
                stderr += msg + "\n"
                this.stdoutWriter?.(msg + "\n")
            },
        })

        // Set cwd in Python
        pyodide.runPython(`
import os
os.chdir(${JSON.stringify(cwd)})
`)

        let code: string
        if (invocation.kind === "eval") {
            code = invocation.code
        } else {
            // Run file
            const filePath = invocation.filePath.startsWith("/")
                ? invocation.filePath
                : `${cwd}/${invocation.filePath}`
            try {
                const content = pyodide.FS.readFile(filePath, { encoding: "utf8" }) as string
                code = content
            } catch {
                return {
                    stdout: "",
                    stderr: `python3: can't open file '${invocation.filePath}': [Errno 2] No such file or directory\n`,
                    exitCode: 2,
                }
            }
        }

        try {
            // Auto-install any import-able packages
            await pyodide.loadPackagesFromImports(code, {
                messageCallback: (msg: string) => {
                    this.stdoutWriter?.(msg + "\n")
                },
            })

            await pyodide.runPythonAsync(code)

            // Sync filesystem after execution
            this.syncWorkspaceFromEmscriptenFS(cwd)

            return { stdout, stderr, exitCode: 0 }
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            stderr += errorMsg + "\n"
            return { stdout, stderr, exitCode: 1 }
        }
    }

    async executePip(args: string[], ctx: CommandContext): Promise<ExecResult> {
        const subcommand = args[0]

        if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
            return { stdout: PIP_USAGE + "\n", stderr: "", exitCode: 0 }
        }

        if (subcommand === "--version" || subcommand === "-V") {
            await this.ensureInitialized()
            return {
                stdout: `pip (micropip) for Python ${PYTHON_VERSION} [Pyodide ${this.pyodide!.version}]\n`,
                stderr: "",
                exitCode: 0,
            }
        }

        await this.ensureInitialized()
        const pyodide = this.pyodide!

        let stdout = ""
        let stderr = ""

        pyodide.setStdout({
            batched: (msg: string) => {
                stdout += msg + "\n"
                this.stdoutWriter?.(msg + "\n")
            },
        })
        pyodide.setStderr({
            batched: (msg: string) => {
                stderr += msg + "\n"
                this.stdoutWriter?.(msg + "\n")
            },
        })

        switch (subcommand) {
            case "install": {
                const packages = args.slice(1).filter((a) => !a.startsWith("-"))
                if (packages.length === 0) {
                    return { stdout: "", stderr: "ERROR: You must give at least one requirement to install\n", exitCode: 1 }
                }

                try {
                    const packageList = packages.map((p) => JSON.stringify(p)).join(", ")
                    await pyodide.runPythonAsync(`
import micropip
await micropip.install([${packageList}])
`)
                    const installedMsg = `Successfully installed ${packages.join(" ")}\n`
                    stdout += installedMsg
                    this.stdoutWriter?.(installedMsg)
                    return { stdout, stderr, exitCode: 0 }
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : String(error)
                    stderr += errorMsg + "\n"
                    return { stdout, stderr, exitCode: 1 }
                }
            }

            case "list": {
                try {
                    await pyodide.runPythonAsync(`
import micropip
pkgs = micropip.list()
print(f"{'Package':<30} {'Version':<15}")
print(f"{'-'*30} {'-'*15}")
for name, pkg in sorted(pkgs.items()):
    print(f"{name:<30} {pkg.version:<15}")
`)
                    return { stdout, stderr, exitCode: 0 }
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : String(error)
                    stderr += errorMsg + "\n"
                    return { stdout, stderr, exitCode: 1 }
                }
            }

            case "show": {
                const packageName = args[1]
                if (!packageName) {
                    return { stdout: "", stderr: "ERROR: Please provide a package name\n", exitCode: 1 }
                }

                try {
                    await pyodide.runPythonAsync(`
import micropip
pkgs = micropip.list()
pkg_name = ${JSON.stringify(packageName)}
if pkg_name in pkgs:
    pkg = pkgs[pkg_name]
    print(f"Name: {pkg_name}")
    print(f"Version: {pkg.version}")
else:
    print(f"WARNING: Package(s) not found: {pkg_name}")
`)
                    return { stdout, stderr, exitCode: 0 }
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : String(error)
                    stderr += errorMsg + "\n"
                    return { stdout, stderr, exitCode: 1 }
                }
            }

            case "uninstall": {
                const packages = args.slice(1).filter((a) => !a.startsWith("-"))
                if (packages.length === 0) {
                    return { stdout: "", stderr: "ERROR: You must give at least one requirement to uninstall\n", exitCode: 1 }
                }

                try {
                    const packageList = packages.map((p) => JSON.stringify(p)).join(", ")
                    await pyodide.runPythonAsync(`
import micropip
micropip.uninstall([${packageList}])
`)
                    const uninstalledMsg = `Successfully uninstalled ${packages.join(" ")}\n`
                    stdout += uninstalledMsg
                    this.stdoutWriter?.(uninstalledMsg)
                    return { stdout, stderr, exitCode: 0 }
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : String(error)
                    stderr += errorMsg + "\n"
                    return { stdout, stderr, exitCode: 1 }
                }
            }

            default:
                return { stdout: "", stderr: `ERROR: unknown command "${subcommand}"\n${PIP_USAGE}\n`, exitCode: 1 }
        }
    }

    dispose(): void {
        this.pyodide = null
        this.initPromise = null
    }
}

function parsePythonArgs(args: string[]): 
    | { kind: "version" }
    | { kind: "help" }
    | { kind: "eval"; code: string }
    | { kind: "run-file"; filePath: string }
    | { kind: "error"; message: string } {
    if (args.length === 0) {
        return { kind: "error", message: "REPL mode is not supported. Use python3 -c <code> or python3 <file>." }
    }

    const [first, ...rest] = args

    if (first === "-V" || first === "--version") {
        return { kind: "version" }
    }

    if (first === "-h" || first === "--help") {
        return { kind: "help" }
    }

    if (first === "-c") {
        const code = rest[0]?.trim()
        if (!code) {
            return { kind: "error", message: "python3 -c requires inline code" }
        }
        return { kind: "eval", code }
    }

    if (first === "-m") {
        const moduleName = rest[0]?.trim()
        if (!moduleName) {
            return { kind: "error", message: "python3 -m requires a module name" }
        }
        // Run as `python -m module`
        return { kind: "eval", code: `import runpy; runpy.run_module(${JSON.stringify(moduleName)}, run_name='__main__')` }
    }

    if (first.startsWith("-")) {
        return { kind: "error", message: `Unsupported option: ${first}` }
    }

    // It's a file path
    return { kind: "run-file", filePath: first }
}

export function createPyodideSession(fs: ObservableInMemoryFs): PyodideSession {
    return new PyodideSession(fs)
}
