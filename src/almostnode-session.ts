import type { CommandContext, ExecResult } from "just-bash/browser"
import { posixPath as path } from "./posix-path"
import { PackageManager } from "almostnode/npm"
import { Runtime } from "almostnode/runtime"
import { getServerBridge } from "almostnode/server-bridge"
import { VirtualFS } from "almostnode/virtual-fs"
import { ViteDevServer } from "almostnode/frameworks/vite-dev-server"

import {
    ObservableInMemoryFs,
} from "./observable-in-memory-fs"

const ALMOSTNODE_INTERNAL_ROOT = "/.almostnode"
const ALMOSTNODE_NODE_VERSION = "v20.0.0"
const ALMOSTNODE_NPM_VERSION = "9.6.4"
const NODE_EXEC_PATH = "/usr/local/bin/node"
const GLOBAL_NODE_MODULES_ROOT = "/usr/local/lib/node_modules"
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin:/node_modules/.bin"
const NPM_USAGE = [
    "Usage: npm <command>",
    "",
    "Commands:",
    "  run <script>   Run a script from package.json",
    "  start          Run the start script",
    "  test           Run the test script",
    "  install [pkg]  Install packages",
    "  ls             List installed packages",
].join("\n")

const STATIC_MIME_TYPES: Record<string, string> = {
    css: "text/css; charset=utf-8",
    cjs: "application/javascript; charset=utf-8",
    gif: "image/gif",
    htm: "text/html; charset=utf-8",
    html: "text/html; charset=utf-8",
    ico: "image/x-icon",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "application/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    map: "application/json; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    mjs: "application/javascript; charset=utf-8",
    otf: "font/otf",
    pdf: "application/pdf",
    png: "image/png",
    svg: "image/svg+xml",
    txt: "text/plain; charset=utf-8",
    wasm: "application/wasm",
    webp: "image/webp",
    woff: "font/woff",
    woff2: "font/woff2",
}

type PackageJsonLike = {
    name?: string
    version?: string
    scripts?: Record<string, string>
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
}

type BinCommandRegistrar = (name: string, handler: (args: string[], ctx: CommandContext) => Promise<ExecResult>) => void
type VitePreviewListener = (previewUrl: string | null) => void
type BatchFileLoader = (paths: string[]) => Promise<Map<string, Uint8Array>>

export interface AlmostNodeSessionVfs {
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

declare global {
    interface Window {
        __esbuild?: unknown
        __esbuildInitPromise?: Promise<void>
    }
}

/** Strip leading "./" from a path (e.g. "./esm/index.js" → "esm/index.js") */
function stripDotSlash(p: string): string {
    return p.startsWith("./") ? p.slice(2) : p
}

function getStaticMimeType(filePath: string): string {
    const extension = filePath.split(".").pop()?.toLowerCase() || ""
    return STATIC_MIME_TYPES[extension] || "application/octet-stream"
}

function getRequestPathname(requestUrl: string): string {
    return new URL(requestUrl, "http://localhost").pathname
}

/**
 * Detect CJS modules and wrap them in an ESM shim so the browser can
 * import them.  Detects `require(`, `module.exports`, or `exports.` at
 * statement level.  Already-ESM sources (containing `import ` or
 * `export `) are returned untouched.
 *
 * `require('pkg')` calls are hoisted into ESM `import` declarations so
 * that transitive CJS dependencies are loaded by the browser's module
 * loader (and themselves shimmed when served).
 */
function wrapCjsAsEsm(code: string, virtualPrefix = "", requestPath = ""): string {
    // Strip strings and comments so keyword detection is accurate
    const stripped = code.replace(
        /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*)/g,
        (match) => " ".repeat(match.length),
    )

    // Quick ESM check – if it already has import/export syntax, leave it alone
    if (/\b(import\s+|export\s+|export\s*\{|export\s+default\b)/.test(stripped)) {
        return code
    }
    // Quick CJS check – must have at least one CJS indicator
    if (!/\b(require\s*\(|module\.exports|exports\.)/.test(stripped)) {
        return code
    }

    // Compute the directory of the file being served so relative requires
    // (e.g. require('./cjs/react-is.development.js')) resolve correctly.
    // requestPath should be the *resolved* file path (with extension), so
    // dirname always gives the correct parent directory.
    const requestDir = requestPath ? path.dirname(requestPath) : ""

    // Collect require() calls and replace them with references to
    // imported shim variables.  We only handle string-literal requires.
    // Build a comment-free view of the code so we don't match require()
    // inside comments.  Strings must be preserved since require specifiers
    // live inside them.  We reuse the same tokenizer but only blank comments.
    const commentFree = code.replace(
        /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*)/g,
        (m) => {
            if (m.startsWith("/*") || m.startsWith("//")) {
                return " ".repeat(m.length)
            }
            return m
        },
    )

    const imports: string[] = []
    let counter = 0
    // Match on comment-free version but replace in original code at same offsets
    const requirePattern = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g
    let rewritten = ""
    let lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = requirePattern.exec(commentFree)) !== null) {
        const specifier = match[2]
        const varName = `__cjs_req_${counter++}__`
        let resolvedSpec: string
        if (specifier.startsWith(".")) {
            resolvedSpec = `${virtualPrefix}${path.resolve(requestDir, specifier)}`
        } else {
            resolvedSpec = `${virtualPrefix}/node_modules/${specifier}`
        }
        imports.push(`import ${varName} from "${resolvedSpec}";`)
        rewritten += code.slice(lastIndex, match.index)
        rewritten += `(${varName} && ${varName}.__esModule ? ${varName}.default : ${varName})`
        lastIndex = match.index + match[0].length
    }
    rewritten += code.slice(lastIndex)

    // Detect CJS "re-export" patterns:
    //   module.exports = require('./some-file')           (unconditional)
    //   if (NODE_ENV === 'production') { module.exports = require(A) }
    //   else { module.exports = require(B) }              (conditional)
    // Add `export * from "..."` so named imports flow through.
    // Only emit ONE export-star to avoid "conflicting star exports" when
    // multiple conditional branches re-export modules with the same names.
    // Since our process shim sets NODE_ENV='production', prefer the
    // production variant if present; otherwise take the first match.
    const reExportPattern = /module\.exports\s*=\s*\(__cjs_req_(\d+)__\s*&&\s*__cjs_req_\1__\.__esModule\s*\?\s*__cjs_req_\1__\.default\s*:\s*__cjs_req_\1__\)/g
    const reExportCandidates: string[] = []
    let reM: RegExpExecArray | null
    while ((reM = reExportPattern.exec(rewritten)) !== null) {
        const reExportVar = `__cjs_req_${reM[1]}__`
        const reExportImport = imports.find((i) => i.includes(reExportVar))
        if (reExportImport) {
            const specMatch = reExportImport.match(/from\s+"([^"]+)"/)
            if (specMatch) reExportCandidates.push(specMatch[1])
        }
    }
    if (reExportCandidates.length > 0) {
        // Prefer production build (matches our NODE_ENV shim)
        const picked = reExportCandidates.find((s) => /production|\.prod[\.\b]/.test(s))
            ?? reExportCandidates[0]
        return [
            "// [monospace CJS→ESM re-export]",
            ...imports,
            "var module = { exports: {} };",
            "var exports = module.exports;",
            "var process = { env: { NODE_ENV: 'production' } };",
            rewritten,
            "export default module.exports;",
            `export * from "${picked}";`,
        ].join("\n")
    }

    // Extract named exports by scanning for `exports.NAME =` patterns in
    // the rewritten code.  These become static ESM named exports.
    const namedExports = new Set<string>()
    const exportsPattern = /\bexports\.(\w+)\s*=/g
    let expMatch: RegExpExecArray | null
    while ((expMatch = exportsPattern.exec(rewritten)) !== null) {
        const name = expMatch[1]
        if (name !== "__esModule") namedExports.add(name)
    }

    const namedExportLines: string[] = []
    if (namedExports.size > 0) {
        const names = [...namedExports]
        // Use prefixed variable names to avoid clashing with identifiers
        // already declared in the original CJS code (e.g. `function typeOf`).
        for (const name of names) {
            namedExportLines.push(`var __cjs_e_${name}__ = module.exports.${name};`)
        }
        namedExportLines.push(
            `export { ${names.map((n) => `__cjs_e_${n}__ as ${n}`).join(", ")} };`,
        )
    }

    return [
        "// [monospace CJS→ESM shim]",
        ...imports,
        "var module = { exports: {} };",
        "var exports = module.exports;",
        "var process = { env: { NODE_ENV: 'production' } };",
        rewritten,
        "export default module.exports;",
        ...namedExportLines,
    ].join("\n")
}

const ESBUILD_WASM_VERSION = "0.20.0"

/**
 * Pre-initialize esbuild-wasm before ViteDevServer is created.
 *
 * Turbopack statically analyses `import(CDN_URL)` inside almostnode's
 * vite-dev-server.ts, replaces the specifier with 'unknown' and breaks
 * the runtime import.  By loading the module ourselves with a URL
 * constructed at runtime (invisible to Turbopack's static pass) and
 * setting `window.__esbuild`, the ViteDevServer's `initEsbuild()` finds
 * the singleton already in place and skips its own broken import().
 */
async function ensureEsbuildWasm(): Promise<void> {
    if (typeof window === "undefined") return
    if (window.__esbuild) return
    if (window.__esbuildInitPromise) {
        await window.__esbuildInitPromise
        return
    }

    window.__esbuildInitPromise = (async () => {
        // Build URLs at runtime so Turbopack cannot statically resolve them
        const esmUrl = `https://esm.sh/esbuild-wasm@${ESBUILD_WASM_VERSION}`
        const wasmUrl = `https://unpkg.com/esbuild-wasm@${ESBUILD_WASM_VERSION}/esbuild.wasm`

        // Use indirect import to prevent Turbopack static analysis
        const dynamicImport = new Function("url", "return import(url)") as (url: string) => Promise<Record<string, unknown>>
        const mod = await dynamicImport(esmUrl)
        const esbuildMod = (mod.default || mod) as { initialize: (opts: { wasmURL: string }) => Promise<void> }

        try {
            await esbuildMod.initialize({ wasmURL: wasmUrl })
        } catch (err) {
            if (err instanceof Error && err.message.includes("Cannot call \"initialize\" more than once")) {
                // already initialized
            } else {
                window.__esbuildInitPromise = undefined
                throw err
            }
        }

        window.__esbuild = esbuildMod
    })()

    await window.__esbuildInitPromise
}

function normalizePath(inputPath: string): string {
    return path.normalize(inputPath.trim() || "/") || "/"
}

function isInternalAlmostNodePath(targetPath: string): boolean {
    const normalizedPath = normalizePath(targetPath)
    return normalizedPath === ALMOSTNODE_INTERNAL_ROOT
        || normalizedPath.startsWith(`${ALMOSTNODE_INTERNAL_ROOT}/`)
}

function appendChunk(chunks: string[], value: string): void {
    if (!value) {
        return
    }

    chunks.push(value)
}

function getPackageJsonDependencyNames(pkgJson: PackageJsonLike): string[] {
    const dependencyNames: string[] = []
    const dependencySections = [
        pkgJson.dependencies,
        pkgJson.devDependencies,
        pkgJson.optionalDependencies,
        pkgJson.peerDependencies,
    ]

    for (const section of dependencySections) {
        if (!section || typeof section !== "object") {
            continue
        }

        for (const packageName of Object.keys(section)) {
            if (!dependencyNames.includes(packageName)) {
                dependencyNames.push(packageName)
            }
        }
    }

    return dependencyNames
}

