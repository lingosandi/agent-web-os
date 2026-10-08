/**
 * Characterization tests for the Python workspace FS (post-refactor):
 * a custom Emscripten filesystem type mounted at the workspace root with
 * real-time write-through into ObservableInMemoryFs.
 *
 * The mount's node_ops/stream_ops run against injected primitives (a tiny
 * fake of Emscripten's createNode/isDir/isFile/isLink/ErrnoError), so these
 * tests exercise the exact same op code paths as real pyodide — the
 * end-to-end contract with a real CPython/Emscripten is verified separately
 * in .pi-smoke/pyodide-write-through.test.ts.
 *
 * Behaviors carried over from the pre-refactor snapshot sync that MUST hold:
 * - Python sees hub files at run start (nested dirs, binary fidelity,
 *   lazy-file hydration, skip-with-warning for unreadable entries)
 * - Python writes survive the run, including mid-run crashes (partial
 *   outputs) — now via real-time write-through + end-of-run flush
 * - Hub-only files are never deleted by Python-side activity
 */
import { describe, it, expect, beforeEach } from "vitest"
import {
    createWorkspaceMount,
    WORKSPACE_FS_ERRNO,
    type WorkspaceFsNode,
    type WorkspaceFsPrimitives,
    type WorkspaceMount,
} from "./pyodide-workspace-fs"
import { ObservableInMemoryFs } from "./observable-in-memory-fs"

const DIR_MODE = 16895
const LINK_MODE = 40960

class FakeErrnoError extends Error {
    constructor(readonly errno: number) {
        super(`Errno ${errno}`)
    }
}

let nextNodeId = 1

/** Minimal Emscripten-shaped primitives: FSNode creation + mode tests. */
const primitives: WorkspaceFsPrimitives = {
    createNode(parent, name, mode) {
        // Mirror MEMFS createNode: refuse to shadow an existing entry.
        if (parent && (parent.contents as Record<string, WorkspaceFsNode>)[name]) {
            throw new FakeErrnoError(WORKSPACE_FS_ERRNO.EEXIST)
        }
        const node: WorkspaceFsNode = {
            id: nextNodeId++,
            name,
            mode,
            parent: parent ?? null,
            atime: Date.now(),
            mtime: Date.now(),
            ctime: Date.now(),
            rdev: 0,
            contents: null,
            usedBytes: 0,
            link: null,
            node_ops: null,
            stream_ops: null,
            hubPath: "",
            dirty: false,
        }
        return node
    },
    isDir: (mode) => (mode & 0xf000) === 0x4000,
    isFile: (mode) => (mode & 0xf000) === 0x8000,
    isLink: (mode) => (mode & 0xf000) === 0xa000,
    ErrnoError: FakeErrnoError,
}

/** Drive node/stream ops the way the Emscripten FS core does. */
class MountDriver {
    constructor(readonly mount: WorkspaceMount, readonly root: WorkspaceFsNode) {}

    child(parent: WorkspaceFsNode, name: string): WorkspaceFsNode {
        return (parent.contents as Record<string, WorkspaceFsNode>)[name]
    }

    lookup(parent: WorkspaceFsNode, name: string): WorkspaceFsNode {
        return parent.node_ops!.lookup(parent, name)
    }

    mknod(parent: WorkspaceFsNode, name: string, mode: number): WorkspaceFsNode {
        return parent.node_ops!.mknod(parent, name, mode, 0)
    }

    readdir(node: WorkspaceFsNode): string[] {
        return node.node_ops!.readdir(node)
    }

    getattr(node: WorkspaceFsNode): Record<string, unknown> {
        return node.node_ops!.getattr(node)
    }

    unlink(parent: WorkspaceFsNode, name: string): void {
        parent.node_ops!.unlink(parent, name)
    }

    rmdir(parent: WorkspaceFsNode, name: string): void {
        parent.node_ops!.rmdir(parent, name)
    }

    rename(oldNode: WorkspaceFsNode, newDir: WorkspaceFsNode, newName: string): void {
        oldNode.parent!.node_ops!.rename(oldNode, newDir, newName)
    }

