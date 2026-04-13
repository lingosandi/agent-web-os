import { describe, expect, it, vi } from "vitest"

vi.spyOn(console, "log").mockImplementation(() => {})

import {
    createNodeBrowserBashSession,
    enableNode,
    getServerBridge,
    resetServerBridge,
} from "./node"
import { createBrowserBashSession, executeBrowserBash } from "./browser-bash-session"
import { defineCommand } from "just-bash/browser"

describe("node entry exports", () => {
    it("exports enableNode", () => {
        expect(typeof enableNode).toBe("function")
    })

    it("exports createNodeBrowserBashSession", () => {
        expect(typeof createNodeBrowserBashSession).toBe("function")
    })

    it("exports getServerBridge", () => {
        expect(typeof getServerBridge).toBe("function")
    })

    it("exports resetServerBridge", () => {
        expect(typeof resetServerBridge).toBe("function")
    })
})

describe("enableNode", () => {
    it("registers node commands onto an existing browser bash session", async () => {
        const session = createBrowserBashSession()

        const before = await executeBrowserBash(session, "node --version")
        expect(before.success).toBe(false)

        await enableNode(session)

        const after = await executeBrowserBash(session, "node --version")
        expect(after.success).toBe(true)
        expect(after.stdout).toContain("v")
    })

    it("is idempotent when called more than once on the same session", async () => {
        const session = createBrowserBashSession()

        const first = await enableNode(session)
        const second = await enableNode(session)
        const result = await executeBrowserBash(session, "node --version")

        expect(first).toBe(session)
        expect(second).toBe(session)
        expect(result.success).toBe(true)
    })

    it("creates a node-enabled session via the dedicated entry", async () => {
        const session = await createNodeBrowserBashSession()
        const result = await executeBrowserBash(session, "node --version")

        expect(result.success).toBe(true)
        expect(result.stdout).toContain("v")
    })

    it("preserves browser session options in the dedicated node entry", async () => {
        const session = await createNodeBrowserBashSession({
            rootPath: "/project",
            customCommands: [
                defineCommand("greet", async () => ({ stdout: "hello\n", stderr: "", exitCode: 0 })),
            ],
        })

        const nodeResult = await executeBrowserBash(session, "node --version")
        const customResult = await executeBrowserBash(session, "greet")

        expect(session.rootPath).toBe("/project")
        expect(session.cwd).toBe("/project")
        expect(nodeResult.success).toBe(true)
        expect(customResult.stdout?.trim()).toBe("hello")
    })
})