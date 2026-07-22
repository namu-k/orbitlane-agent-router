import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

async function createManifest(target, transactionPath, instruction, generated) {
  await mkdir(transactionPath, { recursive: true });
  const backups = Object.freeze([
    await stageSnapshot(transactionPath, "instruction", instruction),
    await stageSnapshot(transactionPath, "generated", generated),
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
  if (!backup.exists) {
    await rm(backup.targetPath, { force: true });
    return;
  }
  const stagedPath = join(transactionPath, `restore-${randomUUID()}.stage`);
  await writeStaged(stagedPath, await readFile(backup.path, "utf8"), backup.mode);
  await replaceStaged(stagedPath, backup.targetPath);
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
  if (!adapter?.runtime?.available) return "TARGET_RUNTIME_MISSING";
  if (typeof adapter.supportsVersion !== "function" || !adapter.supportsVersion(adapter.runtime.version)) return "TARGET_RUNTIME_UNSUPPORTED";
  return null;
}

function installDiff(target, instruction, generated, rendered) {
  const replacement = markerBoundedPolicy(target, rendered.policy.endsWith("\n") ? rendered.policy : `${rendered.policy}\n`);
  const instructionAfter = ownedBlockPattern(target).test(instruction.content)
    ? instruction.content.replace(ownedBlockPattern(target), replacement)
    : `${instruction.content}${replacement}`;
  return Object.freeze({
    instruction: Object.freeze({ path: instruction.path, before: instruction.content, after: instructionAfter }),
    generated: Object.freeze({ path: generated.path, before: generated.content, after: rendered.generated }),
  });
}

function uninstallDiff(target, instruction, generated) {
  return Object.freeze({
    instruction: Object.freeze({ path: instruction.path, before: instruction.content, after: instruction.content.replace(ownedBlockPattern(target), "") }),
    generated: Object.freeze({ path: generated.path, before: generated.content, after: null }),
  });
}

async function originalsMatch(instruction, generated) {
  const [currentInstruction, currentGenerated] = await Promise.all([snapshot(instruction.path), snapshot(generated.path)]);
  return currentInstruction.exists === instruction.exists
    && currentGenerated.exists === generated.exists
    && currentInstruction.hash === instruction.hash
    && currentGenerated.hash === generated.hash;
}

async function validateStages(stages) {
  for (const stage of stages) {
    if (sha256(await readFile(stage.path, "utf8")) !== stage.hash) {
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
    || !Array.isArray(manifest.backups) || manifest.backups.length !== 2) return null;
  const transactionPath = dirname(manifest.path);
  const backupNames = ["instruction", "generated"];
  const backupContents = [];
  for (const [index, backup] of manifest.backups.entries()) {
    if (backup === null || typeof backup !== "object" || typeof backup.path !== "string"
      || typeof backup.targetPath !== "string" || typeof backup.hash !== "string"
      || !/^[a-f0-9]{64}$/.test(backup.hash) || typeof backup.timestamp !== "string"
      || typeof backup.exists !== "boolean" || !(backup.mode === null || Number.isInteger(backup.mode))
      || backup.path !== join(transactionPath, `${backupNames[index]}.backup`)) return null;
    const content = await readFile(backup.path, "utf8");
    if (sha256(content) !== backup.hash) return null;
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
    diff = await operation.plan(instruction, generated);
    if (operation.isUnchanged(diff, generated)) return Object.freeze({ status: "unchanged", diff, manifest: null });
    transactionPath = join(dirname(adapter.instructionPath), `.orbitlane-${target}-${randomUUID()}`);
    manifest = await createManifest(target, transactionPath, instruction, generated);
    await Promise.all([mkdir(dirname(instruction.path), { recursive: true }), mkdir(dirname(generated.path), { recursive: true })]);
    await operation.stage(transactionPath, diff, instruction, generated);
    const stages = operation.stages(transactionPath, diff, generated);
    await hooks.afterStage?.({ target, manifest, diff });
    if (!await validateStages(stages)) return terminalFailure("STAGED_CONTENT_CHANGED", diff, undefined, manifest, "aborted");
    await hooks.beforeCommit?.({ target, manifest, diff });
    if (!await validateStages(stages)) return terminalFailure("STAGED_CONTENT_CHANGED", diff, undefined, manifest, "aborted");
    if (!await originalsMatch(instruction, generated)) return terminalFailure("TARGET_CONTENT_CHANGED", diff, undefined, manifest, "aborted");
    manifest = await persistManifest({ ...manifest, phase: "committing" });
    if (!await validateStages(stages)) return terminalFailure("STAGED_CONTENT_CHANGED", diff, undefined, manifest, "aborted");
    if (!await originalsMatch(instruction, generated)) return terminalFailure("TARGET_CONTENT_CHANGED", diff, undefined, manifest, "aborted");
    commitStarted = true;
    await operation.commit(transactionPath, diff, instruction, generated, adapter, stages);
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
    plan: (instruction, generated) => installDiff(target, instruction, generated, adapter.render(contract)),
    isUnchanged: (diff, generated) => diff.instruction.before === diff.instruction.after && generated.exists && diff.generated.before === diff.generated.after,
    stage: async (transactionPath, diff, instruction, generated) => {
      await writeStaged(join(transactionPath, "instruction.stage"), diff.instruction.after, instruction.mode);
      await writeStaged(join(transactionPath, "generated.stage"), diff.generated.after, generated.mode);
    },
    stages: (transactionPath, diff) => Object.freeze([
      Object.freeze({ path: join(transactionPath, "instruction.stage"), hash: sha256(diff.instruction.after) }),
      Object.freeze({ path: join(transactionPath, "generated.stage"), hash: sha256(diff.generated.after) }),
    ]),
    commit: async (transactionPath, diff, instruction, generated, targetAdapter) => {
      await replaceStaged(join(transactionPath, "instruction.stage"), instruction.path);
      if (targetAdapter.failurePoint === "terminateAfterInstructionCommit") process.kill(process.pid, "SIGKILL");
      if (targetAdapter.failurePoint === "leaveAfterInstructionCommit") throw Object.assign(new Error("interrupted for recovery"), { code: "INTERRUPTED_FOR_RECOVERY" });
      if (targetAdapter.failurePoint === "afterInstructionCommit" || hooks.interruptAfterInstructionCommit) throw Object.assign(new Error("interrupted"), { code: "INSTALL_INTERRUPTED" });
      await replaceStaged(join(transactionPath, "generated.stage"), generated.path);
    },
  });
}

async function uninstallOne(target, adapter, hooks) {
  return runTarget(target, adapter, hooks, {
    status: "uninstalled",
    plan: (instruction, generated) => uninstallDiff(target, instruction, generated),
    isUnchanged: (diff, generated) => diff.instruction.before === diff.instruction.after && !generated.exists,
    stage: async (transactionPath, diff, instruction, generated) => {
      await writeStaged(join(transactionPath, "instruction.stage"), diff.instruction.after, instruction.mode);
      if (generated.exists) await writeStaged(join(transactionPath, "generated.stage"), generated.content, generated.mode);
    },
    stages: (transactionPath, diff, generated) => Object.freeze([
      Object.freeze({ path: join(transactionPath, "instruction.stage"), hash: sha256(diff.instruction.after) }),
      ...(generated.exists ? [Object.freeze({ path: join(transactionPath, "generated.stage"), hash: sha256(generated.content) })] : []),
    ]),
    commit: async (transactionPath, diff, instruction, generated, targetAdapter) => {
      await replaceStaged(join(transactionPath, "instruction.stage"), instruction.path);
      if (targetAdapter.failurePoint === "afterInstructionCommit" || hooks.interruptAfterInstructionCommit) throw Object.assign(new Error("interrupted"), { code: "UNINSTALL_INTERRUPTED" });
      if (generated.exists) await rename(generated.path, join(transactionPath, "generated.removed"));
    },
  });
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
