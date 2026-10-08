/**
 * PyodideSession initialization lifecycle, exercised with a fake pyodide
 * runtime (the real interpreter lives in the .pi-smoke ground-truth tests).
 *
 * Covers the two lifecycle hazards of the workspace write-through mount:
 * 1. After dispose + re-init, the workspace mount must be re-created on the
 *    NEW interpreter (a stale mount map would leave write-through dead).
 * 2. A failed initialization must not poison the session — the next
 *    invocation retries loading the runtime.
 */
import type { WorkspaceFsNode, WorkspaceFsType } from "./pyodide-workspace-fs"
import { WORKSPACE_FS_ERRNO } from "./pyodide-workspace-fs"
import { describe, it, expect } from "vitest"
import { ObservableInMemoryFs } from "./observable-in-memory-fs"
import { PyodideSession } from "./pyodide-session"
import type { EmscriptenFS, PyodideAPI } from "./pyodide-session"

class FakeErrnoError extends Error {
    constructor(readonly errno: number) {
        super(`Errno ${errno}`)
    }
}

const DIR_MODE = 16895
const FILE_MODE = 33206

let nextNodeId = 1

/**
 * Minimal FS-core double: owns its own "/" tree (for paths outside mounts),
 * tracks our custom mounts and resolves paths the same way Emscripten does
 * (longest mounted prefix, node-tree walk). Only the operations the
 * lifecycle tests need are implemented.
 */
class FakePyodideFS implements EmscriptenFS {
    readonly mountedRoots = new Map<string, WorkspaceFsNode>()
    ErrnoError = FakeErrnoError
    private readonly ownRoot: WorkspaceFsNode

    constructor() {
        this.ownRoot = this.createNode(null, "", DIR_MODE, 0)
        this.ownRoot.contents = {}
    }

    createNode(parent: WorkspaceFsNode | null, name: string, mode: number, rdev: number): WorkspaceFsNode {
        if (parent && (parent.contents as Record<string, WorkspaceFsNode>)[name]) {
            throw new FakeErrnoError(WORKSPACE_FS_ERRNO.EEXIST)
        }
        return {
            id: nextNodeId++,
            name,
            mode,
            parent,
            atime: Date.now(),
            mtime: Date.now(),
            ctime: Date.now(),
            rdev,
            contents: null,
            usedBytes: 0,
            link: null,
            node_ops: null,
            stream_ops: null,
            hubPath: "",
            dirty: false,
        }
    }

    isDir(mode: number): boolean { return (mode & 0xf000) === 0x4000 }
    isFile(mode: number): boolean { return (mode & 0xf000) === 0x8000 }
    isLink(mode: number): boolean { return (mode & 0xf000) === 0xa000 }

    mkdir(path: string): void {
        const { parent, name, child } = this.resolveParent(path)
        if (child) throw new FakeErrnoError(WORKSPACE_FS_ERRNO.EEXIST)
        if (parent.node_ops?.mknod) {
            // Path lives inside one of our mounts — go through its node op
            // (which also mirrors the mkdir to the hub).
            parent.node_ops.mknod(parent, name, DIR_MODE, 0)
            return
        }
        const node = this.createNode(parent, name, DIR_MODE, 0)
        node.contents = {}
        ;(parent.contents as Record<string, WorkspaceFsNode>)[name] = node
    }

    mount(type: WorkspaceFsType, opts: { rootPath: string }, mountpoint: string): void {
        const root = type.mount({ opts })
        this.mountedRoots.set(mountpoint, root)
    }

    readFile(path: string, opts?: { encoding?: string }): string | Uint8Array {
        const node = this.resolve(path)
        const bytes = (node?.contents as Uint8Array | null) ?? null
        if (!bytes) throw new FakeErrnoError(WORKSPACE_FS_ERRNO.ENOENT)
        return opts?.encoding === "utf8" ? new TextDecoder().decode(bytes) : bytes
    }

    /** Longest-mount-prefix resolution; null when the path does not exist. */
    private resolve(path: string): WorkspaceFsNode | null {
        let bestPrefix = ""
        for (const mountPoint of this.mountedRoots.keys()) {
            if ((path === mountPoint || path.startsWith(`${mountPoint}/`)) && mountPoint.length > bestPrefix.length) {
                bestPrefix = mountPoint
            }
        }
        const [tree, relative] = bestPrefix
            ? [this.mountedRoots.get(bestPrefix)!, bestPrefix === "/" ? path : path.slice(bestPrefix.length)]
            : [this.ownRoot, path]
        let node = tree
        for (const segment of relative.split("/").filter(Boolean)) {
            const next = (node.contents as Record<string, WorkspaceFsNode>)[segment]
            if (!next) return null
            node = next
        }
        return node
    }

