import { it } from "vitest"
import { appendFileSync, writeFileSync } from "node:fs"

const OUT = "C:/Users/shele/Documents/GitHub/agent-web-os/.pi-smoke/tf4-result.txt"

it("esbuild direct sanity", async () => {
    writeFileSync(OUT, "")
    const glob = globalThis as unknown as { __esbuild?: { transform: (c: string, o: unknown) => Promise<{ code: string }> } }
    const esbuild = glob.__esbuild
    if (!esbuild) {
        appendFileSync(OUT, "no __esbuild in globalThis\n")
        return
    }
    const src = 'import { x } from "y";\nexport function f(){ return x }\n'
    const r1 = await esbuild.transform(src, { loader: "js", format: "cjs", target: "esnext", platform: "neutral" })
    appendFileSync(OUT, "plain cjs:\n" + r1.code + "\n")
    try {
        const r2 = await esbuild.transform(src, {
            loader: "js",
            format: "cjs",
            target: "esnext",
            platform: "neutral",
            define: { "import.meta.url": "import_meta.url", "import.meta.dirname": "import_meta.dirname", "import.meta.filename": "import_meta.filename", "import.meta": "import_meta" },
        })
        appendFileSync(OUT, "with define:\n" + r2.code + "\n")
    } catch (error) {
        appendFileSync(OUT, "with define FAILED: " + String(error) + "\n")
    }
})
