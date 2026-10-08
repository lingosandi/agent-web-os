import type { WorkspaceFsNode, WorkspaceFsType } from "./pyodide-workspace-fs"
import type { CommandContext, ExecResult } from "just-bash/browser"
import { WorkspaceMount, createWorkspaceMount, emscriptenPrimitives } from "./pyodide-workspace-fs"
import { ObservableInMemoryFs } from "./observable-in-memory-fs"

/**
 * Pyodide version loaded from the CDN by default.
 * 0.29.x keeps Python 3.13 and accepts both `pyodide_*` and (since 0.29.4)
 * `pyemscripten_*` wheel platform tags, which every published OCP.wasm /
 * cadquery-OCP wheel uses — micropip rejects those on 0.27.x.
 * Override per-session via `pyodideVersion` if you need another line.
 */
const DEFAULT_PYODIDE_VERSION = "0.29.5"
const DEFAULT_PYODIDE_CDN_URL = `https://cdn.jsdelivr.net/pyodide/v${DEFAULT_PYODIDE_VERSION}/full/`

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
export interface PyodideAPI {
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

/** Minimal Pyodide FS surface used for mounting and script reads */
export interface EmscriptenFS {
    createNode(parent: WorkspaceFsNode | null, name: string, mode: number, rdev: number): WorkspaceFsNode
    isDir(mode: number): boolean
    isFile(mode: number): boolean
    isLink(mode: number): boolean
    mkdir(path: string): void
    mount(type: WorkspaceFsType, opts: { rootPath: string }, mountpoint: string): void
    readFile(path: string, opts?: { encoding?: string }): string | Uint8Array
    ErrnoError: new (errno: number) => Error & { errno: number }
}


export class PyodideSession {
    private pyodide: PyodideAPI | null = null
    private readonly workspaceMounts = new Map<string, WorkspaceMount>()
    private initPromise: Promise<void> | null = null
    private stdoutWriter?: (data: string) => void
    private readonly cdnUrl: string

    constructor(
        private readonly fs: ObservableInMemoryFs,
        options: { pyodideVersion?: string; pyodideBaseUrl?: string } = {},
    ) {
        this.cdnUrl =
            options.pyodideBaseUrl ??
            (options.pyodideVersion
                ? `https://cdn.jsdelivr.net/pyodide/v${options.pyodideVersion}/full/`
                : DEFAULT_PYODIDE_CDN_URL)
    }


    /** Loads the pyodide runtime. Protected seam — tests override this with
     *  a fake runtime to exercise the initialization lifecycle without the
     *  real WASM interpreter. */
    protected async createRuntime(): Promise<PyodideAPI> {
        const { loadPyodide } = await import(
            /* webpackIgnore: true */
            `${this.cdnUrl}pyodide.mjs`
        ) as { loadPyodide: (opts?: Record<string, unknown>) => Promise<PyodideAPI> }

        return loadPyodide({
            indexURL: this.cdnUrl,
            packages: ["micropip"],
        })
    }

    private async ensureInitialized(): Promise<void> {
        if (this.pyodide) return
        if (this.initPromise) {
            await this.initPromise
            return
        }

        this.initPromise = (async () => {
            this.pyodide = await this.createRuntime()

            // Stale mounts from a previous interpreter lifecycle (dispose +
            // re-init) bound the old WASM FS's node objects — drop them so
            // every root is re-created against the new interpreter.
            this.workspaceMounts.clear()

            // Default workspace mount — other roots are mounted lazily by
            // ensureWorkspaceMount when a run's cwd demands them.
            this.ensureWorkspaceMount("/workspace")
        })()

        try {
            await this.initPromise
        } catch (error) {
            // Retry the next invocation instead of caching the rejection
            // (e.g. a transient CDN failure would otherwise poison every
            // future python command in the session).
            this.initPromise = null
            this.pyodide = null
            throw error
        }
    }

    /**
     * Mount the write-through workspace FS at `rootPath` (idempotent).
     * All Python FS mutations under the root hit the hub in real time.
     */
    private ensureWorkspaceMount(rootPath: string): WorkspaceMount {
        const pyodide = this.pyodide!
        let mount = this.workspaceMounts.get(rootPath)
        if (!mount) {
            try {
                pyodide.FS.mkdir(rootPath)
            } catch {
                // May already exist
            }
            mount = createWorkspaceMount(
                this.fs,
                emscriptenPrimitives(pyodide.FS),
                rootPath,
            )
            pyodide.FS.mount(mount.filesystemType, { rootPath }, rootPath)
            this.workspaceMounts.set(rootPath, mount)
        }
        return mount
    }

    private getWorkspaceRoot(cwd: string): string {
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

        // Mount the workspace write-through FS for this run's root and
        // rebuild its node tree from the hub (source of truth). Lazy files
        // are hydrated here — sync syscalls cannot await.
        const workspaceRoot = this.getWorkspaceRoot(cwd)
        const mount = this.ensureWorkspaceMount(workspaceRoot)
        const syncWarnings: string[] = []
        await mount.rebuildSkeleton(syncWarnings)

        let stdout = ""
        let stderr = ""
        for (const warning of syncWarnings) {
            stderr += `warning: ${warning}\n`
        }

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
        // Set stdin — return piped stdin content on first read, then EOF.
        // Without this, Pyodide falls back to LegacyReader._getInput which
        // throws "Illegal invocation" in browser contexts.
        let stdinRead = false
        pyodide.setStdin({
            stdin: () => {
                if (stdinRead || !ctx.stdin) return null
                stdinRead = true
                return ctx.stdin
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

        // Fresh __main__ namespace per invocation — real CPython starts a
        // fresh interpreter each run; sharing the default globals leaks
        // variables, imports and sys.path mutations across invocations.
        const namespace = pyodide.runPython("dict()") as { destroy(): void }
        let exitCode = 0
        try {
            // Auto-install any import-able packages
            await pyodide.loadPackagesFromImports(code, {
                messageCallback: (msg: string) => {
                    this.stdoutWriter?.(msg + "\n")
                },
            })

            await pyodide.runPythonAsync(code, { globals: namespace })
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            stderr += errorMsg + "\n"
            exitCode = 1
        }

        // Write-through flush — on the success AND error path, so files
        // written before a failure are preserved (real Python keeps partial
        // outputs on non-zero exit). The mount has already forwarded most
        // mutations in real time; this pushes what is left and drains the
        // tracked hub operations.
        try {
            const flushWarnings: string[] = []
            await mount.flush(flushWarnings)
            for (const warning of flushWarnings) {
                stderr += `warning: ${warning}\n`
            }
        } catch (flushError) {
            const msg = flushError instanceof Error ? flushError.message : String(flushError)
            stderr += `warning: failed to sync filesystem changes: ${msg}\n`
        } finally {
            namespace.destroy()
        }

        return { stdout, stderr, exitCode }
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
        // Prevent stdin crash — pip never reads stdin but some packages
        // might try during install. Return EOF immediately.
        pyodide.setStdin({ stdin: () => null })

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


