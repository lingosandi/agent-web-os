var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var stdin_exports = {};
__export(stdin_exports, {
  APP_NAME: () => APP_NAME,
  APP_TITLE: () => APP_TITLE,
  CONFIG_DIR_NAME: () => CONFIG_DIR_NAME,
  ENV_AGENT_DIR: () => ENV_AGENT_DIR,
  ENV_SESSION_DIR: () => ENV_SESSION_DIR,
  PACKAGE_NAME: () => PACKAGE_NAME,
  VERSION: () => VERSION,
  detectInstallMethod: () => detectInstallMethod,
  expandTildePath: () => expandTildePath,
  getAgentDir: () => getAgentDir,
  getAuthPath: () => getAuthPath,
  getBinDir: () => getBinDir,
  getBundledInteractiveAssetPath: () => getBundledInteractiveAssetPath,
  getChangelogPath: () => getChangelogPath,
  getCustomThemesDir: () => getCustomThemesDir,
  getDebugLogPath: () => getDebugLogPath,
  getDocsPath: () => getDocsPath,
  getExamplesPath: () => getExamplesPath,
  getExportTemplateDir: () => getExportTemplateDir,
  getInteractiveAssetsDir: () => getInteractiveAssetsDir,
  getModelsPath: () => getModelsPath,
  getPackageDir: () => getPackageDir,
  getPackageJsonPath: () => getPackageJsonPath,
  getPromptsDir: () => getPromptsDir,
  getReadmePath: () => getReadmePath,
  getSelfUpdateCommand: () => getSelfUpdateCommand,
  getSelfUpdateUnavailableInstruction: () => getSelfUpdateUnavailableInstruction,
  getSessionsDir: () => getSessionsDir,
  getSettingsPath: () => getSettingsPath,
  getShareViewerUrl: () => getShareViewerUrl,
  getThemesDir: () => getThemesDir,
  getToolsDir: () => getToolsDir,
  getUpdateInstruction: () => getUpdateInstruction,
  isBunBinary: () => isBunBinary,
  isBunRuntime: () => isBunRuntime
});
module.exports = __toCommonJS(stdin_exports);
var import_child_process = require("child_process");
var import_fs = require("fs");
var import_os = require("os");
var import_path = require("path");
var import_url = require("url");
var import_child_process2 = require("./utils/child-process.js");
const __filename = (0, import_url.fileURLToPath)(import_meta.url);
const __dirname = (0, import_path.dirname)(__filename);
const isBunBinary = import_meta.url.includes("$bunfs") || import_meta.url.includes("~BUN") || import_meta.url.includes("%7EBUN");
const isBunRuntime = !!process.versions.bun;
function makeSelfUpdateCommand(installStep, uninstallStep) {
  if (!uninstallStep)
    return installStep;
  return {
    ...installStep,
    display: `${uninstallStep.display} && ${installStep.display}`,
    steps: [uninstallStep, installStep]
  };
}
function makeSelfUpdateCommandStep(command, args) {
  return {
    command,
    args,
    display: [command, ...args].map((arg) => /\s/.test(arg) ? `"${arg}"` : arg).join(" ")
  };
}
function detectInstallMethod() {
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
  const path = process.platform === "win32" || packageDir.includes("\\") ? import_path.win32 : { basename: import_path.basename, dirname: import_path.dirname };
  const [scope, name] = packageName.split("/");
  let root;
  if (name && scope?.startsWith("@") && path.basename(path.dirname(packageDir)) === scope && path.basename(packageDir) === name) {
    root = path.dirname(path.dirname(packageDir));
  } else if (!name && path.basename(packageDir) === packageName) {
    root = path.dirname(packageDir);
  }
  if (!root || path.basename(root) !== "node_modules")
    return void 0;
  const parent = path.dirname(root);
  if (path.basename(parent) === "lib")
    return { root, prefix: path.dirname(parent) };
  return void 0;
}
function getSelfUpdateCommandForMethod(method, installedPackageName, updatePackageName = installedPackageName, npmCommand) {
  switch (method) {
    case "bun-binary":
      return void 0;
    case "pnpm":
      return makeSelfUpdateCommand(makeSelfUpdateCommandStep("pnpm", ["install", "-g", updatePackageName]), updatePackageName === installedPackageName ? void 0 : makeSelfUpdateCommandStep("pnpm", ["remove", "-g", installedPackageName]));
    case "yarn":
      return makeSelfUpdateCommand(makeSelfUpdateCommandStep("yarn", ["global", "add", updatePackageName]), updatePackageName === installedPackageName ? void 0 : makeSelfUpdateCommandStep("yarn", ["global", "remove", installedPackageName]));
    case "bun":
      return makeSelfUpdateCommand(makeSelfUpdateCommandStep("bun", ["install", "-g", updatePackageName]), updatePackageName === installedPackageName ? void 0 : makeSelfUpdateCommandStep("bun", ["uninstall", "-g", installedPackageName]));
    case "npm": {
      const [command = "npm", ...npmArgs] = npmCommand ?? [];
      const inferred = npmCommand?.length ? void 0 : getInferredNpmInstall(installedPackageName);
      const prefixArgs = [...npmArgs, ...inferred ? ["--prefix", inferred.prefix] : []];
      const installStep = makeSelfUpdateCommandStep(command, [...prefixArgs, "install", "-g", updatePackageName]);
      const uninstallStep = updatePackageName === installedPackageName ? void 0 : makeSelfUpdateCommandStep(command, [...prefixArgs, "uninstall", "-g", installedPackageName]);
      return makeSelfUpdateCommand(installStep, uninstallStep);
    }
    case "unknown":
      return void 0;
  }
}
function readCommandOutput(command, args, options = {}) {
  const result = (0, import_child_process.spawnSync)(command, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: (0, import_child_process2.shouldUseWindowsShell)(command)
  });
  if (result.status === 0)
    return result.stdout.trim() || void 0;
  if (options.requireSuccess) {
    const reason = result.error?.message || result.stderr.trim() || `exit code ${result.status ?? "unknown"}`;
    throw new Error(`Failed to run ${[command, ...args].join(" ")}: ${reason}`);
  }
  return void 0;
}
function getGlobalPackageRoots(method, packageName, npmCommand) {
  switch (method) {
    case "npm": {
      const configured = !!npmCommand?.length;
      const [command = "npm", ...npmArgs] = npmCommand ?? [];
      if (configured && command === "bun") {
        const bunBin = readCommandOutput(command, [...npmArgs, "pm", "bin", "-g"], {
          requireSuccess: true
        });
        const roots = [(0, import_path.join)((0, import_os.homedir)(), ".bun", "install", "global", "node_modules")];
        if (bunBin) {
          roots.push((0, import_path.join)((0, import_path.dirname)(bunBin), "install", "global", "node_modules"));
        }
        return roots;
      }
      const root = readCommandOutput(command, [...npmArgs, "root", "-g"], {
        requireSuccess: configured
      });
      const inferred = configured ? void 0 : getInferredNpmInstall(packageName);
      return [root, inferred?.root].filter((x) => !!x);
    }
    case "pnpm": {
      const root = readCommandOutput("pnpm", ["root", "-g"]);
      return root ? [root, (0, import_path.dirname)(root)] : [];
    }
    case "yarn": {
      const dir = readCommandOutput("yarn", ["global", "dir"]);
      return dir ? [dir, (0, import_path.join)(dir, "node_modules")] : [];
    }
    case "bun": {
      const bunBin = readCommandOutput("bun", ["pm", "bin", "-g"]);
      const roots = [(0, import_path.join)((0, import_os.homedir)(), ".bun", "install", "global", "node_modules")];
      if (bunBin) {
        roots.push((0, import_path.join)((0, import_path.dirname)(bunBin), "install", "global", "node_modules"));
      }
      return roots;
    }
    case "bun-binary":
    case "unknown":
      return [];
  }
}
function normalizeExistingPathForComparison(path) {
  const resolvedPath = (0, import_path.resolve)(path);
  if (!(0, import_fs.existsSync)(resolvedPath)) {
    return void 0;
  }
  let normalizedPath;
  try {
    normalizedPath = (0, import_fs.realpathSync)(resolvedPath);
  } catch {
    return void 0;
  }
  if (process.platform === "win32") {
    normalizedPath = normalizedPath.toLowerCase();
  }
  return normalizedPath;
}
function isSelfUpdatePathWritable() {
  const packageDir = getPackageDir();
  try {
    (0, import_fs.accessSync)(packageDir, import_fs.constants.W_OK);
    (0, import_fs.accessSync)((0, import_path.dirname)(packageDir), import_fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
function isManagedByGlobalPackageManager(method, packageName, npmCommand) {
  const packageDir = normalizeExistingPathForComparison(getPackageDir());
  return !!packageDir && getGlobalPackageRoots(method, packageName, npmCommand).some((root) => {
    const normalizedRoot = normalizeExistingPathForComparison(root);
    return !!normalizedRoot && packageDir.startsWith(normalizedRoot.endsWith(import_path.sep) ? normalizedRoot : `${normalizedRoot}${import_path.sep}`);
  });
}
function getSelfUpdateCommand(packageName, npmCommand, updatePackageName = packageName) {
  const method = detectInstallMethod();
  const command = getSelfUpdateCommandForMethod(method, packageName, updatePackageName, npmCommand);
  if (!command || !isManagedByGlobalPackageManager(method, packageName, npmCommand) || !isSelfUpdatePathWritable()) {
    return void 0;
  }
  return command;
}
function getSelfUpdateUnavailableInstruction(packageName, npmCommand, updatePackageName = packageName) {
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
function getUpdateInstruction(packageName) {
  const method = detectInstallMethod();
  const command = getSelfUpdateCommandForMethod(method, packageName);
  if (command) {
    return `Run: ${command.display}`;
  }
  return getSelfUpdateUnavailableInstruction(packageName);
}
function getPackageDir() {
  const envDir = process.env.PI_PACKAGE_DIR;
  if (envDir) {
    if (envDir === "~")
      return (0, import_os.homedir)();
    if (envDir.startsWith("~/"))
      return (0, import_os.homedir)() + envDir.slice(1);
    return envDir;
  }
  if (isBunBinary) {
    return (0, import_path.dirname)(process.execPath);
  }
  let dir = __dirname;
  while (dir !== (0, import_path.dirname)(dir)) {
    if ((0, import_fs.existsSync)((0, import_path.join)(dir, "package.json"))) {
      return dir;
    }
    dir = (0, import_path.dirname)(dir);
  }
  return __dirname;
}
function getThemesDir() {
  if (isBunBinary) {
    return (0, import_path.join)(getPackageDir(), "theme");
  }
  const packageDir = getPackageDir();
  const srcOrDist = (0, import_fs.existsSync)((0, import_path.join)(packageDir, "src")) ? "src" : "dist";
  return (0, import_path.join)(packageDir, srcOrDist, "modes", "interactive", "theme");
}
function getExportTemplateDir() {
  if (isBunBinary) {
    return (0, import_path.join)(getPackageDir(), "export-html");
  }
  const packageDir = getPackageDir();
  const srcOrDist = (0, import_fs.existsSync)((0, import_path.join)(packageDir, "src")) ? "src" : "dist";
  return (0, import_path.join)(packageDir, srcOrDist, "core", "export-html");
}
function getPackageJsonPath() {
  return (0, import_path.join)(getPackageDir(), "package.json");
}
function getReadmePath() {
  return (0, import_path.resolve)((0, import_path.join)(getPackageDir(), "README.md"));
}
function getDocsPath() {
  return (0, import_path.resolve)((0, import_path.join)(getPackageDir(), "docs"));
}
function getExamplesPath() {
  return (0, import_path.resolve)((0, import_path.join)(getPackageDir(), "examples"));
}
function getChangelogPath() {
  return (0, import_path.resolve)((0, import_path.join)(getPackageDir(), "CHANGELOG.md"));
}
function getInteractiveAssetsDir() {
  if (isBunBinary) {
    return (0, import_path.join)(getPackageDir(), "assets");
  }
  const packageDir = getPackageDir();
  const srcOrDist = (0, import_fs.existsSync)((0, import_path.join)(packageDir, "src")) ? "src" : "dist";
  return (0, import_path.join)(packageDir, srcOrDist, "modes", "interactive", "assets");
}
function getBundledInteractiveAssetPath(name) {
  return (0, import_path.join)(getInteractiveAssetsDir(), name);
}
const pkg = JSON.parse((0, import_fs.readFileSync)(getPackageJsonPath(), "utf-8"));
const piConfigName = pkg.piConfig?.name;
const PACKAGE_NAME = pkg.name || "@mariozechner/pi-coding-agent";
const APP_NAME = piConfigName || "pi";
const APP_TITLE = piConfigName ? APP_NAME : "\u03C0";
const CONFIG_DIR_NAME = pkg.piConfig?.configDir || ".pi";
const VERSION = pkg.version || "0.0.0";
const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
const ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR`;
function expandTildePath(path) {
  if (path === "~")
    return (0, import_os.homedir)();
  if (path.startsWith("~/"))
    return (0, import_os.homedir)() + path.slice(1);
  return path;
}
const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";
function getShareViewerUrl(gistId) {
  const baseUrl = process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
  return `${baseUrl}#${gistId}`;
}
function getAgentDir() {
  const envDir = process.env[ENV_AGENT_DIR];
  if (envDir) {
    return expandTildePath(envDir);
  }
  return (0, import_path.join)((0, import_os.homedir)(), CONFIG_DIR_NAME, "agent");
}
function getCustomThemesDir() {
  return (0, import_path.join)(getAgentDir(), "themes");
}
function getModelsPath() {
  return (0, import_path.join)(getAgentDir(), "models.json");
}
function getAuthPath() {
  return (0, import_path.join)(getAgentDir(), "auth.json");
}
function getSettingsPath() {
  return (0, import_path.join)(getAgentDir(), "settings.json");
}
function getToolsDir() {
  return (0, import_path.join)(getAgentDir(), "tools");
}
function getBinDir() {
  return (0, import_path.join)(getAgentDir(), "bin");
}
function getPromptsDir() {
  return (0, import_path.join)(getAgentDir(), "prompts");
}
function getSessionsDir() {
  return (0, import_path.join)(getAgentDir(), "sessions");
}
function getDebugLogPath() {
  return (0, import_path.join)(getAgentDir(), `${APP_NAME}-debug.log`);
}
