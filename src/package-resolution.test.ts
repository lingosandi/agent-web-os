import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { ObservableInMemoryFs } from "./observable-in-memory-fs"
import { AlmostNodeSession } from "./almostnode-session"

/**
 * Tests for package resolution through rewriteBareImports.
 * Tests resolveBarePkgEntry, resolveExportsEntry, resolveWildcardExports,
 * resolveConditionValue, and wrapCjsAsEsm indirectly.
 */
describe("AlmostNodeSession - package resolution via rewriteBareImports", () => {
    let fs: ObservableInMemoryFs
    let session: AlmostNodeSession

    function setupPackage(
        pkgName: string,
        pkgJson: Record<string, unknown>,
        files?: Record<string, string>,
    ): void {
        const root = `/workspace/node_modules/${pkgName}`
        // Write to VFS (used by resolveBarePkgEntry for package resolution)
        session.vfs.mkdirSync(root, { recursive: true })
        session.vfs.writeFileSync(`${root}/package.json`, JSON.stringify(pkgJson))
        if (files) {
            for (const [filePath, content] of Object.entries(files)) {
                const fullPath = `${root}/${filePath}`
                const dir = fullPath.substring(0, fullPath.lastIndexOf("/"))
                session.vfs.mkdirSync(dir, { recursive: true })
                session.vfs.writeFileSync(fullPath, content)
            }
        }
    }

    beforeEach(() => {
        fs = new ObservableInMemoryFs()
        session = new AlmostNodeSession(fs)
    })

    afterEach(() => {
        session.dispose()
    })

    describe("exports field resolution", () => {
        it("resolves . export with import condition", () => {
            setupPackage("my-pkg", {
                name: "my-pkg",
                exports: {
                    ".": { import: "./esm/index.mjs", require: "./cjs/index.js" },
                },
            })

            const code = 'import x from "my-pkg"'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toContain("/node_modules/my-pkg/esm/index.mjs")
        })

        it("resolves with browser condition taking priority", () => {
            setupPackage("browser-pkg", {
                name: "browser-pkg",
                exports: {
                    ".": {
                        browser: "./browser/index.js",
                        import: "./esm/index.mjs",
                        default: "./cjs/index.js",
                    },
                },
            })

            const code = 'import x from "browser-pkg"'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toContain("/node_modules/browser-pkg/browser/index.js")
        })

        it("resolves with module condition over import", () => {
            setupPackage("mod-pkg", {
                name: "mod-pkg",
                exports: {
                    ".": {
                        module: "./esm/mod.js",
                        import: "./esm/imp.js",
                        default: "./cjs/index.js",
                    },
                },
            })

            const code = 'import x from "mod-pkg"'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toContain("/node_modules/mod-pkg/esm/mod.js")
        })

        it("skips types condition", () => {
            setupPackage("typed-pkg", {
                name: "typed-pkg",
                exports: {
                    ".": {
                        types: "./index.d.ts",
                        default: "./index.js",
                    },
                },
            })

            const code = 'import x from "typed-pkg"'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toContain("/node_modules/typed-pkg/index.js")
            expect(result).not.toContain(".d.ts")
        })

        it("skips .d.ts resolved entries", () => {
            setupPackage("dts-pkg", {
                name: "dts-pkg",
                exports: {
                    ".": {
                        import: "./index.d.ts",
                        default: "./index.js",
                    },
                },
            })

            const code = 'import x from "dts-pkg"'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toContain("/node_modules/dts-pkg/index.js")
        })

        it("resolves nested condition objects", () => {
            setupPackage("nested-pkg", {
                name: "nested-pkg",
                exports: {
                    ".": {
                        browser: {
                            import: "./browser-esm.js",
                            default: "./browser-cjs.js",
                        },
                    },
                },
            })

            const code = 'import x from "nested-pkg"'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toContain("/node_modules/nested-pkg/browser-esm.js")
        })
    })

    describe("deep imports", () => {
        it("resolves deep import via exports map", () => {
            setupPackage("ui-lib", {
                name: "ui-lib",
                exports: {
                    "./Button": { import: "./esm/Button.js" },
                },
            })

            const code = 'import Button from "ui-lib/Button"'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toContain("/node_modules/ui-lib/esm/Button.js")
        })

        it("resolves deep import with wildcard exports", () => {
            setupPackage("wildcard-pkg", {
                name: "wildcard-pkg",
                exports: {
                    "./*": { default: "./dist/*/index.js" },
                },
            })

            const code = 'import Component from "wildcard-pkg/MyComponent"'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toContain("/node_modules/wildcard-pkg/dist/MyComponent/index.js")
        })

        it("resolves deep import by direct file existence", () => {
            setupPackage("direct-pkg", {
                name: "direct-pkg",
            }, {
                "lib/util.js": "export default {}",
            })

            const code = 'import util from "direct-pkg/lib/util"'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toContain("/node_modules/direct-pkg/lib/util.js")
        })

        it("falls back to subpath when no exports match", () => {
            setupPackage("fallback-pkg", {
                name: "fallback-pkg",
            })

            const code = 'import x from "fallback-pkg/deep/path"'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toContain("/node_modules/fallback-pkg/deep/path")
        })
    })

    describe("module/main field fallbacks", () => {
        it("uses module field when no exports", () => {
            setupPackage("module-pkg", {
                name: "module-pkg",
                module: "esm/index.js",
            })

            const code = 'import x from "module-pkg"'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toContain("/node_modules/module-pkg/esm/index.js")
        })

        it("uses main field when no exports or module", () => {
            setupPackage("main-pkg", {
                name: "main-pkg",
                main: "lib/main.js",
            })

            const code = 'import x from "main-pkg"'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toContain("/node_modules/main-pkg/lib/main.js")
        })

        it("prefers exports over module field", () => {
            setupPackage("prefer-exports", {
                name: "prefer-exports",
                module: "esm/legacy.js",
                exports: {
                    ".": { import: "./dist/modern.js" },
                },
            })

            const code = 'import x from "prefer-exports"'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toContain("/node_modules/prefer-exports/dist/modern.js")
        })

        it("falls back to index.js", () => {
            setupPackage("no-entry", {
                name: "no-entry",
            }, {
                "index.js": "export default {}",
            })

            const code = 'import x from "no-entry"'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toContain("/node_modules/no-entry/index.js")
        })
    })

    describe("scoped packages", () => {
        it("resolves scoped package", () => {
            setupPackage("@scope/lib", {
                name: "@scope/lib",
                module: "esm/index.js",
            })

            const code = 'import x from "@scope/lib"'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toContain("/node_modules/@scope/lib/esm/index.js")
        })

        it("resolves scoped package deep import", () => {
            setupPackage("@scope/ui", {
                name: "@scope/ui",
                exports: {
                    "./components": { import: "./dist/components.js" },
                },
            })

            const code = 'import { Button } from "@scope/ui/components"'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toContain("/node_modules/@scope/ui/dist/components.js")
        })
    })

    describe("virtualPrefix", () => {
        it("prepends virtualPrefix to resolved paths", () => {
            setupPackage("vp-pkg", {
                name: "vp-pkg",
                module: "index.mjs",
            })

            const code = 'import x from "vp-pkg"'
            const result = session.rewriteBareImports(code, "/workspace", "/__virtual__/5173")
            expect(result).toContain('from "/__virtual__/5173/node_modules/vp-pkg/index.mjs"')
        })
    })

    describe("URL and path specifiers not rewritten", () => {
        it("does not rewrite https:// URLs", () => {
            const code = 'import x from "https://cdn.example.com/mod.js"'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toBe(code)
        })

        it("does not rewrite relative imports", () => {
            const code = 'import x from "./local.js"'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toBe(code)
        })

        it("does not rewrite parent-relative imports", () => {
            const code = 'import x from "../parent.js"'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toBe(code)
        })

        it("does not rewrite absolute path imports", () => {
            const code = 'import x from "/absolute/path.js"'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toBe(code)
        })
    })

    describe("multiple imports in one file", () => {
        it("rewrites all bare imports", () => {
            setupPackage("react", {
                name: "react",
                module: "esm/react.js",
            })
            setupPackage("react-dom", {
                name: "react-dom",
                module: "esm/react-dom.js",
            })

            const code = [
                'import React from "react"',
                'import ReactDOM from "react-dom"',
                'import "./styles.css"',
            ].join("\n")

            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toContain("/node_modules/react/esm/react.js")
            expect(result).toContain("/node_modules/react-dom/esm/react-dom.js")
            expect(result).toContain("./styles.css")
        })
    })

    describe("dynamic imports", () => {
        it("rewrites dynamic import specifiers", () => {
            setupPackage("lazy-pkg", {
                name: "lazy-pkg",
                module: "index.mjs",
            })

            const code = 'const mod = import("lazy-pkg")'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toContain("/node_modules/lazy-pkg/index.mjs")
        })
    })

    describe("export from", () => {
        it("rewrites export ... from bare specifier", () => {
            setupPackage("re-export", {
                name: "re-export",
                module: "index.mjs",
            })

            const code = 'export { default } from "re-export"'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toContain("/node_modules/re-export/index.mjs")
        })

        it("rewrites export * from bare specifier", () => {
            setupPackage("star-export", {
                name: "star-export",
                main: "index.js",
            })

            const code = 'export * from "star-export"'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toContain("/node_modules/star-export/index.js")
        })
    })

    describe("comments are ignored", () => {
        it("does not rewrite imports inside line comments", () => {
            const code = '// import x from "nonexistent"\nconst a = 1'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toBe(code)
        })

        it("does not rewrite imports inside block comments", () => {
            const code = '/* import x from "nonexistent" */\nconst a = 1'
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toBe(code)
        })
    })
})

