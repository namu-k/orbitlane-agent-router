#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClaudeTier1Adapter } from "../src/adapters/claude/index.js";
import { createCodexTier1Adapter } from "../src/adapters/codex/index.js";
import { resolveTargetPaths } from "../src/config/paths.js";
import { planSnapshot } from "../src/config/snapshots.js";
import { loadJsonSource } from "../src/config/source.js";
import { resolveEffectiveContract } from "../src/guards/resolve-contract.js";
import { installRouting, previewRouting, recoverRouting, uninstallRouting } from "../src/installer/index.js";
import { loadClaudeEvidence } from "../src/estimate/claude.js";
import { loadCodexEvidence } from "../src/estimate/codex.js";
import { resolveModelPrice, validatePriceCatalog } from "../src/estimate/pricing.js";
import { scoreConfidence } from "../src/estimate/confidence.js";
import { estimateRuntime } from "../src/estimate/index.js";
import { combineEstimates, renderHumanSummary, writeSafeReport } from "../src/estimate/report.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = new Set(["codex", "claude", "both"]);

function unavailableRuntimeEstimate(runtime) {
  const confidence = scoreConfidence({ runtime, source_kind: "none", usage_evidence: "none", model_evidence: "unknown", attribution_evidence: "none", price_basis: "none", price_match: null, baseline_source: "unknown", baseline_known: false, priced_included_usage: "0", total_observed_usage: "0", corrupt_lines: 0, total_lines: 0 });
  return Object.freeze({ runtime, status: "insufficient", raw_estimated_model_cost_difference_nanos: null, confidence_adjusted_reference_amount_nanos: null, display: "데이터 부족", confidence, baseline: Object.freeze({ status: "unknown", model: null, source: "unknown" }), coverage: confidence.coverage, models: Object.freeze([]), calculation_basis: Object.freeze({ price_basis: null, price_match: null }), warnings: Object.freeze(["RUNTIME_EVIDENCE_UNAVAILABLE"]) });
}

// The installed hook must keep working after the package that installed it is gone,
// which is the normal end state for npx and dlx. Rather than storing an absolute path
// into an evictable cache, install copies the runtime next to the report it reads.
function vendoredHookPath(root, filename = "claude-spawn-hook.js") {
  const path = join(root, ".orbitlane", "hook", "guards", filename);
  // node has to receive this as a real path, so unlike the other guard arguments it
  // cannot be base64. POSIX single quoting makes any byte literal, but cmd expands
  // %VAR% even inside double quotes, so such a path could never launch correctly.
  if (process.platform === "win32" && path.includes("%")) {
    throw Object.assign(new Error(`UNSAFE_INSTALL_PATH: ${path} contains % which cmd would expand`), { code: "UNSAFE_INSTALL_PATH" });
  }
  return path;
}

function usage() {
  return "Usage: orbitlane <install|uninstall|recover> --target <codex|claude|both> --contract <path> [--global] [--config-root <path>] [--runtime-defaults <path>] [--dry-run]\n       orbitlane estimate --runtime <auto|claude|codex> [--session <latest|thread-id|path>] [--baseline-model <model>] [--prices <catalog.json>] --output <report.json>";
}

function parseEstimate(rest) {
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!['--runtime', '--session', '--baseline-model', '--prices', '--output'].includes(token)) throw Object.assign(new TypeError(`UNKNOWN_OPTION: ${token}`), { code: 'UNKNOWN_OPTION' });
    const value = rest[++index]; if (typeof value !== 'string' || value.startsWith('--') || options[token] !== undefined) throw Object.assign(new TypeError(`INVALID_ESTIMATE_OPTION: ${token}`), { code: 'INVALID_ESTIMATE_OPTION' });
    options[token] = value;
  }
  if (!['auto', 'claude', 'codex'].includes(options['--runtime'])) throw Object.assign(new TypeError('RUNTIME_REQUIRED: auto, claude, or codex'), { code: 'RUNTIME_REQUIRED' });
  if (options['--output'] === undefined) throw Object.assign(new TypeError('OUTPUT_REQUIRED'), { code: 'OUTPUT_REQUIRED' });
  const session = options['--session'] ?? 'latest';
  if (options['--runtime'] === 'auto' && session !== 'latest') throw Object.assign(new TypeError('AUTO_SESSION_MUST_BE_LATEST'), { code: 'AUTO_SESSION_MUST_BE_LATEST' });
  return Object.freeze({ command: 'estimate', runtime: options['--runtime'], session, output: options['--output'], baselineModel: options['--baseline-model'] ?? null, prices: options['--prices'] });
}

