import { useEffect, useRef, useCallback } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import { createBrowserBashSession, executeBrowserBash, type BrowserBashSession } from "agent-web-os"
import "./App.css"

const DOTS = Array.from({ length: 10 })

function useTerminal() {
    const containerRef = useRef<HTMLDivElement>(null)
    const terminalRef = useRef<Terminal | null>(null)
    const sessionRef = useRef<BrowserBashSession | null>(null)
    const inputBufferRef = useRef("")
    const runningRef = useRef(false)
    const streamedBytesRef = useRef(0)

    const runCommand = useCallback((command: string) => {
        const terminal = terminalRef.current
        const session = sessionRef.current
        if (!terminal || !session || runningRef.current) return

        inputBufferRef.current = ""
        terminal.write(command + "\r\n")
        runningRef.current = true
        streamedBytesRef.current = 0
        void executeBrowserBash(session, command, { truncateOutput: false }).then((result) => {
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

                runningRef.current = true
                streamedBytesRef.current = 0
                void executeBrowserBash(session, command, { truncateOutput: false }).then((result) => {
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
                continue
            }

            if (char === "\n") continue
            if (char === "\u200B" || char === "\u200C" || char === "\u200D" || char === "\u2060" || char === "\uFEFF") continue

            inputBufferRef.current += char
            terminal.write(char)
        }
    }, [])

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

        terminal.write("Welcome to Agent Web OS (WASM/X86_64)\r\n")
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
                        <span className="grid-value">WASM-32</span>
                    </div>
                    <div className="grid-item">
                        <span className="grid-label">Shell</span>
                        <span className="grid-value">BASH-5.1</span>
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
                            onClick={() => runCommand("npm install -g @mariozechner/pi-coding-agent")}
                        >
                            ▶ npm install -g @mariozechner/pi-coding-agent
                        </button>
                    </div>
                    <div className="terminal-core">
                        <div className="terminal-header">
                            <span>bash-5.1$ session_01</span>
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

                <footer>
                    <div>OPEN SOURCE // MIT LICENSE</div>
                    <div>[ NPM: agent-web-os ]</div>
                    <div>GITHUB.COM/NICOSHL/AGENT-WEB-OS</div>
                </footer>
            </main>
        </>
    )
}