function getCommandEnvironment(ctx: CommandContext): Record<string, string> {
    const environment: Record<string, string> = {}

    for (const [key, value] of ctx.env.entries()) {
        environment[key] = value
    }

    return environment
}

async function ensureObservableDirectory(fs: ObservableInMemoryFs, directoryPath: string): Promise<void> {
    const normalizedPath = normalizePath(directoryPath)
    if (normalizedPath === "/") {
        return
    }

    if (await fs.exists(normalizedPath)) {
        return
    }

    await fs.mkdir(normalizedPath, { recursive: true })
}

function removeVirtualPath(vfs: VirtualFS, targetPath: string): void {
    const normalizedPath = normalizePath(targetPath)
    if (normalizedPath === "/" || isInternalAlmostNodePath(normalizedPath) || !vfs.existsSync(normalizedPath)) {
        return
    }

    const stat = vfs.statSync(normalizedPath)
    if (!stat.isDirectory()) {
        vfs.unlinkSync(normalizedPath)
        return
    }

    for (const childName of vfs.readdirSync(normalizedPath)) {
        removeVirtualPath(vfs, path.join(normalizedPath, childName))
    }

    vfs.rmdirSync(normalizedPath)
}

class AlmostNodeVirtualFs extends VirtualFS {
    private suppressMirrorCount = 0

    constructor(private readonly session: AlmostNodeSession) {
        super()
    }

    withoutMirror<T>(operation: () => T): T {
        this.suppressMirrorCount += 1

        try {
            return operation()
        } finally {
            this.suppressMirrorCount -= 1
        }
    }

    private shouldMirror(targetPath: string): boolean {
        return this.suppressMirrorCount === 0 && !isInternalAlmostNodePath(targetPath)
    }

    override writeFileSync(targetPath: string, data: string | Uint8Array): void {
        super.writeFileSync(targetPath, data)

        if (this.shouldMirror(targetPath)) {
            void this.session.applyVirtualWrite(targetPath, data)
        }
    }

    override mkdirSync(targetPath: string, options?: { recursive?: boolean }): void {
        super.mkdirSync(targetPath, options)

        if (this.shouldMirror(targetPath)) {
            void this.session.applyVirtualMkdir(targetPath)
        }
    }

    override unlinkSync(targetPath: string): void {
        super.unlinkSync(targetPath)

        if (this.shouldMirror(targetPath)) {
            void this.session.applyVirtualRemove(targetPath, false)
        }
    }

    override rmdirSync(targetPath: string): void {
        super.rmdirSync(targetPath)

        if (this.shouldMirror(targetPath)) {
            void this.session.applyVirtualRemove(targetPath, true)
        }
    }

    override renameSync(previousPath: string, nextPath: string): void {
        super.renameSync(previousPath, nextPath)

        if (this.shouldMirror(previousPath) && this.shouldMirror(nextPath)) {
            void this.session.applyVirtualRename(previousPath, nextPath)
        }
    }
}

export class AlmostNodeSession {
    private readonly _vfs = new AlmostNodeVirtualFs(this)
    get vfs(): AlmostNodeSessionVfs { return this._vfs }

    private readonly disposeObservableSubscription: () => void
    private initializePromise: Promise<void> | null = null
    private initialized = false
    private pendingOperations = new Set<Promise<void>>()
    private suppressObservableMirrorCount = 0
    private registeredBinCommands = new Set<string>()
    private binCommandRegistrar?: BinCommandRegistrar
    private batchFileLoader?: BatchFileLoader
    private stdoutWriter?: (data: string) => void
    private _stdinHandler: ((data: string) => void) | null = null
    private _terminalColumns = 80
    private _terminalRows = 24
    private viteServer?: ViteDevServer
    private vitePort: number | null = null
    private vitePreviewUrl: string | null = null
    private vitePreviewListener?: VitePreviewListener
    private parsedPackageJsonCache = new Map<string, { raw: string; value: Record<string, unknown> | null }>()
    private transformedTextCache = new Map<string, { source: string; transformed: string }>()

    constructor(private readonly fs: ObservableInMemoryFs) {
        this._vfs.mkdirSync(ALMOSTNODE_INTERNAL_ROOT, { recursive: true })

        // Shim the deprecated `constants` module (missing from almostnode's builtins).
        // Many npm packages still `require('constants')`.
        this._vfs.mkdirSync("/node_modules/constants", { recursive: true })
        this._vfs.writeFileSync("/node_modules/constants/package.json", JSON.stringify({
            name: "constants",
            version: "0.0.1",
            main: "index.js",
        }))
        this._vfs.writeFileSync("/node_modules/constants/index.js", [
            "// Node.js `constants` shim (os.constants + fs.constants)",
            "var os = require('os');",
            "var constants = {};",
            "if (os.constants) {",
            "  if (os.constants.signals) Object.assign(constants, os.constants.signals);",
            "  if (os.constants.errno) Object.assign(constants, os.constants.errno);",
            "  if (os.constants.priority) Object.assign(constants, os.constants.priority);",
            "}",
            "// Common fs.constants used by npm packages",
            "constants.O_RDONLY = 0;",
            "constants.O_WRONLY = 1;",
            "constants.O_RDWR = 2;",
            "constants.O_CREAT = 64;",
            "constants.O_EXCL = 128;",
            "constants.O_TRUNC = 512;",
            "constants.O_APPEND = 1024;",
            "constants.O_DIRECTORY = 65536;",
            "constants.O_NOFOLLOW = 131072;",
            "constants.O_SYNC = 1052672;",
            "constants.O_SYMLINK = 2097152;",
            "constants.O_NONBLOCK = 2048;",
            "constants.S_IFMT = 61440;",
            "constants.S_IFREG = 32768;",
            "constants.S_IFDIR = 16384;",
            "constants.S_IFCHR = 8192;",
            "constants.S_IFBLK = 24576;",
            "constants.S_IFIFO = 4096;",
            "constants.S_IFLNK = 40960;",
            "constants.S_IFSOCK = 49152;",
            "constants.S_IRWXU = 448;",
            "constants.S_IRUSR = 256;",
            "constants.S_IWUSR = 128;",
            "constants.S_IXUSR = 64;",
            "constants.S_IRWXG = 56;",
            "constants.S_IRGRP = 32;",
            "constants.S_IWGRP = 16;",
            "constants.S_IXGRP = 8;",
            "constants.S_IRWXO = 7;",
            "constants.S_IROTH = 4;",
            "constants.S_IWOTH = 2;",
            "constants.S_IXOTH = 1;",
            "constants.F_OK = 0;",
            "constants.R_OK = 4;",
            "constants.W_OK = 2;",
            "constants.X_OK = 1;",
            "constants.COPYFILE_EXCL = 1;",
            "constants.COPYFILE_FICLONE = 2;",
            "constants.COPYFILE_FICLONE_FORCE = 4;",
            "constants.UV_FS_COPYFILE_EXCL = 1;",
            "constants.UV_FS_COPYFILE_FICLONE = 2;",
            "constants.UV_FS_COPYFILE_FICLONE_FORCE = 4;",
            "module.exports = constants;",
        ].join("\n"))

        // Shim `stream/promises` subpath (missing from almostnode's builtins).
        // The stream module has .promises but it's not registered as a subpath.
        this._vfs.mkdirSync("/node_modules/stream", { recursive: true })
        this._vfs.writeFileSync("/node_modules/stream/package.json", JSON.stringify({
            name: "stream",
            version: "0.0.1",
            main: "index.js",
        }))
        this._vfs.writeFileSync("/node_modules/stream/index.js",
            "module.exports = require('stream');")
        this._vfs.mkdirSync("/node_modules/stream/promises", { recursive: true })
        this._vfs.writeFileSync("/node_modules/stream/promises/package.json", JSON.stringify({
            name: "stream-promises",
            version: "0.0.1",
            main: "index.js",
        }))
        this._vfs.writeFileSync("/node_modules/stream/promises/index.js",
            "var stream = require('stream');\nmodule.exports = stream.promises || {};")

        // Shim `stream/web` subpath (missing from almostnode's builtins).
        // Re-exports the browser-native Web Streams API (ReadableStream, WritableStream, etc.)
        this._vfs.mkdirSync("/node_modules/stream/web", { recursive: true })
        this._vfs.writeFileSync("/node_modules/stream/web/package.json", JSON.stringify({
            name: "stream-web",
            version: "0.0.1",
            main: "index.js",
        }))
        this._vfs.writeFileSync("/node_modules/stream/web/index.js", [
            "// Web Streams API shim — re-exports browser globals",
            "module.exports = {",
            "  ReadableStream: typeof ReadableStream !== 'undefined' ? ReadableStream : undefined,",
            "  ReadableStreamDefaultReader: typeof ReadableStreamDefaultReader !== 'undefined' ? ReadableStreamDefaultReader : undefined,",
            "  ReadableStreamBYOBReader: typeof ReadableStreamBYOBReader !== 'undefined' ? ReadableStreamBYOBReader : undefined,",
            "  ReadableStreamDefaultController: typeof ReadableStreamDefaultController !== 'undefined' ? ReadableStreamDefaultController : undefined,",
            "  ReadableByteStreamController: typeof ReadableByteStreamController !== 'undefined' ? ReadableByteStreamController : undefined,",
            "  WritableStream: typeof WritableStream !== 'undefined' ? WritableStream : undefined,",
            "  WritableStreamDefaultWriter: typeof WritableStreamDefaultWriter !== 'undefined' ? WritableStreamDefaultWriter : undefined,",
            "  WritableStreamDefaultController: typeof WritableStreamDefaultController !== 'undefined' ? WritableStreamDefaultController : undefined,",
            "  TransformStream: typeof TransformStream !== 'undefined' ? TransformStream : undefined,",
            "  TransformStreamDefaultController: typeof TransformStreamDefaultController !== 'undefined' ? TransformStreamDefaultController : undefined,",
            "  ByteLengthQueuingStrategy: typeof ByteLengthQueuingStrategy !== 'undefined' ? ByteLengthQueuingStrategy : undefined,",
            "  CountQueuingStrategy: typeof CountQueuingStrategy !== 'undefined' ? CountQueuingStrategy : undefined,",
            "};",
        ].join("\n"))

        this.disposeObservableSubscription = this.fs.subscribe((event) => {
            void this.trackOperation((async () => {
                if (!this.initialized || this.suppressObservableMirrorCount > 0) {
                    return
                }

                const normalizedPath = normalizePath(event.path)
                if (isInternalAlmostNodePath(normalizedPath)) {
                    return
                }

                if (event.event === "unlink" || event.event === "unlinkDir") {
                    this._vfs.withoutMirror(() => {
                        removeVirtualPath(this._vfs, normalizedPath)
                    })
                    return
                }

                await this.copyObservablePathIntoVirtualFs(normalizedPath)
            })())
        })
    }

    dispose(): void {
        this.disposeObservableSubscription()
        this.stopViteServer()
    }

    setBinCommandRegistrar(registrar: BinCommandRegistrar): void {
        this.binCommandRegistrar = registrar
    }

    setBatchFileLoader(loader: BatchFileLoader): void {
        this.batchFileLoader = loader
    }