    private resolveParent(path: string): { parent: WorkspaceFsNode; name: string; child: WorkspaceFsNode | null } {
        const segments: string[] = []
        for (const segment of path.split("/")) {
            if (segment === "") continue
            if (segment === "..") { segments.pop(); continue }
            if (segment === ".") continue
            segments.push(segment)
        }
        const name = segments[segments.length - 1]
        const parent = this.resolve(`/${segments.slice(0, -1).join("/")}`) ?? this.ownRoot
        const child = (parent.contents as Record<string, WorkspaceFsNode>)[name] ?? null
        return { parent, name, child }
    }

    /** open(O_CREAT) + write + close — drives the node's stream ops. */
    writeFile(path: string, data: string | Uint8Array): void {
        const { parent, name, child } = this.resolveParent(path)
        const node = child ?? parent.node_ops!.mknod(parent, name, FILE_MODE, 0)
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data
        const stream = { node, position: 0, fd: 1, flags: 0 }
        node.stream_ops!.write(stream, bytes, 0, bytes.byteLength, null)
        stream.position += bytes.byteLength
        node.stream_ops!.close(stream)
    }
}

function makeFakeRuntime(fs: FakePyodideFS): PyodideAPI {
    return {
        version: "0.29.5-fake",
        FS: fs,
        runPython: (code: string) => (code.trim() === "dict()" ? { destroy() { /* fresh namespace */ } } : undefined),
        runPythonAsync: async (code: string) => {
            if (code === "epoch-1") fs.writeFile("/workspace/epoch1.txt", "one")
            if (code === "epoch-2") fs.writeFile("/workspace/epoch2.txt", "two")
            return undefined
        },
        loadPackagesFromImports: async () => undefined,
        loadPackage: async () => undefined,
        setStdout: () => undefined,
        setStderr: () => undefined,
        setStdin: () => undefined,
        globals: { get: () => undefined },
    }
}

function makeCtx(fs: ObservableInMemoryFs) {
    const envMap = new Map<string, string>()
    envMap.set("PATH", "/usr/local/bin:/usr/bin:/bin")
    return {
        cwd: "/workspace",
        env: envMap,
        fs,
        stdin: "",
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        stdout: { write: () => true },
        stderr: { write: () => true },
    } as unknown as Parameters<PyodideSession["executePython"]>[1]
}

class PyodideSessionWithRuntimeSequence extends PyodideSession {
    /** Runtime factories consulted in order; the last one repeats. */
    runtimeFactories: Array<() => Promise<PyodideAPI>> = []
    runtimeCalls = 0

    override async createRuntime(): Promise<PyodideAPI> {
        const index = Math.min(this.runtimeCalls, this.runtimeFactories.length - 1)
        this.runtimeCalls += 1
        const factory = this.runtimeFactories[index]
        if (!factory) throw new Error("no runtime factory configured")
        return factory()
    }
}

describe("PyodideSession lifecycle", () => {
    function makeEpochSession(hub: ObservableInMemoryFs): { session: PyodideSessionWithRuntimeSequence; epoch1: FakePyodideFS; epoch2: FakePyodideFS } {
        const epoch1 = new FakePyodideFS()
        const epoch2 = new FakePyodideFS()
        const session = new PyodideSessionWithRuntimeSequence(hub)
        session.runtimeFactories = [
            async () => makeFakeRuntime(epoch1),
            async () => makeFakeRuntime(epoch2),
        ]
        return { session, epoch1, epoch2 }
    }

    it("re-mounts the workspace write-through FS on a fresh interpreter after dispose", async () => {
        const hub = new ObservableInMemoryFs()
        const { session, epoch1, epoch2 } = makeEpochSession(hub)
        const ctx = makeCtx(hub)

        await session.executePython(["-c", "epoch-1"], makeCtx(hub))
        expect(await hub.readFile("/workspace/epoch1.txt", "utf8")).toBe("one")
        // First interpreter carries the write-through mount.
        expect(epoch1.mountedRoots.has("/workspace")).toBe(true)

        session.dispose()
        await session.executePython(["-c", "epoch-2"], ctx)

        // New interpreter must have its own write-through mount…
        expect(epoch2.mountedRoots.has("/workspace")).toBe(true)
        // …writes must reach the hub, and epoch-1 output survives.
        expect(await hub.readFile("/workspace/epoch2.txt", "utf8")).toBe("two")
        expect(await hub.exists("/workspace/epoch1.txt")).toBe(true)
    })

    it("does not poison the session when runtime loading fails once", async () => {
        const hub = new ObservableInMemoryFs()
        const session = new PyodideSessionWithRuntimeSequence(hub)
        const epoch2 = new FakePyodideFS()
        session.runtimeFactories = [
            async () => { throw new Error("CDN unreachable") },
            async () => makeFakeRuntime(epoch2),
        ]
        const ctx = makeCtx(hub)

        await expect(session.executePython(["-c", "epoch-2"], ctx)).rejects.toThrow("CDN unreachable")
        await session.executePython(["-c", "epoch-2"], ctx)
        expect(session.runtimeCalls).toBe(2)
        expect(await hub.readFile("/workspace/epoch2.txt", "utf8")).toBe("two")

        session.dispose()
    })
})