import {
    InMemoryFs,
    type CpOptions,
    type FileContent,
    type MkdirOptions,
    type RmOptions,
} from "just-bash"
import { posixPath as path } from "./posix-path"

type ObservableInMemoryFsWriteFileSyncOptions = Parameters<InMemoryFs["writeFileSync"]>[2]
type ObservableInMemoryFsWriteFileSyncMetadata = Parameters<InMemoryFs["writeFileSync"]>[3]
type ObservableInMemoryFsWriteFileLazy = Parameters<InMemoryFs["writeFileLazy"]>[1]
type ObservableInMemoryFsWriteFileLazyMetadata = Parameters<InMemoryFs["writeFileLazy"]>[2]
type ObservableInMemoryFsWriteOptions = Parameters<InMemoryFs["writeFile"]>[2]

type ObservableInMemoryFsEntryType = "file" | "directory" | "symlink"

export type ObservableInMemoryFsChangeEventName =
    | "add"
    | "addDir"
    | "change"
    | "unlink"
    | "unlinkDir"

export type ObservableInMemoryFsChangeEvent = {
    event: ObservableInMemoryFsChangeEventName
    path: string
    entryType: ObservableInMemoryFsEntryType
    previousPath?: string
}

export type ObservableInMemoryFsOptions = {
    /** Whether to console.log change events (default: false) */
    consoleLogChanges?: boolean
    /** Root path used to filter which changes are console-logged (default: "/") */
    workspaceRoot?: string
}

function isObservableInMemoryFsLike(value: unknown): value is ObservableInMemoryFs {
    if (!value || typeof value !== "object") {
        return false
    }

    const candidate = value as Partial<Record<keyof ObservableInMemoryFs, unknown>>

    return typeof candidate.subscribe === "function"
        && typeof candidate.exists === "function"
        && typeof candidate.readFile === "function"
        && typeof candidate.readdir === "function"
        && typeof candidate.stat === "function"
}

export function assertObservableInMemoryFs(value: unknown): ObservableInMemoryFs {
    if (!isObservableInMemoryFsLike(value)) {
        throw new Error("Expected ObservableInMemoryFs-backed just-bash filesystem")
    }

    return value
}

function formatChangeEventForLog(event: ObservableInMemoryFsChangeEvent): string {
    const previousPathSuffix = event.previousPath
        ? ` (from ${event.previousPath})`
        : ""

    return `[ObservableInMemoryFs] ${event.event} ${event.entryType} ${event.path}${previousPathSuffix}`
}

type ObservableInMemoryFsListener = (event: ObservableInMemoryFsChangeEvent) => void

type ObservableInMemoryFsPathState = {
    exists: boolean
    entryType?: ObservableInMemoryFsEntryType
}

type ObservableInMemoryFsEmitOptions = {
    shouldConsoleLog?: boolean
}

function normalizeEntryType(stat: {
    isDirectory: boolean
    isFile: boolean
    isSymbolicLink: boolean
}): ObservableInMemoryFsEntryType {
    if (stat.isDirectory) {
        return "directory"
    }

    if (stat.isSymbolicLink) {
        return "symlink"
    }

    return "file"
}

async function readPathState(
    fs: InMemoryFs,
    path: string,
): Promise<ObservableInMemoryFsPathState> {
    const exists = await fs.exists(path)
    if (!exists) {
        return { exists: false }
    }

    if (isObservableInMemoryFsLike(fs) && fs.isPathLazy(path)) {
        return {
            exists: true,
            entryType: "file",
        }
    }

    const stat = await fs.lstat(path)
    return {
        exists: true,
        entryType: normalizeEntryType(stat),
    }
}

function mapAddEvent(entryType: ObservableInMemoryFsEntryType): ObservableInMemoryFsChangeEventName {
    return entryType === "directory" ? "addDir" : "add"
}

function mapUnlinkEvent(entryType: ObservableInMemoryFsEntryType): ObservableInMemoryFsChangeEventName {
    return entryType === "directory" ? "unlinkDir" : "unlink"
}

function normalizeFsPathForLogScope(fsPath: string): string {
    const normalized = path.normalize(fsPath)
    return normalized === "." ? "/" : normalized
}

function createWorkspacePathFilter(workspaceRoot: string): (fsPath: string) => boolean {
    const normalizedWorkspaceRoot = normalizeFsPathForLogScope(workspaceRoot)

    return (fsPath: string) => {
        const normalizedPath = normalizeFsPathForLogScope(fsPath)

        if (normalizedPath !== normalizedWorkspaceRoot && !normalizedPath.startsWith(`${normalizedWorkspaceRoot}/`)) {
            return false
        }

        const relativePath = path.relative(normalizedWorkspaceRoot, normalizedPath)
        if (!relativePath || relativePath === ".") {
            return true
        }

        return relativePath
            .split("/")
            .every((segment) => segment.length > 0 && !segment.startsWith("."))
    }
}