    setStdoutWriter(writer: ((data: string) => void) | undefined): void {
        this.stdoutWriter = writer
    }

    /** Send data to the stdin of the currently running interactive process. */
    writeStdin(data: string): void {
        this._stdinHandler?.(data)
    }

    /** Update terminal dimensions (used for process.stdout.columns/rows). */
    setTerminalSize(columns: number, rows: number): void {
        this._terminalColumns = columns
        this._terminalRows = rows
    }

    setVitePreviewListener(listener: VitePreviewListener | undefined): void {
        this.vitePreviewListener = listener
        listener?.(this.vitePreviewUrl)
    }

    setViteHmrTarget(target: Window | null): void {
        if (!target || !this.viteServer) {
            return
        }

        this.viteServer.setHMRTarget(target)
    }

    /**
     * Resolve a bare module specifier (e.g. "@mui/material" or "react") to a
     * `/node_modules/...` URL path that the ViteDevServer can serve.
     *
     * Resolution order mirrors Node/bundler conventions:
     *   1. package.json "exports" (condition "import" → "default")
     *   2. package.json "module"
     *   3. package.json "main"
     *   4. index.js / index.mjs fallback
     *
     * For deep imports like "@mui/material/Button", we resolve from the
     * package directory directly.
     */
    private resolveBarePkgEntryCache = new Map<string, string | null>()

    private parseCachedPackageJson(packageJsonPath: string, raw: string): Record<string, unknown> | null {
        const cached = this.parsedPackageJsonCache.get(packageJsonPath)
        if (cached && cached.raw === raw) {
            return cached.value
        }

        try {
            const parsed = JSON.parse(raw) as Record<string, unknown>
            this.parsedPackageJsonCache.set(packageJsonPath, { raw, value: parsed })
            return parsed
        } catch {
            this.parsedPackageJsonCache.set(packageJsonPath, { raw, value: null })
            return null
        }
    }

    private transformTextWithCache(
        cacheKey: string,
        source: string,
        transform: (value: string) => string,
    ): string {
        const cached = this.transformedTextCache.get(cacheKey)
        if (cached && cached.source === source) {
            return cached.transformed
        }

        const transformed = transform(source)
        this.transformedTextCache.set(cacheKey, { source, transformed })
        return transformed
    }

    private resolveBarePkgEntry(specifier: string, root: string): string | null {
        const cacheKey = `${root}\u0000${specifier}`
        const cached = this.resolveBarePkgEntryCache.get(cacheKey)
        if (cached !== undefined) return cached

        const result = this._resolveBarePkgEntry(specifier, root)
        this.resolveBarePkgEntryCache.set(cacheKey, result)
        return result
    }

    private _resolveBarePkgEntry(specifier: string, root: string): string | null {
        // Split specifier into package name + sub-path
        let pkgName: string
        let subPath: string

        if (specifier.startsWith("@")) {
            // scoped: @scope/pkg or @scope/pkg/sub
            const parts = specifier.split("/")
            pkgName = `${parts[0]}/${parts[1]}`
            subPath = parts.slice(2).join("/")
        } else {
            const slashIdx = specifier.indexOf("/")
            if (slashIdx === -1) {
                pkgName = specifier
                subPath = ""
            } else {
                pkgName = specifier.slice(0, slashIdx)
                subPath = specifier.slice(slashIdx + 1)
            }
        }

        const nodeModulesPath = `${root}/node_modules/${pkgName}`
        const pkgJsonPath = `${nodeModulesPath}/package.json`

        let pkgJson: Record<string, unknown> | null = null
        try {
            if (this.vfs.existsSync(pkgJsonPath)) {
                pkgJson = this.parseCachedPackageJson(pkgJsonPath, this.vfs.readFileSync(pkgJsonPath, "utf8"))
            }
        } catch {
            // malformed package.json
        }

        if (subPath) {
            // Deep import: @mui/material/Button → resolve via exports map or direct path
            if (pkgJson?.exports && typeof pkgJson.exports === "object") {
                const exportsMap = pkgJson.exports as Record<string, unknown>
                const entry = this.resolveExportsEntry(exportsMap, `./${subPath}`)
                    ?? this.resolveWildcardExports(exportsMap, subPath)
                if (entry) return `/node_modules/${pkgName}/${stripDotSlash(entry)}`
            }

            // Try direct file paths
            const candidates = [
                `/node_modules/${pkgName}/${subPath}`,
                `/node_modules/${pkgName}/${subPath}.js`,
                `/node_modules/${pkgName}/${subPath}.mjs`,
                `/node_modules/${pkgName}/${subPath}/index.js`,
                `/node_modules/${pkgName}/${subPath}/index.mjs`,
            ]
            for (const candidate of candidates) {
                if (this.vfs.existsSync(`${root}${candidate}`)) return candidate
            }
            return `/node_modules/${pkgName}/${subPath}`
        }

        // Root import: resolve entry point
        if (pkgJson?.exports && typeof pkgJson.exports === "object") {
            const entry = this.resolveExportsEntry(pkgJson.exports as Record<string, unknown>, ".")
            if (entry) return `/node_modules/${pkgName}/${stripDotSlash(entry)}`
        }

        // "module" field (ESM entry)
        if (typeof pkgJson?.module === "string") {
            return `/node_modules/${pkgName}/${stripDotSlash(pkgJson.module)}`
        }

        // "main" field
        if (typeof pkgJson?.main === "string") {
            return `/node_modules/${pkgName}/${stripDotSlash(pkgJson.main)}`
        }

        // Fallback
        const fallbacks = [
            `/node_modules/${pkgName}/index.js`,
            `/node_modules/${pkgName}/index.mjs`,
        ]
        for (const fb of fallbacks) {
            if (this.vfs.existsSync(`${root}${fb}`)) return fb
        }

        return `/node_modules/${pkgName}/index.js`
    }

    private resolveExportsEntry(exports: Record<string, unknown>, key: string): string | null {
        const entry = exports[key]
        if (!entry) {
            // If exports is a single string (shorthand for ".")
            if (key === "." && typeof exports === "string") return exports as unknown as string
            return null
        }

        return this.resolveConditionValue(entry)
    }

    /**
     * Handle wildcard exports like "./*" → { "default": { "default": "./esm/* /index.js" } }
     */
    private resolveWildcardExports(exports: Record<string, unknown>, subPath: string): string | null {
        const wildcardKey = "./*"
        const wildcardEntry = exports[wildcardKey]
        if (!wildcardEntry) return null

        const resolved = this.resolveConditionValue(wildcardEntry)
        if (!resolved) return null

        // Replace * with the actual sub-path
        return resolved.replace(/\*/g, subPath)
    }

    /**
     * Recursively resolve a condition value from an exports entry.
     * Handles: string, { import, module, default, require }, and nested conditions.
     * Skips "types" conditions since we need JS, not .d.ts files.
     *
     * Priority: browser > module > import > default > require
     * "browser" and "module" are preferred because they point to true ESM bundles.
     * "import" is deprioritised because some packages (e.g. @emotion/*) map it to
     * a CJS-to-ESM wrapper (.cjs.mjs) that uses require()/exports which fails
     * in a browser context.
     */
    private resolveConditionValue(value: unknown): string | null {
        if (typeof value === "string") return value
        if (typeof value !== "object" || value === null) return null

        const conditions = value as Record<string, unknown>
        for (const condition of ["browser", "module", "import", "default", "require"]) {
            const condValue = conditions[condition]
            if (condValue === undefined) continue
            // Skip types-only entries
            if (condition === "types") continue
            const resolved = this.resolveConditionValue(condValue)
            if (resolved && !resolved.endsWith(".d.ts") && !resolved.endsWith(".d.cts") && !resolved.endsWith(".d.mts")) {
                return resolved
            }
        }
        return null
    }

    /**
     * Rewrite bare import specifiers in JavaScript source to /node_modules/... paths.
     * When virtualPrefix is provided (e.g. "/__virtual__/5173"), prepends it to
     * resolved paths so the browser stays within the service-worker-routed URL
     * namespace and cascading relative imports keep going through the SW.
     */
    rewriteBareImports(code: string, root: string, virtualPrefix = ""): string {
        // Match: import ... from 'specifier'  /  import 'specifier'  /  export ... from 'specifier'
        // Also dynamic: import('specifier')
        // Must NOT match relative (./ ../) or absolute (/) or URLs (http:// https://)
        //
        // Strip comments (but NOT strings — specifiers live in strings) then
        // run the import/export regex.  To avoid false matches inside string
        // literals (e.g. "forgot to export from the file"), we require the
        // import/export keyword to appear at statement level: preceded by
        // line-start, semicolon, or opening brace.
        // Build a comment-free copy (same length, offsets preserved) so
        // the import/export regex doesn't match inside comments.  Strings
        // are kept intact because specifiers live inside them.  Regex
        // literals are NOT handled — their `//` can be falsely blanked —
        // so we must match on commentFree but apply edits to the original
        // `code` using the same offsets.
        const commentFree = code.replace(
            /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*)/g,
            (m) => {
                if (m.startsWith("/*") || m.startsWith("//")) return " ".repeat(m.length)
                return m
            },
        )

