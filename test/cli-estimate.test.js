import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
const cli = fileURLToPath(new URL("../bin/orbitlane.js", import.meta.url));
const invoke = (args, options = {}) => new Promise((resolveResult) => { const child = spawn(process.execPath, [cli, ...args], { cwd: options.cwd, env: { ...process.env, ...(options.env ?? options) } }); let stdout=""; let stderr=""; child.stdout.on("data", c => stdout += c); child.stderr.on("data", c => stderr += c); child.on("close", code => resolveResult({ code, stdout, stderr })); });
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

test("auto writes a sanitized partial report when one runtime evidence source fails", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "orbitlane-cli-auto-"));
  const evidence = join(project, ".orbitlane", "evidence", "project");
  const badCodexHome = join(project, "not-a-directory");
  await mkdir(evidence, { recursive: true });
  await cp(resolve("fixtures/estimate/claude/detailed-exact/routing-decisions.v1.jsonl"), join(evidence, "routing-decisions.v1.jsonl"));
  await cp(resolve("fixtures/estimate/claude/detailed-exact/execution-usage.v1.jsonl"), join(evidence, "execution-usage.v1.jsonl"));
  await writeFile(badCodexHome, "not a sessions directory");
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(project, { recursive: true, force: true })); });
  const output = join(project, "report.json");
  const result = await invoke(["estimate", "--runtime", "auto", "--baseline-model", "sol", "--output", output], { cwd: project, env: { CODEX_HOME: badCodexHome } });
  assert.equal(result.code, 1, result.stderr);
  const report = JSON.parse(await readFile(output, "utf8"));
  assert.equal(report.runtimes.claude.runtime, "claude");
  assert.equal(report.runtimes.codex.status, "insufficient");
  assert.deepEqual(report.runtimes.codex.warnings, ["RUNTIME_EVIDENCE_UNAVAILABLE"]);
  assert.doesNotMatch(JSON.stringify(report), /not-a-directory/);
});

test("an explicit baseline unknown to every selected runtime is a fatal input error", async () => {
  const output = join(await mkdtemp(join(tmpdir(), "orbitlane-cli-")), "report.json");
  const result = await invoke(["estimate", "--runtime", "codex", "--baseline-model", "not-a-model", "--output", output], { CODEX_HOME: join(tmpdir(), "missing-codex-home") });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /BASELINE_MODEL_UNKNOWN/);
});