describe("AlmostNodeSession - wrapCjsAsEsm via rewriteBareImports", () => {
    let fs: ObservableInMemoryFs
    let session: AlmostNodeSession

    beforeEach(() => {
        fs = new ObservableInMemoryFs()
        session = new AlmostNodeSession(fs)
    })

    afterEach(() => {
        session.dispose()
    })

    it("does not modify pure ESM code", () => {
        const esmCode = 'import x from "./local.js"\nexport default x'
        const result = session.rewriteBareImports(esmCode, "/workspace")
        // ESM code should be returned as-is (no CJS wrapping)
        expect(result).toBe(esmCode)
    })

    it("does not modify code without CJS or ESM indicators", () => {
        const plainCode = 'const x = 1\nconst y = x + 1'
        const result = session.rewriteBareImports(plainCode, "/workspace")
        expect(result).toBe(plainCode)
    })
})

describe("AlmostNodeSession - executeNpm edge cases", () => {
    let fs: ObservableInMemoryFs
    let session: AlmostNodeSession

    function makeCtx(cwd = "/workspace"): any {
        const envMap = new Map<string, string>()
        envMap.set("PATH", "/usr/local/bin:/usr/bin:/bin")
        return {
            cwd,
            env: envMap,
            exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        }
    }

    beforeEach(() => {
        fs = new ObservableInMemoryFs()
        session = new AlmostNodeSession(fs)
    })

    afterEach(() => {
        session.dispose()
    })

    it("errors on missing package.json for run command", async () => {
        fs.mkdirSync("/workspace", { recursive: true })
        const result = await session.executeNpm(["run", "build"], makeCtx())
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain("package.json")
    })

    it("npm run with no script name lists scripts", async () => {
        fs.mkdirSync("/workspace", { recursive: true })
        fs.writeFileSync("/workspace/package.json", JSON.stringify({
            name: "test",
            scripts: { build: "echo ok" },
        }))
        const result = await session.executeNpm(["run"], makeCtx())
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain("build")
    })

    it("errors on undefined script", async () => {
        fs.mkdirSync("/workspace", { recursive: true })
        fs.writeFileSync("/workspace/package.json", JSON.stringify({
            name: "test",
            scripts: { build: "echo ok" },
        }))
        const result = await session.executeNpm(["run", "nonexistent"], makeCtx())
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain("nonexistent")
    })

    it("npm help returns usage info", async () => {
        const result = await session.executeNpm(["help"], makeCtx())
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBeTruthy()
    })

    it("npm --help returns usage info", async () => {
        const result = await session.executeNpm(["--help"], makeCtx())
        expect(result.exitCode).toBe(0)
    })

    it("npm with no args returns usage", async () => {
        const result = await session.executeNpm([], makeCtx())
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBeTruthy()
    })

    it("npm version is unknown command", async () => {
        const result = await session.executeNpm(["version"], makeCtx())
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain("Unknown command")
    })

    it("npm -v returns version string", async () => {
        const result = await session.executeNpm(["-v"], makeCtx())
        expect(result.exitCode).toBe(0)
    })

    it("npm ls with empty modules returns empty", async () => {
        fs.mkdirSync("/workspace", { recursive: true })
        const result = await session.executeNpm(["ls"], makeCtx())
        expect(result.exitCode).toBe(0)
    })
})