export class ObservableInMemoryFs extends InMemoryFs {
    private listeners: Set<ObservableInMemoryFsListener> | undefined
    private lazyPaths = new Set<string>()
    private suppressSyncEventCount = 0
    private suppressConsoleLogCount = 0
    private suppressChangeEmissionCount = 0
    private readonly consoleLogChanges: boolean
    private readonly isLoggableWorkspacePath: (fsPath: string) => boolean

    constructor(options?: ObservableInMemoryFsOptions) {
        super()
        this.consoleLogChanges = options?.consoleLogChanges ?? false
        this.isLoggableWorkspacePath = createWorkspacePathFilter(options?.workspaceRoot ?? "/")
    }

    isPathLazy(filePath: string): boolean {
        return this.lazyPaths.has(normalizeFsPathForLogScope(filePath))
    }

    private clearLazyPath(filePath: string): void {
        this.lazyPaths.delete(normalizeFsPathForLogScope(filePath))
    }

    private clearLazyPathsUnder(rootPath: string): void {
        const normalizedRootPath = normalizeFsPathForLogScope(rootPath)

        for (const filePath of Array.from(this.lazyPaths)) {
            if (filePath === normalizedRootPath || filePath.startsWith(`${normalizedRootPath}/`)) {
                this.lazyPaths.delete(filePath)
            }
        }
    }

    subscribe(listener: ObservableInMemoryFsListener): () => void {
        const listeners = this.listeners ??= new Set<ObservableInMemoryFsListener>()
        listeners.add(listener)

        return () => {
            listeners.delete(listener)

            if (listeners.size === 0 && this.listeners === listeners) {
                this.listeners = undefined
            }
        }
    }

    private shouldEmitChanges(): boolean {
        if (this.suppressChangeEmissionCount > 0) {
            return false
        }

        return this.consoleLogChanges || (this.listeners?.size ?? 0) > 0
    }

    async suppressObservability<T>(operation: () => Promise<T>): Promise<T> {
        this.suppressChangeEmissionCount += 1
        this.suppressSyncEventCount += 1
        this.suppressConsoleLogCount += 1

        try {
            return await operation()
        } finally {
            this.suppressConsoleLogCount -= 1
            this.suppressSyncEventCount -= 1
            this.suppressChangeEmissionCount -= 1
        }
    }

    private queueChangeEmission(emission: Promise<void>): void {
        void emission.catch((error: unknown) => {
            console.error("[ObservableInMemoryFs] Failed to emit change event", error)
        })
    }

    private areConsoleLogsSuppressed(): boolean {
        return this.suppressConsoleLogCount > 0
    }

    private async runWithSuppressedConsoleLogs<T>(operation: () => Promise<T>): Promise<T> {
        this.suppressConsoleLogCount += 1

        try {
            return await operation()
        } finally {
            this.suppressConsoleLogCount -= 1
        }
    }

    private shouldConsoleLogChangeEvent(event: ObservableInMemoryFsChangeEvent): boolean {
        if (!this.isLoggableWorkspacePath(event.path)) {
            return false
        }

        if (event.previousPath && !this.isLoggableWorkspacePath(event.previousPath)) {
            return false
        }

        return true
    }

    private emit(
        event: ObservableInMemoryFsChangeEvent,
        options?: ObservableInMemoryFsEmitOptions,
    ): void {
        const shouldConsoleLog = options?.shouldConsoleLog ?? this.shouldConsoleLogChangeEvent(event)

        if (
            this.consoleLogChanges
            && shouldConsoleLog
            && !this.areConsoleLogsSuppressed()
        ) {
            console.log(formatChangeEventForLog(event))
        }

        if (!this.listeners) {
            return
        }

        for (const listener of this.listeners) {
            try {
                listener(event)
            } catch (error: unknown) {
                console.error("[ObservableInMemoryFs] Change listener failed", error)
            }
        }
    }

    private areSyncEventsSuppressed(): boolean {
        return this.suppressSyncEventCount > 0
    }

    private async runWithSuppressedSyncEvents<T>(operation: () => Promise<T>): Promise<T> {
        this.suppressSyncEventCount += 1

        try {
            return await operation()
        } finally {
            this.suppressSyncEventCount -= 1
        }
    }

