import { useEffect, useRef, useCallback, useState } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import { createBrowserBashSession, executeBrowserBash, type BrowserBashSession } from "agent-web-os"
import "./App.css"

const DOTS = Array.from({ length: 10 })
const AGENT_WEB_OS_INSTALL_SNIPPET = String.raw`npm install agent-web-os
bun add agent-web-os
pnpm add agent-web-os
yarn add agent-web-os`

const XTERM_INSTALL_SNIPPET = String.raw`npm install @xterm/xterm @xterm/addon-fit
bun add @xterm/xterm @xterm/addon-fit
pnpm add @xterm/xterm @xterm/addon-fit
yarn add @xterm/xterm @xterm/addon-fit`

const VITE_SETUP_SNIPPET = String.raw`import { createBrowserBashSession, executeBrowserBash } from "agent-web-os"

const session = createBrowserBashSession({ rootPath: "/workspace" })

export async function runAgentWebOsDemo() {
    const result = await executeBrowserBash(session, "node --version")
    console.log(result.stdout)
}`

const XTERM_HOOK_SNIPPET = String.raw`import { Terminal } from "@xterm/xterm"
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
})`

function useTerminal() {
    const containerRef = useRef<HTMLDivElement>(null)
    const terminalRef = useRef<Terminal | null>(null)
    const sessionRef = useRef<BrowserBashSession | null>(null)
    const inputBufferRef = useRef("")
    const runningRef = useRef(false)
    const streamedBytesRef = useRef(0)

    const executeCommand = useCallback((command: string): Promise<void> => {
        const terminal = terminalRef.current
        const session = sessionRef.current
        if (!terminal || !session) return Promise.resolve()

        runningRef.current = true
        streamedBytesRef.current = 0
        return executeBrowserBash(session, command, { truncateOutput: false }).then((result) => {
            const remaining = result.stdout?.slice(streamedBytesRef.current)
            if (remaining) {
                terminal.write(remaining)
            }
            if (result.stderr) {
                terminal.write(result.stderr)
            }
        }).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : "Command failed"
            terminal.write(`\x1b[31m${message}\x1b[0m\r\n`)
        }).finally(() => {
            runningRef.current = false
            terminal.write("$ ")
        })
    }, [])

    const runCommand = useCallback((command: string): Promise<void> => {
        const terminal = terminalRef.current
        if (!terminal || runningRef.current) return Promise.resolve()

        inputBufferRef.current = ""
        terminal.write(command + "\r\n")
        return executeCommand(command)
    }, [executeCommand])

    const handleData = useCallback((data: string) => {
        const terminal = terminalRef.current
        const session = sessionRef.current
        if (!terminal || !session) return

        // When a command is running, forward raw input to its stdin
        if (runningRef.current) {
            session.almostNodeSession.writeStdin(data)
            return
        }

        for (const char of data) {
            if (char === "\u0003") {
                inputBufferRef.current = ""
                terminal.write("^C\r\n$ ")
                continue
            }

            if (char === "\u007f") {
                if (inputBufferRef.current.length > 0) {
                    inputBufferRef.current = inputBufferRef.current.slice(0, -1)
                    terminal.write("\b \b")
                }
                continue
            }

            if (char === "\r") {
                terminal.write("\r\n")
                const command = inputBufferRef.current.trim()
                inputBufferRef.current = ""

                if (!command) {
                    terminal.write("$ ")
                    continue
                }

                if (command === "clear") {
                    terminal.clear()
                    terminal.write("$ ")
                    continue
                }

                executeCommand(command)
                continue
            }

            if (char === "\n") continue
            if (char === "\u200B" || char === "\u200C" || char === "\u200D" || char === "\u2060" || char === "\uFEFF") continue

            inputBufferRef.current += char
            terminal.write(char)
        }
    }, [executeCommand])

    useEffect(() => {
        const container = containerRef.current
        if (!container) return

        const session = createBrowserBashSession({ rootPath: "/workspace" })
        sessionRef.current = session

        const terminal = new Terminal({
            cursorBlink: true,
            convertEol: true,
            fontSize: 13,
            fontFamily: "'IBM Plex Mono', 'JetBrains Mono', 'Fira Code', Menlo, monospace",
            theme: {
                background: "#000000",
                foreground: "#ffffff",
                cursor: "#00FF41",
                selectionBackground: "rgba(0, 255, 65, 0.2)",
            },
            scrollback: 1000,
        })

        const fitAddon = new FitAddon()
        terminal.loadAddon(fitAddon)
        terminal.open(container)
        fitAddon.fit()

        session.almostNodeSession.setStdoutWriter((data) => {
            streamedBytesRef.current += data.length
            terminal.write(data)
        })

        session.almostNodeSession.setTerminalSize(terminal.cols, terminal.rows)
        terminal.onResize(({ cols, rows }) => {
            session.almostNodeSession.setTerminalSize(cols, rows)
        })

        terminal.attachCustomKeyEventHandler((event) => {
            if (event.type !== "keydown") return true
            if (event.ctrlKey && event.key === "c" && terminal.hasSelection()) return false
            if (event.ctrlKey && event.key === "v") return false
            return true
        })

        terminal.write("Welcome to Agent Web OS\r\n")
        terminal.write("Sandbox initialized. Node.js + Python available.\r\n")
        terminal.write("Type 'help' for available commands.\r\n\r\n")
        terminal.write("$ ")

        terminalRef.current = terminal
        const dataDisposable = terminal.onData(handleData)

        const observer = new ResizeObserver(() => {
            try { fitAddon.fit() } catch { /* ignore */ }
        })
        observer.observe(container)

        return () => {
            dataDisposable.dispose()
            observer.disconnect()
            terminal.dispose()
            session.dispose()
            terminalRef.current = null
            sessionRef.current = null
        }
    }, [handleData])

    return { containerRef, runCommand }
}