describe("AlmostNodeSession - executeNode edge cases", () => {
    let fs: ObservableInMemoryFs
    let session: AlmostNodeSession

    function makeCtx(cwd = "/workspace"): any {
        const envMap = new Map<string, string>()
        envMap.set("PATH", "/usr/local/bin:/usr/bin:/bin")
        return {
            cwd,
            env: envMap,
            exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        }
    }

    beforeEach(() => {
        fs = new ObservableInMemoryFs()
        session = new AlmostNodeSession(fs)
    })

    afterEach(() => {
        session.dispose()
    })

    it("node with no args returns REPL error", async () => {
        const result = await session.executeNode([], makeCtx())
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain("REPL")
    })

    it("node -v returns version", async () => {
        const result = await session.executeNode(["-v"], makeCtx())
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toMatch(/^v\d+\.\d+\.\d+/)
    })

    it("node --version returns version", async () => {
        const result = await session.executeNode(["--version"], makeCtx())
        expect(result.exitCode).toBe(0)
    })

    it("node -h returns help", async () => {
        const result = await session.executeNode(["-h"], makeCtx())
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain("Supported")
    })

    it("node -e with empty code fails", async () => {
        const result = await session.executeNode(["-e", ""], makeCtx())
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain("requires inline code")
    })

    it("node -e with whitespace-only code fails", async () => {
        const result = await session.executeNode(["-e", "   "], makeCtx())
        expect(result.exitCode).toBe(1)
    })

    it("node -p with empty expression fails", async () => {
        const result = await session.executeNode(["-p", ""], makeCtx())
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain("requires an expression")
    })

    it("unsupported flag returns error", async () => {
        const result = await session.executeNode(["--inspect"], makeCtx())
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain("Unsupported node flag")
        expect(result.stderr).toContain("--inspect")
    })

    it("missing script file returns error", async () => {
        fs.mkdirSync("/workspace", { recursive: true })
        const result = await session.executeNode(["nonexistent.js"], makeCtx())
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain("Cannot find module")
    })
})
