/**
 * Characterization tests for the Node VFS→Observable sync-adapter refactor.
 *
 * Block A ("invariants") captures behaviors that MUST hold before AND after
 * the refactor: eventual mirror visibility, echo suppression, internal-path
 * exclusion, and event visibility for third-party hub subscribers.
 *
 * Block B ("ordered + synchronous mirroring") captures the NEW guarantees the
 * adapter introduces — these characterize the race bugs being fixed
 * (fire-and-forget mirror ops can interleave wrongly) and synchronous hub
 * visibility for writes. They are expected to FAIL on the pre-refactor
 * implementation and pass after it.
 *
 * `settle()` (a trivial npm run) drains every tracked/queued mirror
 * operation deterministically — no timer waits.
 */
import type { CommandContext } from "just-bash/browser"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { AlmostNodeSession } from "./almostnode-session"
import { ObservableInMemoryFs, type ObservableInMemoryFsChangeEvent } from "./observable-in-memory-fs"

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

describe("node sync adapter: mirror invariants (before AND after refactor)", () => {
    let fs: ObservableInMemoryFs
    let session: AlmostNodeSession

    beforeEach(async () => {
        fs = new ObservableInMemoryFs()
        session = new AlmostNodeSession(fs)
        await session.executeNpm(["-v"], makeCtx(fs))
    })

    afterEach(() => {
        session.dispose()
    })

    function settle(): Promise<unknown> {
        return session.executeNpm(["-v"], makeCtx(fs))
    }

    it("write through VFS eventually lands in the observable FS (deep path, binary bytes)", async () => {
        session.vfs.writeFileSync("/deep/nested/bin.dat", new Uint8Array([0, 1, 254, 255]))
        await settle()

        expect(Array.from(await fs.readFileBuffer("/deep/nested/bin.dat"))).toEqual([0, 1, 254, 255])
    })

    it("mkdir through VFS eventually lands in the observable FS", async () => {
        session.vfs.mkdirSync("/made/dir", { recursive: true })
        await settle()

        expect((await fs.stat("/made/dir")).isDirectory).toBe(true)
    })

    it("unlink/rmdir through VFS eventually lands in the observable FS", async () => {
        session.vfs.mkdirSync("/gone", { recursive: true })
        session.vfs.writeFileSync("/gone/f.txt", "x")
        session.vfs.writeFileSync("/top.txt", "y")
        await settle()

        session.vfs.unlinkSync("/gone/f.txt")
        session.vfs.rmdirSync("/gone")
        session.vfs.unlinkSync("/top.txt")
        await settle()

        expect(await fs.exists("/gone/f.txt")).toBe(false)
        expect(await fs.exists("/gone")).toBe(false)
        expect(await fs.exists("/top.txt")).toBe(false)
    })

    it("rename through VFS eventually lands in the observable FS (both directions removed/added)", async () => {
        session.vfs.writeFileSync("/orig.txt", "content")
        session.vfs.mkdirSync("/dest-dir", { recursive: true })
        await settle()

        session.vfs.renameSync("/orig.txt", "/dest-dir/moved.txt")
        await settle()

        expect(await fs.exists("/orig.txt")).toBe(false)
        expect(await fs.readFile("/dest-dir/moved.txt", "utf8")).toBe("content")
    })

    it("VFS write does not echo back through the observable subscription", async () => {
        session.vfs.writeFileSync("/echo.txt", "stable")
        await settle()
        session.vfs.writeFileSync("/echo.txt", "stable-2")
        await settle()

        expect(session.vfs.readFileSync("/echo.txt", "utf8")).toBe("stable-2")
        expect(await fs.readFile("/echo.txt", "utf8")).toBe("stable-2")
    })

    it("internal /.almostnode paths are never mirrored to the observable FS", async () => {
        session.vfs.mkdirSync("/.almostnode", { recursive: true })
        session.vfs.writeFileSync("/.almostnode/internal.txt", "secret")
        session.vfs.mkdirSync("/.almostnode/cache", { recursive: true })
        await settle()

        expect(await fs.exists("/.almostnode/internal.txt")).toBe(false)
        expect(await fs.exists("/.almostnode/cache")).toBe(false)
    })

    it("third-party hub subscribers still receive change events for node writes", async () => {
        const events: ObservableInMemoryFsChangeEvent[] = []
        fs.subscribe((event) => { events.push(event) })

        session.vfs.writeFileSync("/visible.txt", "v1")
        await settle()
        await fs.settleChangeEmissions()
        const writeEvents = events.filter((event) => event.path === "/visible.txt")
        expect(writeEvents.length).toBeGreaterThan(0)
    })
})

