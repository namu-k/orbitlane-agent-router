import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { isolated } from "./cli-global.test.js";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/orbitlane.js", import.meta.url));
async function invoke(args, options = {}) { try { const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], { ...options, encoding: "utf8" }); return { code: 0, stdout, stderr }; } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; } }

test("install stores a contract snapshot and points the report at it", async (t) => {
  const { contractPath, claudeHome, env } = await isolated(t);
  assert.equal((await invoke(["install", "--global", "--target", "claude", "--contract", contractPath], { env })).code, 0);
  const report = JSON.parse(await readFile(join(claudeHome, ".orbitlane", "claude-report.json"), "utf8"));
  assert.equal(report.schema_version, 2);
  assert.match(report.contract_snapshot.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(await readdir(join(claudeHome, ".orbitlane", "contracts")), [`${report.contract_snapshot.sha256}.json`]);
});
test("the installed guard command carries the config dir, not a contract path", async (t) => { const { contractPath, claudeHome, env } = await isolated(t); await invoke(["install", "--global", "--target", "claude", "--contract", contractPath], { env }); const command = JSON.parse(await readFile(join(claudeHome, "settings.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command; assert.match(command, /claude-spawn-hook\.js/); assert.doesNotMatch(command, /contract\.json/); });
test("dry-run creates no snapshot directory", async (t) => { const { contractPath, claudeHome, env } = await isolated(t); assert.equal((await invoke(["install", "--global", "--target", "claude", "--dry-run", "--contract", contractPath], { env })).code, 0); await assert.rejects(readdir(join(claudeHome, ".orbitlane", "contracts"))); });
