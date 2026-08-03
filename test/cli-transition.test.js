import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { isolated } from "./cli-global.test.js";
import { createClaudeTier1Adapter } from "../src/adapters/claude/index.js";
import { installRouting, recoverRouting } from "../src/installer/index.js";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/orbitlane.js", import.meta.url));
const sha256 = (content) => createHash("sha256").update(content, "utf8").digest("hex");
const ROLES_LESS = {
  contract_version: "1.0.0",
  lanes: { sol: { class: "judgment", reasoning: "high" }, terra: { class: "implementation", reasoning: "medium" }, luna: { class: "bounded-retrieval", reasoning: "low" } },
  targets: {
    codex: { lanes: { sol: { model: "codex-sol", provenance: "user-local" }, terra: { model: "codex-terra", provenance: "user-local" }, luna: { model: "codex-luna", provenance: "user-local" } } },
    claude: { lanes: { sol: { model: "opus", provenance: "user-local" }, terra: { model: "claude-terra", provenance: "user-local" }, luna: { model: "haiku", provenance: "user-local" } } },
  },
};

async function invoke(args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], { ...options, encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}

async function withBothContracts(t) {
  const context = await isolated(t);
  const rolesLessPath = join(context.directory, "roles-less.json");
  await writeFile(rolesLessPath, `${JSON.stringify(ROLES_LESS)}\n`, "utf8");
  return { ...context, rolesLessPath };
}

async function installPresent(context, target = "claude") {
  const result = await invoke(["install", "--global", "--target", target, "--contract", context.contractPath], { env: context.env });
  assert.equal(result.code, 0);
  return result;
}

async function transitionAbsent(context, target = "claude", env = context.env) {
  return invoke(["install", "--global", "--target", target, "--contract", context.rolesLessPath], { env });
}

async function aliasDirectory(alias, target) {
  if (process.platform === "win32") {
    await execFileAsync("cmd.exe", ["/d", "/c", "mklink", "/J", alias, target], { windowsHide: true });
  } else {
    await symlink(target, alias, "dir");
  }
}

async function filesBefore(context) {
  const home = context.claudeHome;
  return Object.freeze({
    instruction: await readFile(join(home, "CLAUDE.md"), "utf8"),
    report: await readFile(join(home, ".orbitlane", "claude-report.json"), "utf8"),
    settings: await readFile(join(home, "settings.json"), "utf8"),
    snapshots: await readdir(join(home, ".orbitlane", "contracts")),
    runtime: await readdir(join(home, ".orbitlane", "hook")),
  });
}

async function assertUnchanged(context, before) {
  assert.equal(await readFile(join(context.claudeHome, "CLAUDE.md"), "utf8"), before.instruction);
  assert.equal(await readFile(join(context.claudeHome, ".orbitlane", "claude-report.json"), "utf8"), before.report);
  assert.equal(await readFile(join(context.claudeHome, "settings.json"), "utf8"), before.settings);
  assert.deepEqual(await readdir(join(context.claudeHome, ".orbitlane", "contracts")), before.snapshots);
  assert.deepEqual(await readdir(join(context.claudeHome, ".orbitlane", "hook")), before.runtime);
}

async function guidanceFilesBefore(context) {
  return Object.freeze({
    instruction: await readFile(join(context.claudeHome, "CLAUDE.md"), "utf8"),
    report: await readFile(join(context.claudeHome, ".orbitlane", "claude-report.json"), "utf8"),
    snapshots: await readdir(join(context.claudeHome, ".orbitlane", "contracts")),
  });
}

async function assertGuidanceUnchanged(context, before) {
  assert.equal(await readFile(join(context.claudeHome, "CLAUDE.md"), "utf8"), before.instruction);
  assert.equal(await readFile(join(context.claudeHome, ".orbitlane", "claude-report.json"), "utf8"), before.report);
  assert.deepEqual(await readdir(join(context.claudeHome, ".orbitlane", "contracts")), before.snapshots);
  await assert.rejects(readFile(join(context.claudeHome, "settings.json"), "utf8"));
  await assert.rejects(readdir(join(context.claudeHome, ".orbitlane", "hook")));
}

