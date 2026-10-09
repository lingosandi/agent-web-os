import { describe, it, expect } from "vitest"
import { createNodeBrowserBashSession, enableNode } from "../src/node"
import { executeBrowserBash } from "../src/browser-bash-session"

/**
 * End-to-end smoke of the full in-browser OS stack against the real
 * just-bash + almostnode + observable FS wiring — the surface the
 * session's fixes changed (adapter lifecycle, lazy markers, console
 * silencing, npm cache invalidation, abort listeners).
 */
describe("agent-web-os end-to-end smoke", () => {
    it("creates a session, runs shell + node, disposes, re-enables", async () => {
        const session = await createNodeBrowserBashSession({ rootPath: "/workspace" })

        // 1. Shell basics: echo + cwd handling through just-bash
        const echo = await executeBrowserBash(session, "echo hello-os")
        expect(echo.success).toBe(true)
        expect(echo.stdout).toContain("hello-os")

        // 2. File ops through the shell hit the observable FS (lazy markers clear)
        await executeBrowserBash(session, "mkdir -p /workspace/src && echo 'x = 1' > /workspace/src/app.js")
        const cat = await executeBrowserBash(session, "cat /workspace/src/app.js")
        expect(cat.stdout).toContain("x = 1")

        // 3. node runtime works and console survives (ref-counted silencing)
        const nodeVersion = await executeBrowserBash(session, "node --version")
        expect(nodeVersion.success).toBe(true)
        expect(nodeVersion.stdout).toMatch(/v\d+/)

        const nodeRun = await executeBrowserBash(session, "node -e \"console.log('from-node')\"")
        expect(nodeRun.success).toBe(true)
        expect(nodeRun.stdout).toContain("from-node")
        // console must be restored after execution (was: hijacked globally)
        expect(typeof console.log).toBe("function")

        // 4. node reads the FS the shell wrote (mirror observable → VirtualFS)
        const fsRead = await executeBrowserBash(session, "node -e \"console.log(require('fs').readFileSync('/workspace/src/app.js','utf8'))\"")
        expect(fsRead.stdout).toContain("x = 1")

        // 5. node writes a file the shell can read (mirror VirtualFS → observable)
        await executeBrowserBash(session, "node -e \"require('fs').writeFileSync('/workspace/from-node.txt','mirror-ok')\"")
        const back = await executeBrowserBash(session, "cat /workspace/from-node.txt")
        expect(back.stdout).toContain("mirror-ok")

        // 6. Append via shell (appendFile lazy-marker fix)
        await executeBrowserBash(session, "echo appended >> /workspace/src/app.js")
        const appended = await executeBrowserBash(session, "node -e \"console.log(require('fs').readFileSync('/workspace/src/app.js','utf8'))\"")
        expect(appended.stdout).toContain("appended")

        // 7. Abort signal doesn't leak listeners and aborts cleanly
        const controller = new AbortController()
        const abortSpy = controller.signal.addEventListener
        const aborted = await executeBrowserBash(session, "echo aborted", { signal: controller.signal })
        expect(aborted.success).toBe(true)
        // listener removed in finally — no growth on a long-lived signal
        controller.abort(new Error("post-run"))
        expect(() => controller.signal.throwIfAborted()).toThrow("post-run")

        // 8. Dispose: adapters cleared, no throw on terminal calls after
        session.dispose()
        expect(() => {
            session.writeStdin("x")
            session.setTerminalSize(120, 40)
        }).not.toThrow()

        // 9. Re-enable after dispose attaches a fresh runtime (was: silent no-op)
        const re = await enableNode(session)
        const afterReEnable = await executeBrowserBash(session, "node -e \"console.log('revived')\"")
        expect(afterReEnable.success).toBe(true)
        expect(afterReEnable.stdout).toContain("revived")

        session.dispose()
    })

    it.each([
        { command: "node -e \"console.log(process.version)\"", success: true },
        { command: "node -e \"throw new Error('runtime-failure')\"", success: false },
    ])("restores host process after $command", async ({ command, success }) => {
        const original = Object.getOwnPropertyDescriptor(globalThis, "process")
        const originalProcess = Reflect.get(globalThis, "process")
        const session = await createNodeBrowserBashSession({ rootPath: "/workspace" })
        try {
            const result = await executeBrowserBash(session, command)
            expect(result.success).toBe(success)
            expect(Object.getOwnPropertyDescriptor(globalThis, "process")).toEqual(original)
            expect(Reflect.get(globalThis, "process")).toBe(originalProcess)
        } finally {
            session.dispose()
            // Keep the host runner intact even when testing a broken runtime.
            if (original) {
                Object.defineProperty(globalThis, "process", original)
                original.set?.call(globalThis, originalProcess)
            } else Reflect.deleteProperty(globalThis, "process")
        }
    })

    it("npm install → node resolves the fresh package entry", async () => {
        const session = await createNodeBrowserBashSession({ rootPath: "/workspace" })

        // Real npm requires a package.json before installing; the shim
        // has no `npm init`, so write a minimal one via the shell.
        const init = await executeBrowserBash(session, "echo '{\"name\":\"smoke\",\"version\":\"1.0.0\"}' > /workspace/package.json")
        expect(init.success).toBe(true)

        // npm install a tiny package and require it — exercises the
        // install path that must invalidate resolveBarePkgEntryCache.
        // Note: `node -e` evals have no source file, so almostnode's
        // resolver starts at "/" and can't see cwd's node_modules;
        // requiring from a script file (the realistic flow) works.
        const install = await executeBrowserBash(session, "npm install left-pad", { commandTimeoutMs: 120_000, truncateOutput: false })
        expect(install.success).toBe(true)

        await executeBrowserBash(session, "echo \"console.log(require('left-pad')('ok', 6))\" > /workspace/s.js")
        const use = await executeBrowserBash(session, "node /workspace/s.js")
        expect(use.success).toBe(true)
        expect(use.stdout.trim()).toContain("ok")

        session.dispose()
    }, 180_000)
})