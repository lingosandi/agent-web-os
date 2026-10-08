/**
 * Custom Emscripten filesystem type that mounts the workspace root of an
 * ObservableInMemoryFs into Pyodide with REAL-TIME WRITE-THROUGH.
 *
 * Design (verified against pyodide 0.29.5's FS implementation):
 * - The mount's node tree mirrors the hub subtree. Content lives in the node
 *   tree while Python runs; every mutation is forwarded to the hub:
 *   file/dir creation (sync), content pushes on stream close (sync), and
 *   deletion/rename/chmod/utime as tracked fire-and-forget hub operations.
 * - Before each run the skeleton is rebuilt from the hub (source of truth),
 *   which also eagerly hydrates lazy files — sync syscalls cannot await.
 * - After each run (success or error) `flush()` pushes dirty content and
 *   drains the tracked hub operations, so partial outputs always survive
 *   crashes, without a post-run back-scan of the whole tree.
 *
 * Emscripten contract implemented here (all call shapes extracted from
 * pyodide.asm.js):
 * - node_ops: getattr, setattr, lookup, mknod, rename, unlink, rmdir,
 *   readdir, symlink, readlink. ENOENT must be errno 44 (this build's
 *   ERRNO_CODES mapping, not libc values).
 * - stream_ops: open, close, read, write, llseek. Core FS updates
 *   stream.position when our ops return, and calls FS.truncate(node, 0)
 *   (→ setattr {size:0}) for O_TRUNC.
 * - FS core handles path resolution, fd tables, permissions and mount
 *   traversal; node tree bookkeeping (parent.contents maps) is ours.
 *
 * The Emscripten primitives are injected so the ops are unit-testable without
 * a real pyodide: tests pass a tiny fake `createNode`/`isDir`/`isFile`/
 * `ErrnoError` and run the exact same op code paths.
 */
import type { ObservableInMemoryFs } from "./observable-in-memory-fs"

/** Errno values as Emscripten's ERRNO_CODES expects them (NOT libc numbers). */
export const WORKSPACE_FS_ERRNO = {
    ENOENT: 44,
    EPERM: 63,
    EEXIST: 20,
    ENOTDIR: 54,
    EISDIR: 31,
    EINVAL: 28,
    EXDEV: 75,
    ENOTEMPTY: 55,
} as const

const DIR_MODE = 16895 // 0o40777 — what MEMFS mounts use for roots
const FILE_MODE = 33206 // 0o100644 — ordinary file

export interface WorkspaceFsNode {
    id: number
    name: string
    mode: number
    parent: WorkspaceFsNode | null
    atime: number
    mtime: number
    ctime: number
    rdev: number
    /** dir: child map; file: content buffer (length === usedBytes); link: null */
    contents: Record<string, WorkspaceFsNode> | Uint8Array | null
    usedBytes: number
    link: string | null
    node_ops: WorkspaceFsNodeOps | null
    stream_ops: WorkspaceFsStreamOps | null
    /** Absolute path in the hub FS (our extension of FSNode). */
    hubPath: string
    /** Content in the node tree is newer than what the hub has. */
    dirty: boolean
}

export interface WorkspaceFsNodeOps {
    getattr(node: WorkspaceFsNode): Record<string, unknown>
    setattr(node: WorkspaceFsNode, attr: Record<string, unknown>): void
    lookup(parent: WorkspaceFsNode, name: string): WorkspaceFsNode
    mknod(parent: WorkspaceFsNode, name: string, mode: number, dev: number): WorkspaceFsNode
    rename(oldNode: WorkspaceFsNode, newDir: WorkspaceFsNode, newName: string): void
    unlink(parent: WorkspaceFsNode, name: string): void
    rmdir(parent: WorkspaceFsNode, name: string): void
    readdir(node: WorkspaceFsNode): string[]
    symlink(parent: WorkspaceFsNode, newName: string, oldPath: string): WorkspaceFsNode
    readlink(node: WorkspaceFsNode): string
}

export interface WorkspaceFsStream {
    node: WorkspaceFsNode
    position: number
    fd: number
    flags: number
}

export interface WorkspaceFsStreamOps {
    open(stream: WorkspaceFsStream): void
    close(stream: WorkspaceFsStream): void
    read(stream: WorkspaceFsStream, buffer: Uint8Array, offset: number, length: number, position: number | null): number
    write(stream: WorkspaceFsStream, buffer: Uint8Array, offset: number, length: number, position: number | null): number
    llseek(stream: WorkspaceFsStream, offset: number, whence: number): number
}

