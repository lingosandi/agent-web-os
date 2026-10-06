import { describe, it, expect, beforeEach } from "vitest"
import { ObservableInMemoryFs } from "./observable-in-memory-fs"

describe("ObservableInMemoryFs lazy-path handling", () => {
    let fs: ObservableInMemoryFs

    beforeEach(() => {
        fs = new ObservableInMemoryFs()
    })

    it("clears the lazy marker when a lazy file is written via async writeFile", async () => {
        fs.mkdirSync("/w", { recursive: true })
        fs.writeFileLazy("/w/lazy.txt", () => "hydrated")
        expect(fs.isPathLazy("/w/lazy.txt")).toBe(true)

        await fs.writeFile("/w/lazy.txt", "overwritten")
        expect(fs.isPathLazy("/w/lazy.txt")).toBe(false)
        expect(await fs.readFile("/w/lazy.txt", "utf8")).toBe("overwritten")
    })

    it("clears the lazy marker when a lazy file is appended via appendFile", async () => {
        fs.mkdirSync("/w", { recursive: true })
        fs.writeFileLazy("/w/lazy.log", () => "hydrated")
        expect(fs.isPathLazy("/w/lazy.log")).toBe(true)

        await fs.appendFile("/w/lazy.log", "line")
        expect(fs.isPathLazy("/w/lazy.log")).toBe(false)
    })

    it("keeps the lazy marker for untouched lazy files", async () => {
        fs.mkdirSync("/w", { recursive: true })
        fs.writeFileLazy("/w/lazy.txt", () => "hydrated")
        fs.writeFileLazy("/w/other.txt", () => "hydrated")

        await fs.writeFile("/w/other.txt", "overwritten")
        expect(fs.isPathLazy("/w/lazy.txt")).toBe(true)
        expect(fs.isPathLazy("/w/other.txt")).toBe(false)
    })
})