describe("node sync adapter: synchronous, ordered mirroring (post-refactor behavior)", () => {
    let fs: ObservableInMemoryFs
    let session: AlmostNodeSession

    beforeEach(async () => {
        fs = new ObservableInMemoryFs()
        session = new AlmostNodeSession(fs)
        await session.executeNpm(["-v"], makeCtx(fs))
    })

    afterEach(() => {
        session.dispose()
    })

    function settle(): Promise<unknown> {
        return session.executeNpm(["-v"], makeCtx(fs))
    }

    it("writeFileSync is visible in the observable FS WITHOUT settling", async () => {
        session.vfs.writeFileSync("/immediate.txt", "now")

        expect(await fs.readFile("/immediate.txt", "utf8")).toBe("now")
    })

    it("writeFileSync creates missing parent directories in the observable FS synchronously", async () => {
        session.vfs.writeFileSync("/a/b/c.txt", "deep")

        expect(await fs.readFile("/a/b/c.txt", "utf8")).toBe("deep")
    })

    it("mkdirSync is visible in the observable FS WITHOUT settling", async () => {
        session.vfs.mkdirSync("/instant-dir", { recursive: true })

        expect((await fs.stat("/instant-dir")).isDirectory).toBe(true)
    })

    it("rename followed by unlink of the new name leaves nothing behind", async () => {
        session.vfs.writeFileSync("/victim.txt", "x")
        await settle()

        session.vfs.renameSync("/victim.txt", "/victim-renamed.txt")
        session.vfs.unlinkSync("/victim-renamed.txt")
        await settle()

        expect(await fs.exists("/victim.txt")).toBe(false)
        expect(await fs.exists("/victim-renamed.txt")).toBe(false)
    })

    it("rename followed by write to the new name keeps the new content", async () => {
        session.vfs.writeFileSync("/old.txt", "old-content")
        await settle()

        session.vfs.renameSync("/old.txt", "/new.txt")
        session.vfs.writeFileSync("/new.txt", "new-content")
        await settle()

        expect(await fs.readFile("/new.txt", "utf8")).toBe("new-content")
        expect(await fs.exists("/old.txt")).toBe(false)
    })

    it("write followed by unlink does not resurrect the file", async () => {
        session.vfs.mkdirSync("/resurrect", { recursive: true })
        await settle()

        session.vfs.writeFileSync("/resurrect/f.txt", "doomed")
        session.vfs.unlinkSync("/resurrect/f.txt")
        await settle()

        expect(await fs.exists("/resurrect/f.txt")).toBe(false)
    })

    it("unlink followed by write keeps the written file", async () => {
        session.vfs.writeFileSync("/flip.txt", "v1")
        await settle()

        session.vfs.unlinkSync("/flip.txt")
        session.vfs.writeFileSync("/flip.txt", "v2")
        await settle()

        expect(await fs.readFile("/flip.txt", "utf8")).toBe("v2")
    })

    it("sync write does not echo back through the observable subscription", async () => {
        session.vfs.writeFileSync("/sync-echo.txt", "first")
        session.vfs.writeFileSync("/sync-echo.txt", "second")
        await settle()

        expect(session.vfs.readFileSync("/sync-echo.txt", "utf8")).toBe("second")
        expect(await fs.readFile("/sync-echo.txt", "utf8")).toBe("second")
    })
    it("write followed by unlink is fully drained by settle()", async () => {
        session.vfs.writeFileSync("/chain.txt", "x")
        session.vfs.unlinkSync("/chain.txt")
        await settle()

        expect(await fs.exists("/chain.txt")).toBe(false)
    })
})