function parse(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) return Object.freeze({ command: "help" });
  const [command = "install", ...rest] = argv;
  if (command === "estimate") return parseEstimate(rest);
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

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const digest = /^[a-f0-9]{64}$/;

function transitionFailure(code, path) {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

function hasHookTuples(settings, tuples) {
  return tuples.every(({ event, matcher, command }) => Array.isArray(settings?.hooks?.[event])
    && settings.hooks[event].some((entry) => entry?.matcher === matcher
      && Array.isArray(entry.hooks) && entry.hooks.some((hook) => hook?.type === "command" && hook.command === command)));
}

function receiptHooks(receipt) {
  if (receipt?.version === 2 && Array.isArray(receipt.hooks) && receipt.hooks.length > 0
    && receipt.hooks.every((hook) => ["PreToolUse", "PostToolUse"].includes(hook?.event) && hook.matcher === "Agent" && typeof hook.command === "string" && hook.command.length > 0)) return receipt.hooks;
  if (receipt?.version === 1 && receipt.install_shape === "claude-managed-role-guard" && typeof receipt.guard_command === "string") return [{ event: "PreToolUse", matcher: "Agent", command: receipt.guard_command }];
  return undefined;
}

async function claudeTransitionAction(options, claudeGuardEnabled) {
  if (options.command !== "install" || (options.target !== "claude" && options.target !== "both")) return undefined;
  const resolved = resolveTargetPaths({ global: options.global === true, configRoot: options.configRoot, targets: ["claude"] }).claude;
  let content;
  try { content = await readFile(resolved.generatedPath, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw transitionFailure("REPORT_UNREADABLE", resolved.generatedPath);
  }
  let report;
  try { report = JSON.parse(content); } catch { throw transitionFailure("REPORT_UNREADABLE", resolved.generatedPath); }
  if (report === null || typeof report !== "object" || Array.isArray(report)) throw transitionFailure("REPORT_UNREADABLE", resolved.generatedPath);
  const receipt = report.receipt;
  const legacy = receipt?.version === undefined;
  if (!legacy) {
    if (!([1, 2].includes(receipt?.version)) || (receipt.version === 1 && !["guidance-only", "claude-managed-role-guard"].includes(receipt.install_shape))
      || (receipt.install_shape === "claude-managed-role-guard" && (typeof receipt.guard_command !== "string" || receipt.guard_command.length === 0))) {
      throw transitionFailure("RECEIPT_UNVERIFIABLE", resolved.generatedPath);
    }
    let effective;
    try { effective = await resolveEffectiveContract({ cwd: resolved.root, claudeConfigDir: resolved.root }); } catch (error) { throw transitionFailure(error?.code ?? "REPORT_UNREADABLE", resolved.generatedPath); }
    let canonicalGeneratedPath;
    try { canonicalGeneratedPath = await realpath(resolved.generatedPath); } catch { throw transitionFailure("RECEIPT_UNVERIFIABLE", resolved.generatedPath); }
    if (effective.reportPath !== canonicalGeneratedPath) throw transitionFailure("RECEIPT_UNVERIFIABLE", resolved.generatedPath);
  }
  if (receipt?.version === 1 && receipt.install_shape === "guidance-only") return undefined;
  const hooks = legacy ? (typeof report?.settings_projection?.guard_command === "string" ? [{ event: "PreToolUse", matcher: "Agent", command: report.settings_projection.guard_command }] : undefined) : receiptHooks(receipt);
  if (!legacy && (!report?.contract_snapshot || !digest.test(report.contract_snapshot.sha256 ?? ""))) throw transitionFailure("REPORT_POINTER_MISSING", resolved.generatedPath);
  if (!Array.isArray(hooks)) {
    throw transitionFailure("RECEIPT_UNVERIFIABLE", resolved.generatedPath);
  }
  let settings;
  try { settings = JSON.parse(await readFile(resolved.settingsPath, "utf8")); } catch { throw transitionFailure("RECEIPT_UNVERIFIABLE", resolved.settingsPath); }
  if (!hasHookTuples(settings, hooks)) throw transitionFailure("RECEIPT_UNVERIFIABLE", resolved.settingsPath);
  if (claudeGuardEnabled) return undefined;
  return Object.freeze({ kind: "remove-owned-hook", hooks, reportHash: sha256(content) });
}

async function readJsonIfPossible(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return undefined; }
}

function guidanceOnlySettingsAreClear(settings, command) {
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return false;
  if (settings.hooks === undefined) return true;
  if (settings.hooks === null || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) return false;
  if (settings.hooks.PreToolUse === undefined) return true;
  if (!Array.isArray(settings.hooks.PreToolUse)) return false;
  for (const entry of settings.hooks.PreToolUse) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || typeof entry.matcher !== "string" || !Array.isArray(entry.hooks)) return false;
    for (const hook of entry.hooks) {
      if (hook === null || typeof hook !== "object" || Array.isArray(hook)) return false;
      // Guidance-only receipts never grant deletion authority. Seeing the stale
      // command anywhere is therefore an ambiguous ownership conflict, including
      // a non-Agent matcher that the installer could not safely remove from.
      if (hook.command === command) return false;
    }
  }
  return true;
}

