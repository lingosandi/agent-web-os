import { it } from "vitest"
import { appendFileSync, writeFileSync } from "node:fs"

const OUT = "C:/Users/shele/Documents/GitHub/agent-web-os/.pi-smoke/fetch-result.txt"

it("host fetch still works after setup patches", async () => {
    writeFileSync(OUT, "")
    try {
        const res = await fetch("https://registry.npmjs.org/lodash/latest")
        appendFileSync(OUT, "status=" + res.status + "\n")
    } catch (error) {
        appendFileSync(OUT, "fetch FAILED: " + String(error) + "\n")
    }
    appendFileSync(OUT, "defineProperty patched: " + String(Object.defineProperty.name === "patchedDefine") + "\n")
})
