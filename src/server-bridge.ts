/**
 * Lazy singleton holder for the almostnode ServerBridge.
 *
 * This module purposefully avoids a top-level `import "almostnode"` so that
 * bundlers (tsup/rollup) don't pull the entire almostnode package into the
 * shared chunk.  The dynamic `import()` ensures almostnode only appears in the
 * lazily-loaded almostnode-session chunk.
 */

export type ServerBridge = {
    initServiceWorker(options?: { swUrl?: string }): Promise<void>
    registerServer(server: unknown, port: number): void
    unregisterServer(port: number): void
    getServerUrl(port: number): string
}

type AlmostNodeServerBridgeModule = {
    getServerBridge(): ServerBridge
    resetServerBridge(): void
}

let globalBridge: ServerBridge | null = null
let almostnodeModule: AlmostNodeServerBridgeModule | null = null
let almostnodePromise: Promise<AlmostNodeServerBridgeModule> | null = null

export async function getServerBridge(): Promise<ServerBridge> {
    if (!almostnodeModule) {
        if (!almostnodePromise) {
            almostnodePromise = import("almostnode/server-bridge") as Promise<AlmostNodeServerBridgeModule>
        }

        almostnodeModule = await almostnodePromise
    }

    if (!globalBridge) {
        globalBridge = almostnodeModule.getServerBridge()
    }

    return globalBridge
}

export function resetServerBridge(): void {
    almostnodeModule?.resetServerBridge()
    globalBridge = null
}