async function staleGuidanceCommandIsClear(settingsPath, command) {
  let content;
  try { content = await readFile(settingsPath, "utf8"); } catch (error) { return error?.code === "ENOENT"; }
  try { return guidanceOnlySettingsAreClear(JSON.parse(content), command); } catch { return false; }
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
    const versionedWithoutSchema = receipt?.version !== undefined && report?.schema_version !== 2;
    const legacy = receipt?.version === undefined;
    const hooks = legacy ? (typeof report?.settings_projection?.guard_command === "string" ? [{ event: "PreToolUse", matcher: "Agent", command: report.settings_projection.guard_command }] : undefined) : receiptHooks(receipt);
    const shape = legacy
      ? (Array.isArray(hooks) ? "claude-managed-role-guard" : undefined)
      : Array.isArray(hooks) ? "claude-managed-role-guard" : receipt?.version === 1 ? receipt.install_shape : undefined;

    if (!versionedWithoutSchema && report !== undefined && shape === "guidance-only") {
      const staleCommand = report?.settings_projection?.guard_command;
      const clear = typeof staleCommand !== "string" || staleCommand.length === 0
        || await staleGuidanceCommandIsClear(resolved.claude.settingsPath, staleCommand);
      if (clear) {
        // A proper guidance-only receipt has no settings ownership. Even after a
        // read-only stale-command probe, keep settingsPath out of the adapter so
        // the transaction layer cannot rewrite or remove any hook.
        const { settingsPath, ...guidanceOnlyPaths } = resolved.claude;
        result.claude = Object.freeze({ ...guidanceOnlyPaths, spawnGuardCommand: false });
      } else {
        result.claude = failedAdapter(Object.assign(new Error(`RECEIPT_UNVERIFIABLE: ${resolved.claude.generatedPath}`), { code: "RECEIPT_UNVERIFIABLE" }), resolved.claude);
      }
    } else {
      // Ownership must be proven where removal actually happens. mergeSettings only
      // strips hooks under the Agent matcher, so accepting the command under any
      // matcher would report a successful uninstall while leaving the entry in place
      // and deleting the runtime it points at.
      const settings = await readJsonIfPossible(resolved.claude.settingsPath);
      const installed = Array.isArray(hooks) && hasHookTuples(settings, hooks);
      result.claude = !versionedWithoutSchema && shape === "claude-managed-role-guard" && installed
        ? Object.freeze({ ...resolved.claude, spawnGuardCommand: hooks })
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
  const claudePaths = options.claudeTransitionAction !== undefined || options.claudeGuardEnabled !== false ? resolved.claude : claudeGuidanceOnlyPaths;
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
      result.claude = Object.freeze({ ...createClaudeTier1Adapter(contract, {
        ...claudePaths,
        managedAssets: options.managedAssets,
        ...(options.claudeGuardEnabled === false ? {} : {
          spawnGuardCommand: guardCommand(process.execPath, vendoredHookPath(resolved.claude.root), resolved.claude.root, join(generated, "evidence", options.global === true ? "global" : "project", "routing-decisions.v1.jsonl"), options.global === true ? "global" : "project", join(generated, "evidence", options.global === true ? "global" : "project"), options.collectorInstanceRef ?? "preflight"),
          usageObserverCommand: guardCommand(process.execPath, vendoredHookPath(resolved.claude.root, "claude-usage-hook.js"), join(generated, "evidence", options.global === true ? "global" : "project", "execution-usage.v1.jsonl"), options.global === true ? "global" : "project", options.collectorInstanceRef ?? "preflight"),
          installedScope: options.global === true ? "global" : "project",
          telemetryRoot: resolved.claude.root,
          collectorInstanceRef: options.collectorInstanceRef,
          runtimeVersionSnapshot: options.runtimeVersionSnapshot,
          secretPaths: options.secretPaths,
          evidenceRoots: options.evidenceRoots,
          ownedFiles: options.ownedFiles,
        }),
        runtimeDefaults,
        contractSha256: options.contractSha256,
        runtimeDefaultsSha256: options.runtimeDefaultsSha256,
      }), ...(options.claudeTransitionAction === undefined ? {} : { transitionAction: options.claudeTransitionAction }) });
    } catch (error) { result.claude = failedAdapter(error, claudePaths); }
  }
  return Object.freeze(result);
}