test("present to absent removes only the exact owned Agent hook", async (t) => {
  const context = await withBothContracts(t);
  await installPresent(context);
  const settingsPath = join(context.claudeHome, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  settings.hooks.PreToolUse[0].hooks.push({ type: "command", command: "foreign-agent" });
  settings.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: "foreign-bash" }] });
  settings.hooks.PostToolUse[0].hooks.push({ type: "command", command: "foreign-post" });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  assert.equal((await transitionAbsent(context)).code, 0);
  const after = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(after.hooks.PreToolUse, [
    { matcher: "Agent", hooks: [{ type: "command", command: "foreign-agent" }] },
    { matcher: "Bash", hooks: [{ type: "command", command: "foreign-bash" }] },
  ]);
  assert.deepEqual(after.hooks.PostToolUse, [{ matcher: "Agent", hooks: [{ type: "command", command: "foreign-post" }] }]);
});

test("a missing exact PostToolUse tuple fails closed before a guard reinstall", async (t) => {
  const context = await withBothContracts(t);
  await installPresent(context);
  const settingsPath = join(context.claudeHome, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  delete settings.hooks.PostToolUse;
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  const before = await filesBefore(context);
  const result = await invoke(["install", "--global", "--target", "claude", "--contract", context.contractPath], { env: context.env });
  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /RECEIPT_UNVERIFIABLE/);
  await assertUnchanged(context, before);
});

test("present to absent leaves a valid guidance receipt and inert vendored runtime", async (t) => {
  const context = await withBothContracts(t);
  await installPresent(context);
  assert.equal((await transitionAbsent(context)).code, 0);
  const report = JSON.parse(await readFile(join(context.claudeHome, ".orbitlane", "claude-report.json"), "utf8"));
  assert.equal(report.receipt.install_shape, "guidance-only");
  assert.match(report.contract_snapshot.sha256, /^[a-f0-9]{64}$/);
  assert.ok((await readdir(join(context.claudeHome, ".orbitlane", "hook"))).length > 0);
  assert.equal((await invoke(["uninstall", "--global", "--target", "claude"], { env: context.env })).code, 0);
  await assert.rejects(readdir(join(context.claudeHome, ".orbitlane", "hook")));
});

test("a global transition accepts an alias path to its installed report", async (t) => {
  const context = await withBothContracts(t);
  await installPresent(context);
  const alias = join(context.directory, "claude-home-alias");
  await aliasDirectory(alias, context.claudeHome);

  assert.equal((await transitionAbsent(context, "claude", { ...context.env, CLAUDE_CONFIG_DIR: alias })).code, 0);
  assert.equal(JSON.parse(await readFile(join(context.claudeHome, "settings.json"), "utf8")).hooks, undefined);
});

test("absent to present restores one hook and remains idempotent", async (t) => {
  const context = await withBothContracts(t);
  assert.equal((await transitionAbsent(context)).code, 0);
  await installPresent(context);
  await installPresent(context);
  const commands = JSON.parse(await readFile(join(context.claudeHome, "settings.json"), "utf8")).hooks.PreToolUse.flatMap((entry) => entry.hooks).map((hook) => hook.command);
  assert.equal(commands.length, 1);
  assert.ok((await readdir(join(context.claudeHome, ".orbitlane", "hook"))).length > 0);
});

test("v2 receipt owns exactly the Agent PreToolUse and PostToolUse tuples", async (t) => {
  const context = await withBothContracts(t);
  await installPresent(context);
  const report = JSON.parse(await readFile(join(context.claudeHome, ".orbitlane", "claude-report.json"), "utf8"));
  assert.equal(report.receipt.version, 2);
  assert.deepEqual(report.receipt.hooks.map(({ event, matcher }) => ({ event, matcher })), [
    { event: "PreToolUse", matcher: "Agent" },
    { event: "PostToolUse", matcher: "Agent" },
  ]);
  const settings = JSON.parse(await readFile(join(context.claudeHome, "settings.json"), "utf8"));
  assert.equal(settings.hooks.PreToolUse[0].hooks.length, 1);
  assert.equal(settings.hooks.PostToolUse[0].hooks.length, 1);
});

