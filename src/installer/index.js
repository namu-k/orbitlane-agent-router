import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { markerBoundedPolicy } from "../policy/index.js";

const TARGET_NAMES = Object.freeze(["codex", "claude"]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function ownedBlockPattern(target) {
  return new RegExp(`${escape(`<!-- ORBITLANE:START ${target} -->`)}[\\s\\S]*?${escape(`<!-- ORBITLANE:END ${target} -->`)}\\n?`, "g");
}

async function snapshot(path) {
  try {
    const [content, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return Object.freeze({ path, exists: true, content, hash: sha256(content), timestamp: new Date().toISOString(), mode: metadata.mode & 0o777 });
  } catch (error) {
    if (error.code === "ENOENT") return Object.freeze({ path, exists: false, content: "", hash: sha256(""), timestamp: new Date().toISOString(), mode: null });
    throw error;
  }
}

async function preserveMode(path, mode) {
  if (mode !== null && process.platform !== "win32") await chmod(path, mode);
}

async function writeStaged(path, content, mode) {
  await writeFile(path, content, "utf8");
  await preserveMode(path, mode);
}

async function stageSnapshot(transactionPath, name, source) {
  const path = join(transactionPath, `${name}.backup`);
  await writeStaged(path, source.content, source.mode);
  return Object.freeze({ path, hash: source.hash, timestamp: source.timestamp, exists: source.exists, mode: source.mode, targetPath: source.path });
}

async function directoryDigest(path) {
  const entries = [];
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      const child = join(directory, entry.name);
      if (entry.isDirectory()) await visit(child, `${relative}/`);
      else entries.push(`${relative}:${createHash("sha256").update(await readFile(child)).digest("hex")}`);
    }
  }
  await visit(path);
  return sha256(entries.sort().join("\n"));
}

async function snapshotAsset(transactionPath, asset) {
  const backupPath = join(transactionPath, `${asset.name}.backup`);
  try {
    const metadata = await stat(asset.path);
    if (asset.kind === "directory") {
      if (!metadata.isDirectory()) throw Object.assign(new Error(`ASSET_TYPE_MISMATCH: ${asset.path}`), { code: "ASSET_TYPE_MISMATCH" });
      await cp(asset.path, backupPath, { recursive: true });
      return Object.freeze({ name: asset.name, kind: asset.kind, path: backupPath, hash: await directoryDigest(backupPath), timestamp: new Date().toISOString(), exists: true, mode: metadata.mode & 0o777, targetPath: asset.path });
    }
    if (!metadata.isFile()) throw Object.assign(new Error(`ASSET_TYPE_MISMATCH: ${asset.path}`), { code: "ASSET_TYPE_MISMATCH" });
    const content = await readFile(asset.path);
    await writeFile(backupPath, content);
    return Object.freeze({ name: asset.name, kind: asset.kind, path: backupPath, hash: createHash("sha256").update(content).digest("hex"), timestamp: new Date().toISOString(), exists: true, mode: metadata.mode & 0o777, targetPath: asset.path });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return Object.freeze({ name: asset.name, kind: asset.kind, path: backupPath, hash: sha256(""), timestamp: new Date().toISOString(), exists: false, mode: null, targetPath: asset.path });
  }
}

async function createManifest(target, transactionPath, instruction, generated, settings, assets = []) {
  await mkdir(transactionPath, { recursive: true });
  const backups = Object.freeze([
    await stageSnapshot(transactionPath, "instruction", instruction),
    await stageSnapshot(transactionPath, "generated", generated),
    ...(settings === null ? [] : [await stageSnapshot(transactionPath, "settings", settings)]),
    ...await Promise.all(assets.map((asset) => snapshotAsset(transactionPath, asset))),
  ]);
  return persistManifest(Object.freeze({ version: 1, target, path: join(transactionPath, "manifest.json"), phase: "prepared", backups }));
}

async function persistManifest(manifest) {
  const temporary = `${manifest.path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest)}\n`, "utf8");
  await rename(temporary, manifest.path);
  return Object.freeze(manifest);
}

async function replaceStaged(stagedPath, destination) {
  await rename(stagedPath, destination);
}

async function restoreBackup(backup, transactionPath) {
  if (backup.kind === "directory") {
    await rm(backup.targetPath, { recursive: true, force: true });
    if (backup.exists) await cp(backup.path, backup.targetPath, { recursive: true });
    return;
  }
  if (!backup.exists) {
    await rm(backup.targetPath, { force: true });
    return;
  }
  const stagedPath = join(transactionPath, `restore-${randomUUID()}.stage`);
  await writeStaged(stagedPath, await readFile(backup.path, "utf8"), backup.mode);
  await replaceStaged(stagedPath, backup.targetPath);
}