function preflightAdapters(contract, options) {
  const targetAdapters = adapters(contract, options);
  const selected = options.target === "both" ? ["codex", "claude"] : [options.target];
  const failures = {};
  for (const target of selected) {
    try { targetAdapters[target].render(); } catch (error) { failures[target] = error; }
  }
  return Object.freeze(failures);
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

function prepareClaudeTelemetry(root, global) {
  const keyPath = join(root, ".orbitlane", "secrets", "telemetry-hmac.key");
  return Object.freeze({
    collectorInstanceRef: randomUUID(),
    runtimeVersionSnapshot: { version: null, version_source: "unknown", version_observed_at: null, version_freshness: "unknown" },
    secretPaths: [keyPath],
    evidenceRoots: [join(root, ".orbitlane", "evidence", global ? "global" : "project")],
    ownedFiles: [join(root, ".orbitlane", "hook"), join(root, ".orbitlane", "claude-report.json"), keyPath],
    managedAssets: [
      Object.freeze({ name: "runtime", kind: "directory", path: join(root, ".orbitlane", "hook"), sourcePath: join(PACKAGE_ROOT, "src"), packageJson: true }),
      Object.freeze({ name: "telemetry-hmac-key", kind: "file", path: keyPath, mode: 0o600 }),
    ],
  });
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
  if (options.command === "estimate") {
    const catalog = options.prices === undefined ? JSON.parse(await readFile(join(PACKAGE_ROOT, "src", "estimate", "default-prices.json"), "utf8")) : (await loadJsonSource(options.prices)).value;
    const selected = options.runtime === "auto" ? ["claude", "codex"] : [options.runtime];
    const validCatalog = validatePriceCatalog(catalog);
    if (options.baselineModel !== null && selected.every((runtime) => resolveModelPrice(validCatalog, runtime, options.baselineModel) === null)) throw Object.assign(new TypeError("BASELINE_MODEL_UNKNOWN"), { code: "BASELINE_MODEL_UNKNOWN" });
    const settled = await Promise.all(selected.map(async (runtime) => {
      try {
        const evidence = runtime === "claude" ? await loadClaudeEvidence({ cwd: process.cwd(), session: options.session }) : await loadCodexEvidence({ cwd: process.cwd(), session: options.session });
        return { runtime, estimate: estimateRuntime({ evidence, catalog: validCatalog, explicitBaselineModel: options.baselineModel }), failed: false };
      } catch {
        return { runtime, estimate: unavailableRuntimeEstimate(runtime), failed: true };
      }
    }));
    const failures = settled.filter((entry) => entry.failed);
    if (failures.length === selected.length) throw Object.assign(new Error("ESTIMATE_RUNTIME_FAILURE"), { code: "ESTIMATE_RUNTIME_FAILURE" });
    const report = combineEstimates({ catalog: validCatalog, estimates: settled.map((entry) => entry.estimate) });
    await writeSafeReport(resolve(options.output), report);
    process.stdout.write(`${renderHumanSummary(report)}\n`);
    if (failures.length > 0) process.exitCode = 1;
    return undefined;
  }
  if (options.command === "recover") return recoverRouting({ manifest: { path: resolve(options.manifest) } });
  if (options.command === "uninstall") {
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

  // Everything the Claude target needs before its adapter exists. A failure here is
  // carried into adapters() as that target's failure so a --target both run still
  // installs Codex, matching how adapter construction already isolates targets.
  const preflightFailures = preflightAdapters(contract, { ...options, runtimeDefaults, claudeGuardEnabled });
  let prepared = preflightFailures.claude === undefined ? {} : { claudePreparationError: preflightFailures.claude };
  if (claudeSelected && preflightFailures.claude === undefined) {
    try {
      const transitionAction = await claudeTransitionAction(options, claudeGuardEnabled);
      const claudeRoot = resolveTargetPaths({ global: options.global === true, configRoot: options.configRoot, targets: ["claude"] }).claude.root;
      const telemetry = claudeGuardEnabled ? prepareClaudeTelemetry(claudeRoot, options.global === true) : {};
      const contractSnapshot = planSnapshot(claudeRoot, "contracts", contractSource.bytes);
      const runtimeDefaultsSnapshot = runtimeDefaultsSource === undefined ? undefined : planSnapshot(claudeRoot, "runtime-defaults", runtimeDefaultsSource.bytes);
      const snapshotAssets = persist ? [
        Object.freeze({ name: `contract-${contractSnapshot.sha256}`, kind: "file", path: contractSnapshot.path, content: contractSource.bytes, mode: 0o600 }),
        ...(runtimeDefaultsSnapshot === undefined ? [] : [Object.freeze({ name: `runtime-defaults-${runtimeDefaultsSnapshot.sha256}`, kind: "file", path: runtimeDefaultsSnapshot.path, content: runtimeDefaultsSource.bytes, mode: 0o600 })]),
      ] : [];
      prepared = { contractSha256: contractSnapshot.sha256, runtimeDefaultsSha256: runtimeDefaultsSnapshot?.sha256,
        ...(claudeGuardEnabled ? telemetry : { collectorInstanceRef: "dry-run", runtimeVersionSnapshot: { version: null, version_source: "unknown", version_observed_at: null, version_freshness: "unknown" }, secretPaths: [], evidenceRoots: [], ownedFiles: [] }),
        managedAssets: persist ? [...snapshotAssets, ...(claudeGuardEnabled ? telemetry.managedAssets : [])] : [],
        ...(transitionAction === undefined ? {} : { claudeTransitionAction: transitionAction }) };
    } catch (error) {
      prepared = { claudePreparationError: error };
    }
  }

  const targetAdapters = adapters(contract, { ...options, runtimeDefaults, claudeGuardEnabled, ...prepared });
  if (options.command === "uninstall") return uninstall(options, targetAdapters);
  return options.dryRun ? previewRouting(contract, { target: options.target, adapters: targetAdapters }) : installRouting(contract, { target: options.target, adapters: targetAdapters });
}

try {
  const report = await main();
  if (report === undefined) {}
  else if (report === null) process.stdout.write(`${usage()}\n`);
  else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = exitCode(report);
  }
} catch (error) {
  process.stderr.write(`${error.code ?? "CLI_ERROR"}: ${error.message}\n${usage()}\n`);
  process.exitCode = 2;
}