test("a v1 to v2 migration refuses before mutation when its owned Pre tuple is absent", async (t) => {
  const context = await withBothContracts(t);
  await installPresent(context);
  const reportPath = join(context.claudeHome, ".orbitlane", "claude-report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  report.receipt = { version: 1, install_shape: "claude-managed-role-guard", guard_command: report.receipt.hooks[0].command };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const settingsPath = join(context.claudeHome, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  settings.hooks.PreToolUse[0].hooks[0].command = "foreign-pre";
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  const before = await filesBefore(context);

  const result = await invoke(["install", "--global", "--target", "claude", "--contract", context.contractPath], { env: context.env });

  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /RECEIPT_UNVERIFIABLE/);
  await assertUnchanged(context, before);
});

for (const [name, mutate, code] of [
  ["corrupt report", async (context) => writeFile(join(context.claudeHome, ".orbitlane", "claude-report.json"), "{not json", "utf8"), "REPORT_UNREADABLE"],
  ["pointerless versioned report", async (context) => { const path = join(context.claudeHome, ".orbitlane", "claude-report.json"); const report = JSON.parse(await readFile(path, "utf8")); delete report.contract_snapshot; await writeFile(path, `${JSON.stringify(report)}\n`, "utf8"); }, "REPORT_POINTER_MISSING"],
  ["receiptless report with Agent hook", async (context) => { const path = join(context.claudeHome, ".orbitlane", "claude-report.json"); const report = JSON.parse(await readFile(path, "utf8")); delete report.receipt; delete report.settings_projection.guard_command; await writeFile(path, `${JSON.stringify(report)}\n`, "utf8"); }, "RECEIPT_UNVERIFIABLE"],
  ["receipt mismatch", async (context) => { const path = join(context.claudeHome, ".orbitlane", "claude-report.json"); const report = JSON.parse(await readFile(path, "utf8")); report.receipt.hooks[0].command = "other-command"; await writeFile(path, `${JSON.stringify(report)}\n`, "utf8"); }, "RECEIPT_UNVERIFIABLE"],
]) {
  test(`${name} aborts a roles-present to roles-absent transition before writes`, async (t) => {
    const context = await withBothContracts(t);
    await installPresent(context);
    await mutate(context);
    const before = await filesBefore(context);
    const result = await transitionAbsent(context);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout + result.stderr, new RegExp(code));
    await assertUnchanged(context, before);
  });
}

test("a legacy report transitions with its exact live command", async (t) => {
  const context = await withBothContracts(t);
  await installPresent(context);
  const path = join(context.claudeHome, ".orbitlane", "claude-report.json");
  const report = JSON.parse(await readFile(path, "utf8"));
  delete report.receipt;
  await writeFile(path, `${JSON.stringify(report)}\n`, "utf8");
  assert.equal((await transitionAbsent(context)).code, 0);
  assert.equal(JSON.parse(await readFile(join(context.claudeHome, "settings.json"), "utf8")).hooks?.PreToolUse, undefined);
});

test("a malformed PreToolUse value is unowned for transition, direct installer, and uninstall", async (t) => {
  const context = await withBothContracts(t);
  await installPresent(context);
  const report = await readFile(join(context.claudeHome, ".orbitlane", "claude-report.json"), "utf8");
  const command = JSON.parse(report).receipt.guard_command;
  const settingsPath = join(context.claudeHome, "settings.json");
  await writeFile(settingsPath, `${JSON.stringify({ hooks: { PreToolUse: {} } })}\n`, "utf8");
  const before = await filesBefore(context);
  const transition = await transitionAbsent(context);
  assert.notEqual(transition.code, 0);
  assert.match(transition.stdout + transition.stderr, /RECEIPT_UNVERIFIABLE/);
  await assertUnchanged(context, before);
  const direct = await installRouting(ROLES_LESS, { target: "claude", adapters: { claude: await transitionAdapter(context, Object.freeze({ kind: "remove-owned-hook", command, reportHash: sha256(report) })) } });
  assert.equal(direct.outcomes.claude.error.code, "RECEIPT_UNVERIFIABLE");
  await assertUnchanged(context, before);
  const uninstall = await invoke(["uninstall", "--global", "--target", "claude"], { env: context.env });
  assert.notEqual(uninstall.code, 0);
  assert.match(uninstall.stdout + uninstall.stderr, /RECEIPT_UNVERIFIABLE/);
  await assertUnchanged(context, before);
});

