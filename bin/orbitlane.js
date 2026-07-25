#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { cp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClaudeTier1Adapter } from "../src/adapters/claude/index.js";
import { createCodexTier1Adapter } from "../src/adapters/codex/index.js";
import { resolveTargetPaths } from "../src/config/paths.js";
import { planSnapshot, writeSnapshot } from "../src/config/snapshots.js";
import { loadJsonSource } from "../src/config/source.js";
import { installRouting, previewRouting, recoverRouting, uninstallRouting } from "../src/installer/index.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = new Set(["codex", "claude", "both"]);

// The installed hook must keep working after the package that installed it is gone,
// which is the normal end state for npx and dlx. Rather than storing an absolute path
// into an evictable cache, install copies the runtime next to the report it reads.
function vendoredHookPath(root) {
  const path = join(root, ".orbitlane", "hook", "guards", "claude-spawn-hook.js");
  // node has to receive this as a real path, so unlike the other guard arguments it
  // cannot be base64. POSIX single quoting makes any byte literal, but cmd expands
  // %VAR% even inside double quotes, so such a path could never launch correctly.
  if (process.platform === "win32" && path.includes("%")) {
    throw Object.assign(new Error(`UNSAFE_INSTALL_PATH: ${path} contains % which cmd would expand`), { code: "UNSAFE_INSTALL_PATH" });
  }
  return path;
}

