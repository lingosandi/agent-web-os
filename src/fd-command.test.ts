import { describe, it, expect, beforeEach } from "vitest"
import { createBrowserBashSession, executeBrowserBash, type BrowserBashSession } from "./browser-bash-session"

describe("fd command", () => {
    let session: BrowserBashSession

    beforeEach(() => {
        session = createBrowserBashSession({ rootPath: "/workspace" })
        // Create a test file tree
        session.fs.mkdirSync("/workspace/src", { recursive: true })
        session.fs.mkdirSync("/workspace/src/utils", { recursive: true })
        session.fs.mkdirSync("/workspace/tests", { recursive: true })
        session.fs.mkdirSync("/workspace/.hidden", { recursive: true })
        session.fs.mkdirSync("/workspace/node_modules/pkg", { recursive: true })
        session.fs.writeFileSync("/workspace/src/index.ts", "export {}")
        session.fs.writeFileSync("/workspace/src/app.tsx", "export default function App() {}")
        session.fs.writeFileSync("/workspace/src/utils/helpers.ts", "export function help() {}")
        session.fs.writeFileSync("/workspace/src/utils/types.d.ts", "export type T = string")
        session.fs.writeFileSync("/workspace/tests/app.test.ts", "test('works')")
        session.fs.writeFileSync("/workspace/.hidden/secret.ts", "const x = 1")
        session.fs.writeFileSync("/workspace/README.md", "# Hello")
        session.fs.writeFileSync("/workspace/package.json", "{}")
        session.fs.writeFileSync("/workspace/node_modules/pkg/index.js", "module.exports = {}")
    })

    it("finds all files when no pattern specified", async () => {
        const result = await executeBrowserBash(session, "fd", { truncateOutput: false })
        expect(result.exit_code).toBe(0)
        expect(result.stdout).toContain("src/index.ts")
        expect(result.stdout).toContain("README.md")
    })

    it("matches by regex pattern (default mode)", async () => {
        const result = await executeBrowserBash(session, "fd '\\.ts$'", { truncateOutput: false })
        expect(result.exit_code).toBe(0)
        expect(result.stdout).toContain("index.ts")
        expect(result.stdout).toContain("helpers.ts")
        expect(result.stdout).not.toContain("app.tsx")
        expect(result.stdout).not.toContain("README.md")
    })

    it("matches by glob pattern with --glob", async () => {
        const result = await executeBrowserBash(session, "fd --glob '*.tsx'", { truncateOutput: false })
        expect(result.exit_code).toBe(0)
        expect(result.stdout).toContain("app.tsx")
        expect(result.stdout).not.toContain("index.ts")
    })

    it("filters by file type -t f", async () => {
        const result = await executeBrowserBash(session, "fd -t d", { truncateOutput: false })
        expect(result.exit_code).toBe(0)
        expect(result.stdout).toContain("src")
        expect(result.stdout).toContain("tests")
        expect(result.stdout).not.toContain("index.ts")
    })

    it("filters by extension -e", async () => {
        const result = await executeBrowserBash(session, "fd -e md", { truncateOutput: false })
        expect(result.exit_code).toBe(0)
        expect(result.stdout).toContain("README.md")
        expect(result.stdout).not.toContain("index.ts")
    })

    it("skips hidden files by default", async () => {
        const result = await executeBrowserBash(session, "fd secret", { truncateOutput: false })
        // .hidden dir is skipped, so secret.ts shouldn't be found
        expect(result.stdout).not.toContain("secret.ts")
    })

    it("includes hidden files with --hidden", async () => {
        const result = await executeBrowserBash(session, "fd --hidden secret", { truncateOutput: false })
        expect(result.exit_code).toBe(0)
        expect(result.stdout).toContain("secret.ts")
    })

    it("respects --max-results", async () => {
        const result = await executeBrowserBash(session, "fd --max-results 2", { truncateOutput: false })
        expect(result.exit_code).toBe(0)
        const lines = result.stdout!.trim().split("\n").filter(Boolean)
        expect(lines.length).toBe(2)
    })

    it("respects --max-depth", async () => {
        const result = await executeBrowserBash(session, "fd -d 1", { truncateOutput: false })
        expect(result.exit_code).toBe(0)
        // Should find files in /workspace but not in /workspace/src/utils
        expect(result.stdout).toContain("README.md")
        expect(result.stdout).not.toContain("helpers.ts")
    })

    it("searches a specific path", async () => {
        const result = await executeBrowserBash(session, "fd '' src/utils", { truncateOutput: false })
        expect(result.exit_code).toBe(0)
        expect(result.stdout).toContain("helpers.ts")
        expect(result.stdout).not.toContain("README.md")
    })

    it("handles --exclude", async () => {
        const result = await executeBrowserBash(session, "fd --exclude '*.md'", { truncateOutput: false })
        expect(result.exit_code).toBe(0)
        expect(result.stdout).not.toContain("README.md")
        expect(result.stdout).toContain("index.ts")
    })

    it("shows version with --version", async () => {
        const result = await executeBrowserBash(session, "fd --version", { truncateOutput: false })
        expect(result.exit_code).toBe(0)
        expect(result.stdout).toContain("fd")
    })

    it("shows help with --help", async () => {
        const result = await executeBrowserBash(session, "fd --help", { truncateOutput: false })
        expect(result.exit_code).toBe(0)
        expect(result.stdout).toContain("Usage: fd")
    })

    it("returns exit code 1 when no matches", async () => {
        const result = await executeBrowserBash(session, "fd nonexistent_xyz", { truncateOutput: false })
        expect(result.exit_code).toBe(1)
    })

    it("works with --glob and --color=never (pi-coding-agent flags)", async () => {
        const result = await executeBrowserBash(session, "fd --glob --color=never --hidden '*.ts' /workspace", { truncateOutput: false })
        expect(result.exit_code).toBe(0)
        expect(result.stdout).toContain("index.ts")
        expect(result.stdout).toContain("helpers.ts")
    })

    it("respects gitignore patterns", async () => {
        session.fs.writeFileSync("/workspace/.gitignore", "node_modules\n")
        const result = await executeBrowserBash(session, "fd index.js", { truncateOutput: false })
        // node_modules should be ignored by gitignore
        expect(result.stdout).not.toContain("node_modules")
    })

    it("ignores gitignore with --no-ignore", async () => {
        session.fs.writeFileSync("/workspace/.gitignore", "node_modules\n")
        const result = await executeBrowserBash(session, "fd --no-ignore --hidden index.js", { truncateOutput: false })
        expect(result.exit_code).toBe(0)
        expect(result.stdout).toContain("node_modules")
    })
})
