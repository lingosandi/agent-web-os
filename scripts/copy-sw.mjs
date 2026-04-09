#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, "..")
const source = resolve(packageRoot, "node_modules", "almostnode", "dist", "__sw__.js")
const destination = resolve(packageRoot, "dist", "__sw__.js")

if (!existsSync(source)) {
    throw new Error(`Expected service worker asset at ${source}`)
}

mkdirSync(dirname(destination), { recursive: true })
copyFileSync(source, destination)