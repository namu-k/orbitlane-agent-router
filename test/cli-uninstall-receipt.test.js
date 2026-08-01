import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { isolated } from "./cli-global.test.js";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/orbitlane.js", import.meta.url));
async function invoke(args, options = {}) { try { const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], { ...options, encoding: "utf8" }); return { code: 0, stdout, stderr }; } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; } }

const rolesLessContract = {
  contract_version: "1.0.0",
  lanes: { sol: { class: "judgment", reasoning: "high" }, terra: { class: "implementation", reasoning: "medium" }, luna: { class: "bounded-retrieval", reasoning: "low" } },
  targets: { claude: { lanes: { sol: { model: "claude-sol", provenance: "fixture" }, terra: { model: "claude-terra", provenance: "fixture" }, luna: { model: "claude-luna", provenance: "fixture" } } } },
};

async function rolesLessPath(directory) {
  const path = join(directory, "roles-less.json");
  await writeFile(path, `${JSON.stringify(rolesLessContract)}\n`, "utf8");
  return path;
}

async function tree(root) {
  const entries = [];
  async function visit(path, prefix = "") {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(child, `${name}/`);
      else entries.push(`${name}:${createHash("sha256").update(await readFile(child)).digest("hex")}`);
    }
  }
  await visit(root);
  return entries.sort();
}

async function managedState(claudeHome) {
  return {
    instruction: await readFile(join(claudeHome, "CLAUDE.md"), "utf8"),
    report: await readFile(join(claudeHome, ".orbitlane", "claude-report.json"), "utf8"),
    settings: await readFile(join(claudeHome, "settings.json"), "utf8"),
    snapshots: await tree(join(claudeHome, ".orbitlane", "contracts")),
    runtime: await tree(join(claudeHome, ".orbitlane", "hook")),
  };
}

test("uninstall with a roles-less contract removes the managed receipt's exact hook", async (t) => {
  const { contractPath, claudeHome, directory, env } = await isolated(t);
  const rolesLessPathname = await rolesLessPath(directory);
  await invoke(["install", "--global", "--target", "claude", "--contract", contractPath], { env });

  const result = await invoke(["uninstall", "--global", "--target", "claude", "--contract", rolesLessPathname], { env });

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(await readFile(join(claudeHome, "settings.json"), "utf8")), {});
  await assert.rejects(readFile(join(claudeHome, ".orbitlane", "claude-report.json"), "utf8"));
  await assert.rejects(readdir(join(claudeHome, ".orbitlane", "contracts")));
  await assert.rejects(readdir(join(claudeHome, ".orbitlane", "hook")));
});

for (const [name, mutate] of [
  ["a corrupt receipt", async (claudeHome) => writeFile(join(claudeHome, ".orbitlane", "claude-report.json"), "{not json", "utf8")],
  ["a mismatched receipt", async (claudeHome) => { const path = join(claudeHome, ".orbitlane", "claude-report.json"); const report = JSON.parse(await readFile(path, "utf8")); report.receipt.guard_command = "foreign"; await writeFile(path, `${JSON.stringify(report)}\n`, "utf8"); }],
]) {
  test(`${name} refuses explicit-contract uninstall without mutation`, async (t) => {
    const { contractPath, claudeHome, directory, env } = await isolated(t);
    const rolesLessPathname = await rolesLessPath(directory);
    await invoke(["install", "--global", "--target", "claude", "--contract", contractPath], { env });
    await mutate(claudeHome);
    const before = await managedState(claudeHome);

    const result = await invoke(["uninstall", "--global", "--target", "claude", "--contract", rolesLessPathname], { env });

    assert.notEqual(result.code, 0);
    assert.match(result.stdout + result.stderr, /RECEIPT_UNVERIFIABLE/);
    assert.deepEqual(await managedState(claudeHome), before);
  });
}

