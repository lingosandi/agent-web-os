import { describe, it, expect, vi } from "vitest"
import {
    ObservableInMemoryFs,
    assertObservableInMemoryFs,
    type ObservableInMemoryFsChangeEvent,
} from "./observable-in-memory-fs"

function collectEvents(fs: ObservableInMemoryFs): ObservableInMemoryFsChangeEvent[] {
    const events: ObservableInMemoryFsChangeEvent[] = []
    fs.subscribe((event) => events.push(event))
    return events
}

/** Wait a tick to let queued emissions fire */
async function tick(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("ObservableInMemoryFs", () => {
    describe("constructor", () => {
        it("creates an instance with defaults", () => {
            const fs = new ObservableInMemoryFs()
            expect(fs).toBeDefined()
        })

        it("accepts consoleLogChanges option", () => {
            const fs = new ObservableInMemoryFs({ consoleLogChanges: true })
            expect(fs).toBeDefined()
        })

        it("accepts workspaceRoot option", () => {
            const fs = new ObservableInMemoryFs({ workspaceRoot: "/workspace" })
            expect(fs).toBeDefined()
        })
    })

    describe("subscribe", () => {
        it("returns an unsubscribe function", () => {
            const fs = new ObservableInMemoryFs()
            const unsub = fs.subscribe(() => {})
            expect(typeof unsub).toBe("function")
        })

        it("calls listener on writeFileSync", async () => {
            const fs = new ObservableInMemoryFs()
            const events = collectEvents(fs)

            fs.writeFileSync("/test.txt", "hello")
            await tick()

            expect(events.length).toBe(1)
            expect(events[0].event).toBe("add")
            expect(events[0].path).toBe("/test.txt")
            expect(events[0].entryType).toBe("file")
        })

        it("emits 'change' for overwriting an existing file", async () => {
            const fs = new ObservableInMemoryFs()
            fs.writeFileSync("/test.txt", "hello")
            await tick()

            const events = collectEvents(fs)
            fs.writeFileSync("/test.txt", "updated")
            await tick()

            expect(events.some((e) => e.event === "change" && e.path === "/test.txt")).toBe(true)
        })

        it("does not call listener after unsubscribe", async () => {
            const fs = new ObservableInMemoryFs()
            const listener = vi.fn()
            const unsub = fs.subscribe(listener)

            unsub()
            fs.writeFileSync("/test.txt", "hello")
            await tick()

            expect(listener).not.toHaveBeenCalled()
        })

        it("handles multiple listeners", async () => {
            const fs = new ObservableInMemoryFs()
            const listener1 = vi.fn()
            const listener2 = vi.fn()
            fs.subscribe(listener1)
            fs.subscribe(listener2)

            fs.writeFileSync("/test.txt", "hello")
            await tick()

            expect(listener1).toHaveBeenCalled()
            expect(listener2).toHaveBeenCalled()
        })
    })

    describe("mkdirSync", () => {
        it("emits addDir event", async () => {
            const fs = new ObservableInMemoryFs()
            const events = collectEvents(fs)

            fs.mkdirSync("/mydir", { recursive: true })
            await tick()

            expect(events.some((e) => e.event === "addDir" && e.path === "/mydir")).toBe(true)
        })

        it("does not emit if dir already exists", async () => {
            const fs = new ObservableInMemoryFs()
            fs.mkdirSync("/mydir", { recursive: true })
            await tick()

            const events = collectEvents(fs)
            fs.mkdirSync("/mydir", { recursive: true })
            await tick()

            expect(events.filter((e) => e.path === "/mydir")).toHaveLength(0)
        })
    })

    describe("writeFile (async)", () => {
        it("emits add event for new file", async () => {
            const fs = new ObservableInMemoryFs()
            const events = collectEvents(fs)

            fs.mkdirSync("/dir", { recursive: true })
            await tick()

            await fs.writeFile("/dir/test.txt", "content")

            expect(events.some((e) => e.event === "add" && e.path === "/dir/test.txt")).toBe(true)
        })

        it("emits change event for existing file", async () => {
            const fs = new ObservableInMemoryFs()
            fs.mkdirSync("/dir", { recursive: true })
            await fs.writeFile("/dir/test.txt", "content")

            const events = collectEvents(fs)
            await fs.writeFile("/dir/test.txt", "updated")

            expect(events.some((e) => e.event === "change" && e.path === "/dir/test.txt")).toBe(true)
        })
    })

    describe("mkdir (async)", () => {
        it("emits addDir event for new directory", async () => {
            const fs = new ObservableInMemoryFs()
            const events = collectEvents(fs)

            await fs.mkdir("/newdir", { recursive: true })

            expect(events.some((e) => e.event === "addDir" && e.path === "/newdir")).toBe(true)
        })
    })

    describe("rm (async)", () => {
        it("emits unlink event for file removal", async () => {
            const fs = new ObservableInMemoryFs()
            fs.mkdirSync("/dir", { recursive: true })
            await fs.writeFile("/dir/test.txt", "content")

            const events = collectEvents(fs)
            await fs.rm("/dir/test.txt")

            expect(events.some((e) => e.event === "unlink" && e.path === "/dir/test.txt")).toBe(true)
        })

        it("emits unlinkDir event for directory removal", async () => {
            const fs = new ObservableInMemoryFs()
            await fs.mkdir("/rmdir", { recursive: true })

            const events = collectEvents(fs)
            await fs.rm("/rmdir", { recursive: true })

            expect(events.some((e) => e.event === "unlinkDir" && e.path === "/rmdir")).toBe(true)
        })
    })

    describe("mv (async)", () => {
        it("emits unlink + add events for move", async () => {
            const fs = new ObservableInMemoryFs()
            fs.mkdirSync("/src", { recursive: true })
            fs.mkdirSync("/dest", { recursive: true })
            await fs.writeFile("/src/file.txt", "content")
            await tick()

            const events = collectEvents(fs)
            await fs.mv("/src/file.txt", "/dest/file.txt")

            expect(events.some((e) => e.event === "unlink" && e.path === "/src/file.txt")).toBe(true)
            expect(events.some((e) => e.event === "add" && e.path === "/dest/file.txt")).toBe(true)
        })
    })

    describe("chmod (async)", () => {
        it("emits change event", async () => {
            const fs = new ObservableInMemoryFs()
            fs.mkdirSync("/dir", { recursive: true })
            await fs.writeFile("/dir/test.txt", "content")

            const events = collectEvents(fs)
            await fs.chmod("/dir/test.txt", 0o755)

            expect(events.some((e) => e.event === "change" && e.path === "/dir/test.txt")).toBe(true)
        })
    })

    describe("suppressObservability", () => {
        it("suppresses events during operation", async () => {
            const fs = new ObservableInMemoryFs()
            const events = collectEvents(fs)

            await fs.suppressObservability(async () => {
                fs.writeFileSync("/suppressed.txt", "hello")
                fs.mkdirSync("/suppressed-dir", { recursive: true })
            })
            await tick()

            expect(events).toHaveLength(0)
        })

        it("re-enables events after operation", async () => {
            const fs = new ObservableInMemoryFs()
            await fs.suppressObservability(async () => {
                fs.writeFileSync("/suppressed.txt", "hello")
            })

            const events = collectEvents(fs)
            fs.writeFileSync("/after.txt", "world")
            await tick()

            expect(events.some((e) => e.path === "/after.txt")).toBe(true)
        })

        it("re-enables events even if operation throws", async () => {
            const fs = new ObservableInMemoryFs()
            try {
                await fs.suppressObservability(async () => {
                    throw new Error("oops")
                })
            } catch { /* expected */ }

            const events = collectEvents(fs)
            fs.writeFileSync("/after-error.txt", "data")
            await tick()

            expect(events.some((e) => e.path === "/after-error.txt")).toBe(true)
        })
    })

    describe("writeFileLazy", () => {
        it("marks path as lazy", () => {
            const fs = new ObservableInMemoryFs()
            fs.writeFileLazy("/lazy.txt", () => "lazy content")
            expect(fs.isPathLazy("/lazy.txt")).toBe(true)
        })

        it("clears lazy flag after read", async () => {
            const fs = new ObservableInMemoryFs()
            fs.writeFileLazy("/lazy.txt", () => "lazy content")
            await fs.stat("/lazy.txt")
            expect(fs.isPathLazy("/lazy.txt")).toBe(false)
        })

        it("emits add event for lazy write", async () => {
            const fs = new ObservableInMemoryFs()
            const events = collectEvents(fs)

            fs.writeFileLazy("/lazy.txt", () => "lazy content")
            await tick()

            expect(events.some((e) => e.event === "add" && e.path === "/lazy.txt")).toBe(true)
        })
    })

    describe("isPathLazy", () => {
        it("returns false for non-lazy paths", () => {
            const fs = new ObservableInMemoryFs()
            fs.writeFileSync("/regular.txt", "content")
            expect(fs.isPathLazy("/regular.txt")).toBe(false)
        })

        it("returns false for nonexistent paths", () => {
            const fs = new ObservableInMemoryFs()
            expect(fs.isPathLazy("/nonexistent.txt")).toBe(false)
        })
    })

    describe("console logging", () => {
        it("logs changes when consoleLogChanges is true", async () => {
            const spy = vi.spyOn(console, "log").mockImplementation(() => {})
            const fs = new ObservableInMemoryFs({ consoleLogChanges: true, workspaceRoot: "/workspace" })
            fs.mkdirSync("/workspace", { recursive: true })
            await tick()
            spy.mockClear()

            fs.writeFileSync("/workspace/test.txt", "hello")
            await tick()

            expect(spy).toHaveBeenCalledWith(
                expect.stringContaining("[ObservableInMemoryFs]"),
            )
            spy.mockRestore()
        })

        it("does not log changes outside workspaceRoot", async () => {
            const spy = vi.spyOn(console, "log").mockImplementation(() => {})
            const fs = new ObservableInMemoryFs({ consoleLogChanges: true, workspaceRoot: "/workspace" })
            fs.writeFileSync("/outside/test.txt", "hello")
            await tick()

            // Should NOT have logged for /outside/test.txt since it's outside /workspace
            const calls = spy.mock.calls.filter(
                (call) => typeof call[0] === "string" && call[0].includes("/outside/test.txt"),
            )
            expect(calls).toHaveLength(0)
            spy.mockRestore()
        })

        it("does not log for hidden files (dot-prefix segments)", async () => {
            const spy = vi.spyOn(console, "log").mockImplementation(() => {})
            const fs = new ObservableInMemoryFs({ consoleLogChanges: true, workspaceRoot: "/" })
            fs.mkdirSync("/.hidden", { recursive: true })
            fs.writeFileSync("/.hidden/test.txt", "hello")
            await tick()

            const calls = spy.mock.calls.filter(
                (call) => typeof call[0] === "string" && call[0].includes("/.hidden/test.txt"),
            )
            expect(calls).toHaveLength(0)
            spy.mockRestore()
        })
    })

    describe("appendFile", () => {
        it("emits change event for existing file append", async () => {
            const fs = new ObservableInMemoryFs()
            fs.mkdirSync("/dir", { recursive: true })
            await fs.writeFile("/dir/test.txt", "hello")

            const events = collectEvents(fs)
            await fs.appendFile("/dir/test.txt", " world")

            expect(events.some((e) => e.event === "change" && e.path === "/dir/test.txt")).toBe(true)
        })
    })

    describe("readFileBuffer", () => {
        it("clears lazy flag after reading", async () => {
            const fs = new ObservableInMemoryFs()
            fs.writeFileLazy("/lazy.bin", () => new Uint8Array([1, 2, 3]))
            expect(fs.isPathLazy("/lazy.bin")).toBe(true)

            await fs.readFileBuffer("/lazy.bin")
            expect(fs.isPathLazy("/lazy.bin")).toBe(false)
        })
    })

    describe("listener error handling", () => {
        it("catches and logs listener errors without stopping emission", async () => {
            const spy = vi.spyOn(console, "error").mockImplementation(() => {})
            const fs = new ObservableInMemoryFs()

            const goodListener = vi.fn()
            fs.subscribe(() => {
                throw new Error("bad listener")
            })
            fs.subscribe(goodListener)

            fs.writeFileSync("/test.txt", "hello")
            await tick()

            expect(spy).toHaveBeenCalled()
            expect(goodListener).toHaveBeenCalled()
            spy.mockRestore()
        })
    })
})

describe("assertObservableInMemoryFs", () => {
    it("returns valid ObservableInMemoryFs", () => {
        const fs = new ObservableInMemoryFs()
        expect(assertObservableInMemoryFs(fs)).toBe(fs)
    })

    it("throws for null", () => {
        expect(() => assertObservableInMemoryFs(null)).toThrow()
    })

    it("throws for undefined", () => {
        expect(() => assertObservableInMemoryFs(undefined)).toThrow()
    })

    it("throws for plain object without expected methods", () => {
        expect(() => assertObservableInMemoryFs({})).toThrow()
    })

    it("throws for primitive values", () => {
        expect(() => assertObservableInMemoryFs(42)).toThrow()
        expect(() => assertObservableInMemoryFs("string")).toThrow()
    })
})