    override writeFileSync(
        path: string,
        content: FileContent,
        options?: ObservableInMemoryFsWriteFileSyncOptions,
        metadata?: ObservableInMemoryFsWriteFileSyncMetadata,
    ): void {
        const previous = this.areSyncEventsSuppressed() || !this.shouldEmitChanges()
            ? null
            : readPathState(this, path)

        super.writeFileSync(path, content, options, metadata)
        this.clearLazyPath(path)

        if (!previous) {
            return
        }

        this.queueChangeEmission(previous.then((state) => this.emitWriteEvent(path, state)))
    }

    override writeFileLazy(
        path: string,
        lazy: ObservableInMemoryFsWriteFileLazy,
        metadata?: ObservableInMemoryFsWriteFileLazyMetadata,
    ): void {
        const previous = this.areSyncEventsSuppressed() || !this.shouldEmitChanges()
            ? null
            : readPathState(this, path)

        super.writeFileLazy(path, lazy, metadata)
        this.lazyPaths.add(normalizeFsPathForLogScope(path))

        if (!previous) {
            return
        }

        this.queueChangeEmission(previous.then((state) => this.emitWriteEvent(path, state)))
    }

    private async emitWriteEvent(path: string, previous: ObservableInMemoryFsPathState): Promise<void> {
        const current = await readPathState(this, path)
        if (!current.exists || !current.entryType) {
            return
        }

        if (!previous.exists) {
            this.emit({
                event: mapAddEvent(current.entryType),
                path,
                entryType: current.entryType,
            })
            return
        }

        this.emit({
            event: "change",
            path,
            entryType: current.entryType,
        })
    }

    private async emitMkdirEvent(path: string, previous: ObservableInMemoryFsPathState): Promise<void> {
        const current = await readPathState(this, path)
        if (!current.exists || current.entryType !== "directory" || previous.exists) {
            return
        }

        this.emit({
            event: "addDir",
            path,
            entryType: "directory",
        })
    }

    private emitRemovalEvent(
        path: string,
        previous: ObservableInMemoryFsPathState,
        options?: ObservableInMemoryFsEmitOptions,
    ): void {
        if (!previous.exists || !previous.entryType) {
            return
        }

        this.emit({
            event: mapUnlinkEvent(previous.entryType),
            path,
            entryType: previous.entryType,
        }, options)
    }

    override mkdirSync(path: string, options?: MkdirOptions): void {
        const previous = this.areSyncEventsSuppressed() || !this.shouldEmitChanges()
            ? null
            : readPathState(this, path)

        super.mkdirSync(path, options)

        if (!previous) {
            return
        }

        this.queueChangeEmission(previous.then((state) => this.emitMkdirEvent(path, state)))
    }

    override async readFileBuffer(path: string): Promise<Uint8Array> {
        const content = await super.readFileBuffer(path)
        this.clearLazyPath(path)
        return content
    }

    override async stat(path: string) {
        const stat = await super.stat(path)
        this.clearLazyPath(path)
        return stat
    }

    override async lstat(path: string) {
        const stat = await super.lstat(path)
        this.clearLazyPath(path)
        return stat
    }

    override async writeFile(
        path: string,
        content: FileContent,
        options?: ObservableInMemoryFsWriteOptions,
    ): Promise<void> {
        if (!this.shouldEmitChanges()) {
            await super.writeFile(path, content, options)
            return
        }

        const previous = await readPathState(this, path)
        await this.runWithSuppressedSyncEvents(() => super.writeFile(path, content, options))
        await this.emitWriteEvent(path, previous)
    }

    override async appendFile(
        path: string,
        content: FileContent,
        options?: ObservableInMemoryFsWriteOptions,
    ): Promise<void> {
        if (!this.shouldEmitChanges()) {
            await super.appendFile(path, content, options)
            return
        }

        const previous = await readPathState(this, path)
        await this.runWithSuppressedSyncEvents(() => super.appendFile(path, content, options))
        await this.emitWriteEvent(path, previous)
    }

    override async mkdir(path: string, options?: MkdirOptions): Promise<void> {
        if (!this.shouldEmitChanges()) {
            await super.mkdir(path, options)
            return
        }

        const previous = await readPathState(this, path)
        await this.runWithSuppressedSyncEvents(() => super.mkdir(path, options))
        await this.emitMkdirEvent(path, previous)
    }

