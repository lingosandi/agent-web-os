/**
 * Characterization tests for the FS mirror / hydration behaviors that the
 * planned unification refactor (VirtualFS sync adapter + Pyodide write-through
 * mount) must preserve. Written against the CURRENT implementation so they can
 * be re-run unchanged after the refactor.
 *
 * Mirror operations are tracked via session.trackOperation, so
 * flushPendingOperations() is the deterministic completion seam — no timer
 * waits are needed anywhere in this file.
 */
import type { CommandContext } from "just-bash/browser"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { AlmostNodeSession } from "./almostnode-session"
import { ObservableInMemoryFs } from "./observable-in-memory-fs"

function makeCtx(targetFs: ObservableInMemoryFs, cwd = "/workspace"): CommandContext {
    const envMap = new Map<string, string>()
    envMap.set("PATH", "/usr/local/bin:/usr/bin:/bin")
    return {
        cwd,
        env: envMap,
        fs: targetFs,
        stdin: "",
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        stdout: { write: () => true },
        stderr: { write: () => true },
    } as unknown as CommandContext
}

describe("characterization: bidirectional FS mirror", () => {
    let fs: ObservableInMemoryFs
    let session: AlmostNodeSession

    beforeEach(async () => {
        fs = new ObservableInMemoryFs()
        session = new AlmostNodeSession(fs)
        // A trivial npm command is the public seam that both initializes the
        // session (activating the observable→virtual subscription) and drains
        // all pending mirror operations — same guarantee production code
        // relies on before every node/npm execution.
        await session.executeNpm(["-v"], makeCtx(fs))
    })

    afterEach(() => {
        session.dispose()
    })

    /** Drain every tracked mirror operation in both directions. */
    function settle(): Promise<unknown> {
        return session.executeNpm(["-v"], makeCtx(fs))
    }

    // ---- VFS → Observable direction ----

    it("write through VFS appears in observable FS with same bytes", async () => {
        session.vfs.mkdirSync("/m1", { recursive: true })
        session.vfs.writeFileSync("/m1/f.txt", "hello-bytes")
        await settle()

        expect(await fs.exists("/m1/f.txt")).toBe(true)
        expect(await fs.readFile("/m1/f.txt", "utf8")).toBe("hello-bytes")
    })

    it("unlink through VFS removes file from observable FS", async () => {
        fs.mkdirSync("/m2", { recursive: true })
        await fs.writeFile("/m2/gone.txt", "x")
        await settle()
        expect(session.vfs.existsSync("/m2/gone.txt")).toBe(true)

        session.vfs.unlinkSync("/m2/gone.txt")
        await settle()

        expect(await fs.exists("/m2/gone.txt")).toBe(false)
    })

    it("rename through VFS propagates to observable FS", async () => {
        session.vfs.mkdirSync("/m3", { recursive: true })
        session.vfs.writeFileSync("/m3/old.txt", "renamed-content")
        await settle()
        expect(await fs.exists("/m3/old.txt")).toBe(true)

        session.vfs.renameSync("/m3/old.txt", "/m3/new.txt")
        await settle()

        expect(await fs.exists("/m3/old.txt")).toBe(false)
        expect(await fs.exists("/m3/new.txt")).toBe(true)
        expect(await fs.readFile("/m3/new.txt", "utf8")).toBe("renamed-content")
    })

    it("rmdir through VFS removes directory from observable FS", async () => {
        session.vfs.mkdirSync("/m4/sub", { recursive: true })
        session.vfs.writeFileSync("/m4/sub/f.txt", "x")
        await settle()
        expect(await fs.exists("/m4/sub")).toBe(true)

        session.vfs.unlinkSync("/m4/sub/f.txt")
        session.vfs.rmdirSync("/m4/sub")
        await settle()

        expect(await fs.exists("/m4/sub")).toBe(false)
    })

    it("binary (Uint8Array) writes survive the mirror round-trip", async () => {
        const bytes = new Uint8Array([0, 1, 255, 128, 7])
        session.vfs.mkdirSync("/m5", { recursive: true })
        session.vfs.writeFileSync("/m5/bin.dat", bytes)
        await settle()

        const back = await fs.readFileBuffer("/m5/bin.dat")
        expect(Array.from(back)).toEqual(Array.from(bytes))
    })

    // ---- Observable → VFS direction ----

    it("write through observable FS appears in VFS", async () => {
        fs.mkdirSync("/m6", { recursive: true })
        await fs.writeFile("/m6/from-obs.txt", "obs-content")
        await settle()

        expect(session.vfs.existsSync("/m6/from-obs.txt")).toBe(true)
        expect(session.vfs.readFileSync("/m6/from-obs.txt", "utf8")).toBe("obs-content")
    })

    it("append through observable FS is visible in VFS", async () => {
        fs.mkdirSync("/m7", { recursive: true })
        await fs.writeFile("/m7/log.txt", "line1\n")
        await settle()
        await fs.appendFile("/m7/log.txt", "line2\n")
        await settle()

        expect(session.vfs.readFileSync("/m7/log.txt", "utf8")).toBe("line1\nline2\n")
    })

    it("delete through observable FS removes from VFS", async () => {
        fs.mkdirSync("/m8", { recursive: true })
        await fs.writeFile("/m8/del.txt", "x")
        await settle()
        expect(session.vfs.existsSync("/m8/del.txt")).toBe(true)

        await fs.rm("/m8/del.txt")
        await settle()

        expect(session.vfs.existsSync("/m8/del.txt")).toBe(false)
    })

    it("rename through observable FS propagates to VFS", async () => {
        fs.mkdirSync("/m9", { recursive: true })
        await fs.writeFile("/m9/a.txt", "a-content")
        await settle()
        await fs.mv("/m9/a.txt", "/m9/b.txt")
        await settle()

        expect(session.vfs.existsSync("/m9/a.txt")).toBe(false)
        expect(session.vfs.readFileSync("/m9/b.txt", "utf8")).toBe("a-content")
    })

    // ---- Echo suppression (no infinite loops, no duplication) ----

    it("VFS write does not echo back and duplicate via observable events", async () => {
        session.vfs.mkdirSync("/m10", { recursive: true })
        session.vfs.writeFileSync("/m10/echo.txt", "once")
        await settle()

        // Content must be exactly the written value — not duplicated or
        // corrupted by a mirror→subscribe→mirror loop.
        expect(session.vfs.readFileSync("/m10/echo.txt", "utf8")).toBe("once")
        expect(await fs.readFile("/m10/echo.txt", "utf8")).toBe("once")
    })

    it("observable write does not echo back and duplicate via VFS mirror", async () => {
        fs.mkdirSync("/m11", { recursive: true })
        await fs.writeFile("/m11/echo.txt", "once-obs")
        await settle()
        await settle()

        expect(await fs.readFile("/m11/echo.txt", "utf8")).toBe("once-obs")
        expect(session.vfs.readFileSync("/m11/echo.txt", "utf8")).toBe("once-obs")
    })

    // ---- Internal path exclusion ----

    it("internal /.almostnode writes are not mirrored to observable FS", async () => {
        session.vfs.writeFileSync("/.almostnode/cache.txt", "internal")
        await settle()

        expect(await fs.exists("/.almostnode/cache.txt")).toBe(false)
        expect(session.vfs.existsSync("/.almostnode/cache.txt")).toBe(true)
    })

    it("reading a lazy file hydrates it in the observable FS but does NOT push it into VFS", async () => {
        fs.mkdirSync("/m12", { recursive: true })
        fs.writeFileLazy("/m12/lazy.txt", () => "lazy-content")
        await settle()
        expect(fs.isPathLazy("/m12/lazy.txt")).toBe(true)

        // Read through observable FS hydrates the content and clears the lazy
        // marker — CURRENT behavior: no change event fires on read, so the
        // VFS mirror is not updated by this path.
        const content = await fs.readFile("/m12/lazy.txt", "utf8")
        expect(content).toBe("lazy-content")
        await settle()

        expect(fs.isPathLazy("/m12/lazy.txt")).toBe(false)
        expect(session.vfs.existsSync("/m12/lazy.txt")).toBe(false)
        // Hub content intact either way
        expect(await fs.readFile("/m12/lazy.txt", "utf8")).toBe("lazy-content")
    })

    it("writing to a lazy path clears laziness and propagates new content to VFS", async () => {
        fs.mkdirSync("/m13", { recursive: true })
        fs.writeFileLazy("/m13/lazy.txt", () => "original")
        await settle()

        await fs.writeFile("/m13/lazy.txt", "replaced")
        await settle()

        expect(fs.isPathLazy("/m13/lazy.txt")).toBe(false)
        expect(session.vfs.readFileSync("/m13/lazy.txt", "utf8")).toBe("replaced")
    })

    // ---- flushPendingOperations contract ----

    it("flushPendingOperations awaits all outstanding mirror writes", async () => {
        session.vfs.mkdirSync("/m14", { recursive: true })
        for (let i = 0; i < 20; i++) {
            session.vfs.writeFileSync(`/m14/f${i}.txt`, `content-${i}`)
        }
        await settle()

        for (let i = 0; i < 20; i++) {
            expect(await fs.readFile(`/m14/f${i}.txt`, "utf8")).toBe(`content-${i}`)
        }
    })

    // ---- dispose contract ----

    it("dispose stops the observable→VFS subscription", async () => {
        fs.mkdirSync("/m15", { recursive: true })
        await fs.writeFile("/m15/before.txt", "before")
        await settle()
        expect(session.vfs.existsSync("/m15/before.txt")).toBe(true)

        session.dispose()
        await fs.writeFile("/m15/after.txt", "after")
        await settle()

        expect(session.vfs.existsSync("/m15/after.txt")).toBe(false)
    })
})