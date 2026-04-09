/**
 * Shared types for agent-web-os.
 */

export interface ToolResult {
    success: boolean
    error?: string
    [key: string]: any
}
