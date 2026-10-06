import { it } from "vitest"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { transformFile } from "../node_modules/almostnode/src/transform"

const OUT = "C:/Users/shele/Documents/GitHub/agent-web-os/.pi-smoke/tf3-result.txt"

it("transform pi config.js directly", async () => {
    writeFileSync(OUT, "")
    const origWarn = console.warn
    const origLog = console.log
    console.warn = (...args: unknown[]) => appendFileSync(OUT, "WARN: " + args.map(String).join(" ") + "\n")
    console.log = (...args: unknown[]) => appendFileSync(OUT, "LOG: " + args.map(String).join(" ") + "\n")
    const code = readFileSync("C:/Users/shele/pi-check-tmp/node_modules/@mariozechner/pi-coding-agent/dist/config.js", "utf8")
    try {
        const out = await transformFile(code, "config.js")
        appendFileSync(OUT, "transform returned len=" + out.length + " (input " + code.length + ") keeps exports: " + String(/export function/.test(out)) + "\n")
    } catch (error) {
        appendFileSync(OUT, "transform FAILED: " + String(error) + "\n")
    }
    console.warn = origWarn
    console.log = origLog
})
