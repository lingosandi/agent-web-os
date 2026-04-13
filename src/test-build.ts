import { execSync } from "node:child_process"
import { existsSync, mkdirSync, rmdirSync } from "node:fs"
import path from "node:path"

const bunCommand = process.platform === "win32" ? "bun" : "bun"
const shellPath = process.platform === "win32" ? "cmd.exe" : "/bin/sh"
const buildLockDir = path.join(process.cwd(), ".vitest-build-lock")

function sleep(milliseconds: number) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

export function ensureBuiltDist(requiredFiles: string[]) {
    if (requiredFiles.every((filePath) => existsSync(filePath))) {
        return
    }

    try {
        mkdirSync(buildLockDir)
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== "EEXIST") {
            throw error
        }

        const deadline = Date.now() + 120_000
        while (Date.now() < deadline) {
            if (requiredFiles.every((filePath) => existsSync(filePath))) {
                return
            }
            if (!existsSync(buildLockDir)) {
                break
            }
            sleep(100)
        }

        if (requiredFiles.every((filePath) => existsSync(filePath))) {
            return
        }
    }

    try {
        execSync(`${bunCommand} run build`, {
            cwd: process.cwd(),
            stdio: "pipe",
            shell: shellPath,
        })
    } finally {
        try {
            rmdirSync(buildLockDir)
        } catch {
            // Best effort cleanup for concurrent test workers.
        }
    }
}