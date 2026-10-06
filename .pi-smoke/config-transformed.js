Object.defineProperty(exports, "__esModule", { value: true });
const { spawnSync } = require("child_process")
const { accessSync, constants, existsSync, readFileSync, realpathSync } = require("fs")
const { homedir } = require("os")
const { basename, dirname, join, resolve, sep, win32 } = require("path")
const { fileURLToPath } = require("url")
const { shouldUseWindowsShell } = require("./utils/child-process.js")
// =============================================================================
// Package Detection
// =============================================================================
const __filename = fileURLToPath(import_meta.url);
const __dirname = dirname(__filename);
/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
exports.isBunBinary = import_meta.url.includes("$bunfs") || import_meta.url.includes("~BUN") || import_meta.url.includes("%7EBUN")
/** Detect if Bun is the runtime (compiled binary or bun run) */
exports.isBunRuntime = !!process.versions.bun
function makeSelfUpdateCommand(installStep, uninstallStep) {
    if (!uninstallStep)
        return installStep;
    return {
        ...installStep,
        display: `${uninstallStep.display} && ${installStep.display}`,
        steps: [uninstallStep, installStep],
    };
}
function makeSelfUpdateCommandStep(command, args) {
    return {
        command,
        args,
        display: [command, ...args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" "),
    };
}
exports.detectInstallMethod = function detectInstallMethod() {
    if (isBunBinary) {
        return "bun-binary";
    }
    const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase().replace(/\\/g, "/");
    if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/")) {
        return "pnpm";
    }
    if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/")) {
        return "yarn";
    }
    if (isBunRuntime || resolvedPath.includes("/install/global/node_modules/")) {
        return "bun";
    }
    if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/")) {
        return "npm";
    }
    return "unknown";
}
function getInferredNpmInstall(packageName) {
    const packageDir = getPackageDir();
    const path = process.platform === "win32" || packageDir.includes("\\") ? win32 : { basename, dirname };
    const [scope, name] = packageName.split("/");
    let root;
    if (name &&
        scope?.startsWith("@") &&
        path.basename(path.dirname(packageDir)) === scope &&
        path.basename(packageDir) === name) {
        root = path.dirname(path.dirname(packageDir));
    }
    else if (!name && path.basename(packageDir) === packageName) {
        root = path.dirname(packageDir);
    }
    if (!root || path.basename(root) !== "node_modules")
        return undefined;
    const parent = path.dirname(root);
    if (path.basename(parent) === "lib")
        return { root, prefix: path.dirname(parent) };
    // Windows global npm prefixes use `<prefix>\\node_modules`, which is
    // indistinguishable from local project installs by path shape alone. Do not
    // infer unsupported Windows custom prefixes without `npm root -g` evidence.
    return undefined;
}
function getSelfUpdateCommandForMethod(method, installedPackageName, updatePackageName = installedPackageName, npmCommand) {
    switch (method) {
        case "bun-binary":
            return undefined;
        case "pnpm":
            return makeSelfUpdateCommand(makeSelfUpdateCommandStep("pnpm", ["install", "-g", updatePackageName]), updatePackageName === installedPackageName
                ? undefined
                : makeSelfUpdateCommandStep("pnpm", ["remove", "-g", installedPackageName]));
        case "yarn":
            return makeSelfUpdateCommand(makeSelfUpdateCommandStep("yarn", ["global", "add", updatePackageName]), updatePackageName === installedPackageName
                ? undefined
                : makeSelfUpdateCommandStep("yarn", ["global", "remove", installedPackageName]));
        case "bun":
            return makeSelfUpdateCommand(makeSelfUpdateCommandStep("bun", ["install", "-g", updatePackageName]), updatePackageName === installedPackageName
                ? undefined
                : makeSelfUpdateCommandStep("bun", ["uninstall", "-g", installedPackageName]));
        case "npm": {
            const [command = "npm", ...npmArgs] = npmCommand ?? [];
            const inferred = npmCommand?.length ? undefined : getInferredNpmInstall(installedPackageName);
            const prefixArgs = [...npmArgs, ...(inferred ? ["--prefix", inferred.prefix] : [])];
            const installStep = makeSelfUpdateCommandStep(command, [...prefixArgs, "install", "-g", updatePackageName]);
            const uninstallStep = updatePackageName === installedPackageName
                ? undefined
                : makeSelfUpdateCommandStep(command, [...prefixArgs, "uninstall", "-g", installedPackageName]);
            return makeSelfUpdateCommand(installStep, uninstallStep);
        }
        case "unknown":
            return undefined;
    }
}
function readCommandOutput(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: shouldUseWindowsShell(command),
    });
    if (result.status === 0)
        return result.stdout.trim() || undefined;
    if (options.requireSuccess) {
        const reason = result.error?.message || result.stderr.trim() || `exit code ${result.status ?? "unknown"}`;
        throw new Error(`Failed to run ${[command, ...args].join(" ")}: ${reason}`);
    }
    return undefined;
}
function getGlobalPackageRoots(method, packageName, npmCommand) {
    switch (method) {
        case "npm": {
            const configured = !!npmCommand?.length;
            const [command = "npm", ...npmArgs] = npmCommand ?? [];
            if (configured && command === "bun") {
                const bunBin = readCommandOutput(command, [...npmArgs, "pm", "bin", "-g"], {
                    requireSuccess: true,
                });
                const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
                if (bunBin) {
                    roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
                }
                return roots;
            }
            const root = readCommandOutput(command, [...npmArgs, "root", "-g"], {
                requireSuccess: configured,
            });
            const inferred = configured ? undefined : getInferredNpmInstall(packageName);
            return [root, inferred?.root].filter((x) => !!x);
        }
        case "pnpm": {
            const root = readCommandOutput("pnpm", ["root", "-g"]);
            return root ? [root, dirname(root)] : [];
        }
        case "yarn": {
            const dir = readCommandOutput("yarn", ["global", "dir"]);
            return dir ? [dir, join(dir, "node_modules")] : [];
        }
        case "bun": {
            const bunBin = readCommandOutput("bun", ["pm", "bin", "-g"]);
            const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
            if (bunBin) {
                roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
            }
            return roots;
        }
        case "bun-binary":
        case "unknown":
            return [];
    }
}
function normalizeExistingPathForComparison(path) {
    const resolvedPath = resolve(path);
    if (!existsSync(resolvedPath)) {
        return undefined;
    }
    let normalizedPath;
    try {
        normalizedPath = realpathSync(resolvedPath);
    }
    catch {
        return undefined;
    }
    if (process.platform === "win32") {
        normalizedPath = normalizedPath.toLowerCase();
    }
    return normalizedPath;
}
function isSelfUpdatePathWritable() {
    const packageDir = getPackageDir();
    try {
        accessSync(packageDir, constants.W_OK);
        accessSync(dirname(packageDir), constants.W_OK);
        return true;
    }
    catch {
        return false;
    }
}
function isManagedByGlobalPackageManager(method, packageName, npmCommand) {
    const packageDir = normalizeExistingPathForComparison(getPackageDir());
    return (!!packageDir &&
        getGlobalPackageRoots(method, packageName, npmCommand).some((root) => {
            const normalizedRoot = normalizeExistingPathForComparison(root);
            return (!!normalizedRoot &&
                packageDir.startsWith(normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`));
        }));
}
exports.getSelfUpdateCommand = function getSelfUpdateCommand(packageName, npmCommand, updatePackageName = packageName) {
    const method = detectInstallMethod();
    const command = getSelfUpdateCommandForMethod(method, packageName, updatePackageName, npmCommand);
    if (!command || !isManagedByGlobalPackageManager(method, packageName, npmCommand) || !isSelfUpdatePathWritable()) {
        return undefined;
    }
    return command;
}
exports.getSelfUpdateUnavailableInstruction = function getSelfUpdateUnavailableInstruction(packageName, npmCommand, updatePackageName = packageName) {
    const method = detectInstallMethod();
    if (method === "bun-binary") {
        return `Download from: https://github.com/badlogic/pi-mono/releases/latest`;
    }
    const command = getSelfUpdateCommandForMethod(method, packageName, updatePackageName, npmCommand);
    if (command) {
        if (isManagedByGlobalPackageManager(method, packageName, npmCommand) && !isSelfUpdatePathWritable()) {
            return `This installation is managed by a global ${method} install, but the install path is not writable. Update it yourself with: ${command.display}`;
        }
        return `This installation is not managed by a global ${method} install. Update it with the package manager, wrapper, or source checkout that provides it.`;
    }
    return `Update ${updatePackageName} using the package manager, wrapper, or source checkout that provides this installation.`;
}
exports.getUpdateInstruction = function getUpdateInstruction(packageName) {
    const method = detectInstallMethod();
    const command = getSelfUpdateCommandForMethod(method, packageName);
    if (command) {
        return `Run: ${command.display}`;
    }
    return getSelfUpdateUnavailableInstruction(packageName);
}
// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================
/**
 * Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js (dist/): returns __dirname (the dist/ directory)
 * - For tsx (src/): returns parent directory (the package root)
 */
exports.getPackageDir = function getPackageDir() {
    // Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
    const envDir = process.env.PI_PACKAGE_DIR;
    if (envDir) {
        if (envDir === "~")
            return homedir();
        if (envDir.startsWith("~/"))
            return homedir() + envDir.slice(1);
        return envDir;
    }
    if (isBunBinary) {
        // Bun binary: process.execPath points to the compiled executable
        return dirname(process.execPath);
    }
    // Node.js: walk up from __dirname until we find package.json
    let dir = __dirname;
    while (dir !== dirname(dir)) {
        if (existsSync(join(dir, "package.json"))) {
            return dir;
        }
        dir = dirname(dir);
    }
    // Fallback (shouldn't happen)
    return __dirname;
}
/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For tsx (src/): src/modes/interactive/theme/
 */
exports.getThemesDir = function getThemesDir() {
    if (isBunBinary) {
        return join(getPackageDir(), "theme");
    }
    // Theme is in modes/interactive/theme/ relative to src/ or dist/
    const packageDir = getPackageDir();
    const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
    return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}
/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For tsx (src/): src/core/export-html/
 */
exports.getExportTemplateDir = function getExportTemplateDir() {
    if (isBunBinary) {
        return join(getPackageDir(), "export-html");
    }
    const packageDir = getPackageDir();
    const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
    return join(packageDir, srcOrDist, "core", "export-html");
}
/** Get path to package.json */
exports.getPackageJsonPath = function getPackageJsonPath() {
    return join(getPackageDir(), "package.json");
}
/** Get path to README.md */
exports.getReadmePath = function getReadmePath() {
    return resolve(join(getPackageDir(), "README.md"));
}
/** Get path to docs directory */
exports.getDocsPath = function getDocsPath() {
    return resolve(join(getPackageDir(), "docs"));
}
/** Get path to examples directory */
exports.getExamplesPath = function getExamplesPath() {
    return resolve(join(getPackageDir(), "examples"));
}
/** Get path to CHANGELOG.md */
exports.getChangelogPath = function getChangelogPath() {
    return resolve(join(getPackageDir(), "CHANGELOG.md"));
}
/**
 * Get path to built-in interactive assets directory.
 * - For Bun binary: assets/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/assets/
 * - For tsx (src/): src/modes/interactive/assets/
 */
exports.getInteractiveAssetsDir = function getInteractiveAssetsDir() {
    if (isBunBinary) {
        return join(getPackageDir(), "assets");
    }
    const packageDir = getPackageDir();
    const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
    return join(packageDir, srcOrDist, "modes", "interactive", "assets");
}
/** Get path to a bundled interactive asset */
exports.getBundledInteractiveAssetPath = function getBundledInteractiveAssetPath(name) {
    return join(getInteractiveAssetsDir(), name);
}
const pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8"));
const piConfigName = pkg.piConfig?.name;
exports.PACKAGE_NAME = pkg.name || "@mariozechner/pi-coding-agent"
exports.APP_NAME = piConfigName || "pi"
exports.APP_TITLE = piConfigName ? APP_NAME : "π"
exports.CONFIG_DIR_NAME = pkg.piConfig?.configDir || ".pi"
exports.VERSION = pkg.version || "0.0.0"
// e.g., PI_CODING_AGENT_DIR or TAU_CODING_AGENT_DIR
exports.ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`
exports.ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR`
exports.expandTildePath = function expandTildePath(path) {
    if (path === "~")
        return homedir();
    if (path.startsWith("~/"))
        return homedir() + path.slice(1);
    return path;
}
const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";
/** Get the share viewer URL for a gist ID */
exports.getShareViewerUrl = function getShareViewerUrl(gistId) {
    const baseUrl = process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
    return `${baseUrl}#${gistId}`;
}
// =============================================================================
// User Config Paths (~/.pi/agent/*)
// =============================================================================
/** Get the agent config directory (e.g., ~/.pi/agent/) */
exports.getAgentDir = function getAgentDir() {
    const envDir = process.env[ENV_AGENT_DIR];
    if (envDir) {
        return expandTildePath(envDir);
    }
    return join(homedir(), CONFIG_DIR_NAME, "agent");
}
/** Get path to user's custom themes directory */
exports.getCustomThemesDir = function getCustomThemesDir() {
    return join(getAgentDir(), "themes");
}
/** Get path to models.json */
exports.getModelsPath = function getModelsPath() {
    return join(getAgentDir(), "models.json");
}
/** Get path to auth.json */
exports.getAuthPath = function getAuthPath() {
    return join(getAgentDir(), "auth.json");
}
/** Get path to settings.json */
exports.getSettingsPath = function getSettingsPath() {
    return join(getAgentDir(), "settings.json");
}
/** Get path to tools directory */
exports.getToolsDir = function getToolsDir() {
    return join(getAgentDir(), "tools");
}
/** Get path to managed binaries directory (fd, rg) */
exports.getBinDir = function getBinDir() {
    return join(getAgentDir(), "bin");
}
/** Get path to prompt templates directory */
exports.getPromptsDir = function getPromptsDir() {
    return join(getAgentDir(), "prompts");
}
/** Get path to sessions directory */
exports.getSessionsDir = function getSessionsDir() {
    return join(getAgentDir(), "sessions");
}
/** Get path to debug log file */
exports.getDebugLogPath = function getDebugLogPath() {
    return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
//# sourceMappingURL=config.js.map