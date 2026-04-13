export const AGENT_WEB_OS_VERSION = "0.4.1"
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
