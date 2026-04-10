# agent-web-os

**[English](./README.md)** | **[中文](./README.zh-CN.md)**

Browser-based operating system for your agents. Bash + Node.js + Python runtime with an observable in-memory filesystem. Install NPM or PIP packages, run shell commands, execute Node.js scripts, and manage files entirely in the browser — no server required. Supports Claude Code, Codex CLI, and OpenCode.

## Install

```bash
npm install agent-web-os
```

## Usage

### Bash Session

Create a full bash session with a virtual filesystem, shell, and Node.js runtime:

```ts
import { createBrowserBashSession } from "agent-web-os"

const session = createBrowserBashSession({
  rootPath: "/workspace",
})

// Run shell commands
const result = await executeBrowserBash(session, "echo hello world")
console.log(result.stdout) // "hello world\n"

// Read/write files through the observable filesystem
session.fs.writeFileSync("/workspace/index.js", 'console.log("hi")')
await executeBrowserBash(session, "node index.js")

// Clean up
session.dispose()
```

### Observable Filesystem

A reactive in-memory filesystem that emits change events:

```ts
import { ObservableInMemoryFs } from "agent-web-os"

const fs = new ObservableInMemoryFs()

fs.subscribe((event) => {
  console.log(event.event, event.path) // "add", "/hello.txt"
})

fs.writeFileSync("/hello.txt", "world")
```

### Node.js Runtime

Run Node.js scripts and npm commands in the browser via [almostnode](https://www.npmjs.com/package/almostnode):

```ts
import { createAlmostNodeSession } from "agent-web-os"

const nodeSession = createAlmostNodeSession(fs)
// Provides node, npm install, npm run, and Vite dev server support
```

### Service Worker Bridge

For HTTP server support within the browser, register the service worker:

```ts
import { getServerBridge } from "agent-web-os"

const bridge = getServerBridge()
await bridge.initServiceWorker()
```

Copy `node_modules/agent-web-os/dist/__sw__.js` to your public directory so the service worker can be registered.

## License

MIT
