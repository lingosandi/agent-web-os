/**
 * End-to-end ground truth for the Python workspace write-through mount:
 * REAL pyodide (Node build, same 0.29.5 as the runtime CDN default) with
 * REAL CPython syscalls driving our custom Emscripten filesystem type.
 *
 * Verifies the contract the unit characterization tests cannot: that
 * pyodide.FS actually dispatches open/read/write/llseek/mkdir/unlink/rmdir/
 * rename through our node_ops/stream_ops and that Python-visible state and
 * hub state stay consistent.
 */
import { describe, it, expect, beforeAll } from "vitest"
import { loadPyodide } from "pyodide"
import { ObservableInMemoryFs } from "../src/observable-in-memory-fs"
import { createWorkspaceMount, emscriptenPrimitives } from "../src/pyodide-workspace-fs"
import type { WorkspaceMount } from "../src/pyodide-workspace-fs"

interface PyodideRuntime {
    runPythonAsync(code: string): Promise<unknown>
}

async function flush(mount: WorkspaceMount): Promise<string[]> {
    const warnings: string[] = []
    await mount.flush(warnings)
    return warnings
}

describe("pyodide write-through mount (real pyodide)", () => {
    let hub: ObservableInMemoryFs
    let mount: WorkspaceMount
    let pyodide: PyodideRuntime

    beforeAll(async () => {
        hub = new ObservableInMemoryFs()
        const instance = await loadPyodide()
        const fs = instance.FS
        try {
            fs.mkdir("/workspace")
        } catch {
            // may already exist
        }
        mount = createWorkspaceMount(hub, emscriptenPrimitives(fs), "/workspace")
        fs.mount(mount.filesystemType, { rootPath: "/workspace" }, "/workspace")
        pyodide = instance
    })

    it("python sees hub files and writes flow back in real time", async () => {
        hub.mkdirSync("/workspace", { recursive: true })
        await hub.writeFile("/workspace/seed.txt", "seed-content")
        await hub.writeFile("/workspace/data.bin", new Uint8Array([0, 1, 254, 255, 7]))

        const warnings: string[] = []
        await mount.rebuildSkeleton(warnings)
        expect(warnings).toEqual([])

        await pyodide.runPythonAsync(`
import os
with open("/workspace/seed.txt") as f:
    assert f.read() == "seed-content"

with open("/workspace/data.bin", "rb") as f:
    raw = f.read()
    assert isinstance(raw, bytes) and len(raw) == 5 and raw[2] == 254

with open("/workspace/created.txt", "w") as f:
    f.write("from-python")

with open("/workspace/appended.log", "a") as f:
    f.write("line1")
with open("/workspace/appended.log", "a") as f:
    f.write("line2")

with open("/workspace/seed.txt", "w") as f:
    f.write("rewritten")

os.makedirs("/workspace/gen/nested/deep")
with open("/workspace/gen/nested/deep/out.json", "w") as f:
    f.write('{"ok":true}')

os.rename("/workspace/created.txt", "/workspace/renamed.txt")
os.remove("/workspace/renamed.txt")
os.remove("/workspace/gen/nested/deep/out.json")
os.rmdir("/workspace/gen/nested/deep")
with open("/workspace/gen/nested/stays.txt", "w") as f:
    f.write("kept")
`)

        expect(await flush(mount)).toEqual([])

        expect(await hub.readFile("/workspace/seed.txt", "utf8")).toBe("rewritten")
        expect(await hub.exists("/workspace/renamed.txt")).toBe(false)
        expect(await hub.readFile("/workspace/appended.log", "utf8")).toBe("line1line2")
        expect(await hub.exists("/workspace/gen/nested/deep/out.json")).toBe(false)
        expect(await hub.exists("/workspace/gen/nested/deep")).toBe(false)
        expect(await hub.readFile("/workspace/gen/nested/stays.txt", "utf8")).toBe("kept")
        expect(Array.from(await hub.readFileBuffer("/workspace/data.bin"))).toEqual([0, 1, 254, 255, 7])
    })

    it("partial outputs survive a crashed run (flush on error path)", async () => {
        await mount.rebuildSkeleton([])
        try {
            await pyodide.runPythonAsync(`
with open("/workspace/crash-partial.txt", "w") as f:
    f.write("written-before-crash")
raise RuntimeError("boom")
`)
        } catch {
            // expected
        }

        expect(await flush(mount)).toEqual([])
        expect(await hub.readFile("/workspace/crash-partial.txt", "utf8")).toBe("written-before-crash")
    })

    it("seek/append/truncate semantics behave like a real FS", async () => {
        await mount.rebuildSkeleton([])
        await pyodide.runPythonAsync(`
with open("/workspace/seek.txt", "w") as f:
    f.write("0123456789")
with open("/workspace/seek.txt", "r+b") as f:
    f.seek(4)
    assert f.read(2) == b"45"
    f.seek(0, 2)
    assert f.tell() == 10
    f.seek(-3, 2)
    assert f.tell() == 7
    f.write(b"XYZ")

import os
with open("/workspace/trunc.txt", "w") as f:
    f.write("aaaa")
with open("/workspace/trunc.txt") as f:
    assert f.read() == "aaaa"
os.truncate("/workspace/trunc.txt", 2)
with open("/workspace/trunc.txt") as f:
    assert f.read() == "aa"
`)

        expect(await flush(mount)).toEqual([])
        // "0123456789" with bytes 7..9 replaced by XYZ
        expect(await hub.readFile("/workspace/seek.txt", "utf8")).toBe("0123456XYZ")
        expect(await hub.readFile("/workspace/trunc.txt", "utf8")).toBe("aa")
    })

    it("scans mounted directories and imports workspace modules", async () => {
        hub.mkdirSync("/workspace/import-smoke/nested", { recursive: true })
        await hub.writeFile("/workspace/import-smoke/mounted_module.py", "VALUE = 42\n")
        await mount.rebuildSkeleton([])

        const value = await pyodide.runPythonAsync(`
import os, sys
with os.scandir("/workspace/import-smoke") as entries:
    assert sorted((entry.name, entry.is_dir()) for entry in entries) == [
        ("mounted_module.py", False), ("nested", True)
    ]
sys.path.insert(0, "/workspace/import-smoke")
import mounted_module
mounted_module.VALUE
`)
        expect(value).toBe(42)
    })
})