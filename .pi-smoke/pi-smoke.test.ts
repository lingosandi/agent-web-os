import { describe, it, expect } from "vitest"
import { appendFileSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import path from "node:path"
import { createNodeBrowserBashSession } from "../src/node"
import { executeBrowserBash } from "../src/browser-bash-session"

// Throwaway smoke harness: real almostnode sources aliased in vitest.config.ts.
const LOG = new URL("./result.txt", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
function log(label: string, value: string): void {
    appendFileSync(LOG, `===== ${label} =====\n${value}\n`)
}

// Emulate the browser: almostnode's install-time ESM->CJS transform only runs
// when `window` exists (it otherwise skips esbuild and the runtime falls back
// to a weaker AST/regex transform that breaks pi's dist). Seed window.__esbuild
// with a locally-installed esbuild-wasm@0.20.0 (same version almostnode loads
// from CDN in the browser). Runtime-computed specifier -> dynamic import.
const ESBUILD_DIR = "C:/Users/shele/pi-check-tmp/node_modules/esbuild-wasm"

describe("pi smoke under real almostnode", () => {
    it("installs and runs pi -p headless", async () => {
        writeFileSync(LOG, "")
        const session = await createNodeBrowserBashSession({ env: { OPENAI_API_KEY: "sk-dummy" } })
        const chunks: string[] = []
        session.setStdoutWriter((data) => {
            chunks.push(data)
        })

        const install = await executeBrowserBash(session, "npm install -g @mariozechner/pi-coding-agent", { truncateOutput: false })
        log("INSTALL", `exit=${install.exit_code}\n--stdout--\n${install.stdout}\n--stderr--\n${install.stderr}`)
        expect(install.success).toBe(true)

        // Dump the exact code the runtime will eval + harness repair via the
        // real VirtualFS prototype (session hides the VFS instance).
        const VirtualFs = (await import("../node_modules/almostnode/src/virtual-fs")).VirtualFS as {
            prototype: {
                readFileSync: (p: string, e: string) => string
                writeFileSync: (p: string, c: string) => void
                existsSync: (p: string) => boolean
            }
        }
        const origRead = VirtualFs.prototype.readFileSync
        VirtualFs.prototype.readFileSync = function patchedRead(p: string, e: string) {
            const content = origRead.call(this, p, e)
            if (typeof p === "string" && p.includes("pi-coding-agent/dist/config.js")) {
                writeFileSync("C:/Users/shele/Documents/GitHub/agent-web-os/.pi-smoke/config-as-stored.js", content)
            }
            return content
        }

        // Harness repair: almostnode's install patch rewrote `import('node:buffer')`
        // inside a string literal in openai/internal/uploads.js, breaking its syntax.
        const uploadsPath = "/usr/local/lib/node_modules/openai/internal/uploads.js"
        if (await session.fs.exists(uploadsPath)) {
            const uploads = new TextDecoder().decode(await session.fs.readFileBuffer(uploadsPath))
            const repaired = uploads.split('Promise.resolve(require("node:buffer"))').join("import('node:buffer')")
            if (repaired !== uploads) await session.fs.writeFile(uploadsPath, repaired)
            log("REPAIR", `uploads.js mangled=${uploads !== repaired}`)
        } else {
            log("REPAIR", "uploads.js NOT visible in observable fs")
        }

        const version = await executeBrowserBash(session, "pi --version", { truncateOutput: false, commandTimeoutMs: 120_000 })
        log("VERSION", `exit=${version.exit_code}\n--stdout--\n${version.stdout}\n--stderr--\n${version.stderr}`)
        const argvCheck = await executeBrowserBash(session, 'node -e "console.log(JSON.stringify(process.argv.slice(1)))" x -p "Reply with exactly: OK"', { truncateOutput: false })
        log("ARGV", `exit=${argvCheck.exit_code} stdout=${argvCheck.stdout} stderr=${argvCheck.stderr}`)
        const run = await executeBrowserBash(session, 'node /usr/local/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js --mode json --provider openai --model gpt-4o-mini -p "Reply with exactly: OK"', {
            truncateOutput: false,
            commandTimeoutMs: 240_000,
        })
        log("PI -p", `exit=${run.exit_code}\n--stdout--\n${(run.stdout || "").slice(0, 6000)}\n--stderr--\n${(run.stderr || "").slice(0, 6000)}\n--stream--\n${chunks.join("").slice(-6000)}`)

        // Provider-call proof from inside the sandbox runtime: hit OpenAI with
        // a dummy key; a 401 proves the sandbox fetch reaches the provider.
        await session.fs.writeFile("/workspace/netproof.cjs", [
            'fetch("https://api.openai.com/v1/models", { headers: { Authorization: "Bearer sk-dummy" } })',
            "  .then((r) => r.text().then((t) => { console.log('STATUS', r.status); console.log('BODY', t.slice(0, 300)); process.exit(0) }))",
            "  .catch((e) => { console.log('FETCH_ERR', String(e)); process.exit(0) })",
            "setInterval(() => {}, 1000)",
        ].join("\n"))
        const net = await executeBrowserBash(session, "node /workspace/netproof.cjs", { truncateOutput: false, commandTimeoutMs: 120_000 })
        log("NETPROOF", `exit=${net.exit_code}\n--stdout--\n${(net.stdout || "").slice(0, 1500)}\n--stderr--\n${(net.stderr || "").slice(0, 1500)}`)
    })
})