    setattr(node: WorkspaceFsNode, attr: Record<string, unknown>): void {
        node.node_ops!.setattr(node, attr)
    }

    /** open(O_CREAT) + write + close, the way FS.writeFile drives streams.
     *  An existing node is opened (lookup) — FS core only mknods on ENOENT. */
    writeFile(parent: WorkspaceFsNode, name: string, data: Uint8Array): void {
        let fileNode: WorkspaceFsNode | null = null
        try {
            fileNode = this.lookup(parent, name)
        } catch {
            // ENOENT — create it
        }
        if (!fileNode) fileNode = this.mknod(parent, name, 0x81b4)
        const stream = { node: fileNode, position: 0, fd: 1, flags: 0 }
        fileNode.stream_ops!.write(stream, data, 0, data.byteLength, null)
        stream.position += data.byteLength
        fileNode.stream_ops!.close(stream)
    }

    readAll(fileNode: WorkspaceFsNode): Uint8Array {
        const stream = { node: fileNode, position: 0, fd: 1, flags: 0 }
        const buffer = new Uint8Array(fileNode.usedBytes)
        let total = 0
        while (total < buffer.length) {
            const read = fileNode.stream_ops!.read(stream, buffer, total, buffer.length - total, null)
            if (read === 0) break
            stream.position += read
            total += read
        }
        return buffer.subarray(0, total)
    }
}

function makeMount(): { hub: ObservableInMemoryFs; driver: MountDriver } {
    const hub = new ObservableInMemoryFs()
    const mount = createWorkspaceMount(hub, primitives, "/workspace")
    const root = mount.filesystemType.mount({ opts: { rootPath: "/workspace" } })
    return { hub, driver: new MountDriver(mount, root) }
}

async function makePreparedMount(): Promise<{ hub: ObservableInMemoryFs; driver: MountDriver; mount: WorkspaceMount }> {
    const made = makeMount()
    made.hub.mkdirSync("/workspace", { recursive: true })
    const warnings: string[] = []
    await made.driver.mount.rebuildSkeleton(warnings)
    return { hub: made.hub, driver: made.driver, mount: made.driver.mount }
}

