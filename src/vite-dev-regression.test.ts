import { execSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { ensureBuiltDist } from "./test-build"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const websiteRoot = path.join(packageRoot, "website")
const distDir = path.join(packageRoot, "dist")
const viteNodeEntry = pathToFileURL(path.join(websiteRoot, "node_modules", "vite", "dist", "node", "index.js")).href

type ViteDevServer = {
    listen(): Promise<void>
    close(): Promise<void>
    resolvedUrls: { local: string[] | null }
}

type ViteServerHandle = {
    server: ViteDevServer
    baseUrl: string
    stop: () => void
}

const tempDirs = new Set<string>()
const servers = new Set<ViteServerHandle>()

function makeFixtureDir(prefix: string): string {
    const dirPath = mkdtempSync(path.join(tmpdir(), prefix))
    tempDirs.add(dirPath)
    return dirPath
}

function createFixturePackage(rootDir: string): void {
    const appDir = path.join(rootDir, "app")
    const packageDir = path.join(appDir, "node_modules", "agent-web-os")

    mkdirSync(packageDir, { recursive: true })
    cpSync(distDir, path.join(packageDir, "dist"), { recursive: true })

    const rootPackageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"))
    writeFileSync(path.join(packageDir, "package.json"), JSON.stringify(rootPackageJson, null, 2))

    writeFileSync(
        path.join(appDir, "index.html"),
        `<!doctype html>
<html>
  <body>
    <div id="app"></div>
    <script type="module" src="/main.js"></script>
  </body>
</html>
`,
    )

    writeFileSync(
        path.join(appDir, "main.js"),
        `import { createBrowserBashSession } from "agent-web-os";
const session = createBrowserBashSession({ rootPath: "/workspace", python: true });
window.__agentWebOsSession = session;
document.querySelector("#app").textContent = "ready";
`,
    )
}

async function startViteServer(rootDir: string): Promise<ViteServerHandle> {
    const appDir = path.join(rootDir, "app")
    const { createServer } = await import(viteNodeEntry) as {
        createServer(options: Record<string, unknown>): Promise<ViteDevServer>
    }

    const server = await createServer({
        root: appDir,
        configFile: false,
        logLevel: "error",
        server: {
            host: "127.0.0.1",
            port: 0,
        },
    })
    await server.listen()

    const baseUrl = server.resolvedUrls.local?.[0]?.replace(/\/$/, "")
    if (!baseUrl) {
        await server.close()
        throw new Error("Vite dev server did not report a local URL")
    }

    const handle = {
        server,
        baseUrl,
        stop: () => {
            void server.close()
        },
    }
    servers.add(handle)
    return handle
}

async function getOptimizedModuleSource(server: ViteServerHandle, importPath: string): Promise<string> {
    const mainResponse = await fetch(`${server.baseUrl}/main.js`)
    expect(mainResponse.status).toBe(200)

    const mainSource = await mainResponse.text()
    const sanitizedImportPath = importPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const match = mainSource.match(new RegExp(`(?:from|import)\\s*["']([^"']*${sanitizedImportPath}[^"']*)["']`))
    if (!match) {
        throw new Error(`Could not find optimized ${importPath} import in main.js\n${mainSource}`)
    }

    const moduleUrl = new URL(match[1], server.baseUrl).toString()
    const response = await fetch(moduleUrl)
    expect(response.status).toBe(200)
    return await response.text()
}

describe.sequential("vite dev regression coverage", () => {
    beforeAll(() => {
        process.chdir(packageRoot)
        ensureBuiltDist([path.join(distDir, "index.js"), path.join(distDir, "node.js")])
    }, 60_000)

    afterEach(() => {
        for (const server of servers) {
            server.stop()
        }
        servers.clear()

        for (const dirPath of tempDirs) {
            rmSync(dirPath, { recursive: true, force: true })
        }
        tempDirs.clear()
    })

    it("keeps the main entry free of optimized almostnode-session imports", async () => {
        const rootDir = makeFixtureDir("agent-web-os-vite-good-")
        createFixturePackage(rootDir)

        const server = await startViteServer(rootDir)
        const source = await getOptimizedModuleSource(server, "/.vite/deps/agent-web-os.js")

        expect(source).not.toContain("almostnode-session")
    }, 60_000)

    it("resolves the optimized almostnode-session chunk for the explicit node entry", async () => {
        const rootDir = makeFixtureDir("agent-web-os-vite-node-")
        createFixturePackage(rootDir)

        writeFileSync(
            path.join(rootDir, "app", "main.js"),
            `import { createBrowserBashSession } from "agent-web-os";
import { enableNode } from "agent-web-os/node";
const session = createBrowserBashSession({ rootPath: "/workspace", python: true });
await enableNode(session);
window.__agentWebOsSession = session;
document.querySelector("#app").textContent = "ready";
`,
        )

        const server = await startViteServer(rootDir)
        const nodeModuleSource = await getOptimizedModuleSource(server, "/.vite/deps/agent-web-os_node.js")
        const chunkMatch = nodeModuleSource.match(/(?:from|import)\s*["']([^"']*chunk-[^"']+\.js[^"']*)["']/)

        if (!chunkMatch) {
            throw new Error(`Could not find optimized almostnode runtime chunk import in agent-web-os/node\n${nodeModuleSource}`)
        }

        const chunkUrl = new URL(chunkMatch[1], server.baseUrl).toString()
        const chunkResponse = await fetch(chunkUrl)

        expect(chunkResponse.status).toBe(200)
        expect(nodeModuleSource).toContain("enableNode")
    }, 60_000)
})