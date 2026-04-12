// Mock for almostnode/npm
export class PackageManager {
    private vfs: any
    private cwd: string

    constructor(vfs: any, options?: { cwd?: string }) {
        this.vfs = vfs
        this.cwd = options?.cwd ?? "/"
    }

    async install(packageSpec: string, options?: { save?: boolean; onProgress?: (msg: string) => void }) {
        options?.onProgress?.(`Resolving ${packageSpec}...`)
        return { installed: new Map(), added: [packageSpec] }
    }

    async installFromPackageJson(options?: { onProgress?: (msg: string) => void }) {
        options?.onProgress?.("Installing from package.json...")
        return { installed: new Map(), added: [] }
    }

    list(): Record<string, string> {
        const pkgJsonPath = this.cwd + "/node_modules"
        // Return empty for mock
        return {}
    }
}