test("uninstall ignores a missing supplied contract when the installed receipt is valid", async (t) => {
  const { contractPath, claudeHome, directory, env } = await isolated(t);
  await invoke(["install", "--global", "--target", "claude", "--contract", contractPath], { env });

  const result = await invoke(["uninstall", "--global", "--target", "claude", "--contract", join(directory, "missing.json")], { env });

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(await readFile(join(claudeHome, "settings.json"), "utf8")), {});
});

test("uninstall works without --contract after the contract file is gone", async (t) => { const { contractPath, claudeHome, codexHome, env } = await isolated(t); await invoke(["install", "--global", "--target", "both", "--contract", contractPath], { env }); await rm(contractPath); const result = await invoke(["uninstall", "--global", "--target", "both"], { env }); assert.equal(result.code, 0); assert.doesNotMatch(await readFile(join(claudeHome, "CLAUDE.md"), "utf8"), /ORBITLANE:START claude/); assert.doesNotMatch(await readFile(join(codexHome, "AGENTS.md"), "utf8"), /ORBITLANE:START codex/); assert.deepEqual(JSON.parse(await readFile(join(claudeHome, "settings.json"), "utf8")), {}); });
test("a corrupt Claude receipt fails that target and leaves settings untouched", async (t) => { const { contractPath, claudeHome, env } = await isolated(t); await invoke(["install", "--global", "--target", "claude", "--contract", contractPath], { env }); const before = await readFile(join(claudeHome, "settings.json"), "utf8"); await writeFile(join(claudeHome, ".orbitlane", "claude-report.json"), "{not json", "utf8"); const result = await invoke(["uninstall", "--global", "--target", "claude"], { env }); assert.notEqual(result.code, 0); assert.match(result.stdout + result.stderr, /RECEIPT_UNVERIFIABLE/); assert.equal(await readFile(join(claudeHome, "settings.json"), "utf8"), before); });
test("a missing snapshot still permits uninstall when the receipt verifies", async (t) => { const { contractPath, claudeHome, env } = await isolated(t); await invoke(["install", "--global", "--target", "claude", "--contract", contractPath], { env }); await rm(join(claudeHome, ".orbitlane", "contracts"), { recursive: true, force: true }); const result = await invoke(["uninstall", "--global", "--target", "claude"], { env }); assert.equal(result.code, 0); assert.deepEqual(JSON.parse(await readFile(join(claudeHome, "settings.json"), "utf8")), {}); });
test("one target's broken receipt does not block the other target", async (t) => { const { contractPath, claudeHome, codexHome, env } = await isolated(t); await invoke(["install", "--global", "--target", "both", "--contract", contractPath], { env }); await writeFile(join(claudeHome, ".orbitlane", "claude-report.json"), "{not json", "utf8"); await invoke(["uninstall", "--global", "--target", "both"], { env }); assert.doesNotMatch(await readFile(join(codexHome, "AGENTS.md"), "utf8"), /ORBITLANE:START codex/); assert.match(await readFile(join(claudeHome, "CLAUDE.md"), "utf8"), /ORBITLANE:START claude/); });

test("a successful uninstall reclaims the snapshot store but keeps the heartbeat log", async (t) => {
  const { contractPath, claudeHome, directory, env } = await isolated(t);
  const runtimeDefaultsPath = join(directory, "runtime-defaults.json");
  await writeFile(runtimeDefaultsPath, `${JSON.stringify({ lanes: {} })}\n`);
  await invoke(["install", "--global", "--target", "claude", "--contract", contractPath, "--runtime-defaults", runtimeDefaultsPath], { env });
  assert.equal((await readdir(join(claudeHome, ".orbitlane", "contracts"))).length, 1);
  assert.equal((await readdir(join(claudeHome, ".orbitlane", "runtime-defaults"))).length, 1);
  const heartbeatPath = join(claudeHome, ".orbitlane", "claude-heartbeats.jsonl");
  const hmacKeyPath = join(claudeHome, ".orbitlane", "secrets", "telemetry-hmac.key");
  const hmacKey = await readFile(hmacKeyPath);
  await writeFile(heartbeatPath, "{}\n", "utf8");

  const result = await invoke(["uninstall", "--global", "--target", "claude"], { env });

  assert.equal(result.code, 0);
  await assert.rejects(readdir(join(claudeHome, ".orbitlane", "contracts")));
  await assert.rejects(readdir(join(claudeHome, ".orbitlane", "runtime-defaults")));
  await assert.rejects(readdir(join(claudeHome, ".orbitlane", "hook")));
  assert.equal(await readFile(heartbeatPath, "utf8"), "{}\n");
  assert.deepEqual(await readFile(hmacKeyPath), hmacKey);
});

