import { describe, it, expect } from "vitest"
import type { ToolResult } from "./types"

describe("ToolResult type", () => {
    it("accepts a successful result", () => {
        const result: ToolResult = { success: true }
        expect(result.success).toBe(true)
    })

    it("accepts a failed result with error", () => {
        const result: ToolResult = { success: false, error: "something went wrong" }
        expect(result.success).toBe(false)
        expect(result.error).toBe("something went wrong")
    })

    it("accepts additional properties", () => {
        const result: ToolResult = {
            success: true,
            exit_code: 0,
            stdout: "output",
            command: "echo hello",
            custom_field: 42,
        }
        expect(result.exit_code).toBe(0)
        expect(result.stdout).toBe("output")
        expect(result.custom_field).toBe(42)
    })
})
