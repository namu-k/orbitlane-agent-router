import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
const cli = new URL("../bin/orbitlane.js", import.meta.url);
const invoke = (args, env = {}) => new Promise((resolve) => { const child = spawn(process.execPath, [cli.pathname, ...args], { env: { ...process.env, ...env } }); let stdout=""; let stderr=""; child.stdout.on("data", c => stdout += c); child.stderr.on("data", c => stderr += c); child.on("close", code => resolve({ code, stdout, stderr })); });
test("estimate requires runtime and output and rejects auto plus explicit session", async () => {
  const output = join(await mkdtemp(join(tmpdir(), "orbitlane-cli-")), "report.json");
  assert.match((await invoke(["estimate", "--output", output])).stderr, /RUNTIME_REQUIRED/);
  assert.match((await invoke(["estimate", "--runtime", "auto", "--session", "thread-1", "--output", output])).stderr, /AUTO_SESSION_MUST_BE_LATEST/);
});
test("Codex no-data is a successful Insufficient report", async () => {
  const output = join(await mkdtemp(join(tmpdir(), "orbitlane-cli-")), "report.json");
  const result = await invoke(["estimate", "--runtime", "codex", "--output", output], { CODEX_HOME: join(tmpdir(), "missing-codex-home") });
  assert.equal(result.code, 0); const report = JSON.parse(await readFile(output, "utf8"));
  assert.equal(report.runtimes.codex.confidence.grade, "Insufficient"); assert.equal(report.runtimes.codex.raw_estimated_model_cost_difference_nanos, null); assert.match(result.stdout, /데이터 부족/);
});
