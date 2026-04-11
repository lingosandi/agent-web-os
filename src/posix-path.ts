/**
 * Minimal browser-safe POSIX path utilities.
 * Replaces `path.posix` from Node.js so the library works in browser environments.
 */

function normalize(p: string): string {
    if (p === "") return "."
    const isAbsolute = p.charCodeAt(0) === 47 // '/'
    const trailingSlash = p.charCodeAt(p.length - 1) === 47

    const segments: string[] = []
    for (const seg of p.split("/")) {
        if (seg === ".." && segments.length > 0 && segments[segments.length - 1] !== "..") {
            segments.pop()
        } else if (seg !== "." && seg !== "") {
            segments.push(seg)
        }
    }

    let result = segments.join("/")
    if (isAbsolute) result = "/" + result
    if (trailingSlash && result.length > 1) result += "/"
    return result || (isAbsolute ? "/" : ".")
}

function join(...parts: string[]): string {
    return normalize(parts.filter(Boolean).join("/"))
}

function resolve(...parts: string[]): string {
    let resolved = ""
    for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]
        if (!p) continue
        resolved = resolved ? p + "/" + resolved : p
        if (p.charCodeAt(0) === 47) break // absolute, stop
    }
    return normalize(resolved || "/")
}

function dirname(p: string): string {
    if (p === "" || p === "/") return p || "."
    const i = p.lastIndexOf("/")
    if (i === -1) return "."
    if (i === 0) return "/"
    return p.slice(0, i)
}

function basename(p: string, ext?: string): string {
    let base = p.slice(p.lastIndexOf("/") + 1)
    if (ext && base.endsWith(ext)) {
        base = base.slice(0, -ext.length)
    }
    return base
}

function relative(from: string, to: string): string {
    from = resolve(from)
    to = resolve(to)
    if (from === to) return ""

    const fromParts = from.split("/").filter(Boolean)
    const toParts = to.split("/").filter(Boolean)

    let common = 0
    while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
        common++
    }

    const ups = fromParts.length - common
    const remaining = toParts.slice(common)
    return [...Array(ups).fill(".."), ...remaining].join("/")
}

function isAbsolute(p: string): boolean {
    return p.length > 0 && p.charCodeAt(0) === 47
}

export const posixPath = { normalize, join, resolve, dirname, basename, relative, isAbsolute }
