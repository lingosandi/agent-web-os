import { defineCommand } from "just-bash/browser"
import { AlmostNodeSession } from "./almostnode-session"
import {
    attachBrowserBashSessionRuntimeAdapter,
    createBrowserBashSession,
    detachBrowserBashSessionRuntimeAdapter,
    type BrowserBashSession,
    type BrowserBashSessionRuntimeAdapter,
} from "./browser-bash-session"
import { getServerBridge, resetServerBridge, type ServerBridge } from "./server-bridge"

const enabledNodeAdapters = new WeakMap<BrowserBashSession, BrowserBashSessionRuntimeAdapter>()

export type NodeBrowserBashSessionOptions = {
    rootPath?: string
    env?: Record<string, string>
    fsOptions?: import("./observable-in-memory-fs").ObservableInMemoryFsOptions
    python?: boolean
    customCommands?: import("just-bash/browser").CustomCommand[]
}

export async function enableNode(session: BrowserBashSession): Promise<BrowserBashSession> {
    const existingAdapter = enabledNodeAdapters.get(session)
    if (existingAdapter) {
        return session
    }

    const almostNodeSession = new AlmostNodeSession(session.fs)
    const executeNode = almostNodeSession.executeNode.bind(almostNodeSession)
    const executeNpm = almostNodeSession.executeNpm.bind(almostNodeSession)

    almostNodeSession.setBinCommandRegistrar((name, handler) => {
        session.bash.registerCommand(defineCommand(name, handler))
    })

    const adapter: BrowserBashSessionRuntimeAdapter = {
        setStdoutWriter: (writer) => almostNodeSession.setStdoutWriter(writer),
        writeStdin: (data) => almostNodeSession.writeStdin(data),
        setTerminalSize: (columns, rows) => almostNodeSession.setTerminalSize(columns, rows),
        dispose: () => {
            almostNodeSession.dispose()
            // Detach so later setStdoutWriter/writeStdin calls don't hit a
            // disposed session, and enableNode() can attach a fresh one.
            detachBrowserBashSessionRuntimeAdapter(session, adapter)
            enabledNodeAdapters.delete(session)
        },
    }
    attachBrowserBashSessionRuntimeAdapter(session, adapter)
    enabledNodeAdapters.set(session, adapter)

    session.bash.registerCommand(
        defineCommand("node", executeNode),
    )
    session.bash.registerCommand(
        defineCommand("npm", executeNpm),
    )

    return session
}

export async function createNodeBrowserBashSession(
    options: NodeBrowserBashSessionOptions = {},
): Promise<BrowserBashSession> {
    const session = createBrowserBashSession(options)
    await enableNode(session)
    return session
}

export { getServerBridge, resetServerBridge, type ServerBridge }