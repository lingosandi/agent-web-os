import { it } from "vitest"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import * as acorn from "acorn"
import { transformEsmToCjsSimple } from "../node_modules/almostnode/src/frameworks/code-transforms"

const OUT = "C:/Users/shele/Documents/GitHub/agent-web-os/.pi-smoke/tf2-result.txt"

type Node = { type: string; start: number; end: number; meta?: { name: string }; property?: { name: string }; [k: string]: unknown }

function walkAst(node: unknown, callback: (n: Node) => void): void {
    if (!node || typeof node !== "object") return
    const n = node as Record<string, unknown>
    if (typeof n.type === "string") callback(node as Node)
    for (const key of Object.keys(n)) {
        if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue
        const child = n[key]
        if (child && typeof child === "object") {
            if (Array.isArray(child)) {
                for (const item of child) {
                    if (item && typeof item === "object" && typeof (item as Record<string, unknown>).type === "string") walkAst(item, callback)
                }
            } else if (typeof (child as Record<string, unknown>).type === "string") {
                walkAst(child, callback)
            }
        }
    }
}

it("repro full pipeline", () => {
    writeFileSync(OUT, "")
    const code = readFileSync("C:/Users/shele/Documents/GitHub/agent-web-os/.pi-smoke/config-as-stored.js", "utf8")
    const ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" }) as unknown as { body: Node[] }
    const deepReplacements: Array<[number, number, string]> = []
    walkAst(ast, (node) => {
        if (node.type === "MetaProperty" && node.meta?.name === "import" && node.property?.name === "meta") {
            deepReplacements.push([node.start, node.end, "import_meta"])
        }
        if (node.type === "ImportExpression") {
            deepReplacements.push([node.start, node.start + 6, "__dynamicImport"])
        }
    })
    const hasImportDecl = ast.body.some((n) => n.type === "ImportDeclaration")
    const hasExportDecl = ast.body.some((n) => n.type.startsWith("Export"))
    let transformed = code
    deepReplacements.sort((a, b) => b[0] - a[0])
    for (const [start, end, replacement] of deepReplacements) {
        transformed = transformed.slice(0, start) + replacement + transformed.slice(end)
    }
    if (hasImportDecl || hasExportDecl) {
        transformed = transformEsmToCjsSimple(transformed)
        if (hasExportDecl) {
            transformed = 'Object.defineProperty(exports, "__esModule", { value: true });\n' + transformed
        }
    }
    appendFileSync(OUT, "hasImportDecl=" + hasImportDecl + " hasExportDecl=" + hasExportDecl + " replacements=" + deepReplacements.length + "\n")
    appendFileSync(OUT, "keeps function decl: " + String(/function\s+getPackageJsonPath/.test(transformed)) + "\n")
    writeFileSync("C:/Users/shele/Documents/GitHub/agent-web-os/.pi-smoke/config-transformed.js", transformed)
    const lines = transformed.split("\n")
    lines.forEach((l, i) => {
        if (l.includes("getPackageJsonPath")) appendFileSync(OUT, (i + 1) + ": " + l + "\n")
    })
})
