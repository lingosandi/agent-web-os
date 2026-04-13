import { execSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { beforeAll, describe, expect, it } from "vitest"
import { ensureBuiltDist } from "./test-build"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const distDir = path.join(packageRoot, "dist")
const distEntry = path.join(distDir, "index.js")
const nodeEntry = path.join(distDir, "node.js")

const WORKER_MARKERS = [
    "WorkerRuntime",
    "runtime-worker",
    "/assets/runtime-worker",
]

function readText(filePath: string): string {
    return readFileSync(filePath, "utf8")
}

function getStaticRelativeImports(source: string): string[] {
    const imports: string[] = []
    const pattern = /^\s*import\s+(?:[^"']+?\s+from\s+)?["'](\.[^"']+)["'];?$/gm

    for (const match of source.matchAll(pattern)) {
        imports.push(match[1])
    }

    return imports
}

function collectStaticGraph(entryFile: string): string[] {
    const seen = new Set<string>()
    const pending = [entryFile]

    while (pending.length > 0) {
        const filePath = pending.pop()!
        if (seen.has(filePath)) {
            continue
        }

        seen.add(filePath)

        const source = readText(filePath)
        for (const specifier of getStaticRelativeImports(source)) {
            const resolved = path.resolve(path.dirname(filePath), specifier)
            if (resolved.endsWith(".js") && existsSync(resolved)) {
                pending.push(resolved)
            }
        }
    }

    return [...seen]
}

function hasWorkerMarker(source: string): boolean {
    return WORKER_MARKERS.some((marker) => source.includes(marker))
}

describe.sequential("build output regression coverage", () => {
    beforeAll(() => {
        process.chdir(packageRoot)
        ensureBuiltDist([distEntry, nodeEntry])
    }, 60_000)

    it("keeps the eager ESM graph free of almostnode worker runtime code", () => {
        expect(existsSync(distEntry)).toBe(true)

        const staticGraph = collectStaticGraph(distEntry)
        for (const filePath of staticGraph) {
            const source = readText(filePath)
            expect(hasWorkerMarker(source), `unexpected worker marker in ${path.basename(filePath)}`).toBe(false)
        }
    })

    it("confines worker runtime markers to lazy chunks outside the static index.js graph", () => {
        const staticGraph = new Set(collectStaticGraph(distEntry))
        const workerFiles = readdirSync(distDir)
            .filter((name) => name.endsWith(".js"))
            .map((name) => path.join(distDir, name))
            .filter((filePath) => hasWorkerMarker(readText(filePath)))

        for (const filePath of workerFiles) {
            expect(staticGraph.has(filePath), `${path.basename(filePath)} leaked into the eager entry graph`).toBe(false)
        }
    })

    it("keeps node runtime loading behind dynamic imports in the browser entry graph", () => {
        const entrySource = readText(distEntry)
        const staticGraph = collectStaticGraph(distEntry)
        const staticGraphSources = staticGraph.map((filePath) => readText(filePath)).join("\n")

        expect(entrySource).not.toContain("almostnode-session")
        expect(entrySource).not.toContain("./dist-")
        expect(staticGraphSources).not.toContain("almostnode-session")
        expect(staticGraphSources).not.toContain("./dist-")
        expect(entrySource).not.toContain("from \"almostnode\"")
        expect(entrySource).not.toContain("from 'almostnode'")
    })

    it("emits a dedicated node entry for opt-in almostnode support", () => {
        expect(existsSync(nodeEntry)).toBe(true)

        const source = readText(nodeEntry)
        expect(source).toContain("almostnode-session")
        expect(source).toContain('almostnodePromise = import("./server-bridge-')
        expect(source).not.toContain('from "./server-bridge-')
    })
})