function managedAssets(adapter) {
  return Array.isArray(adapter?.managedAssets) ? adapter.managedAssets : [];
}

async function stageManagedAssets(transactionPath, assets, manifest) {
  const backups = new Map(manifest.backups.filter((backup) => backup.name !== undefined).map((backup) => [backup.name, backup]));
  const stages = [];
  for (const asset of assets) {
    const stage = join(transactionPath, `${asset.name}.stage`);
    const backup = backups.get(asset.name);
    if (asset.kind === "directory") {
      await cp(asset.sourcePath, stage, { recursive: true });
      if (asset.packageJson === true) await writeFile(join(stage, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`, "utf8");
      stages.push(Object.freeze({ path: stage, kind: "directory", hash: await directoryDigest(stage), destination: asset.path }));
    } else {
      const content = asset.content ?? (backup?.exists ? await readFile(backup.path) : randomBytes(32));
      await writeFile(stage, content);
      await preserveMode(stage, asset.mode ?? backup?.mode ?? 0o600);
      stages.push(Object.freeze({ path: stage, kind: "file", hash: createHash("sha256").update(content).digest("hex"), destination: asset.path }));
    }
  }
  return stages;
}

async function commitManagedAssets(stages) {
  for (const stage of stages) {
    await mkdir(dirname(stage.destination), { recursive: true });
    if (stage.kind === "directory") {
      const retired = `${stage.destination}.retired-${randomUUID()}`;
      const replaced = await rename(stage.destination, retired).then(() => true, (error) => {
        if (error?.code === "ENOENT") return false;
        throw error;
      });
      await rename(stage.path, stage.destination);
      if (replaced) await rm(retired, { recursive: true, force: true });
    } else await replaceStaged(stage.path, stage.destination);
  }
}

async function rollback(manifest, transactionPath) {
  const errors = [];
  for (const backup of manifest.backups) {
    try {
      await restoreBackup(backup, transactionPath);
    } catch (error) {
      errors.push(Object.freeze({ phase: "rollback", path: backup.targetPath, code: error.code ?? "ROLLBACK_FAILED", message: error.message }));
    }
  }
  return errors;
}

function targetList(target) {
  if (target === "both") return TARGET_NAMES;
  if (TARGET_NAMES.includes(target)) return [target];
  throw new TypeError("target must be codex, claude, or both");
}

function failure(code, diff, cause, manifest = null, errors = []) {
  return Object.freeze({ status: "failed", error: Object.freeze({ code, message: cause?.message ?? code }), diff, manifest, errors: Object.freeze(errors) });
}

async function terminalFailure(code, diff, cause, manifest, phase, errors = []) {
  if (manifest === null) return failure(code, diff, cause, null, errors);
  try {
    return failure(code, diff, cause, await persistManifest({ ...manifest, phase }), errors);
  } catch (error) {
    return failure("TRANSACTION_PHASE_PERSIST_FAILED", diff, error, manifest, [...errors, Object.freeze({ phase: "phase", code: error.code ?? "PHASE_PERSIST_FAILED", message: error.message })]);
  }
}

function runtimeFailure(adapter) {
  if (!adapter || adapter.runtime?.available === false) return "TARGET_RUNTIME_MISSING";
  if (adapter.runtime?.available === true && (typeof adapter.supportsVersion !== "function" || !adapter.supportsVersion(adapter.runtime.version))) return "TARGET_RUNTIME_UNSUPPORTED";
  return null;
}

function previousGuardCommand(content) {
  if (content.length === 0) return undefined;
  let report;
  try { report = JSON.parse(content); } catch {
    throw Object.assign(new Error("REPORT_UNREADABLE: the existing report could not be parsed"), { code: "REPORT_UNREADABLE" });
  }
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    throw Object.assign(new Error("REPORT_UNREADABLE: the existing report is not an object"), { code: "REPORT_UNREADABLE" });
  }
  if (report.schema_version !== undefined && report.schema_version !== 2) {
    throw Object.assign(new Error("UNSUPPORTED_REPORT_SCHEMA: the existing report has an unsupported schema"), { code: "UNSUPPORTED_REPORT_SCHEMA" });
  }
  if (report.receipt?.version !== undefined) {
    if (report.schema_version !== 2) throw Object.assign(new Error("RECEIPT_UNVERIFIABLE: a versioned receipt requires schema version 2"), { code: "RECEIPT_UNVERIFIABLE" });
    if (report.receipt.version !== 1) throw Object.assign(new Error("RECEIPT_UNVERIFIABLE: the existing receipt version is unsupported"), { code: "RECEIPT_UNVERIFIABLE" });
    if (report.receipt.install_shape === "guidance-only") return undefined;
    if (report.receipt.install_shape === "claude-managed-role-guard" && typeof report.receipt.guard_command === "string" && report.receipt.guard_command.length > 0) return report.receipt.guard_command;
    throw Object.assign(new Error("RECEIPT_UNVERIFIABLE: the existing receipt is malformed"), { code: "RECEIPT_UNVERIFIABLE" });
  }
  return report?.settings_projection?.guard_command;
}

function hasAgentHook(content, command) {
  let settings;
  try { settings = content.length === 0 ? {} : JSON.parse(content); } catch {
    throw Object.assign(new Error("RECEIPT_UNVERIFIABLE: settings could not be parsed"), { code: "RECEIPT_UNVERIFIABLE" });
  }
  const entries = settings?.hooks?.PreToolUse;
  if (!Array.isArray(entries)) return false;
  return entries
    .filter((entry) => entry?.matcher === "Agent")
    .flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : []))
    .some((hook) => hook?.type === "command" && hook.command === command);
}

function mergeSettings(content, command, previousCommand, remove = false) {
  const settings = content.length === 0 ? {} : JSON.parse(content);
  const hooks = settings.hooks ?? {};
  const entries = hooks.PreToolUse ?? [];
  const ownedCommands = new Set([command, previousCommand].filter((value) => typeof value === "string"));
  const owned = (hook) => hook?.type === "command" && ownedCommands.has(hook.command);
  const retained = entries.flatMap((entry) => {
    if (entry?.matcher !== "Agent" || !Array.isArray(entry.hooks)) return [entry];
    const next = entry.hooks.filter((hook) => !owned(hook));
    return next.length === 0 ? [] : [{ ...entry, hooks: next }];
  });
  if (remove && retained.length === 0) {
    const { PreToolUse, ...otherHooks } = hooks;
    if (Object.keys(otherHooks).length === 0) delete settings.hooks;
    else settings.hooks = otherHooks;
  } else {
    settings.hooks = { ...hooks, PreToolUse: remove ? retained : [...retained, { matcher: "Agent", hooks: [{ type: "command", command }] }] };
  }
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function installDiff(target, instruction, generated, settings, rendered) {
  const replacement = markerBoundedPolicy(target, rendered.policy.endsWith("\n") ? rendered.policy : `${rendered.policy}\n`);
  const instructionAfter = ownedBlockPattern(target).test(instruction.content)
    ? instruction.content.replace(ownedBlockPattern(target), replacement)
    : `${instruction.content}${replacement}`;
  return Object.freeze({
    instruction: Object.freeze({ path: instruction.path, before: instruction.content, after: instructionAfter }),
    generated: Object.freeze({ path: generated.path, before: generated.content, after: rendered.generated }),
    settings: adapterTransitionSettings(settings, generated, rendered),
  });
}

function adapterTransitionSettings(settings, generated, rendered) {
  const action = rendered.transitionAction;
  if (action !== undefined) {
    const previousCommand = previousGuardCommand(generated.content);
    if (settings === null || action?.kind !== "remove-owned-hook" || typeof action.command !== "string"
      || action.reportHash !== sha256(generated.content) || previousCommand !== action.command || !hasAgentHook(settings.content, action.command)) {
      throw Object.assign(new Error("RECEIPT_UNVERIFIABLE: transition ownership could not be verified"), { code: "RECEIPT_UNVERIFIABLE" });
    }
    return Object.freeze({ path: settings.path, before: settings.content, after: mergeSettings(settings.content, action.command, previousCommand, true) });
  }
  return settings === null || rendered.settingsProjection === undefined
    ? null
    : Object.freeze({ path: settings.path, before: settings.content, after: mergeSettings(settings.content, rendered.settingsProjection.command, previousGuardCommand(generated.content)) });
}

function uninstallDiff(target, instruction, generated, settings, adapter) {
  return Object.freeze({
    instruction: Object.freeze({ path: instruction.path, before: instruction.content, after: instruction.content.replace(ownedBlockPattern(target), "") }),
    generated: Object.freeze({ path: generated.path, before: generated.content, after: null }),
    settings: settings === null ? null : Object.freeze({ path: settings.path, before: settings.content, after: mergeSettings(settings.content, adapter.spawnGuardCommand, previousGuardCommand(generated.content), true) }),
  });
}

async function originalsMatch(instruction, generated, settings) {
  const [currentInstruction, currentGenerated, currentSettings] = await Promise.all([snapshot(instruction.path), snapshot(generated.path), ...(settings === null ? [] : [snapshot(settings.path)])]);
  return currentInstruction.exists === instruction.exists
    && currentGenerated.exists === generated.exists
    && currentInstruction.hash === instruction.hash && currentGenerated.hash === generated.hash
    && (settings === null || (currentSettings.exists === settings.exists && currentSettings.hash === settings.hash));
}

async function validateStages(stages) {
  for (const stage of stages) {
    const hash = stage.kind === "directory" ? await directoryDigest(stage.path) : createHash("sha256").update(await readFile(stage.path)).digest("hex");
    if (hash !== stage.hash) {
      return false;
    }
  }
  return true;
}

async function validateRecoveryManifest(manifest, requestedPath) {
  if (manifest === null || typeof manifest !== "object" || manifest.version !== 1
    || !TARGET_NAMES.includes(manifest.target) || typeof manifest.path !== "string"
    || manifest.path !== requestedPath
    || !["prepared", "committing", "completed", "aborted", "rolled_back", "recovered"].includes(manifest.phase)
    || !Array.isArray(manifest.backups) || manifest.backups.length < 2) return null;
  const transactionPath = dirname(manifest.path);
  const backupNames = manifest.backups.length >= 3 && manifest.backups[2]?.name === undefined ? ["instruction", "generated", "settings"] : ["instruction", "generated"];
  const backupContents = [];
  for (const [index, backup] of manifest.backups.entries()) {
    if (backup === null || typeof backup !== "object" || typeof backup.path !== "string"
      || typeof backup.targetPath !== "string" || typeof backup.hash !== "string"
      || !/^[a-f0-9]{64}$/.test(backup.hash) || typeof backup.timestamp !== "string"
      || typeof backup.exists !== "boolean" || !(backup.mode === null || Number.isInteger(backup.mode))
      || backup.path !== join(transactionPath, `${backup.name ?? backupNames[index]}.backup`)) return null;
    if (backup.kind !== undefined && !["directory", "file"].includes(backup.kind)) return null;
    const content = backup.exists === false ? "" : backup.kind === "directory" ? await directoryDigest(backup.path) : backup.kind === "file" ? await readFile(backup.path) : await readFile(backup.path, "utf8");
    if ((backup.kind === "directory" ? content : backup.kind === "file" ? createHash("sha256").update(content).digest("hex") : sha256(content)) !== backup.hash) return null;
    backupContents.push(content);
  }
  return backupContents;
}

async function runTarget(target, adapter, hooks, operation) {
  let diff = null;
  let manifest = null;
  let transactionPath = null;
  let commitStarted = false;
  const errors = [];
  try {
    const runtime = runtimeFailure(adapter);
    if (runtime) return failure(runtime, null);
    const instruction = await snapshot(adapter.instructionPath);
    const generated = await snapshot(adapter.generatedPath);
    const settings = adapter.settingsPath === undefined ? null : await snapshot(adapter.settingsPath);
    const assets = managedAssets(adapter);
    diff = await operation.plan(instruction, generated, settings);
    if (operation.isUnchanged(diff, generated, settings)) return Object.freeze({ status: "unchanged", diff, manifest: null });
    transactionPath = join(dirname(adapter.instructionPath), `.orbitlane-${target}-${randomUUID()}`);
    manifest = await createManifest(target, transactionPath, instruction, generated, settings, assets);
    await Promise.all([mkdir(dirname(instruction.path), { recursive: true }), mkdir(dirname(generated.path), { recursive: true }), ...(settings === null ? [] : [mkdir(dirname(settings.path), { recursive: true })])]);
    await operation.stage(transactionPath, diff, instruction, generated, settings);
    const assetStages = await stageManagedAssets(transactionPath, assets, manifest);
    const stages = [...assetStages, ...operation.stages(transactionPath, diff, generated)];
    await hooks.afterStage?.({ target, manifest, diff });
    if (!await validateStages(stages)) return terminalFailure("STAGED_CONTENT_CHANGED", diff, undefined, manifest, "aborted");
    await hooks.beforeCommit?.({ target, manifest, diff });
    if (!await validateStages(stages)) return terminalFailure("STAGED_CONTENT_CHANGED", diff, undefined, manifest, "aborted");
    if (!await originalsMatch(instruction, generated, settings)) return terminalFailure("TARGET_CONTENT_CHANGED", diff, undefined, manifest, "aborted");
    manifest = await persistManifest({ ...manifest, phase: "committing" });
    if (!await validateStages(stages)) return terminalFailure("STAGED_CONTENT_CHANGED", diff, undefined, manifest, "aborted");
    if (!await originalsMatch(instruction, generated, settings)) return terminalFailure("TARGET_CONTENT_CHANGED", diff, undefined, manifest, "aborted");
    commitStarted = true;
    await operation.commit(transactionPath, diff, instruction, generated, settings, adapter, assetStages, stages);
    manifest = await persistManifest({ ...manifest, phase: "completed" });
    return Object.freeze({ status: operation.status, diff, manifest });
  } catch (error) {
    if (error?.code === "INTERRUPTED_FOR_RECOVERY") return failure(error.code, diff, error, manifest);
    if (commitStarted && manifest) {
      errors.push(...await rollback(manifest, transactionPath));
      if (errors.length === 0) return terminalFailure(error?.code ?? "INSTALL_FAILED", diff, error, manifest, "rolled_back");
      return failure(error?.code ?? "INSTALL_FAILED", diff, error, manifest, errors);
    }
    return terminalFailure(error?.code ?? "INSTALL_FAILED", diff, error, manifest, "aborted", errors);
  }
}

async function installOne(contract, target, adapter, hooks) {
  return runTarget(target, adapter, hooks, {
    status: "installed",
    plan: (instruction, generated, settings) => {
      const rendered = adapter.render(contract);
      return installDiff(target, instruction, generated, settings, { ...rendered, transitionAction: adapter.transitionAction });
    },
    isUnchanged: (diff, generated, settings) => diff.instruction.before === diff.instruction.after && generated.exists && diff.generated.before === diff.generated.after && (settings === null || diff.settings.before === diff.settings.after) && managedAssets(adapter).length === 0,
    stage: async (transactionPath, diff, instruction, generated, settings) => {
      await writeStaged(join(transactionPath, "instruction.stage"), diff.instruction.after, instruction.mode);
      await writeStaged(join(transactionPath, "generated.stage"), diff.generated.after, generated.mode);
      if (settings !== null) await writeStaged(join(transactionPath, "settings.stage"), diff.settings.after, settings.mode);
    },
    stages: (transactionPath, diff) => Object.freeze([
      Object.freeze({ path: join(transactionPath, "instruction.stage"), hash: sha256(diff.instruction.after) }),
      Object.freeze({ path: join(transactionPath, "generated.stage"), hash: sha256(diff.generated.after) }),
      ...(diff.settings === null ? [] : [Object.freeze({ path: join(transactionPath, "settings.stage"), hash: sha256(diff.settings.after) })]),
    ]),
    commit: async (transactionPath, diff, instruction, generated, settings, targetAdapter, assetStages) => {
      await commitManagedAssets(assetStages);
      await replaceStaged(join(transactionPath, "instruction.stage"), instruction.path);
      if (targetAdapter.failurePoint === "terminateAfterInstructionCommit") process.kill(process.pid, "SIGKILL");
      if (targetAdapter.failurePoint === "leaveAfterInstructionCommit") throw Object.assign(new Error("interrupted for recovery"), { code: "INTERRUPTED_FOR_RECOVERY" });
      if (targetAdapter.failurePoint === "afterInstructionCommit" || hooks.interruptAfterInstructionCommit) throw Object.assign(new Error("interrupted"), { code: "INSTALL_INTERRUPTED" });
      await replaceStaged(join(transactionPath, "generated.stage"), generated.path);
      if (settings !== null) await replaceStaged(join(transactionPath, "settings.stage"), settings.path);
    },
  });
}

async function uninstallOne(target, adapter, hooks) {
  return runTarget(target, adapter, hooks, {
    status: "uninstalled",
    plan: (instruction, generated, settings) => uninstallDiff(target, instruction, generated, settings, { ...adapter, spawnGuardCommand: adapter.spawnGuardCommand ?? adapter.render().settingsProjection?.command }),
    isUnchanged: (diff, generated, settings) => diff.instruction.before === diff.instruction.after && !generated.exists && (settings === null || diff.settings.before === diff.settings.after),
    stage: async (transactionPath, diff, instruction, generated, settings) => {
      await writeStaged(join(transactionPath, "instruction.stage"), diff.instruction.after, instruction.mode);
      if (generated.exists) await writeStaged(join(transactionPath, "generated.stage"), generated.content, generated.mode);
      if (settings !== null) await writeStaged(join(transactionPath, "settings.stage"), diff.settings.after, settings.mode);
    },
    stages: (transactionPath, diff, generated) => Object.freeze([
      Object.freeze({ path: join(transactionPath, "instruction.stage"), hash: sha256(diff.instruction.after) }),
      ...(generated.exists ? [Object.freeze({ path: join(transactionPath, "generated.stage"), hash: sha256(generated.content) })] : []),
      ...(diff.settings === null ? [] : [Object.freeze({ path: join(transactionPath, "settings.stage"), hash: sha256(diff.settings.after) })]),
    ]),
    commit: async (transactionPath, diff, instruction, generated, settings, targetAdapter, assetStages) => {
      await commitManagedAssets(assetStages);
      await replaceStaged(join(transactionPath, "instruction.stage"), instruction.path);
      if (targetAdapter.failurePoint === "afterInstructionCommit" || hooks.interruptAfterInstructionCommit) throw Object.assign(new Error("interrupted"), { code: "UNINSTALL_INTERRUPTED" });
      if (generated.exists) await rename(generated.path, join(transactionPath, "generated.removed"));
      if (settings !== null) await replaceStaged(join(transactionPath, "settings.stage"), settings.path);
    },
  });
}

async function previewOne(contract, target, adapter) {
  try {
    const runtime = runtimeFailure(adapter);
    if (runtime) return failure(runtime, null);
    const [instruction, generated, settings] = await Promise.all([
      snapshot(adapter.instructionPath),
      snapshot(adapter.generatedPath),
      adapter.settingsPath === undefined ? Promise.resolve(null) : snapshot(adapter.settingsPath),
    ]);
    return Object.freeze({
      status: "planned",
      diff: installDiff(target, instruction, generated, settings, { ...adapter.render(contract), transitionAction: adapter.transitionAction }),
      manifest: null,
    });
  } catch (error) {
    return failure(error.code ?? "INSTALL_FAILED", null, error);
  }
}

export async function previewRouting(contract, { target, adapters }) {
  const outcomes = {};
  for (const name of targetList(target)) outcomes[name] = await previewOne(contract, name, adapters?.[name]);
  return Object.freeze({ outcomes: Object.freeze(outcomes) });
}

export async function installRouting(contract, { target, adapters, hooks = {} }) {
  const outcomes = {};
  for (const name of targetList(target)) {
    try {
      outcomes[name] = await installOne(contract, name, adapters?.[name], hooks);
    } catch (error) {
      outcomes[name] = failure(error.code ?? "INSTALL_FAILED", null, error);
    }
  }
  return Object.freeze({ outcomes: Object.freeze(outcomes) });
}

export async function uninstallRouting({ target, adapters, hooks = {} }) {
  const outcomes = {};
  for (const name of targetList(target)) {
    try {
      outcomes[name] = await uninstallOne(name, adapters?.[name], hooks);
    } catch (error) {
      outcomes[name] = failure(error.code ?? "UNINSTALL_FAILED", null, error);
    }
  }
  return Object.freeze({ outcomes: Object.freeze(outcomes) });
}

export async function recoverRouting({ manifest }) {
  try {
    const persisted = JSON.parse(await readFile(manifest.path, "utf8"));
    const validation = await validateRecoveryManifest(persisted, manifest.path);
    if (validation === null) return failure("RECOVERY_INVALID", null, undefined, persisted);
    if (persisted.phase !== "committing") return Object.freeze({ status: persisted.phase, manifest: persisted });
    const errors = await rollback(persisted, dirname(manifest.path));
    if (errors.length > 0) return failure("RECOVERY_FAILED", null, undefined, persisted, errors);
    try {
      const terminal = await persistManifest({ ...persisted, phase: "recovered" });
      return Object.freeze({ status: "recovered", manifest: terminal });
    } catch (error) {
      return failure("RECOVERY_PHASE_PERSIST_FAILED", null, error, persisted);
    }
  } catch (error) {
    return failure("RECOVERY_INVALID", null, error);
  }
}
