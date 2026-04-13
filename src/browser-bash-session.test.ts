import { describe, it, expect, vi, beforeEach } from "vitest"
import {
    attachBrowserBashSessionRuntimeAdapter,
    BROWSER_BASH_SESSION_INTERNALS,
    createBrowserBashSession,
    executeBrowserBash,
    DEFAULT_BASH_SHELL_ENV,
    type BrowserBashSession,
} from "./browser-bash-session"
import { ObservableInMemoryFs } from "./observable-in-memory-fs"

describe("DEFAULT_BASH_SHELL_ENV", () => {
    it("has expected environment variables", () => {
        expect(DEFAULT_BASH_SHELL_ENV.LANG).toBe("C.UTF-8")
        expect(DEFAULT_BASH_SHELL_ENV.LC_ALL).toBe("C.UTF-8")
        expect(DEFAULT_BASH_SHELL_ENV.PYTHONIOENCODING).toBe("utf-8")
        expect(DEFAULT_BASH_SHELL_ENV.PYTHONUTF8).toBe("1")
    })
})

describe("createBrowserBashSession", () => {
    it("creates a session with default options", () => {
        const session = createBrowserBashSession()
        expect(session).toBeDefined()
        expect(session.fs).toBeInstanceOf(ObservableInMemoryFs)
        expect(session.bash).toBeDefined()
        expect(session.setStdoutWriter).toBeInstanceOf(Function)
        expect(session.writeStdin).toBeInstanceOf(Function)
        expect(session.setTerminalSize).toBeInstanceOf(Function)
        expect(session.rootPath).toBe("/workspace")
        expect(session.cwd).toBe("/workspace")
        expect(typeof session.dispose).toBe("function")
    })

    it("creates a session with custom rootPath", () => {
        const session = createBrowserBashSession({ rootPath: "/myproject" })
        expect(session.rootPath).toBe("/myproject")
        expect(session.cwd).toBe("/myproject")
    })

    it("normalizes rootPath with trailing slashes", () => {
        const session = createBrowserBashSession({ rootPath: "/myproject/" })
        expect(session.rootPath).toBe("/myproject")
    })

    it("normalizes rootPath with dot segments", () => {
        const session = createBrowserBashSession({ rootPath: "/foo/bar/../baz" })
        expect(session.rootPath).toBe("/foo/baz")
    })

    it("creates root directory in filesystem", async () => {
        const session = createBrowserBashSession()
        const exists = await session.fs.exists("/workspace")
        expect(exists).toBe(true)
    })

    it("allows custom fsOptions", () => {
        const session = createBrowserBashSession({
            fsOptions: { consoleLogChanges: true, workspaceRoot: "/workspace" },
        })
        expect(session.fs).toBeInstanceOf(ObservableInMemoryFs)
    })

    it("disposes without error", () => {
        const session = createBrowserBashSession()
        expect(() => session.dispose()).not.toThrow()
    })

    it("does not register npm unless node support is enabled", async () => {
        const session = createBrowserBashSession()
        const result = await session.bash.exec("npm --version", {
            cwd: session.cwd,
            env: { ...DEFAULT_BASH_SHELL_ENV, PWD: session.cwd },
        })

        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toMatch(/not found|not available/i)
    })

    it("does not register python unless python support is enabled", async () => {
        const session = createBrowserBashSession()
        const result = await session.bash.exec("python --version", {
            cwd: session.cwd,
            env: { ...DEFAULT_BASH_SHELL_ENV, PWD: session.cwd },
        })

        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toMatch(/not found|not available/i)
    })

    it("tracks runtime adapters and propagates terminal events", () => {
        const session = createBrowserBashSession()
        const writer = vi.fn()
        const adapter = {
            setStdoutWriter: vi.fn(),
            writeStdin: vi.fn(),
            setTerminalSize: vi.fn(),
            dispose: vi.fn(),
        }

        attachBrowserBashSessionRuntimeAdapter(session, adapter)
        session.setStdoutWriter(writer)
        session.writeStdin("input")
        session.setTerminalSize(120, 40)
        session.dispose()

        expect(adapter.setStdoutWriter).toHaveBeenNthCalledWith(1, undefined)
        expect(adapter.setStdoutWriter).toHaveBeenNthCalledWith(2, writer)
        expect(adapter.writeStdin).toHaveBeenCalledWith("input")
        expect(adapter.setTerminalSize).toHaveBeenCalledWith(120, 40)
        expect(adapter.dispose).toHaveBeenCalledTimes(1)
    })

    it("immediately syncs the current stdout writer to newly attached adapters", () => {
        const session = createBrowserBashSession()
        const writer = vi.fn()
        const adapter = {
            setStdoutWriter: vi.fn(),
        }

        session.setStdoutWriter(writer)
        attachBrowserBashSessionRuntimeAdapter(session, adapter)

        expect(adapter.setStdoutWriter).toHaveBeenCalledWith(writer)
    })

    it("rejects attaching a runtime adapter to a non-session object", () => {
        expect(() => {
            attachBrowserBashSessionRuntimeAdapter({
                fs: {} as never,
                bash: {} as never,
                rootPath: "/workspace",
                cwd: "/workspace",
                setStdoutWriter: vi.fn(),
                writeStdin: vi.fn(),
                setTerminalSize: vi.fn(),
                dispose: vi.fn(),
            }, { setStdoutWriter: vi.fn() })
        }).toThrow("Expected createBrowserBashSession() session")
    })

    it("stores internal runtime adapter state on the session", () => {
        const session = createBrowserBashSession()
        const adapter = { dispose: vi.fn() }

        attachBrowserBashSessionRuntimeAdapter(session, adapter)

        const internals = (session as BrowserBashSession & {
            [BROWSER_BASH_SESSION_INTERNALS]: { runtimeAdapters: Set<unknown> }
        })[BROWSER_BASH_SESSION_INTERNALS]

        expect(internals.runtimeAdapters.has(adapter)).toBe(true)
    })
})

