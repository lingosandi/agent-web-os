import { describe, it, expect, vi } from "vitest"
import {
    ObservableInMemoryFs,
    type ObservableInMemoryFsChangeEvent,
} from "./observable-in-memory-fs"

function collectEvents(fs: ObservableInMemoryFs): ObservableInMemoryFsChangeEvent[] {
    const events: ObservableInMemoryFsChangeEvent[] = []
    fs.subscribe((event) => events.push(event))
    return events
}

async function tick(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("ObservableInMemoryFs - extended edge cases", () => {
    describe("cp (async)", () => {
        it("emits add event when copying to new path", async () => {
            const fs = new ObservableInMemoryFs()
            fs.mkdirSync("/dir", { recursive: true })
            await fs.writeFile("/dir/source.txt", "data")

            const events = collectEvents(fs)
            await fs.cp("/dir/source.txt", "/dir/dest.txt")

            expect(events.some((e) => e.event === "add" && e.path === "/dir/dest.txt")).toBe(true)
        })

        it("emits change event when overwriting existing file", async () => {
            const fs = new ObservableInMemoryFs()
            fs.mkdirSync("/dir", { recursive: true })
            await fs.writeFile("/dir/source.txt", "data")
            await fs.writeFile("/dir/dest.txt", "old data")

            const events = collectEvents(fs)
            await fs.cp("/dir/source.txt", "/dir/dest.txt")

            expect(events.some((e) => e.event === "change" && e.path === "/dir/dest.txt")).toBe(true)
        })
    })

    describe("symlink (async)", () => {
        it("emits add event for new symlink", async () => {
            const fs = new ObservableInMemoryFs()
            fs.mkdirSync("/dir", { recursive: true })
            await fs.writeFile("/dir/target.txt", "data")

            const events = collectEvents(fs)
            await fs.symlink("/dir/target.txt", "/dir/link.txt")

            expect(events.some((e) => e.event === "add" && e.path === "/dir/link.txt")).toBe(true)
        })
    })

    describe("link (async)", () => {
        it("emits add event for new hard link", async () => {
            const fs = new ObservableInMemoryFs()
            fs.mkdirSync("/dir", { recursive: true })
            await fs.writeFile("/dir/existing.txt", "data")

            const events = collectEvents(fs)
            await fs.link("/dir/existing.txt", "/dir/linked.txt")

            expect(events.some((e) => e.event === "add" && e.path === "/dir/linked.txt")).toBe(true)
        })
    })

    describe("utimes (async)", () => {
        it("emits change event", async () => {
            const fs = new ObservableInMemoryFs()
            fs.mkdirSync("/dir", { recursive: true })
            await fs.writeFile("/dir/file.txt", "data")

            const events = collectEvents(fs)
            await fs.utimes("/dir/file.txt", new Date(), new Date())

            expect(events.some((e) => e.event === "change" && e.path === "/dir/file.txt")).toBe(true)
        })
    })

    describe("writeFileLazy", () => {
        it("resolves lazy content on read", async () => {
            const fs = new ObservableInMemoryFs()
            fs.writeFileLazy("/lazy.txt", () => "lazy resolved")

            const buffer = await fs.readFileBuffer("/lazy.txt")
            const content = new TextDecoder().decode(buffer)
            expect(content).toBe("lazy resolved")
        })

        it("multiple lazy files tracked independently", () => {
            const fs = new ObservableInMemoryFs()
            fs.writeFileLazy("/a.txt", () => "a")
            fs.writeFileLazy("/b.txt", () => "b")

            expect(fs.isPathLazy("/a.txt")).toBe(true)
            expect(fs.isPathLazy("/b.txt")).toBe(true)
        })

        it("overwriting lazy path with writeFileSync clears lazy flag", () => {
            const fs = new ObservableInMemoryFs()
            fs.writeFileLazy("/file.txt", () => "lazy")
            expect(fs.isPathLazy("/file.txt")).toBe(true)

            fs.writeFileSync("/file.txt", "not lazy")
            expect(fs.isPathLazy("/file.txt")).toBe(false)
        })

        it("rm clears lazy flags under removed path", async () => {
            const fs = new ObservableInMemoryFs()
            fs.mkdirSync("/lazy-dir", { recursive: true })
            fs.writeFileLazy("/lazy-dir/a.txt", () => "a")
            fs.writeFileLazy("/lazy-dir/b.txt", () => "b")

            expect(fs.isPathLazy("/lazy-dir/a.txt")).toBe(true)
            expect(fs.isPathLazy("/lazy-dir/b.txt")).toBe(true)

            await fs.rm("/lazy-dir", { recursive: true })

            expect(fs.isPathLazy("/lazy-dir/a.txt")).toBe(false)
            expect(fs.isPathLazy("/lazy-dir/b.txt")).toBe(false)
        })
    })

    describe("suppressObservability nesting", () => {
        it("handles nested suppression", async () => {
            const fs = new ObservableInMemoryFs()
            const events = collectEvents(fs)

            await fs.suppressObservability(async () => {
                fs.writeFileSync("/outer.txt", "outer")
                await fs.suppressObservability(async () => {
                    fs.writeFileSync("/inner.txt", "inner")
                })
                fs.writeFileSync("/after-inner.txt", "after")
            })
            await tick()

            expect(events).toHaveLength(0)
        })

        it("events resume only after outermost suppression ends", async () => {
            const fs = new ObservableInMemoryFs()

            await fs.suppressObservability(async () => {
                await fs.suppressObservability(async () => {})
                // Still inside outer suppression
            })

            const events = collectEvents(fs)
            fs.writeFileSync("/after-all.txt", "data")
            await tick()

            expect(events.some((e) => e.path === "/after-all.txt")).toBe(true)
        })
    })

    describe("multiple subscribers", () => {
        it("all subscribers receive the same events", async () => {
            const fs = new ObservableInMemoryFs()
            const events1: ObservableInMemoryFsChangeEvent[] = []
            const events2: ObservableInMemoryFsChangeEvent[] = []
            const events3: ObservableInMemoryFsChangeEvent[] = []

            fs.subscribe((e) => events1.push(e))
            fs.subscribe((e) => events2.push(e))
            fs.subscribe((e) => events3.push(e))

            fs.writeFileSync("/test.txt", "hello")
            await tick()

            expect(events1.length).toBeGreaterThan(0)
            expect(events1.length).toBe(events2.length)
            expect(events2.length).toBe(events3.length)
        })

        it("unsubscribing one doesn't affect others", async () => {
            const fs = new ObservableInMemoryFs()
            const listener1 = vi.fn()
            const listener2 = vi.fn()

            const unsub1 = fs.subscribe(listener1)
            fs.subscribe(listener2)

            unsub1()

            fs.writeFileSync("/test.txt", "hello")
            await tick()

            expect(listener1).not.toHaveBeenCalled()
            expect(listener2).toHaveBeenCalled()
        })
    })

    describe("path normalization in events", () => {
        it("normalizes path in lazy tracking", () => {
            const fs = new ObservableInMemoryFs()
            fs.writeFileLazy("/foo/./bar/../baz.txt", () => "content")
            expect(fs.isPathLazy("/foo/baz.txt")).toBe(true)
        })
    })

    describe("mv with lazy paths", () => {
        it("clears lazy flag after mv (internal stat resolves it)", async () => {
            const fs = new ObservableInMemoryFs()
            fs.mkdirSync("/src", { recursive: true })
            fs.mkdirSync("/dest", { recursive: true })
            fs.writeFileLazy("/src/file.txt", () => "lazy content")

            expect(fs.isPathLazy("/src/file.txt")).toBe(true)

            await fs.mv("/src/file.txt", "/dest/file.txt")

            // mv internally reads/stats the source, which clears its lazy flag
            expect(fs.isPathLazy("/src/file.txt")).toBe(false)
            expect(fs.isPathLazy("/dest/file.txt")).toBe(false)
        })
    })
})
