import { defineConfig } from "tsup"

export default defineConfig({
    entry: {
        index: "src/index.ts",
        node: "src/node.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    platform: "browser",
    noExternal: [/.*/],
    esbuildOptions(options) {
        options.alias = {
            ...(options.alias ?? {}),
            "almostnode/npm": "./node_modules/almostnode/src/npm/index.ts",
            "almostnode/runtime": "./node_modules/almostnode/src/runtime.ts",
            "almostnode/server-bridge": "./node_modules/almostnode/src/server-bridge.ts",
            "almostnode/virtual-fs": "./node_modules/almostnode/src/virtual-fs.ts",
            "almostnode/frameworks/vite-dev-server": "./node_modules/almostnode/src/frameworks/vite-dev-server.ts",
            "just-bash": "./node_modules/just-bash/dist/bundle/browser.js",
            "just-bash/browser": "./node_modules/just-bash/dist/bundle/browser.js",
        }
        options.conditions = [...new Set([...(options.conditions ?? []), "browser"])]
    },
})
