import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { writeSnapshot } from "../../src/config/snapshots.js";

const execFileAsync = promisify(execFile);
const hook = fileURLToPath(new URL("../../src/guards/claude-spawn-hook.js", import.meta.url));

const contract = {
  contract_version: "1.0.0",
  lanes: {
    sol: { class: "judgment", reasoning: "high" },
    terra: { class: "implementation", reasoning: "medium" },
    luna: { class: "bounded-retrieval", reasoning: "low" },
  },
  roles: { executor: { lane: "terra", provenance: "user-approved" } },
  targets: { claude: { lanes: { terra: { model: "claude-terra", provenance: "user-local" } } } },
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "orbitlane-hook-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configDir = join(directory, ".claude");
  const written = await writeSnapshot(configDir, "contracts", `${JSON.stringify(contract)}\n`);
  await mkdir(join(configDir, ".orbitlane"), { recursive: true });
  await writeFile(
    join(configDir, ".orbitlane", "claude-report.json"),
    `${JSON.stringify({ schema_version: 2, contract_snapshot: { sha256: written.sha256 } })}\n`,
    "utf8",
  );
  return { directory, configDir, evidencePath: join(configDir, ".orbitlane", "claude-heartbeats.jsonl") };
}

async function invoke({ configDir, evidencePath, payload, cwd }) {
  const child = execFileAsync(process.execPath, [hook, configDir, evidencePath], { cwd, encoding: "utf8" });
  child.child.stdin.end(JSON.stringify(payload));
  try {
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test("a non-Agent tool call exits 0 without consulting any contract", async (t) => {
  const { directory, evidencePath } = await fixture(t);
  const result = await invoke({
    configDir: join(directory, "missing-config"),
    evidencePath,
    payload: { tool_name: "Read", tool_input: {} },
    cwd: directory,
  });
  assert.equal(result.code, 0);
});

test("a matching Agent spawn is allowed", async (t) => {
  const { directory, configDir, evidencePath } = await fixture(t);
  const result = await invoke({
    configDir,
    evidencePath,
    payload: { tool_name: "Agent", tool_input: { subagent_type: "executor", model: "claude-terra" } },
    cwd: directory,
  });
  assert.equal(result.code, 0);
});

test("a mismatched Agent spawn is denied", async (t) => {
  const { directory, configDir, evidencePath } = await fixture(t);
  const result = await invoke({
    configDir,
    evidencePath,
    payload: { tool_name: "Agent", tool_input: { subagent_type: "executor", model: "other-model" } },
    cwd: directory,
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /CONTRACT_MISMATCH/);
});

test("an unresolvable report denies and names the scope and report path", async (t) => {
  const { directory, evidencePath } = await fixture(t);
  const result = await invoke({
    configDir: join(directory, "missing-config"),
    evidencePath,
    payload: { tool_name: "Agent", tool_input: { subagent_type: "executor", model: "claude-terra" } },
    cwd: directory,
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /REPORT_UNREADABLE/);
  assert.match(result.stderr, /selected_scope=global/);
  assert.match(result.stderr, /orbitlane install --global/);
});
