# agent-web-os

**[English](./README.md)** | **[中文](./README.zh-CN.md)**

**官方网站 & 在线演示：[agent-web-os.xyz](https://agent-web-os.xyz/)**

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

const session = createBrowserBashSession({ rootPath: "/workspace", node: true, python: true })

export async function runAgentWebOsDemo() {
    const result = await executeBrowserBash(session, "node --version")
    console.log(result.stdout)
}
```

### Python / Pyodide 版本

`python: true` 会从 jsdelivr CDN 懒加载 Pyodide（默认 `0.29.5`，CPython
3.13）。如需固定其他版本或使用自托管副本，传入 `pyodideVersion` 或完整的
`pyodideBaseUrl`：

```ts
const session = createBrowserBashSession({
    rootPath: "/workspace",
    python: true,
    pyodideVersion: "0.27.7",
    // 或者：pyodideBaseUrl: "https://your-host/pyodide/v0.29.5/full/"
})
```

注意：Pyodide ≥ 0.28 才接受 `pyodide_2025_0` 标签的 wheel，≥ 0.29.4 额外接受
`pyemscripten_*` 标签（所有已发布的 OCP.wasm / cadquery-OCP 构建均使用这些
标签）。在 0.27.x 上 micropip 会拒绝这些标签。

Node 命令结束后会恢复宿主的 `console` 和 `process` 全局对象，包括异常退出的情况，
浏览器中的 Pyodide 在隐藏的独立 iframe 中加载，避免 Node shim 导致环境检测错误。
Python 的 `js` 模块仍访问宿主应用；销毁会话时会移除运行时 iframe。

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

## 许可证

MIT