        // Find matches on commentFree, apply replacements to original code
        const importRe = /((?:^|[;\n{])\s*(?:import|export)\s+(?:[\s\S]*?\s+from\s+|)|(?:import\s*\())(['"])([^'".\\/][^'"]*)\2/gm
        let result = code
        let offset = 0
        let m: RegExpExecArray | null
        while ((m = importRe.exec(commentFree)) !== null) {
            const [fullMatch, prefix, quote, specifier] = m
            // Skip URLs
            if (/^https?:\/\//.test(specifier)) continue
            // Skip already-resolved paths
            if (specifier.startsWith("/")) continue

            const resolved = this.resolveBarePkgEntry(specifier, root)
            if (!resolved) continue

            const replacement = `${prefix}${quote}${virtualPrefix}${resolved}${quote}`
            const start = m.index + offset
            const end = start + fullMatch.length
            result = result.slice(0, start) + replacement + result.slice(end)
            offset += replacement.length - fullMatch.length
        }
        return result
    }

    private async serveExistingVirtualStaticFile<TBody extends { length: number }>(
        root: string,
        requestUrl: string,
        bufferCtor: { from(input: string | Uint8Array): TBody },
    ): Promise<{
        statusCode: number
        statusMessage: string
        headers: Record<string, string>
        body: TBody
        resolvedPath: string
    } | null> {
        const basePath = normalizePath(path.join(root, getRequestPathname(requestUrl)))

        // When the request has no file extension, try common JS extensions
        // and also resolve directory package.json entry points
        const hasExtension = /\.[a-zA-Z0-9]+$/.test(path.basename(basePath))
        let candidates: string[]
        if (hasExtension) {
            candidates = [basePath]
        } else {
            candidates = [basePath, `${basePath}.js`, `${basePath}.mjs`, `${basePath}.jsx`, `${basePath}/index.js`, `${basePath}/index.mjs`]
            const pkgPath = `${basePath}/package.json`

            try {
                if (this.vfs.existsSync(pkgPath)) {
                    const raw = this.vfs.readFileSync(pkgPath, "utf8")
                    const pkg = this.parseCachedPackageJson(pkgPath, raw)
                    const entry = pkg
                        ? (typeof pkg.module === "string" && pkg.module) || (typeof pkg.main === "string" && pkg.main)
                        : null
                    if (entry) candidates.push(normalizePath(path.join(basePath, entry)))
                }
            } catch { /* ignore */ }

            try {
                if (await this.fs.exists(pkgPath)) {
                    const raw = await this.fs.readFile(pkgPath, "utf-8")
                    const pkg = this.parseCachedPackageJson(pkgPath, raw as string)
                    const entry = pkg
                        ? (typeof pkg.module === "string" && pkg.module) || (typeof pkg.main === "string" && pkg.main)
                        : null
                    if (entry) candidates.push(normalizePath(path.join(basePath, entry)))
                }
            } catch { /* ignore */ }
        }

        // Try VFS first (already-loaded files)
        for (const targetPath of candidates) {
            try {
                const stat = this.vfs.statSync(targetPath)
                if (stat.isDirectory()) {
                    continue
                }

                const content = this.vfs.readFileSync(targetPath)
                const body = typeof content === "string"
                    ? bufferCtor.from(content)
                    : bufferCtor.from(content)

                return {
                    statusCode: 200,
                    statusMessage: "OK",
                    headers: {
                        "Content-Type": getStaticMimeType(targetPath),
                        "Content-Length": String(body.length),
                        "Cache-Control": "no-cache",
                    },
                    body,
                    resolvedPath: targetPath,
                }
            } catch {
                // not in VFS – continue trying
            }
        }

        // On-demand: load from observable FS (lazy files hydrated from server)
        for (const targetPath of candidates) {
            try {
                if (!(await this.fs.exists(targetPath))) {
                    continue
                }

                const stat = await this.fs.stat(targetPath)
                if (stat.isDirectory) {
                    continue
                }

                const content = await this.fs.readFileBuffer(targetPath)

                // Populate VFS so subsequent requests are fast
                this._vfs.withoutMirror(() => {
                    this._vfs.mkdirSync(path.dirname(targetPath), { recursive: true })
                    this._vfs.writeFileSync(targetPath, content)
                })

                const body = bufferCtor.from(content)

                return {
                    statusCode: 200,
                    statusMessage: "OK",
                    headers: {
                        "Content-Type": getStaticMimeType(targetPath),
                        "Content-Length": String(body.length),
                        "Cache-Control": "no-cache",
                    },
                    body,
                    resolvedPath: targetPath,
                }
            } catch {
                // continue trying next candidate
            }
        }

        return null
    }

    private stopViteServer(): void {
        if (this.viteServer) {
            this.viteServer.stop()
            this.viteServer = undefined
        }

        if (this.vitePort !== null) {
            try {
                getServerBridge().unregisterServer(this.vitePort)
            } catch {
                // ignore if not registered
            }
        }

        this.vitePort = null
        this.vitePreviewUrl = null
        this.vitePreviewListener?.(null)
    }

    private resolveBinFromPackageJson(
        binName: string,
        packageName: string,
        pkgJson: Record<string, unknown>,
        pkgDir: string,
    ): string | null {
        if (typeof pkgJson.bin === "string") {
            const inferredBinName = typeof pkgJson.name === "string"
                ? pkgJson.name.split("/").pop() ?? pkgJson.name
                : packageName.split("/").pop() ?? packageName

            if (binName === inferredBinName) {
                return normalizePath(path.join(pkgDir, pkgJson.bin))
            }
        }

        if (typeof pkgJson.bin === "object" && pkgJson.bin !== null && binName in pkgJson.bin) {
            const namedBins = pkgJson.bin as Record<string, string>
            return normalizePath(path.join(pkgDir, namedBins[binName]))
        }

        return null
    }

    private async resolveNpmBinPath(binName: string, cwd: string): Promise<string | null> {
        const candidatePackageNames = [binName]
        const packageJsonResult = await this.readPackageJson(cwd)

        if ("pkgJson" in packageJsonResult) {
            for (const packageName of getPackageJsonDependencyNames(packageJsonResult.pkgJson)) {
                if (!candidatePackageNames.includes(packageName)) {
                    candidatePackageNames.push(packageName)
                }
            }
        }

        // Check local node_modules first
        for (const packageName of candidatePackageNames) {
            const pkgJsonPath = normalizePath(path.join(cwd, "node_modules", packageName, "package.json"))

            if (!(await this.fs.exists(pkgJsonPath))) {
                continue
            }

            try {
                const content = await this.fs.readFile(pkgJsonPath, "utf-8")
                const pkgJson = this.parseCachedPackageJson(pkgJsonPath, content as string)
                if (!pkgJson) {
                    continue
                }

                const pkgDir = normalizePath(path.join(cwd, "node_modules", packageName))
                const result = this.resolveBinFromPackageJson(binName, packageName, pkgJson, pkgDir)
                if (result) return result
            } catch {
                // ignore parse errors
            }
        }

        // Fallback: check global node_modules
        const globalResult = await this.resolveGlobalBinPath(binName)
        if (globalResult) return globalResult

        return null
    }

    private async resolveGlobalBinPath(binName: string): Promise<string | null> {
        try {
            const globalModulesDir = GLOBAL_NODE_MODULES_ROOT
            if (!this._vfs.existsSync(globalModulesDir)) return null

            const globalPackages = this._vfs.readdirSync(globalModulesDir)
            for (const entry of globalPackages) {
                const packageName = entry
                const pkgJsonPath = normalizePath(path.join(globalModulesDir, packageName, "package.json"))

                if (!this._vfs.existsSync(pkgJsonPath)) {
                    // Check for scoped packages
                    if (entry.startsWith("@")) {
                        try {
                            const scopeDir = normalizePath(path.join(globalModulesDir, entry))
                            const scopedPackages = this._vfs.readdirSync(scopeDir)
                            for (const scopedPkg of scopedPackages) {
                                const scopedName = `${entry}/${scopedPkg}`
                                const scopedPkgJsonPath = normalizePath(path.join(globalModulesDir, scopedName, "package.json"))
                                if (!this._vfs.existsSync(scopedPkgJsonPath)) continue

                                const raw = this._vfs.readFileSync(scopedPkgJsonPath, "utf8")
                                const pkgJson = this.parseCachedPackageJson(scopedPkgJsonPath, raw)
                                if (!pkgJson) continue

                                const pkgDir = normalizePath(path.join(globalModulesDir, scopedName))
                                const result = this.resolveBinFromPackageJson(binName, scopedName, pkgJson, pkgDir)
                                if (result) return result
                            }
                        } catch { /* ignore */ }
                    }
                    continue
                }

                try {
                    const raw = this._vfs.readFileSync(pkgJsonPath, "utf8")
                    const pkgJson = this.parseCachedPackageJson(pkgJsonPath, raw)
                    if (!pkgJson) continue

                    const pkgDir = normalizePath(path.join(globalModulesDir, packageName))
                    const result = this.resolveBinFromPackageJson(binName, packageName, pkgJson, pkgDir)
                    if (result) return result
                } catch { /* ignore */ }
            }
        } catch { /* ignore */ }

        return null
    }

    /**
     * Replace lru-cache CJS entry points with a browser-safe implementation.
     *
     * lru-cache v11's minified CJS uses `require("node:diagnostics_channel")`
     * and private class fields (`static #t`) which can fail inside the browser
     * WASM runtime's `eval()` context, leaving `exports.LRUCache` undefined
     * ("TypeError: LRUCache is not a constructor").
     *
     * The fix: overwrite the CJS entry with a clean Map-based LRU cache that
     * covers the full API surface used by lru-cache consumers (hosted-git-info,
     * path-scurry, glob, etc.) without any diagnostics_channel dependency or
     * private class fields.
     */
    private patchLruCacheInNodeModules(nodeModulesDir: string): void {
        const lruCacheShim = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LRUCache = void 0;
var LRUCache = (function () {
  function LRUCache(options) {
    if (typeof options === "number") options = { max: options };
    if (!options) options = {};
    this._max = options.max || Infinity;
    this._maxSize = options.maxSize || 0;
    this._sizeCalculation = options.sizeCalculation || null;
    this._dispose = options.dispose || null;
    this._allowStale = !!options.allowStale;
    this._ttl = options.ttl || 0;
    this._noUpdateTTL = !!options.noUpdateTTL;
    this._map = new Map();
    this._order = [];
    this._sizes = new Map();
    this._totalSize = 0;
    this._timers = new Map();
  }
  Object.defineProperty(LRUCache.prototype, "size", { get: function () { return this._map.size; } });
  Object.defineProperty(LRUCache.prototype, "max", { get: function () { return this._max; } });
  Object.defineProperty(LRUCache.prototype, "maxSize", { get: function () { return this._maxSize; } });
  Object.defineProperty(LRUCache.prototype, "calculatedSize", { get: function () { return this._totalSize; } });
  LRUCache.prototype._touch = function (key) {
    var idx = this._order.indexOf(key);
    if (idx > -1) this._order.splice(idx, 1);
    this._order.push(key);
  };
  LRUCache.prototype._evict = function () {
    while (this._order.length > 0 && (this._map.size > this._max || (this._maxSize > 0 && this._totalSize > this._maxSize))) {
      var oldest = this._order.shift();
      if (oldest !== undefined && this._map.has(oldest)) {
        var val = this._map.get(oldest);
        this._map.delete(oldest);
        if (this._sizes.has(oldest)) { this._totalSize -= this._sizes.get(oldest); this._sizes.delete(oldest); }
        if (this._timers.has(oldest)) { clearTimeout(this._timers.get(oldest)); this._timers.delete(oldest); }
        if (this._dispose) this._dispose(val, oldest, "evict");
      }
    }
  };
  LRUCache.prototype._isStale = function (key) {
    return false; // TTL timers handle expiry via delete
  };
  LRUCache.prototype.set = function (key, value, options) {
    if (value === undefined) { this.delete(key); return this; }
    var opts = options || {};
    var size = 0;
    if (this._maxSize > 0) {
      size = opts.size || 0;
      if (!size && this._sizeCalculation) size = this._sizeCalculation(value, key);
      if (size > this._maxSize) return this;
    }
    if (this._map.has(key)) {
      var old = this._map.get(key);
      if (this._sizes.has(key)) { this._totalSize -= this._sizes.get(key); }
      if (this._timers.has(key)) { clearTimeout(this._timers.get(key)); this._timers.delete(key); }
      if (this._dispose && !opts.noDisposeOnSet) this._dispose(old, key, "set");
    }
    this._map.set(key, value);
    this._touch(key);
    if (this._maxSize > 0 && size > 0) { this._sizes.set(key, size); this._totalSize += size; }
    var ttl = opts.ttl !== undefined ? opts.ttl : this._ttl;
    if (ttl > 0) {
      var self = this;
      this._timers.set(key, setTimeout(function () { self.delete(key); }, ttl));
    }
    this._evict();
    return this;
  };
  LRUCache.prototype.get = function (key, options) {
    if (!this._map.has(key)) return undefined;
    var value = this._map.get(key);
    this._touch(key);
    return value;
  };
  LRUCache.prototype.peek = function (key) {
    return this._map.get(key);
  };
  LRUCache.prototype.has = function (key) {
    return this._map.has(key);
  };
  LRUCache.prototype.delete = function (key) {
    if (!this._map.has(key)) return false;
    var val = this._map.get(key);
    this._map.delete(key);
    var idx = this._order.indexOf(key);
    if (idx > -1) this._order.splice(idx, 1);
    if (this._sizes.has(key)) { this._totalSize -= this._sizes.get(key); this._sizes.delete(key); }
    if (this._timers.has(key)) { clearTimeout(this._timers.get(key)); this._timers.delete(key); }
    if (this._dispose) this._dispose(val, key, "delete");
    return true;
  };
  LRUCache.prototype.clear = function () {
    var self = this;
    if (this._dispose) {
      this._map.forEach(function (val, key) { self._dispose(val, key, "delete"); });
    }
    this._timers.forEach(function (t) { clearTimeout(t); });
    this._map.clear();
    this._order.length = 0;
    this._sizes.clear();
    this._totalSize = 0;
    this._timers.clear();
  };
  LRUCache.prototype.keys = function () { return this._map.keys(); };
  LRUCache.prototype.values = function () { return this._map.values(); };
  LRUCache.prototype.entries = function () { return this._map.entries(); };
  LRUCache.prototype.find = function (fn, options) {
    for (var it = this._map.entries(), r; !(r = it.next()).done;) {
      if (fn(r.value[1], r.value[0], this)) return this.get(r.value[0], options);
    }
  };
  LRUCache.prototype.forEach = function (fn, thisArg) {
    var self = this;
    this._map.forEach(function (val, key) { fn.call(thisArg || self, val, key, self); });
  };
  LRUCache.prototype.dump = function () { return []; };
  LRUCache.prototype.load = function (arr) {
    this.clear();
    for (var i = 0; i < arr.length; i++) { this.set(arr[i][0], arr[i][1].value, arr[i][1]); }
  };
  LRUCache.prototype.pop = function () {
    if (this._order.length === 0) return undefined;
    var oldest = this._order[0];
    var val = this._map.get(oldest);
    this.delete(oldest);
    return val;
  };
  LRUCache.prototype.purgeStale = function () { return false; };
  LRUCache.prototype.getRemainingTTL = function (key) { return this._map.has(key) ? Infinity : 0; };
  LRUCache.prototype.info = function (key) {
    if (!this._map.has(key)) return undefined;
    return { value: this._map.get(key) };
  };
  LRUCache.prototype[Symbol.iterator] = function () { return this._map.entries(); };
  LRUCache.prototype[Symbol.toStringTag] = "LRUCache";
  return LRUCache;
})();
exports.LRUCache = LRUCache;
`

        const patchDir = (lruDir: string) => {
            // Overwrite all possible CJS entry points
            const cjsPaths = [
                normalizePath(path.join(lruDir, "dist", "commonjs", "index.min.js")),
                normalizePath(path.join(lruDir, "dist", "commonjs", "index.js")),
                // Also try the package root index (lru-cache v7 style)
                normalizePath(path.join(lruDir, "index.js")),
            ]
            let patched = false
            for (const p of cjsPaths) {
                if (this._vfs.existsSync(p)) {
                    this._vfs.writeFileSync(p, lruCacheShim)
                    patched = true
                }
            }
            // If no known entry was found, check package.json for the actual main field
            if (!patched) {
                const pkgPath = normalizePath(path.join(lruDir, "package.json"))
                if (this._vfs.existsSync(pkgPath)) {
                    try {
                        const pkg = JSON.parse(this._vfs.readFileSync(pkgPath, "utf8") as string)
                        const mainField = pkg.main || pkg.exports?.["."]?.require?.default || pkg.exports?.["."]?.require
                        if (mainField && typeof mainField === "string") {
                            const mainPath = normalizePath(path.join(lruDir, mainField))
                            if (this._vfs.existsSync(mainPath)) {
                                this._vfs.writeFileSync(mainPath, lruCacheShim)
                                patched = true
                            }
                        }
                    } catch { /* ignore parse errors */ }
                }
            }
            return patched
        }

        // Recursively find all lru-cache directories in node_modules
        let patchCount = 0
        const walkNodeModules = (nmDir: string) => {
            if (!this._vfs.existsSync(nmDir)) return
            let entries: string[]
            try {
                entries = this._vfs.readdirSync(nmDir)
            } catch { return }
            for (const entry of entries) {
                if (entry === "lru-cache") {
                    const lruDir = normalizePath(path.join(nmDir, "lru-cache"))
                    if (patchDir(lruDir)) patchCount++
                }
                // Scoped packages (@scope/pkg)
                if (entry.startsWith("@")) {
                    const scopeDir = normalizePath(path.join(nmDir, entry))
                    try {
                        for (const scopedEntry of this._vfs.readdirSync(scopeDir)) {
                            // Check for lru-cache nested inside scoped package
                            const nestedNm = normalizePath(path.join(scopeDir, scopedEntry, "node_modules"))
                            if (this._vfs.existsSync(nestedNm)) {
                                walkNodeModules(nestedNm)
                            }
                        }
                    } catch { /* ignore */ }
                } else {
                    // Check nested node_modules inside each package
                    const nestedNm = normalizePath(path.join(nmDir, entry, "node_modules"))
                    if (this._vfs.existsSync(nestedNm)) {
                        walkNodeModules(nestedNm)
                    }
                }
            }
        }

        walkNodeModules(nodeModulesDir)

        if (patchCount === 0) {
            console.warn(`[agent-web-os] lru-cache patch: no lru-cache found in ${nodeModulesDir}`)
        } else {
            console.log(`[agent-web-os] lru-cache patch: patched ${patchCount} installation(s) in ${nodeModulesDir}`)
        }
    }

    private async registerGlobalBinCommands(packageName: string): Promise<void> {
        if (!this.binCommandRegistrar) return

        const pkgJsonPath = normalizePath(path.join(GLOBAL_NODE_MODULES_ROOT, packageName, "package.json"))
        if (!this._vfs.existsSync(pkgJsonPath)) return

        try {
            const raw = this._vfs.readFileSync(pkgJsonPath, "utf8")
            const pkgJson = this.parseCachedPackageJson(pkgJsonPath, raw)
            if (!pkgJson) return

            let binNames: string[]
            if (typeof pkgJson.bin === "string") {
                const name = typeof pkgJson.name === "string"
                    ? pkgJson.name.split("/").pop() ?? ""
                    : ""
                binNames = name ? [name] : []
            } else if (typeof pkgJson.bin === "object" && pkgJson.bin !== null) {
                binNames = Object.keys(pkgJson.bin)
            } else {
                binNames = []
            }

            for (const binName of binNames) {
                if (this.registeredBinCommands.has(binName)) continue
                this.registeredBinCommands.add(binName)

                this.binCommandRegistrar(binName, async (args, ctx) => {
                    const resolvedPath = await this.resolveGlobalBinPath(binName)
                        ?? await this.resolveNpmBinPath(binName, normalizePath(ctx.cwd))
                    if (!resolvedPath) {
                        return {
                            stdout: "",
                            stderr: `bash: ${binName}: command not found\n`,
                            exitCode: 127,
                        }
                    }

                    return this.executeNode([resolvedPath, ...args], ctx)
                })
            }
        } catch { /* ignore */ }
    }

    private async resolveAndRegisterBinCommands(command: string, cwd: string): Promise<void> {
        if (!this.binCommandRegistrar) {
            return
        }

        const potentialBins = command.split(/&&|\|\||;|\|/).flatMap((part) => {
            const words = part.trim().split(/\s+/)
            for (const word of words) {
                if (!word || word.includes("=") || word.startsWith("/") || word.startsWith("./") || word.startsWith("..")) {
                    continue
                }

                return [word]
            }

            return []
        })

        for (const binName of potentialBins) {
            if (this.registeredBinCommands.has(binName)) {
                continue
            }

            const binPath = await this.resolveNpmBinPath(binName, cwd)
            if (!binPath) {
                continue
            }

            this.registeredBinCommands.add(binName)

            if (binName === "vite") {
                this.binCommandRegistrar(binName, async (args, ctx) => {
                    return this.executeVite(args, ctx)
                })
                continue
            }

            this.binCommandRegistrar(binName, async (args, ctx) => {
                const resolvedPath = await this.resolveNpmBinPath(binName, normalizePath(ctx.cwd))
                if (!resolvedPath) {
                    return {
                        stdout: "",
                        stderr: `bash: ${binName}: command not found\n`,
                        exitCode: 127,
                    }
                }

                return this.executeNode([resolvedPath, ...args], ctx)
            })
        }
    }

    private trackOperation(operation: Promise<void>): Promise<void> {
        this.pendingOperations.add(operation)

        return operation.finally(() => {
            this.pendingOperations.delete(operation)
        })
    }

    private async flushPendingOperations(): Promise<void> {
        while (this.pendingOperations.size > 0) {
            await Promise.all(Array.from(this.pendingOperations))
        }
    }

    private async withSuppressedObservableMirroring<T>(operation: () => Promise<T>): Promise<T> {
        this.suppressObservableMirrorCount += 1

        try {
            return await operation()
        } finally {
            this.suppressObservableMirrorCount -= 1
        }
    }

    private async copyObservablePathIntoVirtualFs(targetPath: string, options?: { force?: boolean }): Promise<void> {
        const normalizedPath = normalizePath(targetPath)
        if (isInternalAlmostNodePath(normalizedPath)) {
            return
        }

        if (!options?.force && this.fs.isPathLazy(normalizedPath)) {
            return
        }

        try {
            const stat = await this.fs.stat(normalizedPath)

            if (stat.isDirectory) {
                this._vfs.withoutMirror(() => {
                    this._vfs.mkdirSync(normalizedPath, { recursive: true })
                })
                return
            }

            const content = await this.fs.readFileBuffer(normalizedPath)
            this._vfs.withoutMirror(() => {
                this._vfs.mkdirSync(path.dirname(normalizedPath), { recursive: true })
                this._vfs.writeFileSync(normalizedPath, content)
            })
        } catch {
            this._vfs.withoutMirror(() => {
                removeVirtualPath(this._vfs, normalizedPath)
            })
        }
    }

    private getNodeModulesPackageRoot(targetPath: string): string | null {
        const normalizedPath = normalizePath(targetPath)
        const nodeModulesMarker = "/node_modules/"
        const nodeModulesIndex = normalizedPath.indexOf(nodeModulesMarker)

        if (nodeModulesIndex === -1) {
            return null
        }

        const packageSegments = normalizedPath.slice(nodeModulesIndex + nodeModulesMarker.length).split("/").filter(Boolean)
        if (packageSegments.length === 0) {
            return null
        }

        const packageNameSegments = packageSegments[0]?.startsWith("@")
            ? packageSegments.slice(0, 2)
            : packageSegments.slice(0, 1)

        if (packageNameSegments.length === 0) {
            return null
        }

        return normalizePath(`${normalizedPath.slice(0, nodeModulesIndex + nodeModulesMarker.length)}${packageNameSegments.join("/")}`)
    }

    private async hydrateObservablePackageIntoVirtualFs(packageRoot: string): Promise<void> {
        const normalizedPackageRoot = normalizePath(packageRoot)
        const packagePaths = Array.from(new Set(this.fs.getAllPaths().map((targetPath) => normalizePath(targetPath))))
            .filter((targetPath) => targetPath === normalizedPackageRoot || targetPath.startsWith(`${normalizedPackageRoot}/`))
            .sort((leftPath, rightPath) => leftPath.split("/").length - rightPath.split("/").length)

        await this.hydrateObservablePathsIntoVirtualFs(packagePaths)
    }

    private async hydrateObservablePathsIntoVirtualFs(targetPaths: string[]): Promise<void> {
        const normalizedPaths = Array.from(new Set(targetPaths.map((targetPath) => normalizePath(targetPath))))
            .sort((leftPath, rightPath) => leftPath.split("/").length - rightPath.split("/").length)

        const lazyFilePaths: string[] = []

        for (const targetPath of normalizedPaths) {
            try {
                if (this.fs.isPathLazy(targetPath)) {
                    lazyFilePaths.push(targetPath)
                    continue
                }

                const stat = await this.fs.stat(targetPath)

                if (stat.isDirectory) {
                    this._vfs.withoutMirror(() => {
                        this._vfs.mkdirSync(targetPath, { recursive: true })
                    })
                    continue
                }

                await this.copyObservablePathIntoVirtualFs(targetPath, { force: true })
            } catch {
                // ignore paths that disappear during hydration
            }
        }

        if (lazyFilePaths.length === 0) {
            return
        }

        if (this.batchFileLoader) {
            const contents = await this.batchFileLoader(lazyFilePaths)

            await this.fs.suppressObservability(async () => {
                for (const [filePath, content] of contents) {
                    this.fs.writeFileSync(filePath, content)
                }
            })

            this._vfs.withoutMirror(() => {
                for (const [filePath, content] of contents) {
                    this._vfs.mkdirSync(path.dirname(filePath), { recursive: true })
                    this._vfs.writeFileSync(filePath, content)
                }
            })

            const missingPaths = lazyFilePaths.filter((lazyPath) => !contents.has(lazyPath))
            for (const missingPath of missingPaths) {
                await this.copyObservablePathIntoVirtualFs(missingPath, { force: true })
            }
            return
        }

        for (const lazyPath of lazyFilePaths) {
            await this.copyObservablePathIntoVirtualFs(lazyPath, { force: true })
        }
    }

    private async hydrateObservableDependencyPackagesIntoVirtualFs(cwd: string): Promise<void> {
        const packageJsonResult = await this.readPackageJson(cwd)
        if ("error" in packageJsonResult) {
            return
        }

        const dependencyPaths: string[] = []

        for (const packageName of getPackageJsonDependencyNames(packageJsonResult.pkgJson)) {
            const packageRoot = normalizePath(path.join(cwd, "node_modules", packageName))

            if (!(await this.fs.exists(packageRoot))) {
                continue
            }

            for (const targetPath of this.fs.getAllPaths()) {
                const normalizedPath = normalizePath(targetPath)
                if (normalizedPath === packageRoot || normalizedPath.startsWith(`${packageRoot}/`)) {
                    dependencyPaths.push(normalizedPath)
                }
            }
        }

        await this.hydrateObservablePathsIntoVirtualFs(dependencyPaths)
    }

    private async hydrateObservableProjectIntoVirtualFs(cwd: string): Promise<void> {
        const normalizedCwd = normalizePath(cwd)
        const cwdPrefix = normalizedCwd.endsWith("/") ? normalizedCwd : `${normalizedCwd}/`
        const projectPaths = Array.from(new Set(this.fs.getAllPaths().map((targetPath) => normalizePath(targetPath))))
            .filter((targetPath) => {
                if (isInternalAlmostNodePath(targetPath)) {
                    return false
                }

                if (targetPath !== normalizedCwd && !targetPath.startsWith(cwdPrefix)) {
                    return false
                }

                return !targetPath.startsWith(`${cwdPrefix}node_modules/`)
            })
            .sort((leftPath, rightPath) => leftPath.split("/").length - rightPath.split("/").length)

        await this.hydrateObservablePathsIntoVirtualFs(projectPaths)
    }

    async applyVirtualWrite(targetPath: string, data: string | Uint8Array): Promise<void> {
        return this.trackOperation((async () => {
            const normalizedPath = normalizePath(targetPath)
            if (isInternalAlmostNodePath(normalizedPath)) {
                return
            }

            await this.withSuppressedObservableMirroring(async () => {
                await ensureObservableDirectory(this.fs, path.dirname(normalizedPath))
                await this.fs.writeFile(normalizedPath, data)
            })
        })())
    }

    async applyVirtualMkdir(targetPath: string): Promise<void> {
        return this.trackOperation((async () => {
            const normalizedPath = normalizePath(targetPath)
            if (isInternalAlmostNodePath(normalizedPath)) {
                return
            }

            await this.withSuppressedObservableMirroring(async () => {
                await this.fs.mkdir(normalizedPath, { recursive: true })
            })
        })())
    }

    async applyVirtualRemove(targetPath: string, recursive: boolean): Promise<void> {
        return this.trackOperation((async () => {
            const normalizedPath = normalizePath(targetPath)
            if (isInternalAlmostNodePath(normalizedPath)) {
                return
            }

            await this.withSuppressedObservableMirroring(async () => {
                await this.fs.rm(normalizedPath, { force: true, recursive })
            })
        })())
    }

    async applyVirtualRename(previousPath: string, nextPath: string): Promise<void> {
        return this.trackOperation((async () => {
            const normalizedPreviousPath = normalizePath(previousPath)
            const normalizedNextPath = normalizePath(nextPath)
            if (isInternalAlmostNodePath(normalizedPreviousPath) || isInternalAlmostNodePath(normalizedNextPath)) {
                return
            }

            await this.withSuppressedObservableMirroring(async () => {
                await ensureObservableDirectory(this.fs, path.dirname(normalizedNextPath))
                await this.fs.mv(normalizedPreviousPath, normalizedNextPath)
            })
        })())
    }

    private async ensureInitialized(): Promise<void> {
        if (this.initialized) {
            return
        }

        if (!this.initializePromise) {
            this.initializePromise = (async () => {
                const allPaths = Array.from(new Set(this.fs.getAllPaths().map((targetPath) => normalizePath(targetPath))))
                    .filter((targetPath) => !isInternalAlmostNodePath(targetPath))
                    .sort((leftPath, rightPath) => leftPath.split("/").length - rightPath.split("/").length)

                for (const targetPath of allPaths) {
                    await this.copyObservablePathIntoVirtualFs(targetPath)
                }

                this.initialized = true
            })()
        }

        await this.initializePromise
    }

    private async readPackageJson(cwd: string): Promise<{ pkgJson: PackageJsonLike } | { error: ExecResult }> {
        const packageJsonPath = normalizePath(path.join(cwd, "package.json"))

        if (!this.vfs.existsSync(packageJsonPath)) {
            await this.copyObservablePathIntoVirtualFs(packageJsonPath, { force: true })
        }

        if (!this.vfs.existsSync(packageJsonPath)) {
            return {
                error: {
                    stdout: "",
                    stderr: "npm ERR! no package.json found\n",
                    exitCode: 1,
                },
            }
        }

        try {
            return {
                pkgJson: (this.parseCachedPackageJson(packageJsonPath, this.vfs.readFileSync(packageJsonPath, "utf8")) ?? {}) as PackageJsonLike,
            }
        } catch {
            return {
                error: {
                    stdout: "",
                    stderr: "npm ERR! Failed to parse package.json\n",
                    exitCode: 1,
                },
            }
        }
    }

    private async runNpmScript(scriptName: string | undefined, cwd: string, ctx: CommandContext): Promise<ExecResult> {
        if (!scriptName) {
            const packageJsonResult = await this.readPackageJson(cwd)
            if ("error" in packageJsonResult) {
                return packageJsonResult.error
            }

            const scripts = packageJsonResult.pkgJson.scripts || {}
            const scriptNames = Object.keys(scripts)
            if (scriptNames.length === 0) {
                return { stdout: "", stderr: "", exitCode: 0 }
            }

            const lifecycleScripts = new Set([
                "prestart",
                "start",
                "poststart",
                "pretest",
                "test",
                "posttest",
                "prestop",
                "stop",
                "poststop",
            ])
            const lifecycleNames = scriptNames.filter((name) => lifecycleScripts.has(name))
            const customNames = scriptNames.filter((name) => !lifecycleScripts.has(name))

            let stdout = `Lifecycle scripts included in ${packageJsonResult.pkgJson.name || ""}:\n`
            for (const listedScriptName of lifecycleNames) {
                stdout += `  ${listedScriptName}\n    ${scripts[listedScriptName]}\n`
            }

            if (customNames.length > 0) {
                stdout += "\navailable via `npm run-script`:\n"
                for (const listedScriptName of customNames) {
                    stdout += `  ${listedScriptName}\n    ${scripts[listedScriptName]}\n`
                }
            }

            return { stdout, stderr: "", exitCode: 0 }
        }

        const packageJsonResult = await this.readPackageJson(cwd)
        if ("error" in packageJsonResult) {
            return packageJsonResult.error
        }

        const { pkgJson } = packageJsonResult
        const scripts = pkgJson.scripts || {}
        const scriptCommand = scripts[scriptName]
        if (!scriptCommand) {
            const availableScripts = Object.keys(scripts)
            let stderr = `npm ERR! Missing script: "${scriptName}"\n`

            if (availableScripts.length > 0) {
                stderr += "\nnpm ERR! Available scripts:\n"
                for (const availableScript of availableScripts) {
                    stderr += `npm ERR!   ${availableScript}\n`
                    stderr += `npm ERR!     ${scripts[availableScript]}\n`
                }
            }

            return { stdout: "", stderr, exitCode: 1 }
        }

        if (!ctx.exec) {
            return {
                stdout: "",
                stderr: "npm ERR! Script execution not available in this context\n",
                exitCode: 1,
            }
        }

        await this.resolveAndRegisterBinCommands(scriptCommand, cwd)

        const preScriptCommand = scripts[`pre${scriptName}`]
        if (preScriptCommand) {
            await this.resolveAndRegisterBinCommands(preScriptCommand, cwd)
        }

        const postScriptCommand = scripts[`post${scriptName}`]
        if (postScriptCommand) {
            await this.resolveAndRegisterBinCommands(postScriptCommand, cwd)
        }

        const execCommand = ctx.exec

        const baseEnv = getCommandEnvironment(ctx)
        const npmEnv: Record<string, string> = {
            ...baseEnv,
            npm_lifecycle_event: scriptName,
            PATH: Array.from(new Set([
                normalizePath(path.join(cwd, "node_modules/.bin")),
                "/node_modules/.bin",
                `${GLOBAL_NODE_MODULES_ROOT}/.bin`,
                ...(baseEnv.PATH?.trim() || DEFAULT_PATH).split(":").filter(Boolean),
            ])).join(":"),
        }

        if (pkgJson.name) {
            npmEnv.npm_package_name = pkgJson.name
        }

        if (pkgJson.version) {
            npmEnv.npm_package_version = pkgJson.version
        }

        let stdout = ""
        let stderr = ""
        const label = `${pkgJson.name || ""}@${pkgJson.version || ""}`

        const runScript = async (name: string, command: string) => {
            stderr += `\n> ${label} ${name}\n> ${command}\n\n`
            const result = await execCommand(command, { cwd, env: npmEnv })
            stdout += result.stdout
            stderr += result.stderr
            return result
        }

        if (preScriptCommand) {
            const preResult = await runScript(`pre${scriptName}`, preScriptCommand)
            if (preResult.exitCode !== 0) {
                return { stdout, stderr, exitCode: preResult.exitCode }
            }
        }

        const mainResult = await runScript(scriptName, scriptCommand)
        if (mainResult.exitCode !== 0) {
            return { stdout, stderr, exitCode: mainResult.exitCode }
        }

        if (postScriptCommand) {
            const postResult = await runScript(`post${scriptName}`, postScriptCommand)
            if (postResult.exitCode !== 0) {
                return { stdout, stderr, exitCode: postResult.exitCode }
            }
        }

        return { stdout, stderr, exitCode: 0 }
    }

    async executeNpm(args: string[], ctx: CommandContext): Promise<ExecResult> {
        const cwd = normalizePath(ctx.cwd)

        await this.ensureInitialized()
        await this.flushPendingOperations()

        const subcommand = args[0]
        let result: ExecResult

        switch (subcommand) {
            case undefined:
            case "help":
            case "--help":
                result = { stdout: `${NPM_USAGE}\n`, stderr: "", exitCode: 0 }
                break
            case "-v":
            case "--version":
                result = { stdout: `${ALMOSTNODE_NPM_VERSION}\n`, stderr: "", exitCode: 0 }
                break
            case "run":
            case "run-script":
                result = await this.runNpmScript(args[1], cwd, ctx)
                break
            case "start":
                result = await this.runNpmScript("start", cwd, ctx)
                break
            case "test":
            case "t":
            case "tst":
                result = await this.runNpmScript("test", cwd, ctx)
                break
            case "install":
            case "i":
            case "add": {
                const isGlobal = args.includes("-g") || args.includes("--global")
                const packageSpecs = args.slice(1).filter((arg) => !arg.startsWith("-"))
                let stdout = ""

                try {
                    if (isGlobal) {
                        if (packageSpecs.length === 0) {
                            result = { stdout: "", stderr: "npm ERR! npm install -g requires a package name\n", exitCode: 1 }
                            break
                        }

                        await ensureEsbuildWasm()

                        // Ensure the global node_modules directory exists
                        this._vfs.mkdirSync(GLOBAL_NODE_MODULES_ROOT, { recursive: true })
                        await ensureObservableDirectory(this.fs, GLOBAL_NODE_MODULES_ROOT)

                        // Ensure a minimal package.json exists at the global prefix
                        const globalPkgJsonPath = normalizePath(path.join(GLOBAL_NODE_MODULES_ROOT, "..", "package.json"))
                        if (!this._vfs.existsSync(globalPkgJsonPath)) {
                            const minimalPkg = JSON.stringify({ name: "global", version: "0.0.0", private: true }, null, 2)
                            this._vfs.mkdirSync(path.dirname(globalPkgJsonPath), { recursive: true })
                            this._vfs.writeFileSync(globalPkgJsonPath, minimalPkg)
                            await this.withSuppressedObservableMirroring(async () => {
                                await ensureObservableDirectory(this.fs, path.dirname(globalPkgJsonPath))
                                await this.fs.writeFile(globalPkgJsonPath, minimalPkg)
                            })
                        }

                        const globalCwd = normalizePath(path.join(GLOBAL_NODE_MODULES_ROOT, ".."))
                        const packageManager = new PackageManager(this.vfs, { cwd: globalCwd })

                        for (const packageSpec of packageSpecs) {
                            const installResult = await packageManager.install(packageSpec, {
                                save: true,
                                onProgress: (message) => {
                                    const line = `${message}\n`
                                    stdout += line
                                    this.stdoutWriter?.(line)
                                },
                            })
                            stdout += `added ${installResult.added.length} packages\n`

                            // Register bin commands from the installed global package
                            const installedPkgName = packageSpec.replace(/@[^/]*$/, "") || packageSpec
                            await this.registerGlobalBinCommands(installedPkgName)

                            // Also try to register by checking what was actually installed
                            for (const added of installResult.added) {
                                const addedName = typeof added === "string" ? String(added).replace(/@[^/]*$/, "") : (added as { name?: string })?.name
                                if (addedName && addedName !== installedPkgName) {
                                    await this.registerGlobalBinCommands(addedName)
                                }
                            }
                        }

                        // Patch lru-cache to avoid diagnostics_channel crash in browser
                        this.patchLruCacheInNodeModules(GLOBAL_NODE_MODULES_ROOT)

                        result = { stdout, stderr: "", exitCode: 0 }
                    } else {
                        const packageJsonResult = await this.readPackageJson(cwd)
                        if ("error" in packageJsonResult) {
                            result = packageJsonResult.error
                            break
                        }

                        await ensureEsbuildWasm()

                        const packageManager = new PackageManager(this.vfs, { cwd })

                        if (packageSpecs.length === 0) {
                            const installResult = await packageManager.installFromPackageJson({
                                onProgress: (message) => {
                                    const line = `${message}\n`
                                    stdout += line
                                    this.stdoutWriter?.(line)
                                },
                            })
                            stdout += `added ${installResult.added.length} packages\n`
                        } else {
                            for (const packageSpec of packageSpecs) {
                                const installResult = await packageManager.install(packageSpec, {
                                    save: true,
                                    onProgress: (message) => {
                                        const line = `${message}\n`
                                        stdout += line
                                        this.stdoutWriter?.(line)
                                    },
                                })
                                stdout += `added ${installResult.added.length} packages\n`
                            }
                        }

                        // Patch lru-cache to avoid diagnostics_channel crash in browser
                        const localNodeModules = normalizePath(path.join(cwd, "node_modules"))
                        this.patchLruCacheInNodeModules(localNodeModules)

                        result = { stdout, stderr: "", exitCode: 0 }
                    }
                } catch (error) {
                    result = {
                        stdout,
                        stderr: `npm ERR! ${error instanceof Error ? error.message : String(error)}\n`,
                        exitCode: 1,
                    }
                }
                break
            }
            case "ls":
            case "list": {
                const packageManager = new PackageManager(this.vfs, { cwd })
                const packages = Object.entries(packageManager.list())

                if (packages.length === 0) {
                    result = { stdout: "(empty)\n", stderr: "", exitCode: 0 }
                    break
                }

                result = {
                    stdout: `${cwd}\n${packages.map(([name, version]) => `+-- ${name}@${version}`).join("\n")}\n`,
                    stderr: "",
                    exitCode: 0,
                }
                break
            }
            default:
                result = {
                    stdout: "",
                    stderr: `npm ERR! Unknown command: "${subcommand}"\n`,
                    exitCode: 1,
                }
                break
        }

        await this.flushPendingOperations()
        return result
    }

    async executeNode(args: string[], ctx: CommandContext): Promise<ExecResult> {
        const cwd = normalizePath(ctx.cwd)
        const invocation:
            | { kind: "version" }
            | { kind: "eval"; code: string; argv: string[]; filename: string }
            | { kind: "run-file"; scriptPath: string; argv: string[] }
            | { kind: "error"; message: string } = (() => {
                if (args.length === 0) {
                    return {
                        kind: "error",
                        message: "REPL mode is not supported in just-bash. Use node -e <code> or node <file>.",
                    }
                }

                const [firstArg, ...restArgs] = args

                if (firstArg === "-v" || firstArg === "--version") {
                    return { kind: "version" }
                }

                if (firstArg === "-h" || firstArg === "--help") {
                    return {
                        kind: "error",
                        message: "Supported node modes in just-bash: node <file>, node -e <code>, node -p <expression>, node --version.",
                    }
                }

                if (firstArg === "-e" || firstArg === "--eval") {
                    const code = restArgs[0]?.trim() || ""
                    if (!code) {
                        return { kind: "error", message: "node -e requires inline code" }
                    }

                    return {
                        kind: "eval",
                        code,
                        argv: ["node", ...restArgs.slice(1)],
                        filename: `${ALMOSTNODE_INTERNAL_ROOT}/eval.js`,
                    }
                }

                if (firstArg === "-p" || firstArg === "--print") {
                    const expression = restArgs[0]?.trim() || ""
                    if (!expression) {
                        return { kind: "error", message: "node -p requires an expression" }
                    }

                    return {
                        kind: "eval",
                        code: [
                            `const __monospace_print_result = ((${expression}));`,
                            "if (typeof __monospace_print_result !== 'undefined') {",
                            "  process.stdout.write(String(__monospace_print_result) + '\\n')",
                            "}",
                        ].join("\n"),
                        argv: ["node", ...restArgs.slice(1)],
                        filename: `${ALMOSTNODE_INTERNAL_ROOT}/print.js`,
                    }
                }

                if (firstArg.startsWith("-")) {
                    return {
                        kind: "error",
                        message: `Unsupported node flag in just-bash: ${firstArg}`,
                    }
                }

                const scriptPath = path.isAbsolute(firstArg)
                    ? normalizePath(firstArg)
                    : normalizePath(path.resolve(cwd, firstArg))

                return {
                    kind: "run-file",
                    scriptPath,
                    argv: ["node", scriptPath, ...restArgs],
                }
            })()

        if (invocation.kind === "error") {
            return {
                stdout: "",
                stderr: `${invocation.message}\n`,
                exitCode: 1,
            }
        }

        if (invocation.kind === "version") {
            return {
                stdout: `${ALMOSTNODE_NODE_VERSION}\n`,
                stderr: "",
                exitCode: 0,
            }
        }

        await this.ensureInitialized()

        await this.flushPendingOperations()

        if (invocation.kind === "run-file") {
            if (!(await this.fs.exists(invocation.scriptPath))) {
                return {
                    stdout: "",
                    stderr: `Cannot find module '${invocation.scriptPath}'\n`,
                    exitCode: 1,
                }
            }

            const packageRoot = this.getNodeModulesPackageRoot(invocation.scriptPath)
            if (packageRoot) {
                await this.hydrateObservablePackageIntoVirtualFs(packageRoot)
                await this.hydrateObservableProjectIntoVirtualFs(cwd)
                await this.hydrateObservableDependencyPackagesIntoVirtualFs(cwd)
            } else {
                await this.copyObservablePathIntoVirtualFs(invocation.scriptPath, { force: true })
            }
        }

        const stdoutChunks: string[] = []
        const stderrChunks: string[] = []
        const runtimeEnv: Record<string, string> = {
            ...getCommandEnvironment(ctx),
            PWD: cwd,
        }

        const runtime = new Runtime(this.vfs, {
            cwd,
            env: runtimeEnv,
            onStdout: (chunk) => {
                appendChunk(stdoutChunks, chunk)
                this.stdoutWriter?.(chunk)
            },
            onStderr: (chunk) => appendChunk(stderrChunks, chunk),
            onConsole: (method, consoleArgs) => {
                const formatted = consoleArgs.map((value) => {
                    if (typeof value === "string") {
                        return value
                    }

                    try {
                        return JSON.stringify(value)
                    } catch {
                        return String(value)
                    }
                }).join(" ")
                if (
                    !formatted
                    || formatted.startsWith("[process] cwd() called")
                    || formatted.startsWith("[process] chdir called:")
                    || formatted.startsWith("[process] chdir result:")
                ) {
                    return
                }

                const chunk = `${formatted}\n`
                if (method === "error" || method === "warn" || method === "trace") {
                    appendChunk(stderrChunks, chunk)
                    return
                }

                appendChunk(stdoutChunks, chunk)
                this.stdoutWriter?.(chunk)
            },
        })

        const process = runtime.getProcess()

        // Enable TTY mode so TUI applications detect a terminal
        process.stdout.isTTY = true
        process.stderr.isTTY = true
        if (process.stdin) {
            process.stdin.isTTY = true
        }
        const stdoutAny = process.stdout as Record<string, unknown>
        stdoutAny.columns = this._terminalColumns
        stdoutAny.rows = this._terminalRows
        stdoutAny.getWindowSize = () => [this._terminalColumns, this._terminalRows]

        // Forward stdin from the host terminal into process.stdin
        this._stdinHandler = process.stdin
            ? (data: string) => { process.stdin.emit("data", data) }
            : null

        const originalExit = process.exit
        let exitCalled = false
        let exitCode = 0
        let syncExecution = true
        let resolveExit: ((code: number) => void) | null = null
        const exitPromise = new Promise<number>((resolve) => {
            resolveExit = resolve
        })
        const previousConsole = {
            log: console.log,
            info: console.info,
            warn: console.warn,
            error: console.error,
            debug: console.debug,
            trace: console.trace,
            dir: console.dir,
            table: console.table,
        }

        console.log = () => undefined
        console.info = () => undefined
        console.warn = () => undefined
        console.error = () => undefined
        console.debug = () => undefined
        console.trace = () => undefined
        console.dir = () => undefined
        console.table = () => undefined

        process.exit = ((code = 0) => {
            if (!exitCalled) {
                exitCalled = true
                exitCode = code
                resolveExit?.(code)
            }

            if (syncExecution) {
                throw new Error(`Process exited with code ${code}`)
            }

            return undefined as never
        }) as typeof process.exit

        process.argv = invocation.argv
        process.argv0 = "node"
        process.execPath = NODE_EXEC_PATH

        const rejectionHandler = (event: PromiseRejectionEvent) => {
            const reason = event.reason
            if (reason instanceof Error && reason.message.startsWith("Process exited with code")) {
                event.preventDefault()
            }
        }

        const canListenForUnhandledRejection = typeof globalThis.addEventListener === "function"
            && typeof globalThis.removeEventListener === "function"

        if (canListenForUnhandledRejection) {
            globalThis.addEventListener("unhandledrejection", rejectionHandler)
        }

        try {
            if (invocation.kind === "eval") {
                runtime.execute(invocation.code, invocation.filename)
            } else {
                runtime.runFile(invocation.scriptPath)
            }

            syncExecution = false

            // Yield to the event loop so that async entry points
            // (e.g. `async function main(){ … }; main()`) have a chance
            // to register stdin listeners before we check.
            await new Promise<void>((r) => setTimeout(r, 0))

            // If the process registered stdin listeners (interactive / TUI), keep
            // it alive until process.exit() is called instead of exiting after 0 ms.
            const isInteractive = process.stdin
                && (process.stdin.listenerCount("data") > 0 || process.stdin.listenerCount("keypress") > 0)
            const asyncExitCode = isInteractive
                ? await exitPromise
                : await Promise.race<number | null>([
                    exitPromise,
                    new Promise<null>((resolve) => {
                        setTimeout(() => resolve(null), 0)
                    }),
                ])

            await this.flushPendingOperations()

            if (exitCalled || asyncExitCode !== null) {
                return {
                    stdout: stdoutChunks.join(""),
                    stderr: stderrChunks.join(""),
                    exitCode: asyncExitCode ?? exitCode,
                }
            }

            return {
                stdout: stdoutChunks.join(""),
                stderr: stderrChunks.join(""),
                exitCode: 0,
            }
        } catch (error) {
            syncExecution = false
            await this.flushPendingOperations()

            if (error instanceof Error) {
                const match = /Process exited with code (\d+)/.exec(error.message)
                if (match) {
                    return {
                        stdout: stdoutChunks.join(""),
                        stderr: stderrChunks.join(""),
                        exitCode: Number.parseInt(match[1] ?? "", 10),
                    }
                }
            }

            appendChunk(stderrChunks, `${error instanceof Error ? (error.stack || error.message) : String(error)}\n`)
            return {
                stdout: stdoutChunks.join(""),
                stderr: stderrChunks.join(""),
                exitCode: 1,
            }
        } finally {
            this._stdinHandler = null
            if (canListenForUnhandledRejection) {
                globalThis.removeEventListener("unhandledrejection", rejectionHandler)
            }
            process.exit = originalExit
            console.log = previousConsole.log
            console.info = previousConsole.info
            console.warn = previousConsole.warn
            console.error = previousConsole.error
            console.debug = previousConsole.debug
            console.trace = previousConsole.trace
            console.dir = previousConsole.dir
            console.table = previousConsole.table
        }
    }

    async executeVite(args: string[], ctx: CommandContext): Promise<ExecResult> {
        const cwd = normalizePath(ctx.cwd)

        await this.ensureInitialized()
        await this.flushPendingOperations()

        const cwdPrefix = cwd.endsWith("/") ? cwd : `${cwd}/`
        const allLazyPaths = this.fs.getAllPaths()
            .map((p) => normalizePath(p))
            .filter((p) => (p === cwd || p.startsWith(cwdPrefix)) && !isInternalAlmostNodePath(p) && this.fs.isPathLazy(p))

        // Eagerly hydrate the files Vite is likely to need immediately, but skip
        // declaration files, source maps, docs, and similar node_modules artifacts
        // that create unnecessary batch traffic during startup.
        const pathsToLoad = allLazyPaths.filter((targetPath) => {
            if (!targetPath.startsWith(`${cwdPrefix}node_modules/`)) {
                return true
            }

            const baseName = path.basename(targetPath).toLowerCase()
            if (baseName === "package.json") {
                return true
            }

            if (
                baseName.endsWith(".d.ts")
                || baseName.endsWith(".d.mts")
                || baseName.endsWith(".d.cts")
                || baseName.endsWith(".map")
                || baseName === "readme"
                || baseName.startsWith("readme.")
                || baseName === "license"
                || baseName.startsWith("license.")
                || baseName === "changelog"
                || baseName.startsWith("changelog.")
            ) {
                return false
            }

            return /\.(?:js|mjs|cjs|jsx|ts|tsx|json|css|scss|sass|less|wasm|svg)$/.test(baseName)
        })

        if (pathsToLoad.length > 0 && this.batchFileLoader) {
            const contents = await this.batchFileLoader(pathsToLoad)
            await this.fs.suppressObservability(async () => {
                for (const [filePath, content] of contents) {
                    this.fs.writeFileSync(filePath, content)
                }
            })
            this._vfs.withoutMirror(() => {
                for (const [filePath, content] of contents) {
                    this._vfs.mkdirSync(path.dirname(filePath), { recursive: true })
                    this._vfs.writeFileSync(filePath, content)
                }
            })
        } else {
            for (const lazyPath of pathsToLoad) {
                await this.copyObservablePathIntoVirtualFs(lazyPath, { force: true })
            }
        }

        let port = 5173
        for (let i = 0; i < args.length; i++) {
            if (args[i] === "--port" && args[i + 1]) {
                const parsed = Number.parseInt(args[i + 1], 10)
                if (!Number.isNaN(parsed) && parsed > 0) {
                    port = parsed
                }
            }
        }

        this.stopViteServer()

        const bridge = getServerBridge()

        await ensureEsbuildWasm()

        this.viteServer = new ViteDevServer(this.vfs, { port, root: cwd })
        this.viteServer.start()

        await bridge.initServiceWorker()
        const virtualPrefix = `/__virtual__/${port}`
        bridge.registerServer({
            get listening() { return true },
            address: () => ({ port, address: "127.0.0.1", family: "IPv4" }),
            handleRequest: async (method, url, headers, body) => {
                let response = await this.viteServer!.handleRequest(method, url, headers, typeof body === "string" ? undefined : body)

                // almostnode's generic static file path goes through DevServer.serveFile(),
                // which resolves an already-resolved path a second time and can 404 files that
                // do exist in the session VFS. Fall back to serving the file directly when the
                // request path resolves to an existing workspace file.
                let resolvedFilePath = ""
                if (response.statusCode === 404 && response.body) {
                    const BufferCtor = response.body.constructor as unknown as {
                        from(input: string | Uint8Array): typeof response.body
                    }
                    const fallbackResponse = await this.serveExistingVirtualStaticFile(cwd, url, BufferCtor)
                    if (fallbackResponse) {
                        resolvedFilePath = fallbackResponse.resolvedPath.replace(cwd, "")
                        response = fallbackResponse
                    }
                }

                // Rewrite absolute paths in HTML responses so that resources
                // like /src/main.tsx resolve to /__virtual__/<port>/src/main.tsx.
                // Without this, the browser loads them from the Next.js origin
                // and the service worker's referer-based routing can't detect
                // they belong to the virtual server.
                const contentType = response.headers["Content-Type"] || response.headers["content-type"] || ""
                if (contentType.includes("text/html") && response.body) {
                    const rawHtml = response.body.toString("utf8")
                    const html = this.transformTextWithCache(
                        `html:${virtualPrefix}:${url}`,
                        rawHtml,
                        (input) => input
                            .replace(/<script\s+type\s*=\s*["']importmap["'][^>]*>[\s\S]*?<\/script>/gi, "")
                            .replace(/(<script\b[^>]*\bsrc\s*=\s*["'])\/((?!\/)[^"']*["'])/gi, `$1${virtualPrefix}/$2`)
                            .replace(/(<link\b[^>]*\bhref\s*=\s*["'])\/((?!\/)[^"']*["'])/gi, `$1${virtualPrefix}/$2`),
                    )

                    const BufferCtor = response.body.constructor as unknown as { from(s: string): typeof response.body }
                    const newBody = BufferCtor.from(html)
                    return {
                        ...response,
                        body: newBody,
                        headers: {
                            ...response.headers,
                            "Content-Length": String(newBody.length),
                        },
                    }
                }

                // Rewrite bare import specifiers in JS responses so the browser
                // can resolve them to /__virtual__/<port>/node_modules/... paths
                // served by ViteDevServer through the service worker.
                // Also wrap CJS modules in an ESM shim so they can be imported.
                if (contentType.includes("javascript") && response.body) {
                    const requestPath = resolvedFilePath || getRequestPathname(url)
                    const rawJs = response.body.toString("utf8")
                    const js = this.transformTextWithCache(
                        `js:${virtualPrefix}:${requestPath}`,
                        rawJs,
                        (input) => {
                            let transformed = this.rewriteBareImports(input, cwd, virtualPrefix)
                            transformed = wrapCjsAsEsm(transformed, virtualPrefix, requestPath)
                            if (/\bprocess\.env\b/.test(transformed) && !/\bvar\s+process\b/.test(transformed)) {
                                transformed = `var process = { env: { NODE_ENV: "production" } };\n${transformed}`
                            }
                            return transformed
                        },
                    )
                    const BufferCtor = response.body.constructor as unknown as { from(s: string): typeof response.body }
                    const newBody = BufferCtor.from(js)
                    return {
                        ...response,
                        body: newBody,
                        headers: {
                            ...response.headers,
                            "Content-Length": String(newBody.length),
                        },
                    }
                }

                return response
            },
        }, port)

        const serverUrl = bridge.getServerUrl(port)
        this.vitePort = port
        this.vitePreviewUrl = `${serverUrl}/`
        this.vitePreviewListener?.(this.vitePreviewUrl)

        return {
            stdout: [
                "",
                "  VITE  ready",
                "",
                `  ➜  Local:   ${this.vitePreviewUrl}`,
                "",
            ].join("\n"),
            stderr: "",
            exitCode: 0,
        }
    }
}

export function createAlmostNodeSession(fs: ObservableInMemoryFs): AlmostNodeSession {
    return new AlmostNodeSession(fs)
}