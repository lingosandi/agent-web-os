import { defineConfig } from "vitest/config"
import path from "path"

// Real almostnode sources (NOT the src/__mocks__ used by the repo's own tests),
// same aliases tsup uses for the published browser bundle.
export default defineConfig({
    test: {
        setupFiles: [path.resolve(__dirname, "setup.ts")],
        include: [".pi-smoke/**/*.test.ts"],
        testTimeout: 600_000,
        hookTimeout: 600_000,
        pool: "forks",
    },
    resolve: {
        alias: {
            "almostnode/npm": path.resolve(__dirname, "../node_modules/almostnode/src/npm/index.ts"),
            "almostnode/runtime": path.resolve(__dirname, "../node_modules/almostnode/src/runtime.ts"),
            "almostnode/server-bridge": path.resolve(__dirname, "../node_modules/almostnode/src/server-bridge.ts"),
            "almostnode/virtual-fs": path.resolve(__dirname, "../node_modules/almostnode/src/virtual-fs.ts"),
            "almostnode/frameworks/vite-dev-server": path.resolve(__dirname, "../node_modules/almostnode/src/frameworks/vite-dev-server.ts"),
        },
    },
})
