export const AGENT_WEB_OS_VERSION = "0.2.0"
console.log(`[agent-web-os] v${AGENT_WEB_OS_VERSION}`)

export {
    ObservableInMemoryFs,
    assertObservableInMemoryFs,
    type ObservableInMemoryFsOptions,
    type ObservableInMemoryFsChangeEvent,
    type ObservableInMemoryFsChangeEventName,
} from "./observable-in-memory-fs"

export {
    createBrowserBashSession,
    executeBrowserBash,
    DEFAULT_BASH_SHELL_ENV,
    type BrowserBashSession,
} from "./browser-bash-session"

export { executeFd } from "./fd-command"

export type { ToolResult } from "./types"

// Re-export just-bash/browser symbols so consumers don't need just-bash directly
export { Bash, defineCommand } from "just-bash/browser"
export type { CommandContext, ExecResult, CustomCommand } from "just-bash/browser"

// Re-export almostnode/server-bridge utilities
// Explicitly typed to avoid exposing the almostnode/server-bridge subpath in .d.ts
// (almostnode doesn't export this subpath in its package.json)
import { getServerBridge as _getServerBridge, resetServerBridge as _resetServerBridge } from "almostnode/server-bridge"

export type ServerBridge = {
    initServiceWorker(): Promise<void>
    registerServer(server: unknown, port: number): void
    unregisterServer(port: number): void
    getServerUrl(port: number): string
}

export const getServerBridge: () => ServerBridge = _getServerBridge
export const resetServerBridge: () => void = _resetServerBridge
