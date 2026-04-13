# agent-web-os

**[English](./README.md)** | **[中文](./README.zh-CN.md)**

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

const session = createBrowserBashSession({ rootPath: "/workspace" })

export async function runAgentWebOsDemo() {
    const result = await executeBrowserBash(session, "node --version")
    console.log(result.stdout)
}
```

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

const session = createBrowserBashSession({ rootPath: "/workspace" })
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
