import { defineCommand } from "just-bash/browser"
import { AlmostNodeSession } from "./almostnode-session"
import {
    attachBrowserBashSessionRuntimeAdapter,
    createBrowserBashSession,
    type BrowserBashSession,
} from "./browser-bash-session"
import { getServerBridge, resetServerBridge, type ServerBridge } from "./server-bridge"

const enabledNodeSessions = new WeakSet<BrowserBashSession>()

export type NodeBrowserBashSessionOptions = {
    rootPath?: string
    env?: Record<string, string>
    fsOptions?: import("./observable-in-memory-fs").ObservableInMemoryFsOptions
    python?: boolean
    customCommands?: import("just-bash/browser").CustomCommand[]
}

export async function enableNode(session: BrowserBashSession): Promise<BrowserBashSession> {
    if (enabledNodeSessions.has(session)) {
        return session
    }

    const almostNodeSession = new AlmostNodeSession(session.fs)
    const executeNode = almostNodeSession.executeNode.bind(almostNodeSession)
    const executeNpm = almostNodeSession.executeNpm.bind(almostNodeSession)

    almostNodeSession.setBinCommandRegistrar((name, handler) => {
        session.bash.registerCommand(defineCommand(name, handler))
    })

    attachBrowserBashSessionRuntimeAdapter(session, {
        setStdoutWriter: (writer) => almostNodeSession.setStdoutWriter(writer),
        writeStdin: (data) => almostNodeSession.writeStdin(data),
        setTerminalSize: (columns, rows) => almostNodeSession.setTerminalSize(columns, rows),
        dispose: () => almostNodeSession.dispose(),
    })

    session.bash.registerCommand(
        defineCommand("node", executeNode),
    )
    session.bash.registerCommand(
        defineCommand("npm", executeNpm),
    )

    enabledNodeSessions.add(session)
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