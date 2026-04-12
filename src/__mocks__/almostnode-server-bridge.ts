// Mock for almostnode/server-bridge
const servers = new Map<number, unknown>()

class MockServerBridge {
    async initServiceWorker() {}
    registerServer(server: unknown, port: number) {
        servers.set(port, server)
    }
    unregisterServer(port: number) {
        servers.delete(port)
    }
    getServerUrl(port: number) {
        return `http://localhost:${port}`
    }
}

let bridge: MockServerBridge | null = null

export function getServerBridge(): MockServerBridge {
    if (!bridge) bridge = new MockServerBridge()
    return bridge
}

export function resetServerBridge(): void {
    bridge = null
    servers.clear()
}
