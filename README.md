# agent-web-os

**[English](./README.md)** | **[中文](./README.zh-CN.md)**

**Website & Live Demo: [agent-web-os.xyz](https://agent-web-os.xyz/)**

A browser-based operating system for AI agents. Full Bash shell, Node.js runtime, and Python 3.11 execution. Observable in-memory filesystem. No server required.

## Install

```bash
npm install agent-web-os
bun add agent-web-os
pnpm add agent-web-os
yarn add agent-web-os
```

## Vite Integration

Install `agent-web-os`, create a session in the browser, and execute commands from your component or hook.

```ts
import { createBrowserBashSession, executeBrowserBash } from "agent-web-os"

const session = createBrowserBashSession({ rootPath: "/workspace", node: true, python: true })

export async function runAgentWebOsDemo() {
    const result = await executeBrowserBash(session, "node --version")
    console.log(result.stdout)
}
```

### Python / Pyodide version

`python: true` lazily loads Pyodide from the jsdelivr CDN (default `0.29.5`,
CPython 3.13). To pin another line or serve your own copy, pass
`pyodideVersion` or a full `pyodideBaseUrl`:

```ts
const session = createBrowserBashSession({
    rootPath: "/workspace",
    python: true,
    pyodideVersion: "0.27.7",
    // or: pyodideBaseUrl: "https://your-host/pyodide/v0.29.5/full/"
})
```

Note: Pyodide ≥ 0.28 accepts `pyodide_2025_0`-tagged wheels, and ≥ 0.29.4
additionally accepts `pyemscripten_*`-tagged wheels (all published OCP.wasm /
cadquery-OCP builds). On 0.27.x micropip rejects those tags.

Node commands restore the host's `console` and `process` globals when execution
finishes, including error exits. In browsers, Pyodide loads in a hidden isolated
iframe so Node shims cannot force Node-only startup. Python's `js` module still
exposes the host application; disposing the session removes the runtime iframe.

## xterm Integration

Install xterm separately, attach it to your DOM node, mirror stdout into the terminal, and send keystrokes into `writeStdin` for interactive tools.

```bash
npm install @xterm/xterm @xterm/addon-fit
bun add @xterm/xterm @xterm/addon-fit
pnpm add @xterm/xterm @xterm/addon-fit
yarn add @xterm/xterm @xterm/addon-fit
```

```ts
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import { createBrowserBashSession, executeBrowserBash } from "agent-web-os"

const session = createBrowserBashSession({ rootPath: "/workspace", node: true, python: true })
const terminal = new Terminal({ convertEol: true, cursorBlink: true })
const fitAddon = new FitAddon()

terminal.loadAddon(fitAddon)
terminal.open(container)
fitAddon.fit()

session.setStdoutWriter((data) => terminal.write(data))
session.setTerminalSize(terminal.cols, terminal.rows)

terminal.onData((data) => {
    session.writeStdin(data)
})
```

## License

MIT
