// Mock for almostnode/virtual-fs
export class VirtualFS {
    private files = new Map<string, { type: "file" | "directory"; content?: Uint8Array }>()
    private encoder = new TextEncoder()
    private decoder = new TextDecoder()

    constructor() {
        this.files.set("/", { type: "directory" })
    }

    private normalizePath(p: string): string {
        const segments: string[] = []
        for (const seg of p.split("/")) {
            if (seg === "..") segments.pop()
            else if (seg !== "." && seg !== "") segments.push(seg)
        }
        return "/" + segments.join("/")
    }

    existsSync(path: string): boolean {
        return this.files.has(this.normalizePath(path))
    }

    statSync(path: string): { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; size: number; mtime: Date } {
        const normalized = this.normalizePath(path)
        const node = this.files.get(normalized)
        if (!node) throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: "ENOENT" })
        return {
            isDirectory: () => node.type === "directory",
            isFile: () => node.type === "file",
            isSymbolicLink: () => false,
            size: node.content?.length ?? 0,
            mtime: new Date(),
        }
    }

    lstatSync(path: string) {
        return this.statSync(path)
    }

    readFileSync(path: string, encoding?: string): any {
        const normalized = this.normalizePath(path)
        const node = this.files.get(normalized)
        if (!node || node.type !== "file") throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" })
        if (encoding === "utf8" || encoding === "utf-8") return this.decoder.decode(node.content)
        return node.content
    }

    writeFileSync(path: string, data: string | Uint8Array): void {
        const normalized = this.normalizePath(path)
        // Ensure parent directories exist
        const parts = normalized.split("/").filter(Boolean)
        let current = ""
        for (let i = 0; i < parts.length - 1; i++) {
            current += "/" + parts[i]
            if (!this.files.has(current)) {
                this.files.set(current, { type: "directory" })
            }
        }
        const content = typeof data === "string" ? this.encoder.encode(data) : data
        this.files.set(normalized, { type: "file", content })
    }

    mkdirSync(path: string, options?: { recursive?: boolean }): void {
        const normalized = this.normalizePath(path)
        if (options?.recursive) {
            const parts = normalized.split("/").filter(Boolean)
            let current = ""
            for (const part of parts) {
                current += "/" + part
                if (!this.files.has(current)) {
                    this.files.set(current, { type: "directory" })
                }
            }
        } else {
            this.files.set(normalized, { type: "directory" })
        }
    }

    readdirSync(path: string): string[] {
        const normalized = this.normalizePath(path)
        const prefix = normalized === "/" ? "/" : normalized + "/"
        const entries = new Set<string>()
        for (const key of this.files.keys()) {
            if (key === normalized) continue
            if (key.startsWith(prefix)) {
                const rest = key.slice(prefix.length)
                const firstSegment = rest.split("/")[0]
                if (firstSegment) entries.add(firstSegment)
            }
        }
        return Array.from(entries)
    }

    unlinkSync(path: string): void {
        this.files.delete(this.normalizePath(path))
    }

    rmdirSync(path: string): void {
        this.files.delete(this.normalizePath(path))
    }

    renameSync(oldPath: string, newPath: string): void {
        const normalizedOld = this.normalizePath(oldPath)
        const normalizedNew = this.normalizePath(newPath)
        const node = this.files.get(normalizedOld)
        if (node) {
            this.files.set(normalizedNew, node)
            this.files.delete(normalizedOld)
        }
    }
}
