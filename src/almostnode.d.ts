/**
 * Ambient type declarations for almostnode subpath imports.
 *
 * almostnode does not ship its own .d.ts files for these entry points.
 * These declarations satisfy the TypeScript compiler during .d.ts generation.
 */

declare module "almostnode/npm" {
    export class PackageManager {
        constructor(vfs: any, options?: { cwd?: string })
        install(spec: string, options?: { save?: boolean; onProgress?: (msg: string) => void }): Promise<{ added: { name: string; version: string }[] }>
        installFromPackageJson(options?: { onProgress?: (msg: string) => void }): Promise<{ added: { name: string; version: string }[] }>
        list(): Record<string, string>
    }
}

declare module "almostnode/runtime" {
    export class Runtime {
        constructor(vfs: any, options?: {
            cwd?: string
            env?: Record<string, string>
            onStdout?: (chunk: string) => void
            onStderr?: (chunk: string) => void
            onConsole?: (method: string, args: any[]) => void
        })
        getProcess(): any
        execute(code: string, filename: string): void
        runFile(path: string): void
    }
}

declare module "almostnode/server-bridge" {
    export function getServerBridge(): {
        initServiceWorker(): Promise<void>
        registerServer(server: any, port: number): void
        unregisterServer(port: number): void
        getServerUrl(port: number): string
    }
    export function resetServerBridge(): void
}

declare module "almostnode/virtual-fs" {
    export class VirtualFS {
        existsSync(path: string): boolean
        statSync(path: string): { isDirectory(): boolean; isFile(): boolean }
        readFileSync(path: string, encoding?: string): any
        writeFileSync(path: string, data: string | Uint8Array): void
        mkdirSync(path: string, options?: { recursive?: boolean }): void
        readdirSync(path: string): string[]
        unlinkSync(path: string): void
        rmdirSync(path: string): void
        renameSync(oldPath: string, newPath: string): void
    }
}

declare module "almostnode/frameworks/vite-dev-server" {
    export class ViteDevServer {
        constructor(vfs: any, options?: { port?: number; root?: string })
        start(): void
        stop(): void
        setHMRTarget(target: Window): void
        handleRequest(method: string, url: string, headers: any, body?: any): Promise<{
            statusCode: number
            statusMessage: string
            headers: Record<string, string>
            body: any
        }>
    }
}
