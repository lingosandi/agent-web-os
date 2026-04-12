/**
 * `fd` command implementation for just-bash.
 *
 * A simplified browser-compatible implementation of https://github.com/sharkdp/fd
 * Supports the flags that pi-coding-agent's find tool uses:
 *   fd [FLAGS] [pattern] [path...]
 *
 * Flags:
 *   --glob / -g          Treat pattern as glob (default: regex)
 *   --fixed-strings / -F Treat pattern as literal string
 *   --hidden / -H        Include hidden files/directories
 *   --no-ignore / -I     Don't respect .gitignore
 *   --type / -t f|d      Filter by type (f=file, d=directory)
 *   --extension / -e ext Filter by extension
 *   --exclude PATTERN    Exclude entries matching glob
 *   --max-depth / -d N   Maximum search depth
 *   --max-results N      Stop after N results
 *   --color never        (accepted, always off)
 *   --ignore-file PATH   Additional ignore file
 *   --absolute-path / -a Print absolute paths
 *   --full-path / -p     Match pattern against full path
 *   -1                   Stop after first result
 */

import type { CommandContext, ExecResult } from "just-bash/browser"

interface FdOptions {
    glob: boolean
    fixedStrings: boolean
    hidden: boolean
    noIgnore: boolean
    typeFilter: "f" | "d" | null
    extensions: string[]
    excludes: string[]
    maxDepth: number
    maxResults: number
    ignoreFiles: string[]
    absolutePath: boolean
    fullPath: boolean
    pattern: string
    searchPaths: string[]
}

function parseFdArgs(args: string[]): { options: FdOptions } | { error: string } {
    const opts: FdOptions = {
        glob: false,
        fixedStrings: false,
        hidden: false,
        noIgnore: false,
        typeFilter: null,
        extensions: [],
        excludes: [],
        maxDepth: Infinity,
        maxResults: Infinity,
        ignoreFiles: [],
        absolutePath: false,
        fullPath: false,
        pattern: "",
        searchPaths: [],
    }

    const positional: string[] = []
    let i = 0

    while (i < args.length) {
        const arg = args[i]

        if (arg === "--") {
            positional.push(...args.slice(i + 1))
            break
        }

        if (arg === "--glob" || arg === "-g") { opts.glob = true; i++; continue }
        if (arg === "--fixed-strings" || arg === "-F") { opts.fixedStrings = true; i++; continue }
        if (arg === "--hidden" || arg === "-H") { opts.hidden = true; i++; continue }
        if (arg === "--no-ignore" || arg === "-I") { opts.noIgnore = true; i++; continue }
        if (arg === "--absolute-path" || arg === "-a") { opts.absolutePath = true; i++; continue }
        if (arg === "--full-path" || arg === "-p") { opts.fullPath = true; i++; continue }
        if (arg === "-1") { opts.maxResults = 1; i++; continue }

        if (arg === "--type" || arg === "-t") {
            const val = args[++i]
            if (val === "f" || val === "file") opts.typeFilter = "f"
            else if (val === "d" || val === "dir" || val === "directory") opts.typeFilter = "d"
            i++; continue
        }

        if (arg === "--extension" || arg === "-e") {
            const ext = args[++i]
            if (ext) opts.extensions.push(ext.startsWith(".") ? ext.slice(1) : ext)
            i++; continue
        }

        if (arg === "--exclude" || arg === "-E") {
            const pat = args[++i]
            if (pat) opts.excludes.push(pat)
            i++; continue
        }

        if (arg === "--max-depth" || arg === "-d") {
            const n = Number.parseInt(args[++i] ?? "", 10)
            if (!Number.isNaN(n)) opts.maxDepth = n
            i++; continue
        }

        if (arg === "--max-results") {
            const n = Number.parseInt(args[++i] ?? "", 10)
            if (!Number.isNaN(n)) opts.maxResults = n
            i++; continue
        }

        if (arg === "--ignore-file") {
            const p = args[++i]
            if (p) opts.ignoreFiles.push(p)
            i++; continue
        }

        // Accept and ignore color flags
        if (arg === "--color" || arg === "--colour") {
            i += 2; continue
        }
        if (arg.startsWith("--color=") || arg.startsWith("--colour=")) {
            i++; continue
        }

        // Accept and ignore some other common flags
        if (arg === "-L" || arg === "--follow") { i++; continue }
        if (arg === "-s" || arg === "--case-sensitive") { i++; continue }
        if (arg === "-i" || arg === "--ignore-case") { i++; continue }
        if (arg === "-S" || arg === "--smart-case") { i++; continue }

        // Version/help
        if (arg === "--version" || arg === "-V") {
            return { error: "__version__" }
        }
        if (arg === "--help" || arg === "-h") {
            return { error: "__help__" }
        }

        if (arg.startsWith("-")) {
            return { error: `Unknown flag: ${arg}` }
        }

        positional.push(arg)
        i++
    }

    if (positional.length > 0) {
        opts.pattern = positional[0]
        opts.searchPaths = positional.slice(1)
    }

    return { options: opts }
}

