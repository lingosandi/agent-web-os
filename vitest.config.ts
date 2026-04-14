import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
    base:'/agent-web-os',
    test: {
        include: ["src/**/*.test.ts"],
    },
    resolve: {
        alias: {
            "almostnode/npm": path.resolve(__dirname, "src/__mocks__/almostnode-npm.ts"),
            "almostnode/runtime": path.resolve(__dirname, "src/__mocks__/almostnode-runtime.ts"),
            "almostnode/server-bridge": path.resolve(__dirname, "src/__mocks__/almostnode-server-bridge.ts"),
            "almostnode/virtual-fs": path.resolve(__dirname, "src/__mocks__/almostnode-virtual-fs.ts"),
            "almostnode/frameworks/vite-dev-server": path.resolve(__dirname, "src/__mocks__/almostnode-vite-dev-server.ts"),
        },
    },
})
