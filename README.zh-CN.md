# agent-web-os

**[English](./README.md)** | **[中文](./README.zh-CN.md)**

基于浏览器的 AI Agent 操作系统。完整的 Bash Shell、Node.js 运行时和 Python 3.11 执行环境。可观测的内存文件系统。无需服务器。

## 安装

```bash
npm install agent-web-os
bun add agent-web-os
pnpm add agent-web-os
yarn add agent-web-os
```

## Vite 集成

安装 `agent-web-os`，在浏览器中创建会话，然后从组件或 Hook 中执行命令。

```ts
import { createBrowserBashSession, executeBrowserBash } from "agent-web-os"

const session = createBrowserBashSession({ rootPath: "/workspace" })

export async function runAgentWebOsDemo() {
    const result = await executeBrowserBash(session, "node --version")
    console.log(result.stdout)
}
```

## xterm 集成

单独安装 xterm，将其挂载到 DOM 节点，将 stdout 映射到终端，并将按键输入发送到 `writeStdin` 以支持交互式工具。

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

void executeBrowserBash(session, "python --version")
session.almostNodeSession.setStdoutWriter((data) => terminal.write(data))
session.almostNodeSession.setTerminalSize(terminal.cols, terminal.rows)

terminal.onData((data) => {
    session.almostNodeSession.writeStdin(data)
})
```

## 许可证

MIT