describe("characterization: Python workspace write-through mount", () => {
    let hub: ObservableInMemoryFs
    let driver: MountDriver
    let mount: WorkspaceMount

    beforeEach(async () => {
        const prepared = await makePreparedMount()
        hub = prepared.hub
        driver = prepared.driver
        mount = driver.mount
    })

    async function flush(): Promise<string[]> {
        const warnings: string[] = []
        await mount.flush(warnings)
        return warnings
    }

    // ---- Python sees the hub at run start (replaces forward sync) ----

    it("rebuildSkeleton exposes hub files to Python", async () => {
        hub.mkdirSync("/workspace", { recursive: true })
        await hub.writeFile("/workspace/hello.py", "print('hi')")
        const warnings: string[] = []

        await mount.rebuildSkeleton(warnings)

        expect(warnings).toEqual([])
        const fileNode = driver.lookup(driver.root, "hello.py")
        expect(driver.readAll(fileNode)).toEqual(new TextEncoder().encode("print('hi')"))
    })

    it("rebuildSkeleton creates nested directories", async () => {
        hub.mkdirSync("/workspace/pkg/sub", { recursive: true })
        await hub.writeFile("/workspace/pkg/sub/deep.txt", "deep")

        await mount.rebuildSkeleton([])

        const pkg = driver.lookup(driver.root, "pkg")
        const sub = driver.lookup(pkg, "sub")
        expect(primitives.isDir(pkg.mode)).toBe(true)
        expect(primitives.isDir(sub.mode)).toBe(true)
        expect(driver.readAll(driver.lookup(sub, "deep.txt"))).toEqual(new TextEncoder().encode("deep"))
    })

    it("rebuildSkeleton preserves binary content byte-for-byte", async () => {
        hub.mkdirSync("/workspace", { recursive: true })
        const bytes = new Uint8Array([0, 1, 254, 255, 0, 8, 127])
        await hub.writeFile("/workspace/blob.bin", bytes)

        await mount.rebuildSkeleton([])

        expect(Array.from(driver.readAll(driver.lookup(driver.root, "blob.bin")))).toEqual(Array.from(bytes))
    })

    it("rebuildSkeleton eagerly hydrates lazy files", async () => {
        hub.mkdirSync("/workspace", { recursive: true })
        hub.writeFileLazy("/workspace/lazy.txt", () => "lazy-content")
        expect(hub.isPathLazy("/workspace/lazy.txt")).toBe(true)

        await mount.rebuildSkeleton([])

        expect(hub.isPathLazy("/workspace/lazy.txt")).toBe(false)
        expect(driver.readAll(driver.lookup(driver.root, "lazy.txt"))).toEqual(new TextEncoder().encode("lazy-content"))
    })

    it("rebuildSkeleton re-creates the node when the hub turned a file into a directory", async () => {
        hub.mkdirSync("/workspace", { recursive: true })
        await hub.writeFile("/workspace/thing.bin", "old-bytes")

        await mount.rebuildSkeleton([])

        // Hub-side file→dir conversion (e.g. the shell ran `mkdir thing.bin`).
        await hub.rm("/workspace/thing.bin", { force: true })
        await hub.mkdir("/workspace/thing.bin", { recursive: true })
        await hub.writeFile("/workspace/thing.bin/inner.txt", "now-a-dir")

        const warnings: string[] = []
        await mount.rebuildSkeleton(warnings)
        expect(warnings).toEqual([])

        const dirNode = driver.lookup(driver.root, "thing.bin")
        expect(primitives.isDir(dirNode.mode)).toBe(true)
        expect(driver.readAll(driver.lookup(dirNode, "inner.txt"))).toEqual(new TextEncoder().encode("now-a-dir"))
    })

    it("rebuildSkeleton skips unreadable entries with a warning", async () => {
        hub.mkdirSync("/workspace", { recursive: true })
        hub.writeFileLazy("/workspace/broken.txt", () => { throw new Error("hydration exploded") })
        await hub.writeFile("/workspace/good.txt", "fine")
        const warnings: string[] = []

        await mount.rebuildSkeleton(warnings)

        expect(warnings.length).toBe(1)
        expect(warnings[0]).toContain("skipped '/workspace/broken.txt'")
        expect(warnings[0]).toContain("hydration exploded")
        expect(driver.readAll(driver.lookup(driver.root, "good.txt"))).toEqual(new TextEncoder().encode("fine"))
    })

    it("rebuildSkeleton on a missing hub dir is a no-op without warnings", async () => {
        const warnings: string[] = []
        await mount.rebuildSkeleton(warnings)
        expect(warnings).toEqual([])
        expect(driver.readdir(driver.root)).toEqual([".", ".."])
    })

    it("rebuildSkeleton drops nodes for hub paths that disappeared", async () => {
        hub.mkdirSync("/workspace", { recursive: true })
        await hub.writeFile("/workspace/f.txt", "1")
        await mount.rebuildSkeleton([])
        await hub.rm("/workspace/f.txt")
        await mount.rebuildSkeleton([])

        expect(() => driver.lookup(driver.root, "f.txt")).toThrowError(FakeErrnoError)
    })

    // ---- Python writes hit the hub in real time (replaces back sync) ----

    it("python file write is written through to the hub on close", async () => {
        driver.writeFile(driver.root, "out.txt", new TextEncoder().encode("from-python"))
        await flush()

        expect(await hub.readFile("/workspace/out.txt", "utf8")).toBe("from-python")
    })

    it("python binary write survives the round-trip byte-for-byte", async () => {
        const bytes = new Uint8Array([200, 100, 50, 25, 0, 255])
        driver.writeFile(driver.root, "model.bin", bytes)
        await flush()

        expect(Array.from(await hub.readFileBuffer("/workspace/model.bin"))).toEqual(Array.from(bytes))
    })

    it("python write in a newly-created nested dir reaches the hub", async () => {
        const gen = driver.mknod(driver.root, "gen", DIR_MODE)
        const deeper = driver.mknod(gen, "deeper", DIR_MODE)
        driver.writeFile(deeper, "result.json", new TextEncoder().encode('{"ok":true}'))
        await flush()

        expect(await hub.readFile("/workspace/gen/deeper/result.json", "utf8")).toBe('{"ok":true}')
    })

    it("python write overwrites the hub's pre-existing version", async () => {
        await hub.writeFile("/workspace/data.txt", "before-run")
        await mount.rebuildSkeleton([])

        driver.writeFile(driver.root, "data.txt", new TextEncoder().encode("python-rewrote-it"))
        await flush()

        expect(await hub.readFile("/workspace/data.txt", "utf8")).toBe("python-rewrote-it")
    })

    it("files Python never wrote stay intact (no hub-only deletions)", async () => {
        await hub.writeFile("/workspace/shell-side.txt", "from-shell")
        await mount.rebuildSkeleton([])
        driver.writeFile(driver.root, "py-side.txt", new TextEncoder().encode("from-python"))
        await flush()

        expect(await hub.readFile("/workspace/shell-side.txt", "utf8")).toBe("from-shell")
        expect(await hub.readFile("/workspace/py-side.txt", "utf8")).toBe("from-python")
    })

    it("partial writes survive a python crash (flush runs on the error path)", async () => {
        // Simulate: python writes a file, then crashes before closing the
        // stream — the node stays dirty and only the end-of-run flush runs.
        const fileNode = driver.mknod(driver.root, "partial.txt", 0x81b4)
        const stream = { node: fileNode, position: 0, fd: 1, flags: 0 }
        const partialBytes = new TextEncoder().encode("partial-data")
        fileNode.stream_ops!.write(stream, partialBytes, 0, partialBytes.byteLength, null)
        // no close() — as if the interpreter died with the file open

        await flush()

        expect(await hub.readFile("/workspace/partial.txt", "utf8")).toBe("partial-data")
    })

    it("truncation (O_TRUNC / os.truncate) reaches the hub", async () => {
        await hub.writeFile("/workspace/data.txt", "original-long-content")
        await mount.rebuildSkeleton([])
        const fileNode = driver.lookup(driver.root, "data.txt")

        driver.setattr(fileNode, { size: 0 })
        await flush()

        expect(await hub.readFileBuffer("/workspace/data.txt")).toEqual(new Uint8Array(0))
    })

    it("append-style writes at a non-zero position fill the gap with zeros", async () => {
        const fileNode = driver.mknod(driver.root, "sparse.txt", 0x81b4)
        const stream = { node: fileNode, position: 0, fd: 1, flags: 0 }
        fileNode.stream_ops!.write(stream, new TextEncoder().encode("tail"), 0, 4, 100)
        await flush()

        const content = await hub.readFileBuffer("/workspace/sparse.txt")
        expect(content.byteLength).toBe(104)
        expect(Array.from(content.slice(0, 100))).toEqual(new Array(100).fill(0))
        expect(new TextDecoder().decode(content.slice(100))).toBe("tail")
    })

    // ---- metadata mutations ----

    it("python unlink removes the hub file", async () => {
        await hub.writeFile("/workspace/gone.txt", "x")
        await mount.rebuildSkeleton([])

        driver.unlink(driver.root, "gone.txt")
        await flush()

        expect(await hub.exists("/workspace/gone.txt")).toBe(false)
    })

    it("python rmdir removes the hub directory", async () => {
        hub.mkdirSync("/workspace/emptydir", { recursive: true })
        await mount.rebuildSkeleton([])

        driver.rmdir(driver.root, "emptydir")
        await flush()

        expect(await hub.exists("/workspace/emptydir")).toBe(false)
    })

    it("python rmdir of a non-empty directory fails with ENOTEMPTY", async () => {
        hub.mkdirSync("/workspace/full", { recursive: true })
        await hub.writeFile("/workspace/full/f.txt", "x")

        await mount.rebuildSkeleton([])

        expect(() => driver.rmdir(driver.root, "full")).toThrowError(FakeErrnoError)
        try {
            driver.rmdir(driver.root, "full")
        } catch (error) {
            expect((error as FakeErrnoError).errno).toBe(WORKSPACE_FS_ERRNO.ENOTEMPTY)
        }
    })

    it("python rename moves the hub file and overwrites the target", async () => {
        await hub.writeFile("/workspace/a.txt", "a-content")
        await hub.writeFile("/workspace/b.txt", "b-old")
        await mount.rebuildSkeleton([])
        const aNode = driver.lookup(driver.root, "a.txt")

        driver.rename(aNode, driver.root, "b.txt")
        await flush()

        expect(await hub.exists("/workspace/a.txt")).toBe(false)
        expect(await hub.readFile("/workspace/b.txt", "utf8")).toBe("a-content")
    })

    it("python rename of a dirty (never-pushed) file publishes under the new path only", async () => {
        const fileNode = driver.mknod(driver.root, "created.txt", 0x81b4)
        const stream = { node: fileNode, position: 0, fd: 1, flags: 0 }
        fileNode.stream_ops!.write(stream, new TextEncoder().encode("moved-content"), 0, 13, null)

        driver.rename(fileNode, driver.root, "final.txt")
        await flush()

        expect(await hub.exists("/workspace/created.txt")).toBe(false)
        expect(await hub.readFile("/workspace/final.txt", "utf8")).toBe("moved-content")
    })

    it("python-created directory reaches the hub even without a flush-triggering write", async () => {
        driver.mknod(driver.root, "made-by-python", DIR_MODE)
        await flush()

        expect(await hub.exists("/workspace/made-by-python")).toBe(true)
    })

    it("python unlink of a never-pushed file does not error in the hub", async () => {
        const fileNode = driver.mknod(driver.root, "ghost.txt", 0x81b4)
        driver.unlink(driver.root, "ghost.txt")
        const warnings = await flush()

        expect(warnings).toEqual([])
        expect(await hub.exists("/workspace/ghost.txt")).toBe(false)
    })

    // ---- stat consistency ----

    it("getattr reports current size after write-through mutations", () => {
        const fileNode = driver.mknod(driver.root, "stat.txt", 0x81b4)
        driver.setattr(fileNode, { size: 42 })
        expect(driver.getattr(fileNode).size).toBe(42)
    })

    it("lookup of a missing file raises Emscripten ENOENT (errno 44)", () => {
        try {
            driver.lookup(driver.root, "nope.txt")
            expect.unreachable()
        } catch (error) {
            expect((error as FakeErrnoError).errno).toBe(WORKSPACE_FS_ERRNO.ENOENT)
        }
    })

    // ---- symlinks ----

    it("python symlink lands in the hub and readlink resolves", async () => {
        driver.root.node_ops!.symlink(driver.root, "link.txt", "/workspace/target.txt")
        await flush()

        expect(await hub.readlink("/workspace/link.txt")).toBe("/workspace/target.txt")
        const linkNode = driver.lookup(driver.root, "link.txt")
        expect(primitives.isLink(linkNode.mode)).toBe(true)
        expect(linkNode.node_ops!.readlink(linkNode)).toBe("/workspace/target.txt")
    })

    // ---- round-trip ----

    it("hub → python → hub round-trip preserves content and structure", async () => {
        hub.mkdirSync("/workspace/a/b", { recursive: true })
        await hub.writeFile("/workspace/a/b/x.txt", "x")
        await hub.writeFile("/workspace/a/y.bin", new Uint8Array([9, 8, 7]))
        await mount.rebuildSkeleton([])

        driver.writeFile(driver.lookup(driver.lookup(driver.root, "a"), "b"), "z.txt", new TextEncoder().encode("z"))
        await flush()

        expect(await hub.readFile("/workspace/a/b/x.txt", "utf8")).toBe("x")
        expect(Array.from(await hub.readFileBuffer("/workspace/a/y.bin"))).toEqual([9, 8, 7])
        expect(await hub.readFile("/workspace/a/b/z.txt", "utf8")).toBe("z")
    })
})