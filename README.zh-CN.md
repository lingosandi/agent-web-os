# agent-web-os

**[English](./README.md)** | **[中文](./README.zh-CN.md)**

基于浏览器的 Agent 操作系统。集成 Bash + Node.js + Python 运行时，内置可观测的内存文件系统。支持安装 NPM 或 PIP 包、执行 Shell 命令、运行 Node.js 脚本，并在浏览器中管理文件——无需服务器。兼容 Claude Code、Codex CLI 和 OpenCode。

## 安装

```bash
npm install agent-web-os
```

## 使用方法

### Bash 会话

创建一个完整的 Bash 会话，包含虚拟文件系统、Shell 和 Node.js 运行时：

```ts
import { createBrowserBashSession } from "agent-web-os"

const session = createBrowserBashSession({
  rootPath: "/workspace",
})

// 执行 Shell 命令
const result = await executeBrowserBash(session, "echo hello world")
console.log(result.stdout) // "hello world\n"

// 通过可观测文件系统读写文件
session.fs.writeFileSync("/workspace/index.js", 'console.log("hi")')
await executeBrowserBash(session, "node index.js")

// 清理资源
session.dispose()
```

### 可观测文件系统

响应式的内存文件系统，支持变更事件监听：

```ts
import { ObservableInMemoryFs } from "agent-web-os"

const fs = new ObservableInMemoryFs()

fs.subscribe((event) => {
  console.log(event.event, event.path) // "add", "/hello.txt"
})

fs.writeFileSync("/hello.txt", "world")
```

### Node.js 运行时

通过 [almostnode](https://www.npmjs.com/package/almostnode) 在浏览器中运行 Node.js 脚本和 npm 命令：

```ts
import { createAlmostNodeSession } from "agent-web-os"

const nodeSession = createAlmostNodeSession(fs)
// 支持 node、npm install、npm run 和 Vite 开发服务器
```

### Service Worker 桥接

如需在浏览器中支持 HTTP 服务器，注册 Service Worker：

```ts
import { getServerBridge } from "agent-web-os"

const bridge = getServerBridge()
await bridge.initServiceWorker()
```

将 `node_modules/agent-web-os/dist/__sw__.js` 复制到你的 public 目录，以便注册 Service Worker。

## 许可证

MIT