test("Claude HMAC keys remain stable across reinstall and Codex-only installs do not create one", async (t) => {
  const { contractPath, claudeHome, env } = await isolated(t);
  assert.equal((await invoke(["install", "--global", "--target", "codex", "--contract", contractPath], { env })).code, 0);
  await assert.rejects(readFile(join(claudeHome, ".orbitlane", "secrets", "telemetry-hmac.key")));
  assert.equal((await invoke(["install", "--global", "--target", "claude", "--contract", contractPath], { env })).code, 0);
  const keyPath = join(claudeHome, ".orbitlane", "secrets", "telemetry-hmac.key");
  const before = await readFile(keyPath);
  assert.equal((await invoke(["install", "--global", "--target", "claude", "--contract", contractPath], { env })).code, 0);
  assert.deepEqual(await readFile(keyPath), before);
});

test("a project uninstall reclaims its own snapshot store too", async (t) => {
  const { contractPath, directory, env } = await isolated(t);
  const projectRoot = join(directory, "repo");

  await invoke(["install", "--target", "claude", "--config-root", projectRoot, "--contract", contractPath], { env });
  assert.equal((await readdir(join(projectRoot, ".orbitlane", "contracts"))).length, 1);

  const result = await invoke(["uninstall", "--target", "claude", "--config-root", projectRoot], { env });

  assert.equal(result.code, 0);
  await assert.rejects(readdir(join(projectRoot, ".orbitlane", "contracts")));
});

test("a refused uninstall leaves the snapshot store intact", async (t) => {
  const { contractPath, claudeHome, env } = await isolated(t);
  await invoke(["install", "--global", "--target", "claude", "--contract", contractPath], { env });
  const before = await readdir(join(claudeHome, ".orbitlane", "contracts"));
  await writeFile(join(claudeHome, ".orbitlane", "claude-report.json"), "{not json", "utf8");

  const result = await invoke(["uninstall", "--global", "--target", "claude"], { env });

  assert.notEqual(result.code, 0);
  assert.deepEqual(await readdir(join(claudeHome, ".orbitlane", "contracts")), before);
});

test("uninstalling only codex does not touch the Claude snapshot store", async (t) => {
  const { contractPath, claudeHome, env } = await isolated(t);
  await invoke(["install", "--global", "--target", "both", "--contract", contractPath], { env });
  const before = await readdir(join(claudeHome, ".orbitlane", "contracts"));

  assert.equal((await invoke(["uninstall", "--global", "--target", "codex"], { env })).code, 0);

  assert.deepEqual(await readdir(join(claudeHome, ".orbitlane", "contracts")), before);
});

test("a guard command recorded under a different matcher is not treated as owned", async (t) => {
  const { contractPath, claudeHome, env } = await isolated(t);
  await invoke(["install", "--global", "--target", "claude", "--contract", contractPath], { env });
  const settingsPath = join(claudeHome, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  // Ownership is proven where removal happens, and mergeSettings only strips the
  // Agent matcher. Anything else must fail rather than report a hollow success.
  settings.hooks.PreToolUse[0].matcher = "Bash";
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  const result = await invoke(["uninstall", "--global", "--target", "claude"], { env });

  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /RECEIPT_UNVERIFIABLE/);
  assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).hooks.PreToolUse[0].hooks.length, 1);
  assert.ok((await readdir(join(claudeHome, ".orbitlane", "hook"))).length > 0, "the runtime must survive a refused uninstall");
});