describe("executeBrowserBash", () => {
    let session: BrowserBashSession

    beforeEach(() => {
        session = createBrowserBashSession()
    })

    it("returns error for empty command", async () => {
        const result = await executeBrowserBash(session, "")
        expect(result.success).toBe(false)
        expect(result.error).toBe("Command is required")
        expect(result.exit_code).toBe(1)
        expect(result.backend).toBe("just-bash")
    })

    it("returns error for whitespace-only command", async () => {
        const result = await executeBrowserBash(session, "   ")
        expect(result.success).toBe(false)
        expect(result.error).toBe("Command is required")
    })

    it("executes echo command", async () => {
        const result = await executeBrowserBash(session, "echo hello")
        expect(result.success).toBe(true)
        expect(result.stdout).toContain("hello")
        expect(result.exit_code).toBe(0)
        expect(result.backend).toBe("just-bash")
    })

    it("includes duration_ms", async () => {
        const result = await executeBrowserBash(session, "echo test")
        expect(typeof result.duration_ms).toBe("number")
        expect(result.duration_ms).toBeGreaterThanOrEqual(0)
    })

    it("returns command in result", async () => {
        const result = await executeBrowserBash(session, "echo test")
        expect(result.command).toBe("echo test")
    })

    it("handles pwd command", async () => {
        const result = await executeBrowserBash(session, "pwd")
        expect(result.success).toBe(true)
        expect(result.stdout).toContain("/workspace")
    })

    it("handles cd command and updates cwd", async () => {
        // Create a directory first
        session.fs.mkdirSync("/workspace/subdir", { recursive: true })
        const result = await executeBrowserBash(session, "cd subdir && pwd")
        expect(result.success).toBe(true)
        expect(result.stdout).toContain("subdir")
    })

    it("handles cat command on created file", async () => {
        await session.fs.writeFile("/workspace/test.txt", "file content")
        const result = await executeBrowserBash(session, "cat test.txt")
        expect(result.success).toBe(true)
        expect(result.stdout).toContain("file content")
    })

    it("truncates long output by default", async () => {
        // Create a very long output
        const longContent = "x".repeat(20000)
        await session.fs.writeFile("/workspace/long.txt", longContent)
        const result = await executeBrowserBash(session, "cat long.txt", { outputLimit: 100 })
        expect(result.stdout.length).toBeLessThan(longContent.length)
        expect(result.stdout).toContain("truncated")
    })

    it("does not truncate when truncateOutput is false", async () => {
        const longContent = "x".repeat(20000)
        await session.fs.writeFile("/workspace/long.txt", longContent)
        const result = await executeBrowserBash(session, "cat long.txt", {
            truncateOutput: false,
        })
        expect(result.stdout).toContain(longContent)
    })

    it("handles non-existent command", async () => {
        const result = await executeBrowserBash(session, "nonexistentcommand")
        expect(result.success).toBe(false)
        expect(result.exit_code).not.toBe(0)
    })

    it("handles failing commands", async () => {
        const result = await executeBrowserBash(session, "cat nonexistent.txt")
        expect(result.success).toBe(false)
    })

    it("supports abort signal", async () => {
        const controller = new AbortController()
        controller.abort()
        const result = await executeBrowserBash(session, "echo test", {
            signal: controller.signal,
        })
        // Should abort since signal is already aborted
        expect(result.success).toBe(false)
    })

    it("runs multiple commands sequentially", async () => {
        const result1 = await executeBrowserBash(session, "echo first")
        const result2 = await executeBrowserBash(session, "echo second")
        expect(result1.success).toBe(true)
        expect(result2.success).toBe(true)
        expect(result1.stdout).toContain("first")
        expect(result2.stdout).toContain("second")
    })

    it("handles pipe commands", async () => {
        await session.fs.writeFile("/workspace/data.txt", "line1\nline2\nline3")
        const result = await executeBrowserBash(session, "cat data.txt | head -n 1")
        expect(result.success).toBe(true)
        expect(result.stdout).toContain("line1")
    })
})