export interface WorkspaceFsPrimitives {
    createNode(parent: WorkspaceFsNode | null, name: string, mode: number, rdev: number): WorkspaceFsNode
    isDir(mode: number): boolean
    isFile(mode: number): boolean
    isLink(mode: number): boolean
    ErrnoError: new (errno: number) => Error & { errno: number }
}

export interface WorkspaceFsType {
    mount(mount: { opts: { rootPath: string } }): WorkspaceFsNode
    syncfs(mount: unknown, populate: boolean, done: (error: unknown) => void): void
}

function joinHubPath(parentPath: string, name: string): string {
    return parentPath === "/" ? `/${name}` : `${parentPath}/${name}`
}

function dirEntries(node: WorkspaceFsNode): Record<string, WorkspaceFsNode> {
    return node.contents as Record<string, WorkspaceFsNode>
}

function fileContents(node: WorkspaceFsNode): Uint8Array | null {
    return node.contents as Uint8Array | null
}

function resizeFileStorage(node: WorkspaceFsNode, newLength: number): void {
    if (newLength === node.usedBytes) return
    if (newLength === 0) {
        node.contents = null
        node.usedBytes = 0
        return
    }
    const previous = fileContents(node)
    const next = new Uint8Array(newLength)
    if (previous) {
        next.set(previous.subarray(0, Math.min(previous.length, newLength)))
    }
    node.contents = next
    node.usedBytes = newLength
}

/**
 * One mounted workspace root: the Emscripten filesystem type plus the node
 * tree it hands out. `rebuildSkeleton` and `flush` are the pre-run / post-run
 * seams called by PyodideSession.
 */
export class WorkspaceMount {
    private readonly dirOps: WorkspaceFsNodeOps
    private readonly fileOps: WorkspaceFsNodeOps
    private readonly linkOps: WorkspaceFsNodeOps
    private readonly streamOps: WorkspaceFsStreamOps
    private chainTail: Promise<void> = Promise.resolve()
    private activeCount = 0
    private readonly pendingWarnings: string[] = []
    private rootNode: WorkspaceFsNode | null = null

    constructor(
        private readonly hub: ObservableInMemoryFs,
        private readonly primitives: WorkspaceFsPrimitives,
        private readonly rootPath: string,
    ) {
        this.dirOps = {
            getattr: (node) => this.getattr(node),
            setattr: (node, attr) => this.setattr(node, attr),
            lookup: (parent, name) => this.lookup(parent, name),
            mknod: (parent, name, mode, dev) => this.mknod(parent, name, mode, dev),
            rename: (oldNode, newDir, newName) => this.rename(oldNode, newDir, newName),
            unlink: (parent, name) => this.unlink(parent, name),
            rmdir: (parent, name) => this.rmdir(parent, name),
            readdir: (node) => this.readdir(node),
            symlink: (parent, newName, oldPath) => this.symlink(parent, newName, oldPath),
            readlink: () => this.readlinkError(),
        }
        this.fileOps = {
            getattr: (node) => this.getattr(node),
            setattr: (node, attr) => this.setattr(node, attr),
        } as WorkspaceFsNodeOps
        this.linkOps = {
            getattr: (node) => this.getattr(node),
            setattr: (node, attr) => this.setattr(node, attr),
            readlink: (node) => this.readlink(node),
        } as WorkspaceFsNodeOps
        this.streamOps = {
            open: () => { /* stream state is owned by the FS core */ },
            close: (stream) => this.pushToHub(stream.node),
            read: (stream, buffer, offset, length, position) => this.read(stream, buffer, offset, length, position),
            write: (stream, buffer, offset, length, position) => this.write(stream, buffer, offset, length, position),
            llseek: (stream, offset, whence) => this.llseek(stream, offset, whence),
        }
    }

    readonly filesystemType: WorkspaceFsType = {
        mount: (mount) => this.mount(mount.opts.rootPath),
        syncfs: (_mount, _populate, done) => done(null),
    }

    private mount(rootPath: string): WorkspaceFsNode {
        if (this.rootNode) throw new this.primitives.ErrnoError(WORKSPACE_FS_ERRNO.EEXIST)
        const root = this.primitives.createNode(null, "", DIR_MODE, 0)
        root.contents = {}
        root.usedBytes = 0
        root.link = null
        root.hubPath = rootPath
        root.dirty = false
        this.assignOps(root)
        this.rootNode = root
        return root
    }

