import type { ToolResult } from "./types"
import { Bash, defineCommand, type CustomCommand } from "just-bash/browser"

import {
    ObservableInMemoryFs,
    type ObservableInMemoryFsOptions,
} from "./observable-in-memory-fs"
import { executeFd } from "./fd-command"

import type { AlmostNodeSession } from "./almostnode-session"
import type { PyodideSession } from "./pyodide-session"

export const DEFAULT_BASH_SHELL_ENV = {
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    PI_OFFLINE: "1",
} as const

const DEFAULT_BASH_COMMAND_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_BASH_OUTPUT_LIMIT = 10_000

export type BrowserBashSession = {
    fs: ObservableInMemoryFs
    bash: Bash
    rootPath: string
    cwd: string
    setStdoutWriter: (writer: ((data: string) => void) | undefined) => void
    writeStdin: (data: string) => void
    setTerminalSize: (columns: number, rows: number) => void
    dispose: () => void
}

type BrowserBashSessionOptions = {
    /** Root path in the virtual filesystem (default: "/workspace") */
    rootPath?: string
    /** Shell environment variables */
    env?: Record<string, string>
    /** Options for the ObservableInMemoryFs */
    fsOptions?: ObservableInMemoryFsOptions
    /** Enable Node.js runtime (node, npm commands). Lazy-loaded on first use. (default: false) */
    node?: boolean
    /** Enable Python runtime via Pyodide (python, python3, pip commands). Lazy-loaded on first use. (default: false) */
    python?: boolean
    /** Additional custom commands to register alongside the built-in commands */
    customCommands?: CustomCommand[]
}

type ExecuteBrowserBashOptions = {
    /** Whether to truncate command output (default: true) */
    truncateOutput?: boolean
    /** Abort signal for cancellation */
    signal?: AbortSignal
    /** Command timeout in ms (default: DEFAULT_BASH_COMMAND_TIMEOUT_MS) */
    commandTimeoutMs?: number
    /** Output truncation limit (default: DEFAULT_BASH_OUTPUT_LIMIT) */
    outputLimit?: number
}

/** Normalize a filesystem path to POSIX form */
function normalizeBashPath(input: string): string {
    const posixPath = input.trim().replace(/\\/g, "/") || "/"
    const segments: string[] = []
    const isAbsolute = posixPath.startsWith("/")
    for (const segment of posixPath.split("/")) {
        if (segment === "..") {
            segments.pop()
        } else if (segment !== "." && segment !== "") {
            segments.push(segment)
        }
    }
    return (isAbsolute ? "/" : "") + segments.join("/") || "/"
}

/** Truncate command output to a byte limit */
function truncateBashOutput(output: string, limitBytes = DEFAULT_BASH_OUTPUT_LIMIT): string {
    if (!output || output.length <= limitBytes) {
        return output
    }

    const headBytes = Math.ceil(limitBytes * 0.3)
    const tailBytes = limitBytes - headBytes
    const omittedBytes = output.length - headBytes - tailBytes
    return `${output.slice(0, headBytes)}\n\n... [${omittedBytes} bytes truncated] ...\n\n${output.slice(-tailBytes)}`
}

