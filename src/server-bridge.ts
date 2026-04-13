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

let globalBridge: ServerBridge | null = null
let almostnodePromise: Promise<{ getServerBridge(): ServerBridge; resetServerBridge(): void }> | null = null

function loadAlmostnode() {
    if (!almostnodePromise) {
        almostnodePromise = import("almostnode/server-bridge") as Promise<{ getServerBridge(): ServerBridge; resetServerBridge(): void }>
    }
    return almostnodePromise
}

export async function getServerBridge(): Promise<ServerBridge> {
    if (!globalBridge) {
        const mod = await loadAlmostnode()
        globalBridge = mod.getServerBridge()
    }
    return globalBridge
}

export function resetServerBridge(): void {
    globalBridge = null
}