async function vendorHookRuntime(root) {
  const destination = join(root, ".orbitlane", "hook");
  const staged = join(root, ".orbitlane", `.hook-${randomUUID()}`);
  const retired = join(root, ".orbitlane", `.hook-retired-${randomUUID()}`);
  try {
    await cp(join(PACKAGE_ROOT, "src"), staged, { recursive: true });
    // The copy leaves the package's module scope behind. Without this the nearest
    // ancestor package.json decides the module type, and in a project that declares
    // CommonJS every import in the hook would fail.
    await writeFile(join(staged, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`, "utf8");
    // Swap by two renames rather than deleting the live runtime first. The already
    // installed settings point at this path, so a guard launched during a recursive
    // delete would find no hook at all; between two renames the gap is a single
    // directory operation, and an interruption leaves the retired copy recoverable.
    const replaced = await rename(destination, retired).then(() => true, (error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });
    await rename(staged, destination);
    if (replaced) await rm(retired, { recursive: true, force: true }).catch(() => {});
  } catch (error) {
    await rm(staged, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function usage() {
  return "Usage: orbitlane <install|uninstall|recover> --target <codex|claude|both> --contract <path> [--global] [--config-root <path>] [--runtime-defaults <path>] [--dry-run]";
}

function parse(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) return Object.freeze({ command: "help" });
  const [command = "install", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--dry-run") options.dryRun = true;
    else if (token === "--global") options.global = true;
    else if (["--target", "--contract", "--config-root", "--runtime-defaults", "--manifest"].includes(token)) options[token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = rest[++index];
    else throw Object.assign(new TypeError(`UNKNOWN_OPTION: ${token}`), { code: "UNKNOWN_OPTION" });
  }
  if (!["install", "uninstall", "recover"].includes(command)) throw Object.assign(new TypeError(`UNKNOWN_COMMAND: ${command}`), { code: "UNKNOWN_COMMAND" });
  if (command !== "recover" && !targets.has(options.target)) throw Object.assign(new TypeError("TARGET_REQUIRED: codex, claude, or both"), { code: "TARGET_REQUIRED" });
  if (command === "install" && typeof options.contract !== "string") throw Object.assign(new TypeError("CONTRACT_REQUIRED"), { code: "CONTRACT_REQUIRED" });
  if (command === "recover" && typeof options.manifest !== "string") throw Object.assign(new TypeError("MANIFEST_REQUIRED"), { code: "MANIFEST_REQUIRED" });
  return Object.freeze({ command, ...options });
}

function quoteShellArgument(value) {
  if (process.platform === "win32") return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\*)$/, "$1$1")}"`;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function encodedArgument(value) {
  return `base64:${Buffer.from(value, "utf8").toString("base64")}`;
}

function guardCommand(...parts) {
  return parts.map((part, index) => quoteShellArgument(index < 2 ? part : encodedArgument(part))).join(" ");
}

function failedAdapter(error, paths) {
  return Object.freeze({ ...paths, render: () => { throw error; } });
}

async function readJsonIfPossible(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return undefined; }
}

async function receiptAdapters(options) {
  const selected = options.target === "both" ? ["codex", "claude"] : [options.target];
  const resolved = resolveTargetPaths({ global: options.global === true, configRoot: options.configRoot, targets: selected });
  const result = {};
  // Codex has no guard and no settings file, so `false` keeps uninstallOne from
  // falling through to `adapter.render()`, which a receipt adapter does not have.
  if (selected.includes("codex")) result.codex = Object.freeze({ ...resolved.codex, spawnGuardCommand: false });
  if (selected.includes("claude")) {
    const report = await readJsonIfPossible(resolved.claude.generatedPath);
    const receipt = report?.receipt;
    // Delete authority never rests on a capability description. Either a versioned
    // receipt names the shape, or — for an install written before this receipt
    // existed — the pre-0.3.0 guard_command proof applies. A report carrying neither
    // proves nothing and must not touch settings.json.
    const legacy = receipt?.version === undefined;
    const command = legacy ? report?.settings_projection?.guard_command : receipt?.guard_command;
    const shape = legacy
      ? (typeof command === "string" && command.length > 0 ? "claude-managed-role-guard" : undefined)
      : receipt?.version === 1 ? receipt.install_shape : undefined;

    if (report !== undefined && shape === "guidance-only") {
      // Nothing was ever written to settings.json, so there is nothing to prove or remove.
      const { settingsPath, ...guidanceOnlyPaths } = resolved.claude;
      result.claude = Object.freeze({ ...guidanceOnlyPaths, spawnGuardCommand: false });
    } else {
      // Ownership must be proven where removal actually happens. mergeSettings only
      // strips hooks under the Agent matcher, so accepting the command under any
      // matcher would report a successful uninstall while leaving the entry in place
      // and deleting the runtime it points at.
      const settings = await readJsonIfPossible(resolved.claude.settingsPath);
      const installed = (settings?.hooks?.PreToolUse ?? [])
        .filter((entry) => entry?.matcher === "Agent")
        .flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : []))
        .some((hook) => hook?.type === "command" && hook.command === command);
      result.claude = shape === "claude-managed-role-guard" && typeof command === "string" && command.length > 0 && installed
        ? Object.freeze({ ...resolved.claude, spawnGuardCommand: command })
        : failedAdapter(Object.assign(new Error(`RECEIPT_UNVERIFIABLE: ${resolved.claude.generatedPath}`), { code: "RECEIPT_UNVERIFIABLE" }), resolved.claude);
    }
  }
  return Object.freeze(result);
}

function adapters(contract, options) {
  const selected = options.target === "both" ? ["codex", "claude"] : [options.target];
  const resolved = resolveTargetPaths({ global: options.global === true, configRoot: options.configRoot, targets: selected });
  const codexPaths = resolved.codex;
  const { settingsPath, ...claudeGuidanceOnlyPaths } = resolved.claude;
  const claudePaths = options.claudeGuardEnabled === false ? claudeGuidanceOnlyPaths : resolved.claude;
  const runtimeDefaults = options.runtimeDefaults === undefined ? undefined : options.runtimeDefaults;
  const generated = join(resolved.claude.root, ".orbitlane");
  const result = {};
  if (selected.includes("codex")) {
    try { result.codex = createCodexTier1Adapter(contract, { ...codexPaths, runtimeDefaults }); } catch (error) { result.codex = failedAdapter(error, codexPaths); }
  }
  if (selected.includes("claude")) {
    try {
      // Preparing the Claude side can fail on its own (vendoring, snapshots). Those
      // failures belong to the Claude target, not to the whole run: --target both
      // must still install Codex.
      if (options.claudePreparationError !== undefined) throw options.claudePreparationError;
      result.claude = createClaudeTier1Adapter(contract, {
        ...claudePaths,
        ...(options.claudeGuardEnabled === false ? {} : {
          spawnGuardCommand: guardCommand(process.execPath, vendoredHookPath(resolved.claude.root), resolved.claude.root, join(generated, "claude-heartbeats.jsonl"), options.global === true ? "global" : "project"),
        }),
        runtimeDefaults,
        contractSha256: options.contractSha256,
        runtimeDefaultsSha256: options.runtimeDefaultsSha256,
      });
    } catch (error) { result.claude = failedAdapter(error, claudePaths); }
  }
  return Object.freeze(result);
}

// The snapshot store and the vendored hook runtime exist only to serve the Claude
// report. Once that report is gone nothing can reach them again, so a successful
// Claude uninstall reclaims them. The heartbeat log is evidence, not derived state,
// and is left alone. A cleanup failure is reported but never rewrites the uninstall
// verdict, which has already been committed by the transaction layer.
async function reclaimDerivedState(options, report) {
  if (report?.outcomes?.claude?.status !== "uninstalled") return;
  const resolved = resolveTargetPaths({ global: options.global === true, configRoot: options.configRoot, targets: ["claude"] });
  const root = resolved.claude.root;
  // An install that landed between the uninstall commit and this point owns the
  // store again. Deleting it would strand the report and settings it just wrote.
  if (await readJsonIfPossible(resolved.claude.generatedPath) !== undefined) return;
  for (const kind of ["contracts", "runtime-defaults", "hook"]) {
    const path = join(root, ".orbitlane", kind);
    try { await rm(path, { recursive: true, force: true }); } catch (error) {
      process.stderr.write(`SNAPSHOT_CLEANUP_FAILED: ${path} (${error?.code ?? "unknown"})\n`);
    }
  }
}

async function uninstall(options, targetAdapters) {
  const report = await uninstallRouting({ target: options.target, adapters: targetAdapters });
  await reclaimDerivedState(options, report);
  return report;
}

function exitCode(report) {
  if (report?.status === "failed") return 2;
  const outcomes = Object.values(report.outcomes ?? {});
  const failures = outcomes.filter((outcome) => outcome.status === "failed").length;
  return failures === 0 ? 0 : failures === outcomes.length ? 2 : 1;
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.command === "help") return null;
  if (options.command === "recover") return recoverRouting({ manifest: { path: resolve(options.manifest) } });
  if (options.command === "uninstall" && options.contract === undefined) {
    return uninstall(options, await receiptAdapters(options));
  }
  const contractSource = await loadJsonSource(options.contract);
  const runtimeDefaultsSource = options.runtimeDefaults === undefined ? undefined : await loadJsonSource(options.runtimeDefaults);
  const contract = contractSource.value;
  // Roles are what the guard enforces. Without them the install is guidance only:
  // no hook entry, no vendored runtime. The snapshot is still written, because the
  // report's contract pointer is what any other installed guard resolves through.
  const claudeGuardEnabled = Object.keys(contract.roles ?? {}).length > 0;
  const runtimeDefaults = runtimeDefaultsSource?.value;
  const claudeSelected = options.target === "claude" || options.target === "both";
  const persist = options.command === "install" && options.dryRun !== true && claudeSelected;
  const store = persist ? writeSnapshot : (root, kind, content) => planSnapshot(root, kind, content);

  // Everything the Claude target needs before its adapter exists. A failure here is
  // carried into adapters() as that target's failure so a --target both run still
  // installs Codex, matching how adapter construction already isolates targets.
  let prepared = {};
  try {
    const claudeRoot = resolveTargetPaths({ global: options.global === true, configRoot: options.configRoot, targets: ["claude"] }).claude.root;
    if (persist && claudeGuardEnabled) await vendorHookRuntime(claudeRoot);
    const contractSnapshot = await store(claudeRoot, "contracts", contractSource.bytes);
    const runtimeDefaultsSnapshot = runtimeDefaultsSource === undefined ? undefined : await store(claudeRoot, "runtime-defaults", runtimeDefaultsSource.bytes);
    prepared = { contractSha256: contractSnapshot.sha256, runtimeDefaultsSha256: runtimeDefaultsSnapshot?.sha256 };
  } catch (error) {
    if (options.target === "codex") prepared = {};
    else if (options.target === "claude") throw error;
    else prepared = { claudePreparationError: error };
  }

  const targetAdapters = adapters(contract, { ...options, runtimeDefaults, claudeGuardEnabled, ...prepared });
  if (options.command === "uninstall") return uninstall(options, targetAdapters);
  return options.dryRun ? previewRouting(contract, { target: options.target, adapters: targetAdapters }) : installRouting(contract, { target: options.target, adapters: targetAdapters });
}

try {
  const report = await main();
  if (report === null) process.stdout.write(`${usage()}\n`);
  else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = exitCode(report);
  }
} catch (error) {
  process.stderr.write(`${error.code ?? "CLI_ERROR"}: ${error.message}\n${usage()}\n`);
  process.exitCode = 2;
}
