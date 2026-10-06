// Runs before test modules load: emulate browser globals so almostnode's
// install-time esbuild transform initializes (it checks isBrowser at import).
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import path from "node:path"

// Harness-only: Node lazily defines its undici global-dispatcher symbol
// non-configurably on first fetch; the VFS copy of undici (pi dep) then fails
// to redefine it. Force configurable on globalThis defines (same trick
// almostnode's child_process shim uses, applied earlier so Node's own lazy
// define is also affected).
const realDefine = Object.defineProperty
function patchedDefine(target: object, key: PropertyKey, descriptor: PropertyDescriptor): object {
    if (target === globalThis && descriptor && !descriptor.configurable) {
        return realDefine.call(Object, target, key, { ...descriptor, configurable: true })
    }
    return realDefine.call(Object, target, key, descriptor)
}
Object.defineProperty = patchedDefine

const ESBUILD_DIR = "C:/Users/shele/pi-check-tmp/node_modules/esbuild-wasm"

const glob = globalThis as unknown as { window?: unknown; self?: unknown; __esbuild?: unknown }
glob.window = globalThis
glob.self = globalThis
// Runtime-computed specifier -> dynamic import (browser ESM build, wasm on this thread)
const esmUrl = pathToFileURL(path.join(ESBUILD_DIR, "lib", "browser.js")).href
const esbuild = (await import(esmUrl)) as { initialize: (o: { wasmModule: WebAssembly.Module; worker: boolean }) => Promise<void> }
const wasmBytes = await readFile(path.join(ESBUILD_DIR, "esbuild.wasm"))
await esbuild.initialize({ wasmModule: new WebAssembly.Module(wasmBytes), worker: false })
glob.__esbuild = esbuild
