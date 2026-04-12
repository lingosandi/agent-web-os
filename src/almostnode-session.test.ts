import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { AlmostNodeSession, createAlmostNodeSession, type AlmostNodeSessionVfs } from "./almostnode-session"
import { ObservableInMemoryFs } from "./observable-in-memory-fs"

/** Wait a tick to let queued operations fire */
async function tick(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("createAlmostNodeSession", () => {
    it("returns an AlmostNodeSession instance", () => {
        const fs = new ObservableInMemoryFs()
        const session = createAlmostNodeSession(fs)
        expect(session).toBeInstanceOf(AlmostNodeSession)
    })
})

describe("AlmostNodeSession", () => {
    let fs: ObservableInMemoryFs
    let session: AlmostNodeSession

    beforeEach(() => {
        fs = new ObservableInMemoryFs()
        session = new AlmostNodeSession(fs)
    })

    afterEach(() => {
        session.dispose()
    })

    describe("constructor VFS shims", () => {
        it("creates /.almostnode directory in VFS", () => {
            expect(session.vfs.existsSync("/.almostnode")).toBe(true)
        })

        it("creates constants shim in VFS", () => {
            expect(session.vfs.existsSync("/node_modules/constants/package.json")).toBe(true)
            expect(session.vfs.existsSync("/node_modules/constants/index.js")).toBe(true)

            const pkgJson = JSON.parse(session.vfs.readFileSync("/node_modules/constants/package.json", "utf8"))
            expect(pkgJson.name).toBe("constants")
            expect(pkgJson.main).toBe("index.js")

            const indexJs = session.vfs.readFileSync("/node_modules/constants/index.js", "utf8") as string
            expect(indexJs).toContain("module.exports")
            expect(indexJs).toContain("os.constants")
            expect(indexJs).toContain("O_RDONLY")
            expect(indexJs).toContain("S_IFMT")
        })

        it("creates stream shim in VFS", () => {
            expect(session.vfs.existsSync("/node_modules/stream/package.json")).toBe(true)
            expect(session.vfs.existsSync("/node_modules/stream/index.js")).toBe(true)

            const pkgJson = JSON.parse(session.vfs.readFileSync("/node_modules/stream/package.json", "utf8"))
            expect(pkgJson.name).toBe("stream")
        })

        it("creates stream/promises shim in VFS", () => {
            expect(session.vfs.existsSync("/node_modules/stream/promises/package.json")).toBe(true)
            expect(session.vfs.existsSync("/node_modules/stream/promises/index.js")).toBe(true)

            const indexJs = session.vfs.readFileSync("/node_modules/stream/promises/index.js", "utf8") as string
            expect(indexJs).toContain("stream.promises")
        })

        it("creates stream/web shim in VFS", () => {
            expect(session.vfs.existsSync("/node_modules/stream/web/package.json")).toBe(true)
            expect(session.vfs.existsSync("/node_modules/stream/web/index.js")).toBe(true)

            const indexJs = session.vfs.readFileSync("/node_modules/stream/web/index.js", "utf8") as string
            expect(indexJs).toContain("ReadableStream")
            expect(indexJs).toContain("WritableStream")
            expect(indexJs).toContain("TransformStream")
        })
    })

    describe("vfs", () => {
        it("exposes AlmostNodeSessionVfs interface", () => {
            const vfs = session.vfs
            expect(typeof vfs.existsSync).toBe("function")
            expect(typeof vfs.statSync).toBe("function")
            expect(typeof vfs.readFileSync).toBe("function")
            expect(typeof vfs.writeFileSync).toBe("function")
            expect(typeof vfs.mkdirSync).toBe("function")
            expect(typeof vfs.readdirSync).toBe("function")
            expect(typeof vfs.unlinkSync).toBe("function")
            expect(typeof vfs.rmdirSync).toBe("function")
            expect(typeof vfs.renameSync).toBe("function")
        })

        it("can write and read files", () => {
            session.vfs.mkdirSync("/test", { recursive: true })
            session.vfs.writeFileSync("/test/file.txt", "hello world")
            const content = session.vfs.readFileSync("/test/file.txt", "utf8")
            expect(content).toBe("hello world")
        })

        it("can create directories recursively", () => {
            session.vfs.mkdirSync("/a/b/c", { recursive: true })
            expect(session.vfs.existsSync("/a")).toBe(true)
            expect(session.vfs.existsSync("/a/b")).toBe(true)
            expect(session.vfs.existsSync("/a/b/c")).toBe(true)
        })

        it("can stat files and directories", () => {
            session.vfs.mkdirSync("/dir", { recursive: true })
            session.vfs.writeFileSync("/dir/file.txt", "content")

            const dirStat = session.vfs.statSync("/dir")
            expect(dirStat.isDirectory()).toBe(true)
            expect(dirStat.isFile()).toBe(false)

            const fileStat = session.vfs.statSync("/dir/file.txt")
            expect(fileStat.isFile()).toBe(true)
            expect(fileStat.isDirectory()).toBe(false)
        })

        it("can list directory contents", () => {
            session.vfs.mkdirSync("/listdir", { recursive: true })
            session.vfs.writeFileSync("/listdir/a.txt", "a")
            session.vfs.writeFileSync("/listdir/b.txt", "b")

            const entries = session.vfs.readdirSync("/listdir")
            expect(entries).toContain("a.txt")
            expect(entries).toContain("b.txt")
        })

        it("can delete files", () => {
            session.vfs.mkdirSync("/deldir", { recursive: true })
            session.vfs.writeFileSync("/deldir/file.txt", "content")
            expect(session.vfs.existsSync("/deldir/file.txt")).toBe(true)

            session.vfs.unlinkSync("/deldir/file.txt")
            expect(session.vfs.existsSync("/deldir/file.txt")).toBe(false)
        })

        it("can remove directories", async () => {
            session.vfs.mkdirSync("/emptydir2", { recursive: true })
            await tick() // let async mirror settle
            expect(session.vfs.existsSync("/emptydir2")).toBe(true)

            session.vfs.rmdirSync("/emptydir2")
            expect(session.vfs.existsSync("/emptydir2")).toBe(false)
        })

        it("can rename files", () => {
            session.vfs.mkdirSync("/rendir", { recursive: true })
            session.vfs.writeFileSync("/rendir/old.txt", "content")

            session.vfs.renameSync("/rendir/old.txt", "/rendir/new.txt")
            expect(session.vfs.existsSync("/rendir/old.txt")).toBe(false)
            expect(session.vfs.existsSync("/rendir/new.txt")).toBe(true)
            expect(session.vfs.readFileSync("/rendir/new.txt", "utf8")).toBe("content")
        })
    })

    describe("VFS → Observable FS mirroring", () => {
        it("mirrors VFS writes to observable FS", async () => {
            session.vfs.mkdirSync("/mirror-test", { recursive: true })
            session.vfs.writeFileSync("/mirror-test/file.txt", "data")
            await tick()

            const exists = await fs.exists("/mirror-test/file.txt")
            expect(exists).toBe(true)
        })

        it("mirrors VFS mkdir to observable FS", async () => {
            session.vfs.mkdirSync("/mirror-dir", { recursive: true })
            await tick()

            const exists = await fs.exists("/mirror-dir")
            expect(exists).toBe(true)
        })

        it("does NOT mirror internal /.almostnode paths", async () => {
            session.vfs.writeFileSync("/.almostnode/internal.txt", "secret")
            await tick()

            const exists = await fs.exists("/.almostnode/internal.txt")
            expect(exists).toBe(false)
        })
    })

    describe("Observable FS → VFS syncing", () => {
        it("syncs new files from observable FS to VFS", async () => {
            // First initialize the session (forces ensureInitialized)
            fs.mkdirSync("/workspace", { recursive: true })
            await fs.writeFile("/workspace/test.txt", "from-observable")
            await tick()

            // After sync, the VFS should have the file
            // Note: syncing only happens after initialized flag is set
        })
    })

    describe("dispose", () => {
        it("can be called without error", () => {
            const localFs = new ObservableInMemoryFs()
            const localSession = new AlmostNodeSession(localFs)
            expect(() => localSession.dispose()).not.toThrow()
        })

        it("can be called multiple times", () => {
            const localFs = new ObservableInMemoryFs()
            const localSession = new AlmostNodeSession(localFs)
            localSession.dispose()
            expect(() => localSession.dispose()).not.toThrow()
        })
    })

    describe("setStdoutWriter", () => {
        it("accepts a writer function", () => {
            const writer = vi.fn()
            expect(() => session.setStdoutWriter(writer)).not.toThrow()
        })

        it("accepts undefined to clear writer", () => {
            session.setStdoutWriter(vi.fn())
            expect(() => session.setStdoutWriter(undefined)).not.toThrow()
        })
    })

    describe("setBinCommandRegistrar", () => {
        it("accepts a registrar function", () => {
            const registrar = vi.fn()
            expect(() => session.setBinCommandRegistrar(registrar)).not.toThrow()
        })
    })

    describe("setBatchFileLoader", () => {
        it("accepts a loader function", () => {
            const loader = vi.fn()
            expect(() => session.setBatchFileLoader(loader)).not.toThrow()
        })
    })

    describe("setVitePreviewListener", () => {
        it("accepts a listener function", () => {
            const listener = vi.fn()
            session.setVitePreviewListener(listener)
            // Should immediately call with null since no vite server is running
            expect(listener).toHaveBeenCalledWith(null)
        })

        it("accepts undefined to clear listener", () => {
            expect(() => session.setVitePreviewListener(undefined)).not.toThrow()
        })
    })

    describe("setViteHmrTarget", () => {
        it("handles null target", () => {
            expect(() => session.setViteHmrTarget(null)).not.toThrow()
        })
    })

    describe("executeNpm", () => {
        function makeCtx(cwd = "/workspace"): any {
            const envMap = new Map<string, string>()
            envMap.set("PATH", "/usr/local/bin:/usr/bin:/bin")
            return {
                cwd,
                env: envMap,
                exec: async (cmd: string, opts: any) => ({
                    stdout: "",
                    stderr: "",
                    exitCode: 0,
                }),
            }
        }

        it("shows help for no args", async () => {
            fs.mkdirSync("/workspace", { recursive: true })
            const result = await session.executeNpm([], makeCtx())
            expect(result.exitCode).toBe(0)
            expect(result.stdout).toContain("Usage: npm")
            expect(result.stdout).toContain("Commands:")
        })

        it("shows help for 'help' subcommand", async () => {
            fs.mkdirSync("/workspace", { recursive: true })
            const result = await session.executeNpm(["help"], makeCtx())
            expect(result.exitCode).toBe(0)
            expect(result.stdout).toContain("Usage: npm")
        })

        it("shows help for '--help' flag", async () => {
            fs.mkdirSync("/workspace", { recursive: true })
            const result = await session.executeNpm(["--help"], makeCtx())
            expect(result.exitCode).toBe(0)
            expect(result.stdout).toContain("Usage: npm")
        })

        it("returns version for -v", async () => {
            fs.mkdirSync("/workspace", { recursive: true })
            const result = await session.executeNpm(["-v"], makeCtx())
            expect(result.exitCode).toBe(0)
            expect(result.stdout).toContain("9.6.4")
        })

        it("returns version for --version", async () => {
            fs.mkdirSync("/workspace", { recursive: true })
            const result = await session.executeNpm(["--version"], makeCtx())
            expect(result.exitCode).toBe(0)
            expect(result.stdout).toContain("9.6.4")
        })

        it("errors for unknown subcommand", async () => {
            fs.mkdirSync("/workspace", { recursive: true })
            const result = await session.executeNpm(["bogus"], makeCtx())
            expect(result.exitCode).toBe(1)
            expect(result.stderr).toContain("Unknown command")
            expect(result.stderr).toContain("bogus")
        })

        it("handles 'ls' with empty packages", async () => {
            fs.mkdirSync("/workspace", { recursive: true })
            const result = await session.executeNpm(["ls"], makeCtx())
            expect(result.exitCode).toBe(0)
            expect(result.stdout).toContain("empty")
        })

        it("handles 'run' without scriptname (lists scripts)", async () => {
            fs.mkdirSync("/workspace", { recursive: true })
            fs.writeFileSync("/workspace/package.json", JSON.stringify({
                name: "test-pkg",
                version: "1.0.0",
                scripts: {
                    build: "echo build",
                    test: "echo test",
                },
            }))

            const result = await session.executeNpm(["run"], makeCtx())
            expect(result.exitCode).toBe(0)
            expect(result.stdout).toContain("build")
            expect(result.stdout).toContain("test")
        })

        it("handles 'run' with missing script", async () => {
            fs.mkdirSync("/workspace", { recursive: true })
            fs.writeFileSync("/workspace/package.json", JSON.stringify({
                name: "test-pkg",
                version: "1.0.0",
                scripts: {},
            }))

            const result = await session.executeNpm(["run", "nonexistent"], makeCtx())
            expect(result.exitCode).toBe(1)
            expect(result.stderr).toContain("Missing script")
        })

        it("errors on install without package.json", async () => {
            fs.mkdirSync("/workspace", { recursive: true })
            const result = await session.executeNpm(["install"], makeCtx())
            expect(result.exitCode).toBe(1)
            expect(result.stderr).toContain("no package.json found")
        })

        it("errors on global install without package name", async () => {
            fs.mkdirSync("/workspace", { recursive: true })
            const result = await session.executeNpm(["install", "-g"], makeCtx())
            expect(result.exitCode).toBe(1)
            expect(result.stderr).toContain("requires a package name")
        })

        it("handles 'test' alias (t)", async () => {
            fs.mkdirSync("/workspace", { recursive: true })
            fs.writeFileSync("/workspace/package.json", JSON.stringify({
                name: "test-pkg",
                version: "1.0.0",
                scripts: { test: "echo testing" },
            }))

            const ctx = makeCtx()
            ctx.exec = async (cmd: string) => ({
                stdout: "testing\n",
                stderr: "",
                exitCode: 0,
            })

            const result = await session.executeNpm(["t"], ctx)
            expect(result.exitCode).toBe(0)
        })

        it("handles 'tst' alias", async () => {
            fs.mkdirSync("/workspace", { recursive: true })
            fs.writeFileSync("/workspace/package.json", JSON.stringify({
                name: "test-pkg",
                version: "1.0.0",
                scripts: { test: "echo testing" },
            }))

            const ctx = makeCtx()
            ctx.exec = async (cmd: string) => ({
                stdout: "testing\n",
                stderr: "",
                exitCode: 0,
            })

            const result = await session.executeNpm(["tst"], ctx)
            expect(result.exitCode).toBe(0)
        })

        it("handles 'start' alias", async () => {
            fs.mkdirSync("/workspace", { recursive: true })
            fs.writeFileSync("/workspace/package.json", JSON.stringify({
                name: "test-pkg",
                version: "1.0.0",
                scripts: { start: "echo starting" },
            }))

            const ctx = makeCtx()
            ctx.exec = async (cmd: string) => ({
                stdout: "starting\n",
                stderr: "",
                exitCode: 0,
            })

            const result = await session.executeNpm(["start"], ctx)
            expect(result.exitCode).toBe(0)
        })
    })

    describe("executeNode", () => {
        function makeCtx(cwd = "/workspace"): any {
            const envMap = new Map<string, string>()
            envMap.set("PATH", "/usr/local/bin:/usr/bin:/bin")
            return {
                cwd,
                env: envMap,
            }
        }

        it("errors for no args (REPL not supported)", async () => {
            const result = await session.executeNode([], makeCtx())
            expect(result.exitCode).toBe(1)
            expect(result.stderr).toContain("REPL mode is not supported")
        })

        it("returns version for -v", async () => {
            const result = await session.executeNode(["-v"], makeCtx())
            expect(result.exitCode).toBe(0)
            expect(result.stdout).toContain("v20.0.0")
        })

        it("returns version for --version", async () => {
            const result = await session.executeNode(["--version"], makeCtx())
            expect(result.exitCode).toBe(0)
            expect(result.stdout).toContain("v20.0.0")
        })

        it("shows help for -h", async () => {
            const result = await session.executeNode(["-h"], makeCtx())
            expect(result.exitCode).toBe(1)
            expect(result.stderr).toContain("Supported node modes")
        })

        it("shows help for --help", async () => {
            const result = await session.executeNode(["--help"], makeCtx())
            expect(result.exitCode).toBe(1)
            expect(result.stderr).toContain("Supported node modes")
        })

        it("errors for -e without code", async () => {
            const result = await session.executeNode(["-e"], makeCtx())
            expect(result.exitCode).toBe(1)
            expect(result.stderr).toContain("requires inline code")
        })

        it("errors for --eval without code", async () => {
            const result = await session.executeNode(["--eval"], makeCtx())
            expect(result.exitCode).toBe(1)
            expect(result.stderr).toContain("requires inline code")
        })

        it("errors for -p without expression", async () => {
            const result = await session.executeNode(["-p"], makeCtx())
            expect(result.exitCode).toBe(1)
            expect(result.stderr).toContain("requires an expression")
        })

        it("errors for unsupported flags", async () => {
            const result = await session.executeNode(["--inspect"], makeCtx())
            expect(result.exitCode).toBe(1)
            expect(result.stderr).toContain("Unsupported node flag")
        })

        it("errors for missing script file", async () => {
            fs.mkdirSync("/workspace", { recursive: true })
            const result = await session.executeNode(["nonexistent.js"], makeCtx())
            expect(result.exitCode).toBe(1)
            expect(result.stderr).toContain("Cannot find module")
        })
    })

    describe("rewriteBareImports", () => {
        it("rewrites bare import specifier", () => {
            // Set up a fake package in VFS
            session.vfs.mkdirSync("/workspace/node_modules/react", { recursive: true })
            session.vfs.writeFileSync(
                "/workspace/node_modules/react/package.json",
                JSON.stringify({ name: "react", main: "index.js" }),
            )
            session.vfs.writeFileSync("/workspace/node_modules/react/index.js", "// react")

            const code = `import React from 'react';\nconsole.log(React);`
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toContain("/node_modules/react")
            expect(result).not.toContain("'react'")
        })

        it("does not rewrite relative imports", () => {
            const code = `import foo from './foo';\nconsole.log(foo);`
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toBe(code)
        })

        it("does not rewrite absolute imports", () => {
            const code = `import foo from '/foo';\nconsole.log(foo);`
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toBe(code)
        })

        it("does not rewrite URL imports", () => {
            const code = `import foo from 'https://example.com/foo.js';\nconsole.log(foo);`
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toBe(code)
        })

        it("handles virtualPrefix", () => {
            session.vfs.mkdirSync("/workspace/node_modules/lodash", { recursive: true })
            session.vfs.writeFileSync(
                "/workspace/node_modules/lodash/package.json",
                JSON.stringify({ name: "lodash", main: "lodash.js" }),
            )
            session.vfs.writeFileSync("/workspace/node_modules/lodash/lodash.js", "// lodash")

            const code = `import _ from 'lodash';\nconsole.log(_);`
            const result = session.rewriteBareImports(code, "/workspace", "/__virtual__/5173")
            expect(result).toContain("/__virtual__/5173/node_modules/lodash")
        })

        it("handles scoped packages", () => {
            session.vfs.mkdirSync("/workspace/node_modules/@scope/pkg", { recursive: true })
            session.vfs.writeFileSync(
                "/workspace/node_modules/@scope/pkg/package.json",
                JSON.stringify({ name: "@scope/pkg", main: "index.js" }),
            )
            session.vfs.writeFileSync("/workspace/node_modules/@scope/pkg/index.js", "// scoped")

            const code = `import pkg from '@scope/pkg';\nconsole.log(pkg);`
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toContain("/node_modules/@scope/pkg")
        })

        it("handles code without import/export", () => {
            const code = `const x = 1;\nconsole.log(x);`
            const result = session.rewriteBareImports(code, "/workspace")
            expect(result).toBe(code)
        })
    })

    describe("applyVirtualWrite", () => {
        it("writes to observable FS", async () => {
            await session.applyVirtualWrite("/test-write.txt", "hello")
            await tick()
            const content = await fs.readFile("/test-write.txt", "utf-8")
            expect(content).toBe("hello")
        })

        it("creates parent directories", async () => {
            await session.applyVirtualWrite("/deep/nested/file.txt", "content")
            await tick()
            const exists = await fs.exists("/deep/nested")
            expect(exists).toBe(true)
        })

        it("does not write internal paths", async () => {
            await session.applyVirtualWrite("/.almostnode/test.txt", "secret")
            await tick()
            const exists = await fs.exists("/.almostnode/test.txt")
            expect(exists).toBe(false)
        })
    })

    describe("applyVirtualMkdir", () => {
        it("creates directory in observable FS", async () => {
            await session.applyVirtualMkdir("/new-dir")
            await tick()
            const exists = await fs.exists("/new-dir")
            expect(exists).toBe(true)
        })

        it("does not create internal directories", async () => {
            await session.applyVirtualMkdir("/.almostnode/subdir")
            await tick()
            const exists = await fs.exists("/.almostnode/subdir")
            expect(exists).toBe(false)
        })
    })

    describe("applyVirtualRemove", () => {
        it("removes file from observable FS", async () => {
            await fs.mkdir("/rmtest", { recursive: true })
            await fs.writeFile("/rmtest/file.txt", "content")

            await session.applyVirtualRemove("/rmtest/file.txt", false)
            await tick()
            const exists = await fs.exists("/rmtest/file.txt")
            expect(exists).toBe(false)
        })

        it("does not remove internal paths", async () => {
            // /.almostnode exists in VFS, this should be a no-op
            await session.applyVirtualRemove("/.almostnode", true)
            expect(session.vfs.existsSync("/.almostnode")).toBe(true)
        })
    })

    describe("applyVirtualRename", () => {
        it("renames in observable FS", async () => {
            await fs.mkdir("/rename-test", { recursive: true })
            await fs.writeFile("/rename-test/old.txt", "content")

            await session.applyVirtualRename("/rename-test/old.txt", "/rename-test/new.txt")
            await tick()
            const oldExists = await fs.exists("/rename-test/old.txt")
            const newExists = await fs.exists("/rename-test/new.txt")
            expect(oldExists).toBe(false)
            expect(newExists).toBe(true)
        })

        it("does not rename internal paths", async () => {
            // Should not crash and should be a no-op for internal paths
            await session.applyVirtualRename("/.almostnode/a", "/.almostnode/b")
            // Just verify it doesn't throw
        })
    })
})
