import { describe, expect, it, vi } from "vitest"

vi.spyOn(console, "log").mockImplementation(() => {})

import {
    createNodeBrowserBashSession,
    enableNode,
    getServerBridge,
    resetServerBridge,
} from "./node"
import { createBrowserBashSession, executeBrowserBash } from "./browser-bash-session"

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

    it("creates a node-enabled session via the dedicated entry", async () => {
        const session = await createNodeBrowserBashSession()
        const result = await executeBrowserBash(session, "node --version")

        expect(result.success).toBe(true)
        expect(result.stdout).toContain("v")
    })
})