for (const [name, mutate] of [
  ["missing legacy command", async (context) => { const path = join(context.claudeHome, ".orbitlane", "claude-report.json"); const report = JSON.parse(await readFile(path, "utf8")); delete report.receipt; delete report.settings_projection.guard_command; await writeFile(path, `${JSON.stringify(report)}\n`, "utf8"); }],
  ["mismatched live command", async (context) => { const path = join(context.claudeHome, "settings.json"); const settings = JSON.parse(await readFile(path, "utf8")); settings.hooks.PreToolUse[0].hooks[0].command = "foreign"; await writeFile(path, `${JSON.stringify(settings)}\n`, "utf8"); }],
]) {
  test(`guard to guard rejects ${name} before writing or stacking hooks`, async (t) => {
    const context = await withBothContracts(t);
    await installPresent(context);
    await mutate(context);
    const before = await filesBefore(context);
    const result = await invoke(["install", "--global", "--target", "claude", "--contract", context.contractPath], { env: context.env });
    assert.notEqual(result.code, 0);
    assert.match(result.stdout + result.stderr, /RECEIPT_UNVERIFIABLE/);
    await assertUnchanged(context, before);
  });
}

test("schema-less versioned receipts fail in direct installation and receipt uninstall", async (t) => {
  const context = await withBothContracts(t);
  await installPresent(context);
  const reportPath = join(context.claudeHome, ".orbitlane", "claude-report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  delete report.schema_version;
  await writeFile(reportPath, `${JSON.stringify(report)}\n`, "utf8");
  const before = await filesBefore(context);
  const action = Object.freeze({ kind: "remove-owned-hook", command: report.receipt.guard_command, reportHash: sha256(await readFile(reportPath, "utf8")) });
  const direct = await installRouting(ROLES_LESS, { target: "claude", adapters: { claude: await transitionAdapter(context, action) } });
  assert.equal(direct.outcomes.claude.error.code, "RECEIPT_UNVERIFIABLE");
  await assertUnchanged(context, before);
  const uninstall = await invoke(["uninstall", "--global", "--target", "claude"], { env: context.env });
  assert.notEqual(uninstall.code, 0);
  assert.match(uninstall.stdout + uninstall.stderr, /RECEIPT_UNVERIFIABLE/);
  await assertUnchanged(context, before);
});

test("a Claude transition failure under both preserves a successful Codex install", async (t) => {
  const context = await withBothContracts(t);
  await installPresent(context, "both");
  await writeFile(join(context.claudeHome, ".orbitlane", "claude-report.json"), "{not json", "utf8");
  const result = await transitionAbsent(context, "both");
  assert.equal(result.code, 1);
  assert.match(await readFile(join(context.codexHome, "AGENTS.md"), "utf8"), /ORBITLANE:START codex/);
});

for (const [name, mutate, code] of [
  ["unsupported modern schema", async (context) => { const path = join(context.claudeHome, ".orbitlane", "claude-report.json"); const report = JSON.parse(await readFile(path, "utf8")); report.schema_version = 99; await writeFile(path, `${JSON.stringify(report)}\n`, "utf8"); }, "UNSUPPORTED_REPORT_SCHEMA"],
  ["malformed modern pointer", async (context) => { const path = join(context.claudeHome, ".orbitlane", "claude-report.json"); const report = JSON.parse(await readFile(path, "utf8")); report.contract_snapshot = {}; await writeFile(path, `${JSON.stringify(report)}\n`, "utf8"); }, "REPORT_POINTER_MALFORMED"],
  ["missing modern snapshot", async (context) => { const path = join(context.claudeHome, ".orbitlane", "claude-report.json"); const report = JSON.parse(await readFile(path, "utf8")); report.contract_snapshot.sha256 = "0".repeat(64); await writeFile(path, `${JSON.stringify(report)}\n`, "utf8"); }, "SNAPSHOT_UNREADABLE"],
  ["hash-mismatched modern snapshot", async (context) => { const path = join(context.claudeHome, ".orbitlane", "claude-report.json"); const report = JSON.parse(await readFile(path, "utf8")); await writeFile(join(context.claudeHome, ".orbitlane", "contracts", `${report.contract_snapshot.sha256}.json`), "tampered\n", "utf8"); }, "SNAPSHOT_HASH_MISMATCH"],
  ["malformed modern snapshot JSON", async (context) => { const bytes = "{not json\n"; const hash = sha256(bytes); const path = join(context.claudeHome, ".orbitlane", "claude-report.json"); const report = JSON.parse(await readFile(path, "utf8")); report.contract_snapshot.sha256 = hash; await mkdir(join(context.claudeHome, ".orbitlane", "contracts"), { recursive: true }); await writeFile(join(context.claudeHome, ".orbitlane", "contracts", `${hash}.json`), bytes, "utf8"); await writeFile(path, `${JSON.stringify(report)}\n`, "utf8"); }, "SNAPSHOT_UNREADABLE"],
]) {
  test(`guidance to guard rejects ${name} before preparation`, async (t) => {
    const context = await withBothContracts(t);
    assert.equal((await transitionAbsent(context)).code, 0);
    await mutate(context);
    const before = await guidanceFilesBefore(context);
    const result = await invoke(["install", "--global", "--target", "claude", "--contract", context.contractPath], { env: context.env });
    assert.notEqual(result.code, 0);
    assert.match(result.stdout + result.stderr, new RegExp(code));
    await assertGuidanceUnchanged(context, before);
  });
}

async function transitionAdapter(context, action, failurePoint) {
  const adapter = createClaudeTier1Adapter(ROLES_LESS, {
    instructionPath: join(context.claudeHome, "CLAUDE.md"),
    generatedPath: join(context.claudeHome, ".orbitlane", "claude-report.json"),
    settingsPath: join(context.claudeHome, "settings.json"),
    contractSha256: "b".repeat(64),
  });
  return Object.freeze({ ...adapter, transitionAction: action, ...(failurePoint === undefined ? {} : { failurePoint }) });
}

test("a stale transition action aborts before the transaction writes", async (t) => {
  const context = await withBothContracts(t);
  await installPresent(context);
  const reportPath = join(context.claudeHome, ".orbitlane", "claude-report.json");
  const report = await readFile(reportPath, "utf8");
  const command = JSON.parse(report).receipt.guard_command;
  const before = await filesBefore(context);
  const result = await installRouting(ROLES_LESS, { target: "claude", adapters: { claude: await transitionAdapter(context, Object.freeze({ kind: "remove-owned-hook", command, reportHash: "0".repeat(64) })) } });
  assert.equal(result.outcomes.claude.error.code, "RECEIPT_UNVERIFIABLE");
  await assertUnchanged(context, before);
});

test("an interrupted transition rolls back, recovery restores it, and retry succeeds", async (t) => {
  const context = await withBothContracts(t);
  await installPresent(context);
  const report = await readFile(join(context.claudeHome, ".orbitlane", "claude-report.json"), "utf8");
  const hooks = JSON.parse(report).receipt.hooks;
  const action = Object.freeze({ kind: "remove-owned-hook", hooks, reportHash: sha256(report) });
  const interrupted = await installRouting(ROLES_LESS, { target: "claude", adapters: { claude: await transitionAdapter(context, action, "leaveAfterInstructionCommit") } });
  assert.equal(interrupted.outcomes.claude.error.code, "INTERRUPTED_FOR_RECOVERY");
  assert.match(await readFile(join(context.claudeHome, "CLAUDE.md"), "utf8"), /execution -> claude-terra/);
  assert.equal((await recoverRouting({ manifest: interrupted.outcomes.claude.manifest })).status, "recovered");
  assert.match(await readFile(join(context.claudeHome, "CLAUDE.md"), "utf8"), /ORBITLANE:START claude/);
  const retried = await installRouting(ROLES_LESS, { target: "claude", adapters: { claude: await transitionAdapter(context, action) } });
  assert.equal(retried.outcomes.claude.status, "installed");
  assert.equal(JSON.parse(await readFile(join(context.claudeHome, "settings.json"), "utf8")).hooks?.PreToolUse, undefined);
});

async function atomicAssetAdapter(context, failurePoint) {
  const source = join(context.directory, "runtime-source");
  const runtime = join(context.claudeHome, ".orbitlane", "hook");
  const key = join(context.claudeHome, ".orbitlane", "secrets", "telemetry-hmac.key");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "runtime.js"), "export const runtime = 'new';\n", "utf8");
  const contract = JSON.parse(await readFile(context.contractPath, "utf8"));
  const adapter = createClaudeTier1Adapter(contract, {
    instructionPath: join(context.claudeHome, "CLAUDE.md"),
    generatedPath: join(context.claudeHome, ".orbitlane", "claude-report.json"),
    settingsPath: join(context.claudeHome, "settings.json"),
    contractSha256: "a".repeat(64),
    spawnGuardCommand: "managed-pre",
    usageObserverCommand: "managed-post",
    installedScope: "global",
    managedAssets: [
      { name: "runtime", kind: "directory", path: runtime, sourcePath: source },
      { name: "telemetry-hmac-key", kind: "file", path: key, mode: 0o600 },
    ],
  });
  return Object.freeze({ ...adapter, failurePoint });
}

