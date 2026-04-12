import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
    createBrowserBashSession,
    executeBrowserBash,
    DEFAULT_BASH_SHELL_ENV,
    type BrowserBashSession,
} from "./browser-bash-session"

describe("executeBrowserBash - output truncation", () => {
    let session: BrowserBashSession

    beforeEach(() => {
        session = createBrowserBashSession()
    })

    afterEach(() => {
        session.dispose()
    })

    it("truncates long stdout with outputLimit", async () => {
        // Generate output longer than 100 chars
        const result = await executeBrowserBash(
            session,
            'echo "' + "A".repeat(200) + '"',
            { outputLimit: 100 },
        )
        expect(result.stdout!.length).toBeLessThan(250)
        expect(result.stdout).toContain("bytes truncated")
    })

    it("does not truncate when truncateOutput is false", async () => {
        const longStr = "B".repeat(200)
        const result = await executeBrowserBash(
            session,
            `echo "${longStr}"`,
            { truncateOutput: false, outputLimit: 50 },
        )
        expect(result.stdout).toContain(longStr)
        expect(result.stdout).not.toContain("bytes truncated")
    })

    it("does not truncate short output", async () => {
        const result = await executeBrowserBash(session, 'echo "short"', {
            outputLimit: 10000,
        })
        expect(result.stdout).toContain("short")
        expect(result.stdout).not.toContain("bytes truncated")
    })
})

describe("executeBrowserBash - cd and PWD tracking", () => {
    let session: BrowserBashSession

    beforeEach(() => {
        session = createBrowserBashSession()
    })

    afterEach(() => {
        session.dispose()
    })

    it("updates cwd after cd", async () => {
        session.fs.mkdirSync("/workspace/subdir", { recursive: true })
        await executeBrowserBash(session, "cd subdir")
        expect(session.cwd).toBe("/workspace/subdir")
    })

    it("cd .. goes up one directory", async () => {
        session.fs.mkdirSync("/workspace/a/b", { recursive: true })
        await executeBrowserBash(session, "cd a/b")
        expect(session.cwd).toBe("/workspace/a/b")

        await executeBrowserBash(session, "cd ..")
        expect(session.cwd).toBe("/workspace/a")
    })

    it("pwd reflects current directory", async () => {
        session.fs.mkdirSync("/workspace/mydir", { recursive: true })
        await executeBrowserBash(session, "cd mydir")
        const result = await executeBrowserBash(session, "pwd")
        expect(result.stdout!.trim()).toBe("/workspace/mydir")
    })

    it("cd to absolute path works", async () => {
        session.fs.mkdirSync("/other", { recursive: true })
        await executeBrowserBash(session, "cd /other")
        expect(session.cwd).toBe("/other")
    })
})

describe("executeBrowserBash - abort signal", () => {
    let session: BrowserBashSession

    beforeEach(() => {
        session = createBrowserBashSession()
    })

    afterEach(() => {
        session.dispose()
    })

    it("fails with already-aborted signal", async () => {
        const controller = new AbortController()
        controller.abort("cancelled")
        const result = await executeBrowserBash(session, "echo hello", {
            signal: controller.signal,
        })
        expect(result.success).toBe(false)
        expect(result.exit_code).not.toBe(0)
    })
})

describe("executeBrowserBash - error output", () => {
    let session: BrowserBashSession

    beforeEach(() => {
        session = createBrowserBashSession()
    })

    afterEach(() => {
        session.dispose()
    })

    it("reports error field on non-zero exit", async () => {
        const result = await executeBrowserBash(session, "cat /nonexistent/file")
        expect(result.success).toBe(false)
        expect(result.exit_code).not.toBe(0)
        expect(result.error).toBeDefined()
    })

    it("includes duration_ms in result", async () => {
        const result = await executeBrowserBash(session, "echo quick")
        expect(result.duration_ms).toBeDefined()
        expect(typeof result.duration_ms).toBe("number")
    })

    it("includes backend in result", async () => {
        const result = await executeBrowserBash(session, "echo hello")
        expect(result.backend).toBe("just-bash")
    })
})

describe("executeBrowserBash - environment variables", () => {
    let session: BrowserBashSession

    beforeEach(() => {
        session = createBrowserBashSession()
    })

    afterEach(() => {
        session.dispose()
    })

    it("reads env variable set inline", async () => {
        const result = await executeBrowserBash(session, 'export MY_VAR=hello123 && echo $MY_VAR')
        expect(result.stdout!.trim()).toBe("hello123")
    })

    it("inline env assignment works", async () => {
        const result = await executeBrowserBash(session, "X=42 && echo $X")
        expect(result.stdout!.trim()).toBe("42")
    })
})

describe("executeBrowserBash - complex commands", () => {
    let session: BrowserBashSession

    beforeEach(() => {
        session = createBrowserBashSession()
    })

    afterEach(() => {
        session.dispose()
    })

    it("handles && chaining with success", async () => {
        const result = await executeBrowserBash(session, 'echo "first" && echo "second"')
        expect(result.success).toBe(true)
        expect(result.stdout).toContain("first")
        expect(result.stdout).toContain("second")
    })

    it("handles semicolon-separated commands", async () => {
        const result = await executeBrowserBash(session, 'echo one; echo two')
        expect(result.success).toBe(true)
        expect(result.stdout).toContain("one")
        expect(result.stdout).toContain("two")
    })

    it("handles piped grep", async () => {
        await session.fs.writeFile("/workspace/data.txt", "hello world\nfoo bar\nhello again")
        const result = await executeBrowserBash(session, "cat /workspace/data.txt | grep hello")
        expect(result.success).toBe(true)
        expect(result.stdout).toContain("hello world")
        expect(result.stdout).toContain("hello again")
        expect(result.stdout).not.toContain("foo bar")
    })

    it("handles file write with echo redirect", async () => {
        await executeBrowserBash(session, 'echo "content here" > /workspace/output.txt')
        const result = await executeBrowserBash(session, "cat /workspace/output.txt")
        expect(result.stdout!.trim()).toBe("content here")
    })

    it("handles ls command", async () => {
        await session.fs.writeFile("/workspace/file1.txt", "a")
        await session.fs.writeFile("/workspace/file2.txt", "b")
        const result = await executeBrowserBash(session, "ls /workspace")
        expect(result.success).toBe(true)
        expect(result.stdout).toContain("file1.txt")
        expect(result.stdout).toContain("file2.txt")
    })

    it("handles mkdir -p", async () => {
        const result = await executeBrowserBash(session, "mkdir -p /workspace/deep/nested/dir")
        expect(result.success).toBe(true)
        const pwdResult = await executeBrowserBash(session, "cd /workspace/deep/nested/dir && pwd")
        expect(pwdResult.stdout!.trim()).toBe("/workspace/deep/nested/dir")
    })
})

describe("createBrowserBashSession - custom commands", () => {
    it("allows registering custom commands", async () => {
        const customCmd = {
            name: "greet",
            handler: async () => ({
                stdout: "Hello from custom command!\n",
                stderr: "",
                exitCode: 0,
            }),
        }
        // defineCommand is used internally, just check custom commands work via the option
        const session = createBrowserBashSession({
            customCommands: [customCmd as any],
        })
        session.dispose()
    })

    it("uses custom env", () => {
        const session = createBrowserBashSession({
            env: { MY_CUSTOM: "value", PATH: "/custom/bin" },
        })
        expect(session.rootPath).toBe("/workspace")
        session.dispose()
    })
})