    private assignOps(node: WorkspaceFsNode): void {
        if (this.primitives.isDir(node.mode)) {
            node.node_ops = this.dirOps
            node.stream_ops = null
        } else if (this.primitives.isFile(node.mode)) {
            node.node_ops = this.fileOps
            node.stream_ops = this.streamOps
        } else if (this.primitives.isLink(node.mode)) {
            node.node_ops = this.linkOps
            node.stream_ops = null
        } else {
            throw new this.primitives.ErrnoError(WORKSPACE_FS_ERRNO.EPERM)
        }
    }

    // ---- node ops ----

    private getattr(node: WorkspaceFsNode): Record<string, unknown> {
        const isFile = this.primitives.isFile(node.mode)
        const isDir = this.primitives.isDir(node.mode)
        const size = isFile
            ? node.usedBytes
            : isDir
                ? 4096
                : (node.link?.length ?? 0)
        return {
            dev: 0,
            ino: node.id,
            mode: node.mode,
            nlink: 1,
            uid: 0,
            gid: 0,
            rdev: node.rdev,
            size,
            atime: new Date(node.atime),
            mtime: new Date(node.mtime),
            ctime: new Date(node.ctime),
            blksize: 4096,
            blocks: Math.ceil(size / 4096),
        }
    }

    private setattr(node: WorkspaceFsNode, attr: Record<string, unknown>): void {
        for (const key of ["mode", "atime", "mtime", "ctime"] as const) {
            if (attr[key] != null) {
                node[key] = attr[key] as never
            }
        }
        const wasDirty = node.dirty
        if (attr.size !== undefined) {
            if (!this.primitives.isFile(node.mode)) {
                throw new this.primitives.ErrnoError(WORKSPACE_FS_ERRNO.EISDIR)
            }
            resizeFileStorage(node, attr.size as number)
            node.dirty = true
        }
        // Metadata-only updates for files that do not exist in the hub yet
        // (created in-mount, not pushed) are dropped: the eventual push
        // creates the file, and the hub does not persist modes/times anyway
        // (the old back-sync never preserved them either).
        if (wasDirty) return
        if (attr.mode !== undefined) {
            this.track(() => this.hub.chmod(node.hubPath, attr.mode as number))
        }
        if (attr.mtime !== undefined) {
            this.track(() => this.hub.utimes(node.hubPath, new Date(), new Date(attr.mtime as number)))
        }
    }

    private lookup(parent: WorkspaceFsNode, name: string): WorkspaceFsNode {
        const child = dirEntries(parent)[name]
        if (!child) throw new this.primitives.ErrnoError(WORKSPACE_FS_ERRNO.ENOENT)
        return child
    }

    private mknod(parent: WorkspaceFsNode, name: string, mode: number, dev: number): WorkspaceFsNode {
        const node = this.primitives.createNode(parent, name, mode, dev)
        node.hubPath = joinHubPath(parent.hubPath, name)
        node.link = null
        node.dirty = false
        node.node_ops = null
        node.stream_ops = null
        if (this.primitives.isDir(node.mode)) {
            node.contents = {}
            node.usedBytes = 0
            this.hub.mkdirSync(node.hubPath, { recursive: true })
        } else if (this.primitives.isFile(node.mode)) {
            node.contents = null
            node.usedBytes = 0
            // Created in-mount; content (even empty) is pushed on close or at
            // the run-end sweep so the hub sees the file exactly once.
            node.dirty = true
        } else {
            throw new this.primitives.ErrnoError(WORKSPACE_FS_ERRNO.EPERM)
        }
        this.assignOps(node)
        dirEntries(parent)[name] = node
        this.touch(parent)
        return node
    }

    private rename(oldNode: WorkspaceFsNode, newDir: WorkspaceFsNode, newName: string): void {
        if (oldNode.parent === newDir && oldNode.name === newName) return
        const target = dirEntries(newDir)[newName]
        if (target) {
            delete dirEntries(newDir)[newName]
            this.track(() => this.hub.rm(target.hubPath))
        }
        const previousDir = oldNode.parent
        if (previousDir) delete dirEntries(previousDir)[oldNode.name]
        dirEntries(newDir)[newName] = oldNode
        oldNode.parent = newDir
        oldNode.name = newName
        const previousHubPath = oldNode.hubPath
        oldNode.hubPath = joinHubPath(newDir.hubPath, newName)
        // Only move hub state that exists there; in-mount creations are
        // pushed later under the new path.
        if (!oldNode.dirty) {
            this.track(() => this.hub.mv(previousHubPath, oldNode.hubPath))
        }
        this.touch(newDir)
        if (previousDir) this.touch(previousDir)
    }