for (const [name, prepare] of [
  ["fresh", async () => {}],
  ["preexisting", async (context) => {
    await mkdir(join(context.claudeHome, ".orbitlane", "hook"), { recursive: true });
    await writeFile(join(context.claudeHome, ".orbitlane", "hook", "runtime.js"), "old runtime\n", "utf8");
    await mkdir(join(context.claudeHome, ".orbitlane", "secrets"), { recursive: true });
    await writeFile(join(context.claudeHome, ".orbitlane", "secrets", "telemetry-hmac.key"), "old key", "utf8");
  }],
]) {
  test(`${name} managed runtime and HMAC key roll back with the Claude transaction`, async (t) => {
    const context = await withBothContracts(t);
    await prepare(context);
    const runtime = join(context.claudeHome, ".orbitlane", "hook", "runtime.js");
    const key = join(context.claudeHome, ".orbitlane", "secrets", "telemetry-hmac.key");
    const beforeRuntime = await readFile(runtime, "utf8").catch(() => undefined);
    const beforeKey = await readFile(key).catch(() => undefined);
    const result = await installRouting(JSON.parse(await readFile(context.contractPath, "utf8")), { target: "claude", adapters: { claude: await atomicAssetAdapter(context, "afterInstructionCommit") } });
    assert.equal(result.outcomes.claude.error.code, "INSTALL_INTERRUPTED");
    assert.deepEqual(await readFile(runtime, "utf8").catch(() => undefined), beforeRuntime);
    assert.deepEqual(await readFile(key).catch(() => undefined), beforeKey);
  });
}

