import { describe, expect, it } from "vitest"

import { getServerBridge, resetServerBridge } from "./server-bridge"

describe("server bridge lifecycle", () => {
    it("returns the same bridge instance until reset", async () => {
        resetServerBridge()

        const first = await getServerBridge()
        const second = await getServerBridge()

        expect(second).toBe(first)
    })

    it("creates a fresh underlying bridge after reset", async () => {
        resetServerBridge()

        const first = await getServerBridge()
        resetServerBridge()
        const second = await getServerBridge()

        expect(second).not.toBe(first)
    })

    it("continues to expose the bridge API after reset", async () => {
        resetServerBridge()

        const bridge = await getServerBridge()
        await bridge.initServiceWorker()
        bridge.registerServer({ name: "server" }, 4173)
        expect(bridge.getServerUrl(4173)).toBe("http://localhost:4173")
        bridge.unregisterServer(4173)
    })
})