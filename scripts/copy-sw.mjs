#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, "..")
const distDir = resolve(packageRoot, "dist")

mkdirSync(distDir, { recursive: true })

// Copy almostnode service worker
const swSource = resolve(packageRoot, "node_modules", "almostnode", "dist", "__sw__.js")
if (!existsSync(swSource)) {
    throw new Error(`Expected service worker asset at ${swSource}`)
}
copyFileSync(swSource, resolve(distDir, "__sw__.js"))

// Copy brotli wasm binary (referenced by bundled brotli-wasm JS via import.meta.url)
const brotliSource = resolve(packageRoot, "node_modules", "brotli-wasm", "pkg.bundler", "brotli_wasm_bg.wasm")
if (existsSync(brotliSource)) {
    copyFileSync(brotliSource, resolve(distDir, "brotli_wasm_bg.wasm"))
}