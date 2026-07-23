import assert from "node:assert/strict";
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
  await writeFile(heartbeatPath, "{}\n", "utf8");

  const result = await invoke(["uninstall", "--global", "--target", "claude"], { env });

  assert.equal(result.code, 0);
  await assert.rejects(readdir(join(claudeHome, ".orbitlane", "contracts")));
  await assert.rejects(readdir(join(claudeHome, ".orbitlane", "runtime-defaults")));
  assert.equal(await readFile(heartbeatPath, "utf8"), "{}\n");
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
