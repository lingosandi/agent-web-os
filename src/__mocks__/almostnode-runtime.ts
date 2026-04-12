// Mock for almostnode/runtime
export class Runtime {
    private vfs: any
    private options: any
    private _process: any

    constructor(vfs: any, options?: any) {
        this.vfs = vfs
        this.options = options || {}
        this._process = {
            exit: (code?: number) => { throw new Error(`Process exited with code ${code ?? 0}`) },
            argv: ["node"],
            argv0: "node",
            execPath: "/usr/local/bin/node",
            env: options?.env ?? {},
            cwd: () => options?.cwd ?? "/",
            chdir: () => {},
            stdout: { write: (data: string) => { options?.onStdout?.(data) } },
            stderr: { write: (data: string) => { options?.onStderr?.(data) } },
            version: "v20.0.0",
            versions: { node: "20.0.0" },
            platform: "linux",
            arch: "x64",
        }
    }

    getProcess() {
        return this._process
    }

    execute(code: string, filename?: string): void {
        // Mock execution — just evaluate simple expressions for testing
        try {
            const fn = new Function(
                "process", "console", "require", "module", "exports", "__filename", "__dirname",
                code,
            )
            const module = { exports: {} }
            fn(
                this._process,
                {
                    log: (...args: any[]) => this.options?.onConsole?.("log", args),
                    error: (...args: any[]) => this.options?.onConsole?.("error", args),
                    warn: (...args: any[]) => this.options?.onConsole?.("warn", args),
                    info: (...args: any[]) => this.options?.onConsole?.("info", args),
                    debug: (...args: any[]) => this.options?.onConsole?.("debug", args),
                    trace: (...args: any[]) => this.options?.onConsole?.("trace", args),
                    dir: (...args: any[]) => this.options?.onConsole?.("log", args),
                    table: (...args: any[]) => this.options?.onConsole?.("log", args),
                },
                () => ({}),
                module,
                module.exports,
                filename ?? "<eval>",
                "/",
            )
        } catch (e) {
            if (e instanceof Error && e.message.startsWith("Process exited with code")) throw e
            this.options?.onStderr?.(e instanceof Error ? (e.stack ?? e.message) : String(e))
            throw e
        }
    }

    runFile(scriptPath: string): void {
        try {
            const content = this.vfs.readFileSync(scriptPath, "utf8")
            this.execute(content, scriptPath)
        } catch (e) {
            if (e instanceof Error && e.message.startsWith("Process exited with code")) throw e
            if (!this.options?.onStderr) {
                throw e
            }
            this.options.onStderr(e instanceof Error ? (e.stack ?? e.message) : String(e))
            throw e
        }
    }
}