export default function App() {
    const { containerRef: terminalContainerRef, runCommand } = useTerminal()
    const [installing, setInstalling] = useState(false)
    const [installed, setInstalled] = useState(false)
    const [startingPi, setStartingPi] = useState(false)

    const handleInstall = useCallback(() => {
        setInstalling(true)
        void runCommand("npm install -g @mariozechner/pi-coding-agent").then(() => {
            setInstalled(true)
        })
    }, [runCommand])

    const handleStartPi = useCallback(() => {
        setStartingPi(true)
        void runCommand("pi").finally(() => {
            setStartingPi(false)
        })
    }, [runCommand])

    return (
        <>
            <div className="frame" />

            <main>
                <div className="header-meta">
                    <div>AGENT-WEB-OS // V.0.1.2</div>
                    <div>STATUS: KERNEL_READY</div>
                    <div>NPM: agent-web-os</div>
                </div>

                <section className="hero-section">
                    <h1 className="hero-title">AGENT<br />WEB OS</h1>

                    <div className="dot-matrix">
                        {DOTS.map((_, i) => <div key={i} className="dot" />)}
                    </div>

                    <p className="hero-subtitle">
                        A browser-based operating system for AI agents.
                        Full Bash shell, Node.js runtime, and Python 3.11 execution.
                        Observable in-memory filesystem. No server required.
                    </p>
                </section>

                <section className="data-grid">
                    <div className="grid-item">
                        <span className="grid-label">Runtime Engine</span>
                        <span className="grid-value">WASM</span>
                    </div>
                    <div className="grid-item">
                        <span className="grid-label">Shell</span>
                        <span className="grid-value">BASH</span>
                    </div>
                    <div className="grid-item">
                        <span className="grid-label">Filesystem</span>
                        <span className="grid-value">IN-MEM</span>
                    </div>
                </section>

                <section className="terminal-container">
                    <div className="terminal-actions">
                        <button
                            className="install-btn"
                            disabled={installing || installed}
                            onClick={handleInstall}
                        >
                            ▶ npm install -g @mariozechner/pi-coding-agent
                        </button>
                        <button
                            className="install-btn"
                            disabled={!installed || startingPi}
                            onClick={handleStartPi}
                        >
                            ▶ start pi-coding-agent
                        </button>
                    </div>
                    <div className="terminal-core">
                        <div className="terminal-header">
                            <span>bash$ session_01</span>
                            <span>agent-web-os live demo</span>
                        </div>
                        <div className="terminal-xterm" ref={terminalContainerRef} />
                    </div>
                </section>

                <div className="marquee">
                    <div className="marquee-content">
                        COMPUTATION BEYOND BORDERS // PYTHON IN BROWSER // NODE.JS WASM // BASH EMULATION // VIRTUAL FILE SYSTEM // AGENT WEB OS // COMPUTATION BEYOND BORDERS // PYTHON IN BROWSER // NODE.JS WASM // BASH EMULATION // VIRTUAL FILE SYSTEM // AGENT WEB OS //
                    </div>
                </div>

                <section className="docs-section">
                    <div className="docs-header">
                        <div className="docs-kicker">Integration Notes</div>
                        <h2 className="docs-title">Ship agent-web-os in your app</h2>
                        <p className="docs-copy">
                            Start by installing the runtime package, then create a browser-only session in your app.
                            If you want a terminal UI, install xterm separately and wire it into the session stdin and stdout streams.
                        </p>
                    </div>

                    <div className="docs-grid">
                        <article className="docs-card">
                            <div className="docs-card-header">
                                <span className="docs-card-kicker">Vite</span>
                                <span className="docs-card-meta">Client bundle</span>
                            </div>
                            <p className="docs-card-copy">
                                Install `agent-web-os`, create a session in the browser, and execute commands from your component or hook.
                            </p>
                            <div className="docs-block">
                                <div className="docs-block-label">Install</div>
                                <pre className="docs-code"><code>{AGENT_WEB_OS_INSTALL_SNIPPET}</code></pre>
                            </div>
                            <div className="docs-block">
                                <div className="docs-block-label">Example</div>
                            <pre className="docs-code"><code>{VITE_SETUP_SNIPPET}</code></pre>
                            </div>
                        </article>

                        <article className="docs-card">
                            <div className="docs-card-header">
                                <span className="docs-card-kicker">xterm</span>
                                <span className="docs-card-meta">Attach terminal IO</span>
                            </div>
                            <p className="docs-card-copy">
                                Install xterm separately, attach it to your DOM node, mirror stdout into the terminal, and send keystrokes into `writeStdin` for interactive tools.
                            </p>
                            <div className="docs-block">
                                <div className="docs-block-label">Install</div>
                                <pre className="docs-code"><code>{XTERM_INSTALL_SNIPPET}</code></pre>
                            </div>
                            <div className="docs-block">
                                <div className="docs-block-label">Example</div>
                                <pre className="docs-code"><code>{XTERM_HOOK_SNIPPET}</code></pre>
                            </div>
                        </article>
                    </div>
                </section>

                <footer>
                    <div>OPEN SOURCE // MIT LICENSE</div>
                    <div>[ NPM: agent-web-os ]</div>
                    <div>GITHUB.COM/NICOSHL/AGENT-WEB-OS</div>
                </footer>
            </main>
        </>
    )
}