test("a legacy 0.2.0 receipt without a version still proves ownership", async (t) => {
  const { contractPath, claudeHome, env } = await isolated(t);
  await invoke(["install", "--global", "--target", "claude", "--contract", contractPath], { env });

  const reportPath = join(claudeHome, ".orbitlane", "claude-report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  delete report.receipt;
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const result = await invoke(["uninstall", "--global", "--target", "claude"], { env });

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(await readFile(join(claudeHome, "settings.json"), "utf8")), {});
});

test("a proper guidance-only receipt never reads or mutates settings", async (t) => {
  const { contractPath, claudeHome, env } = await isolated(t);
  await invoke(["install", "--global", "--target", "claude", "--contract", contractPath], { env });

  const reportPath = join(claudeHome, ".orbitlane", "claude-report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  report.receipt = { version: 1, install_shape: "guidance-only" };
  delete report.settings_projection.guard_command;
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const settingsPath = join(claudeHome, "settings.json");
  const before = "{not JSON and deliberately unreadable";
  await writeFile(settingsPath, before, "utf8");

  const result = await invoke(["uninstall", "--global", "--target", "claude"], { env });

  assert.equal(result.code, 0);
  assert.equal(await readFile(settingsPath, "utf8"), before);
});

test("a stale guidance-only command found in a live Agent hook refuses without mutation", async (t) => {
  const { contractPath, claudeHome, env } = await isolated(t);
  await invoke(["install", "--global", "--target", "claude", "--contract", contractPath], { env });

  const reportPath = join(claudeHome, ".orbitlane", "claude-report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  report.receipt = { version: 1, install_shape: "guidance-only" };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const command = report.settings_projection.guard_command;
  const settingsPath = join(claudeHome, "settings.json");
  const before = `{  "hooks" : { "PreToolUse" : [ { "matcher" : "Agent" , "hooks" : [ { "type" : "command" , "command" : ${JSON.stringify(command)} } ] } ] } }\n`;
  await writeFile(settingsPath, before, "utf8");
  const instructionPath = join(claudeHome, "CLAUDE.md");
  const instructionBefore = await readFile(instructionPath, "utf8");
  const reportBefore = await readFile(reportPath, "utf8");
  const runtimeBefore = await readdir(join(claudeHome, ".orbitlane", "hook"));
  const snapshotsBefore = await readdir(join(claudeHome, ".orbitlane", "contracts"));

  const result = await invoke(["uninstall", "--global", "--target", "claude"], { env });

  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /RECEIPT_UNVERIFIABLE/);
  assert.equal(await readFile(settingsPath, "utf8"), before);
  assert.equal(await readFile(instructionPath, "utf8"), instructionBefore);
  assert.equal(await readFile(reportPath, "utf8"), reportBefore);
  assert.deepEqual(await readdir(join(claudeHome, ".orbitlane", "hook")), runtimeBefore);
  assert.deepEqual(await readdir(join(claudeHome, ".orbitlane", "contracts")), snapshotsBefore);
});

test("a stale guidance-only command may uninstall when valid settings omit it", async (t) => {
  const { contractPath, claudeHome, env } = await isolated(t);
  await invoke(["install", "--global", "--target", "claude", "--contract", contractPath], { env });

  const reportPath = join(claudeHome, ".orbitlane", "claude-report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  report.receipt = { version: 1, install_shape: "guidance-only" };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const settingsPath = join(claudeHome, "settings.json");
  const before = "{ \"hooks\": { \"PreToolUse\": [ { \"matcher\": \"Agent\", \"hooks\": [ { \"type\": \"command\", \"command\": \"third-party\" } ] } ] } }\n";
  await writeFile(settingsPath, before, "utf8");

  const result = await invoke(["uninstall", "--global", "--target", "claude"], { env });

  assert.equal(result.code, 0);
  assert.equal(await readFile(settingsPath, "utf8"), before);
});

test("a stale guidance-only command may uninstall when settings are absent", async (t) => {
  const { contractPath, claudeHome, env } = await isolated(t);
  await invoke(["install", "--global", "--target", "claude", "--contract", contractPath], { env });

  const reportPath = join(claudeHome, ".orbitlane", "claude-report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  report.receipt = { version: 1, install_shape: "guidance-only" };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const settingsPath = join(claudeHome, "settings.json");
  await rm(settingsPath);

  const result = await invoke(["uninstall", "--global", "--target", "claude"], { env });

  assert.equal(result.code, 0);
  await assert.rejects(readFile(settingsPath, "utf8"));
});

test("a stale guidance-only command under a non-Agent matcher refuses without mutation", async (t) => {
  const { contractPath, claudeHome, env } = await isolated(t);
  await invoke(["install", "--global", "--target", "claude", "--contract", contractPath], { env });

  const reportPath = join(claudeHome, ".orbitlane", "claude-report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  report.receipt = { version: 1, install_shape: "guidance-only" };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const command = report.settings_projection.guard_command;
  const settingsPath = join(claudeHome, "settings.json");
  const before = `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] } }, null, 2)}\n`;
  await writeFile(settingsPath, before, "utf8");
  const reportBefore = await readFile(reportPath, "utf8");
  const runtimeBefore = await readdir(join(claudeHome, ".orbitlane", "hook"));
  const snapshotsBefore = await readdir(join(claudeHome, ".orbitlane", "contracts"));

  const result = await invoke(["uninstall", "--global", "--target", "claude"], { env });

  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /RECEIPT_UNVERIFIABLE/);
  assert.equal(await readFile(settingsPath, "utf8"), before);
  assert.match(await readFile(join(claudeHome, "CLAUDE.md"), "utf8"), /ORBITLANE:START claude/);
  assert.equal(await readFile(reportPath, "utf8"), reportBefore);
  assert.deepEqual(await readdir(join(claudeHome, ".orbitlane", "hook")), runtimeBefore);
  assert.deepEqual(await readdir(join(claudeHome, ".orbitlane", "contracts")), snapshotsBefore);
});

test("a stale guidance-only command with malformed settings refuses without mutation", async (t) => {
  const { contractPath, claudeHome, env } = await isolated(t);
  await invoke(["install", "--global", "--target", "claude", "--contract", contractPath], { env });

  const reportPath = join(claudeHome, ".orbitlane", "claude-report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  report.receipt = { version: 1, install_shape: "guidance-only" };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const settingsPath = join(claudeHome, "settings.json");
  const before = "{not JSON";
  await writeFile(settingsPath, before, "utf8");
  const reportBefore = await readFile(reportPath, "utf8");
  const runtimeBefore = await readdir(join(claudeHome, ".orbitlane", "hook"));
  const snapshotsBefore = await readdir(join(claudeHome, ".orbitlane", "contracts"));

  const result = await invoke(["uninstall", "--global", "--target", "claude"], { env });

  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /RECEIPT_UNVERIFIABLE/);
  assert.equal(await readFile(settingsPath, "utf8"), before);
  assert.match(await readFile(join(claudeHome, "CLAUDE.md"), "utf8"), /ORBITLANE:START claude/);
  assert.equal(await readFile(reportPath, "utf8"), reportBefore);
  assert.deepEqual(await readdir(join(claudeHome, ".orbitlane", "hook")), runtimeBefore);
  assert.deepEqual(await readdir(join(claudeHome, ".orbitlane", "contracts")), snapshotsBefore);
});

test("a report with neither a receipt nor a guard command refuses to touch an existing hook", async (t) => {
  const { contractPath, claudeHome, env } = await isolated(t);
  await invoke(["install", "--global", "--target", "claude", "--contract", contractPath], { env });

  const reportPath = join(claudeHome, ".orbitlane", "claude-report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  delete report.receipt;
  delete report.settings_projection.guard_command;
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const before = await readFile(join(claudeHome, "settings.json"), "utf8");

  const result = await invoke(["uninstall", "--global", "--target", "claude"], { env });

  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /RECEIPT_UNVERIFIABLE/);
  assert.equal(await readFile(join(claudeHome, "settings.json"), "utf8"), before);
});
