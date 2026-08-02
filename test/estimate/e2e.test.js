import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixtures = join(root, "fixtures", "estimate");
const cli = join(root, "bin", "orbitlane.js");

function invokeEstimate(args, { cwd, env }) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [cli, "estimate", ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}

async function fixtureEnvironment(t) {
  const project = await mkdtemp(join(tmpdir(), "orbitlane-estimate-e2e-"));
  const claudeEvidence = join(project, ".orbitlane", "evidence", "project");
  const codexHome = join(project, "codex-home");
  const sessions = join(codexHome, "sessions");
  await mkdir(claudeEvidence, { recursive: true });
  await mkdir(sessions, { recursive: true });
  await cp(join(fixtures, "claude", "detailed-exact", "routing-decisions.v1.jsonl"), join(claudeEvidence, "routing-decisions.v1.jsonl"));
  await cp(join(fixtures, "claude", "detailed-exact", "execution-usage.v1.jsonl"), join(claudeEvidence, "execution-usage.v1.jsonl"));
  await cp(join(fixtures, "codex", "linked", "child-terra.jsonl"), join(sessions, "child-terra.jsonl"));
  await cp(join(fixtures, "codex", "linked", "child-luna.jsonl"), join(sessions, "child-luna.jsonl"));
  const rootFixture = await readFile(join(fixtures, "codex", "linked", "root.jsonl"), "utf8");
  await writeFile(join(sessions, "root.jsonl"), rootFixture.replace("__PROJECT_CWD__", resolve(project)));
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(project, { recursive: true, force: true })); });
  return { project, env: { CODEX_HOME: codexHome } };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  test("one offline auto report contains Claude and Codex estimates", async (t) => {
    const { project, env } = await fixtureEnvironment(t);
    const output = join(project, "report.json");
    const result = await invokeEstimate(["--runtime", "auto", "--session", "latest", "--baseline-model", "sol", "--output", output], { cwd: project, env });
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.runtimes.claude.runtime, "claude");
    assert.equal(report.runtimes.codex.runtime, "codex");
    assert.equal(report.runtimes.codex.confidence.runtime_cap, 65);
    assert.match(report.disclaimer, /not a billing statement or proven net savings/);
  });
}

export { fixtureEnvironment, invokeEstimate };