    private unlink(parent: WorkspaceFsNode, name: string): void {
        const child = dirEntries(parent)[name]
        if (!child) throw new this.primitives.ErrnoError(WORKSPACE_FS_ERRNO.ENOENT)
        delete dirEntries(parent)[name]
        this.touch(parent)
        if (child.dirty) {
            // Created in-mount and never pushed — nothing to delete in the hub.
            return
        }
        this.track(() => this.hub.rm(child.hubPath))
    }

    private rmdir(parent: WorkspaceFsNode, name: string): void {
        const child = dirEntries(parent)[name]
        if (!child) throw new this.primitives.ErrnoError(WORKSPACE_FS_ERRNO.ENOENT)
        if (Object.keys(dirEntries(child)).length > 0) {
            throw new this.primitives.ErrnoError(WORKSPACE_FS_ERRNO.ENOTEMPTY)
        }
        delete dirEntries(parent)[name]
        this.touch(parent)
        this.track(() => this.hub.rm(child.hubPath, { recursive: true }))
    }

    private readdir(node: WorkspaceFsNode): string[] {
        return [".", "..", ...Object.keys(dirEntries(node))]
    }

    private symlink(parent: WorkspaceFsNode, newName: string, target: string): WorkspaceFsNode {
        const node = this.primitives.createNode(parent, newName, 40960, 0)
        node.hubPath = joinHubPath(parent.hubPath, newName)
        node.contents = null
        node.usedBytes = 0
        node.link = target
        node.dirty = false
        this.assignOps(node)
        dirEntries(parent)[newName] = node
        this.touch(parent)
        this.track(() => this.hub.symlink(target, node.hubPath))
        return node
    }

    private readlink(node: WorkspaceFsNode): string {
        if (node.link === null) throw new this.primitives.ErrnoError(WORKSPACE_FS_ERRNO.EINVAL)
        return node.link
    }

    private readlinkError(): never {
        throw new this.primitives.ErrnoError(WORKSPACE_FS_ERRNO.EINVAL)
    }

    private touch(node: WorkspaceFsNode): void {
        node.atime = node.mtime = node.ctime = Date.now()
    }

    // ---- stream ops ----

    private read(stream: WorkspaceFsStream, buffer: Uint8Array, offset: number, length: number, position: number | null): number {
        const node = stream.node
        const start = position ?? stream.position
        if (start >= node.usedBytes) return 0
        const size = Math.min(node.usedBytes - start, length)
        if (size <= 0) return 0
        const contents = fileContents(node)
        buffer.set(contents!.subarray(start, start + size), offset)
        return size
    }

    private write(stream: WorkspaceFsStream, buffer: Uint8Array, offset: number, length: number, position: number | null): number {
        if (length <= 0) return 0
        const node = stream.node
        const start = position ?? stream.position
        resizeFileStorage(node, Math.max(node.usedBytes, start + length))
        // `buffer` is a view into the WASM heap — the subarray/set copies the
        // bytes into our node-owned buffer before the heap can reallocate.
        ;(fileContents(node))!.set(buffer.subarray(offset, offset + length), start)
        node.dirty = true
        node.mtime = node.ctime = Date.now()
        return length
    }

    private llseek(stream: WorkspaceFsStream, offset: number, whence: number): number {
        let position = offset
        if (whence === 1) {
            position += stream.position
        } else if (whence === 2 && this.primitives.isFile(stream.node.mode)) {
            position += stream.node.usedBytes
        }
        if (position < 0) throw new this.primitives.ErrnoError(WORKSPACE_FS_ERRNO.EINVAL)
        return position
    }

    // ---- hub write-through ----

    private pushToHub(node: WorkspaceFsNode): void {
        if (!node.dirty || !this.primitives.isFile(node.mode)) return
        const contents = fileContents(node)
        // Copy: the hub keeps the buffer; our node may keep mutating in
        // place on subsequent writes.
        this.hub.writeFileSync(node.hubPath, contents ? contents.slice() : new Uint8Array(0))
        node.dirty = false
    }

    private track(operation: () => Promise<unknown>): void {
        // Operations are applied STRICTLY IN ORDER through a promise chain:
        // e.g. rename(a→b) followed by remove(b) must not race, or the
        // removal could settle before the move and resurrect the file.
        this.activeCount += 1
        this.chainTail = this.chainTail.then(
            operation,
        ).then(
            () => { this.activeCount -= 1 },
            (error) => {
                this.activeCount -= 1
                this.pendingWarnings.push(
                    `failed to apply change to '${this.rootPath}': ${error instanceof Error ? error.message : String(error)}`,
                )
            },
        )
    }