test("hard-crash recovery restores preexisting managed runtime and HMAC key", async (t) => {
  const context = await withBothContracts(t);
  await mkdir(join(context.claudeHome, ".orbitlane", "hook"), { recursive: true });
  await writeFile(join(context.claudeHome, ".orbitlane", "hook", "runtime.js"), "old runtime\n", "utf8");
  await mkdir(join(context.claudeHome, ".orbitlane", "secrets"), { recursive: true });
  const key = join(context.claudeHome, ".orbitlane", "secrets", "telemetry-hmac.key");
  await writeFile(key, "old key", "utf8");
  const result = await installRouting(JSON.parse(await readFile(context.contractPath, "utf8")), { target: "claude", adapters: { claude: await atomicAssetAdapter(context, "leaveAfterInstructionCommit") } });
  assert.equal(result.outcomes.claude.error.code, "INTERRUPTED_FOR_RECOVERY");
  assert.equal(await readFile(join(context.claudeHome, ".orbitlane", "hook", "runtime.js"), "utf8"), "export const runtime = 'new';\n");
  assert.deepEqual(await readFile(key), Buffer.from("old key"), "reinstalls reuse the existing HMAC key before recovery");
  assert.equal((await recoverRouting({ manifest: result.outcomes.claude.manifest })).status, "recovered");
  assert.equal(await readFile(join(context.claudeHome, ".orbitlane", "hook", "runtime.js"), "utf8"), "old runtime\n");
  assert.deepEqual(await readFile(key), Buffer.from("old key"));
});
