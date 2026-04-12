// Mock for almostnode/frameworks/vite-dev-server
export class ViteDevServer {
    private vfs: any
    private options: any
    private stopped = false

    constructor(vfs: any, options: any) {
        this.vfs = vfs
        this.options = options
    }

    setHMRTarget(targetWindow: Window): void {
        // no-op
    }

    async handleRequest(method: string, url: string, headers: Record<string, string>, body?: any) {
        return {
            statusCode: 200,
            statusMessage: "OK",
            headers: { "Content-Type": "text/html" },
            body: Buffer.from("<html></html>"),
        }
    }

    startWatching(): void {}

    stop(): void {
        this.stopped = true
    }
}