    /**
     * Rebuild the mounted node tree from the hub (source of truth) before a
     * Python run. Eagerly hydrates lazy files — sync syscalls cannot await.
     * Unreadable entries are skipped with a warning, exactly like the old
     * forward sync.
     */
    async rebuildSkeleton(warnings: string[]): Promise<void> {
        const root = this.rootNode
        if (!root) return
        await this.syncDir(root, this.rootPath, warnings)
    }

    private async syncDir(dirNode: WorkspaceFsNode, hubPath: string, warnings: string[]): Promise<void> {
        let entries: string[]
        try {
            entries = await this.hub.readdir(hubPath)
        } catch {
            return
        }
        const existing = dirEntries(dirNode)
        for (const name of Object.keys(existing)) {
            if (!entries.includes(name)) delete existing[name]
        }
        for (const entry of entries) {
            const childPath = joinHubPath(hubPath, entry)
            try {
                const stat = await this.hub.stat(childPath)
                if (stat.isDirectory) {
                    let child = existing[entry]
                    if (!child || !this.primitives.isDir(child.mode)) {
                        // Wrong-typed surviving node (hub changed its type
                        // between runs) would make MEMFS createNode throw
                        // EEXIST — drop it and re-create the dir node.
                        if (child) delete existing[entry]
                        child = this.mknod(dirNode, entry, DIR_MODE, 0)
                        // The hub directory already exists; mkdirSync is
                        // idempotent for it.
                        child.dirty = false
                    }
                    await this.syncDir(child, childPath, warnings)
                } else {
                    let child = existing[entry]
                    if (!child || !this.primitives.isFile(child.mode)) {
                        if (child) delete existing[entry]
                        child = this.primitives.createNode(dirNode, entry, FILE_MODE, 0)
                        child.hubPath = childPath
                        child.usedBytes = 0
                        child.contents = null
                        child.link = null
                        child.dirty = false
                        this.assignOps(child)
                        existing[entry] = child
                    }
                    const content = await this.hub.readFileBuffer(childPath)
                    child.contents = content
                    child.usedBytes = content.byteLength
                    child.dirty = false
                }
            } catch (error) {
                warnings.push(`skipped '${childPath}' during sync to Python: ${error instanceof Error ? error.message : String(error)}`)
            }
        }
    }

    /**
     * After a run (success or error): push any content not yet written
     * through and drain every tracked hub operation. Guarantees the hub is
     * consistent with what Python did, even on crashes — replacing the old
     * whole-tree back-scan.
     */
    async flush(warnings: string[]): Promise<void> {
        const root = this.rootNode
        if (root) this.pushDirtyTree(root)
        while (this.activeCount > 0) {
            await this.chainTail
        }
        for (const warning of this.pendingWarnings.splice(0)) {
            warnings.push(warning)
        }
    }

    private pushDirtyTree(dirNode: WorkspaceFsNode): void {
        for (const child of Object.values(dirEntries(dirNode))) {
            if (this.primitives.isDir(child.mode)) {
                this.pushDirtyTree(child)
            } else if (child.dirty) {
                this.pushToHub(child)
            }
        }
    }
}

/** Build the Emscripten-compatible filesystem type for one workspace root. */
export function createWorkspaceMount(
    hub: ObservableInMemoryFs,
    primitives: WorkspaceFsPrimitives,
    rootPath: string,
): WorkspaceMount {
    return new WorkspaceMount(hub, primitives, rootPath)
}

/** Emscripten primitives adapter for a real `pyodide.FS` object. */
export function emscriptenPrimitives(fs: {
    createNode(parent: WorkspaceFsNode | null, name: string, mode: number, rdev: number): WorkspaceFsNode
    isDir(mode: number): boolean
    isFile(mode: number): boolean
    isLink(mode: number): boolean
    ErrnoError: new (errno: number) => Error & { errno: number }
}): WorkspaceFsPrimitives {
    return {
        createNode: (parent, name, mode, rdev) => fs.createNode(parent, name, mode, rdev),
        isDir: (mode) => fs.isDir(mode),
        isFile: (mode) => fs.isFile(mode),
        isLink: (mode) => fs.isLink(mode),
        ErrnoError: fs.ErrnoError,
    }
}