/** Convert a glob pattern to a RegExp */
function globToRegex(pattern: string): RegExp {
    let regex = ""
    let i = 0
    while (i < pattern.length) {
        const ch = pattern[i]
        if (ch === "*") {
            if (pattern[i + 1] === "*") {
                // ** matches everything including slashes
                regex += ".*"
                i += 2
                if (pattern[i] === "/") i++ // skip trailing slash after **
                continue
            }
            regex += "[^/]*"
        } else if (ch === "?") {
            regex += "[^/]"
        } else if (ch === "[") {
            const close = pattern.indexOf("]", i + 1)
            if (close !== -1) {
                regex += pattern.slice(i, close + 1)
                i = close + 1
                continue
            }
            regex += "\\["
        } else if (ch === "{") {
            const close = pattern.indexOf("}", i + 1)
            if (close !== -1) {
                const alternatives = pattern.slice(i + 1, close).split(",").map(a => a.trim())
                regex += `(?:${alternatives.map(escapeRegex).join("|")})`
                i = close + 1
                continue
            }
            regex += "\\{"
        } else if (".+^$|()\\".includes(ch)) {
            regex += `\\${ch}`
        } else {
            regex += ch
        }
        i++
    }
    return new RegExp(`^${regex}$`, "i")
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Simple gitignore-style pattern matching */
function parseIgnorePatterns(content: string): ((relPath: string, isDir: boolean) => boolean)[] {
    const matchers: ((relPath: string, isDir: boolean) => boolean)[] = []
    for (const raw of content.split("\n")) {
        const line = raw.trim()
        if (!line || line.startsWith("#")) continue
        if (line.startsWith("!")) continue // negation not supported in this simple impl

        let pattern = line
        const dirOnly = pattern.endsWith("/")
        if (dirOnly) pattern = pattern.slice(0, -1)

        const re = globToRegex(pattern)
        matchers.push((relPath, isDir) => {
            if (dirOnly && !isDir) return false
            // Match against the basename or full path
            const basename = relPath.split("/").pop() ?? relPath
            return re.test(basename) || re.test(relPath)
        })
    }
    return matchers
}

type IgnoreMatcher = (relPath: string, isDir: boolean) => boolean

async function loadIgnoreFile(
    fs: { readFile(path: string): Promise<string> },
    filePath: string,
): Promise<IgnoreMatcher[]> {
    try {
        const content = await fs.readFile(filePath)
        return parseIgnorePatterns(content)
    } catch {
        return []
    }
}

function resolvePath(base: string, rel: string): string {
    if (rel.startsWith("/")) return normalizePath(rel)
    return normalizePath(`${base}/${rel}`)
}

function normalizePath(p: string): string {
    const parts = p.split("/").filter(Boolean)
    const result: string[] = []
    for (const part of parts) {
        if (part === "..") result.pop()
        else if (part !== ".") result.push(part)
    }
    return `/${result.join("/")}`
}

export async function executeFd(args: string[], ctx: CommandContext): Promise<ExecResult> {
    const parsed = parseFdArgs(args)

    if ("error" in parsed) {
        if (parsed.error === "__version__") {
            return { stdout: "fd 10.2.0 (just-bash)\n", stderr: "", exitCode: 0 }
        }
        if (parsed.error === "__help__") {
            return {
                stdout: [
                    "Usage: fd [OPTIONS] [pattern] [path...]",
                    "",
                    "Options:",
                    "  -H, --hidden           Include hidden files/directories",
                    "  -I, --no-ignore        Don't respect .gitignore",
                    "  -g, --glob             Glob-based search",
                    "  -F, --fixed-strings    Literal string search",
                    "  -t, --type <type>      Filter by type: f(ile), d(irectory)",
                    "  -e, --extension <ext>  Filter by extension",
                    "  -E, --exclude <pat>    Exclude pattern",
                    "  -d, --max-depth <n>    Maximum search depth",
                    "      --max-results <n>  Maximum number of results",
                    "  -a, --absolute-path    Show absolute paths",
                    "  -p, --full-path        Match against full path",
                    "      --ignore-file <f>  Additional ignore file",
                    "      --color <when>     (always off in browser)",
                    "  -1                     Stop after first result",
                    "",
                ].join("\n"),
                stderr: "",
                exitCode: 0,
            }
        }
        return { stdout: "", stderr: `error: ${parsed.error}\n`, exitCode: 1 }
    }

    const opts = parsed.options
    const fs = ctx.fs
    const cwd = ctx.cwd ?? "/"
    const searchRoots = opts.searchPaths.length > 0
        ? opts.searchPaths.map(p => resolvePath(cwd, p))
        : [cwd]

    // Build the match regex from the pattern
    let matchRegex: RegExp | null = null
    if (opts.pattern) {
        if (opts.fixedStrings) {
            matchRegex = new RegExp(escapeRegex(opts.pattern), "i")
        } else if (opts.glob) {
            matchRegex = globToRegex(opts.pattern)
        } else {
            try {
                matchRegex = new RegExp(opts.pattern, "i")
            } catch {
                return { stdout: "", stderr: `error: invalid regex: ${opts.pattern}\n`, exitCode: 1 }
            }
        }
    }

    // Build exclude matchers
    const excludeMatchers = opts.excludes.map(p => globToRegex(p))

    // Load ignore files (gitignore patterns)
    const ignoreMatchers: IgnoreMatcher[] = []
    if (!opts.noIgnore) {
        for (const root of searchRoots) {
            const gitignorePath = `${root}/.gitignore`
            const loaded = await loadIgnoreFile(fs, gitignorePath)
            ignoreMatchers.push(...loaded)
        }
    }
    for (const ignoreFile of opts.ignoreFiles) {
        const absPath = resolvePath(cwd, ignoreFile)
        const loaded = await loadIgnoreFile(fs, absPath)
        ignoreMatchers.push(...loaded)
    }

    const results: string[] = []
    let limitReached = false

    async function walk(dirPath: string, rootPath: string, depth: number): Promise<void> {
        if (limitReached) return
        if (depth > opts.maxDepth) return

        let entries: string[]
        try {
            entries = await fs.readdir(dirPath)
        } catch {
            return
        }

        for (const entry of entries) {
            if (limitReached) return

            // Skip hidden files unless --hidden
            if (!opts.hidden && entry.startsWith(".")) continue

            const fullPath = `${dirPath}/${entry}`
            let isDir = false
            let isFile = false
            try {
                const st = await fs.stat(fullPath)
                isDir = st.isDirectory
                isFile = st.isFile
            } catch {
                continue
            }

            const relPath = fullPath.slice(rootPath.length + 1) || entry

            // Check ignores
            if (!opts.noIgnore && ignoreMatchers.some(m => m(relPath, isDir))) continue

            // Check excludes
            const basename = entry
            if (excludeMatchers.some(re => re.test(basename) || re.test(relPath))) continue

            // Type filter
            if (opts.typeFilter === "f" && !isFile) {
                if (isDir) await walk(fullPath, rootPath, depth + 1)
                continue
            }
            if (opts.typeFilter === "d" && !isDir) continue

            // Extension filter
            if (opts.extensions.length > 0) {
                const dotIdx = entry.lastIndexOf(".")
                const ext = dotIdx >= 0 ? entry.slice(dotIdx + 1) : ""
                if (!opts.extensions.some(e => e.toLowerCase() === ext.toLowerCase())) {
                    if (isDir) await walk(fullPath, rootPath, depth + 1)
                    continue
                }
            }

            // Pattern matching
            if (matchRegex) {
                const target = opts.fullPath ? relPath : basename
                if (!matchRegex.test(target)) {
                    if (isDir) await walk(fullPath, rootPath, depth + 1)
                    continue
                }
            }

            // This entry matches
            const output = opts.absolutePath ? fullPath : relPath
            results.push(output)
            if (results.length >= opts.maxResults) {
                limitReached = true
                return
            }

            // Recurse into directories
            if (isDir) {
                await walk(fullPath, rootPath, depth + 1)
            }
        }
    }

    for (const root of searchRoots) {
        if (limitReached) break
        try {
            const st = await fs.stat(root)
            if (!st.isDirectory) {
                return { stdout: "", stderr: `error: '${root}' is not a directory\n`, exitCode: 1 }
            }
        } catch {
            return { stdout: "", stderr: `error: '${root}': No such file or directory\n`, exitCode: 1 }
        }

        // Load root-level gitignore for this search root
        if (!opts.noIgnore) {
            const rootGitignore = `${root}/.gitignore`
            const loaded = await loadIgnoreFile(fs, rootGitignore)
            // Avoid duplicates by only pushing newly loaded matchers
            if (loaded.length > 0) {
                ignoreMatchers.push(...loaded)
            }
        }

        await walk(root, root, 1)
    }

    results.sort()

    if (results.length === 0) {
        return { stdout: "", stderr: "", exitCode: 1 }
    }

    return { stdout: results.join("\n") + "\n", stderr: "", exitCode: 0 }
}
