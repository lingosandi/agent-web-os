import { describe, it, expect, vi } from "vitest"

// Suppress the console.log from index.ts import
vi.spyOn(console, "log").mockImplementation(() => {})

import {
    AGENT_WEB_OS_VERSION,
    ObservableInMemoryFs,
    AlmostNodeSession,
    createAlmostNodeSession,
    createBrowserBashSession,
    executeBrowserBash,
    DEFAULT_BASH_SHELL_ENV,
    getServerBridge,
    resetServerBridge,
    Bash,
    defineCommand,
} from "./index"

describe("index exports", () => {
    it("exports AGENT_WEB_OS_VERSION", () => {
        expect(typeof AGENT_WEB_OS_VERSION).toBe("string")
        expect(AGENT_WEB_OS_VERSION).toMatch(/^\d+\.\d+\.\d+/)
    })

    it("exports ObservableInMemoryFs", () => {
        expect(ObservableInMemoryFs).toBeDefined()
        expect(typeof ObservableInMemoryFs).toBe("function")
    })

    it("exports AlmostNodeSession", () => {
        expect(AlmostNodeSession).toBeDefined()
        expect(typeof AlmostNodeSession).toBe("function")
    })

    it("exports createAlmostNodeSession", () => {
        expect(typeof createAlmostNodeSession).toBe("function")
    })

    it("exports createBrowserBashSession", () => {
        expect(typeof createBrowserBashSession).toBe("function")
    })

    it("exports executeBrowserBash", () => {
        expect(typeof executeBrowserBash).toBe("function")
    })

    it("exports DEFAULT_BASH_SHELL_ENV", () => {
        expect(DEFAULT_BASH_SHELL_ENV).toBeDefined()
        expect(typeof DEFAULT_BASH_SHELL_ENV).toBe("object")
    })

    it("exports getServerBridge", () => {
        expect(typeof getServerBridge).toBe("function")
    })

    it("exports resetServerBridge", () => {
        expect(typeof resetServerBridge).toBe("function")
    })

    it("re-exports Bash from just-bash", () => {
        expect(Bash).toBeDefined()
        expect(typeof Bash).toBe("function")
    })

    it("re-exports defineCommand from just-bash", () => {
        expect(typeof defineCommand).toBe("function")
    })
})