    override async rm(path: string, options?: RmOptions): Promise<void> {
        if (!this.shouldEmitChanges()) {
            await super.rm(path, options)
            this.clearLazyPathsUnder(path)
            return
        }

        const previous = await readPathState(this, path)
        await super.rm(path, options)
        this.clearLazyPathsUnder(path)
        this.emitRemovalEvent(path, previous)
    }

    override async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
        if (!this.shouldEmitChanges()) {
            await super.cp(src, dest, options)
            this.clearLazyPathsUnder(dest)
            return
        }

        const previous = await readPathState(this, dest)
        await super.cp(src, dest, options)
        this.clearLazyPathsUnder(dest)
        const current = await readPathState(this, dest)

        if (!current.exists || !current.entryType) {
            return
        }

        this.emit({
            event: previous.exists ? "change" : mapAddEvent(current.entryType),
            path: dest,
            entryType: current.entryType,
        })
    }

    override async mv(src: string, dest: string): Promise<void> {
        if (!this.shouldEmitChanges()) {
            await super.mv(src, dest)
            const normalizedSourcePath = normalizeFsPathForLogScope(src)
            const normalizedDestinationPath = normalizeFsPathForLogScope(dest)
            this.clearLazyPathsUnder(normalizedDestinationPath)

            for (const filePath of Array.from(this.lazyPaths)) {
                if (filePath === normalizedSourcePath || filePath.startsWith(`${normalizedSourcePath}/`)) {
                    this.lazyPaths.delete(filePath)
                    this.lazyPaths.add(`${normalizedDestinationPath}${filePath.slice(normalizedSourcePath.length)}`)
                }
            }
            return
        }

        const sourceState = await readPathState(this, src)
        const destinationState = await readPathState(this, dest)
        const shouldConsoleLogMove = this.shouldConsoleLogChangeEvent({
            event: destinationState.exists ? "change" : mapAddEvent(sourceState.entryType ?? "file"),
            path: dest,
            previousPath: src,
            entryType: sourceState.entryType ?? "file",
        })

        if (shouldConsoleLogMove) {
            await super.mv(src, dest)
        } else {
            await this.runWithSuppressedConsoleLogs(() => super.mv(src, dest))
        }

        const normalizedSourcePath = normalizeFsPathForLogScope(src)
        const normalizedDestinationPath = normalizeFsPathForLogScope(dest)
        this.clearLazyPathsUnder(normalizedDestinationPath)

        for (const filePath of Array.from(this.lazyPaths)) {
            if (filePath === normalizedSourcePath || filePath.startsWith(`${normalizedSourcePath}/`)) {
                this.lazyPaths.delete(filePath)
                this.lazyPaths.add(`${normalizedDestinationPath}${filePath.slice(normalizedSourcePath.length)}`)
            }
        }

        this.emitRemovalEvent(src, sourceState, {
            shouldConsoleLog: shouldConsoleLogMove,
        })

        const currentDestinationState = await readPathState(this, dest)
        if (!currentDestinationState.exists || !currentDestinationState.entryType) {
            return
        }

        this.emit({
            event: destinationState.exists ? "change" : mapAddEvent(currentDestinationState.entryType),
            path: dest,
            previousPath: src,
            entryType: currentDestinationState.entryType,
        }, {
            shouldConsoleLog: shouldConsoleLogMove,
        })
    }

    override async chmod(path: string, mode: number): Promise<void> {
        if (!this.shouldEmitChanges()) {
            await super.chmod(path, mode)
            return
        }

        await super.chmod(path, mode)

        const current = await readPathState(this, path)
        if (!current.exists || !current.entryType) {
            return
        }

        this.emit({
            event: "change",
            path,
            entryType: current.entryType,
        })
    }

    override async symlink(target: string, linkPath: string): Promise<void> {
        if (!this.shouldEmitChanges()) {
            await super.symlink(target, linkPath)
            return
        }

        const previous = await readPathState(this, linkPath)
        await super.symlink(target, linkPath)
        await this.emitWriteEvent(linkPath, previous)
    }

    override async link(existingPath: string, newPath: string): Promise<void> {
        if (!this.shouldEmitChanges()) {
            await super.link(existingPath, newPath)
            return
        }

        const previous = await readPathState(this, newPath)
        await super.link(existingPath, newPath)
        await this.emitWriteEvent(newPath, previous)
    }

    override async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
        if (!this.shouldEmitChanges()) {
            await super.utimes(path, atime, mtime)
            return
        }

        await super.utimes(path, atime, mtime)

        const current = await readPathState(this, path)
        if (!current.exists || !current.entryType) {
            return
        }

        this.emit({
            event: "change",
            path,
            entryType: current.entryType,
        })
    }
}