/** Create a browser-based bash session with in-memory filesystem */
export function createBrowserBashSession(options: BrowserBashSessionOptions = {}): BrowserBashSession {
    const rootPath = normalizeBashPath(options.rootPath ?? "/workspace")
    const env = options.env ?? { ...DEFAULT_BASH_SHELL_ENV }

    const fs = new ObservableInMemoryFs(options.fsOptions)
    fs.mkdirSync(rootPath, { recursive: true })

    // Pre-create tool shim files at the paths pi-coding-agent expects
    // (almostnode's os.homedir() returns "/home/user")
    // This makes getToolPath() find the tools via existsSync() so no
    // download is attempted. The grep tool's spawn() then goes through
    // just-bash which has a built-in rg implementation.
    const piBinDir = "/home/user/.pi/agent/bin"
    fs.mkdirSync(piBinDir, { recursive: true })
    fs.writeFileSync(`${piBinDir}/rg`, "#!/bin/sh\nrg \"$@\"\n")
    fs.writeFileSync(`${piBinDir}/fd`, "#!/bin/sh\nfd \"$@\"\n")

    // Lazy-loaded runtime sessions
    let almostNodeSession: AlmostNodeSession | null = null
    let almostNodeSessionPromise: Promise<AlmostNodeSession> | null = null
    let pyodideSession: PyodideSession | null = null
    let pyodideSessionPromise: Promise<PyodideSession> | null = null

    async function getAlmostNodeSession(): Promise<AlmostNodeSession> {
        if (almostNodeSession) return almostNodeSession
        if (almostNodeSessionPromise) return almostNodeSessionPromise
        almostNodeSessionPromise = import("./almostnode-session").then((mod) => {
            almostNodeSession = new mod.AlmostNodeSession(fs)
            almostNodeSession.setBinCommandRegistrar((name, handler) => {
                bash.registerCommand(defineCommand(name, handler))
            })
            if (currentStdoutWriter) almostNodeSession.setStdoutWriter(currentStdoutWriter)
            return almostNodeSession
        })
        return almostNodeSessionPromise
    }

    async function getPyodideSession(): Promise<PyodideSession> {
        if (pyodideSession) return pyodideSession
        if (pyodideSessionPromise) return pyodideSessionPromise
        pyodideSessionPromise = import("./pyodide-session").then((mod) => {
            pyodideSession = new mod.PyodideSession(fs)
            if (currentStdoutWriter) pyodideSession.setStdoutWriter(currentStdoutWriter)
            return pyodideSession
        })
        return pyodideSessionPromise
    }

    let currentStdoutWriter: ((data: string) => void) | undefined

    // Build custom commands based on enabled runtimes
    const runtimeCommands: CustomCommand[] = []

    if (options.node) {
        runtimeCommands.push(
            defineCommand("node", async (args, ctx) => (await getAlmostNodeSession()).executeNode(args, ctx)),
            defineCommand("npm", async (args, ctx) => (await getAlmostNodeSession()).executeNpm(args, ctx)),
        )
    }

    if (options.python) {
        runtimeCommands.push(
            defineCommand("python", async (args, ctx) => (await getPyodideSession()).executePython(args, ctx)),
            defineCommand("python3", async (args, ctx) => (await getPyodideSession()).executePython(args, ctx)),
            defineCommand("pip", async (args, ctx) => (await getPyodideSession()).executePip(args, ctx)),
        )
    }

    const bash = new Bash({
        cwd: rootPath,
        env: { ...env },
        fs,
        customCommands: [
            ...runtimeCommands,
            defineCommand("fd", async (args, ctx) => executeFd(args, ctx)),
            ...(options.customCommands ?? []),
        ],
    })

    return {
        fs,
        bash,
        rootPath,
        cwd: rootPath,
        setStdoutWriter: (writer) => {
            currentStdoutWriter = writer
            almostNodeSession?.setStdoutWriter(writer)
            pyodideSession?.setStdoutWriter(writer)
        },
        writeStdin: (data) => almostNodeSession?.writeStdin(data),
        setTerminalSize: (columns, rows) => almostNodeSession?.setTerminalSize(columns, rows),
        dispose: () => {
            almostNodeSession?.dispose()
            pyodideSession?.dispose()
        },
    }
}

/** Execute a bash command and return a ToolResult */
export async function executeBrowserBash(
    session: BrowserBashSession,
    command: string,
    options: ExecuteBrowserBashOptions = {},
): Promise<ToolResult> {
    const trimmedCommand = command.trim()
    if (!trimmedCommand) {
        return { success: false, error: "Command is required", stderr: "Command is required", exit_code: 1, command: trimmedCommand, backend: "just-bash" }
    }

    const startedAt = Date.now()
    const outputLimit = options.outputLimit ?? DEFAULT_BASH_OUTPUT_LIMIT
    const timeoutMs = options.commandTimeoutMs ?? DEFAULT_BASH_COMMAND_TIMEOUT_MS

    const timeoutController = new AbortController()
    const combinedController = new AbortController()
    const abort = (reason?: unknown) => {
        combinedController.abort(reason instanceof Error ? reason : new Error(String(reason ?? "Command aborted")))
    }

    if (options.signal) {
        if (options.signal.aborted) {
            abort(options.signal.reason)
        } else {
            options.signal.addEventListener("abort", () => abort(options.signal!.reason), { once: true })
        }
    }

    timeoutController.signal.addEventListener("abort", () => abort(timeoutController.signal.reason), { once: true })
    const timeoutId = globalThis.setTimeout(() => {
        timeoutController.abort(new Error(`Command timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    try {
        const result = await session.bash.exec(trimmedCommand, {
            cwd: session.cwd,
            env: {
                ...DEFAULT_BASH_SHELL_ENV,
                PWD: session.cwd,
            },
            signal: combinedController.signal,
        })

        const nextCwd = result.env?.PWD?.trim()
        if (nextCwd) {
            session.cwd = normalizeBashPath(nextCwd)
        }

        const stdout = options.truncateOutput === false ? result.stdout : truncateBashOutput(result.stdout, outputLimit)
        const stderr = options.truncateOutput === false ? result.stderr : truncateBashOutput(result.stderr, outputLimit)
        const error = result.exitCode === 0 ? undefined : stderr || undefined

        return {
            success: result.exitCode === 0,
            command: trimmedCommand,
            stdout,
            stderr,
            output: stdout,
            exit_code: result.exitCode,
            duration_ms: Date.now() - startedAt,
            backend: "just-bash",
            ...(error ? { error } : {}),
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, command: trimmedCommand, error: message, stderr: message, exit_code: 1, duration_ms: Date.now() - startedAt, backend: "just-bash" }
    } finally {
        globalThis.clearTimeout(timeoutId)
    }
}
