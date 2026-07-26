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

async function invoke({ configDir, evidencePath, payload, cwd, installedScope, env }) {
  const args = installedScope === undefined ? [hook, configDir, evidencePath] : [hook, configDir, evidencePath, installedScope];
  // env is per-invocation so a subagent-model override cannot leak into other cases.
  const child = execFileAsync(process.execPath, args, { cwd, encoding: "utf8", ...(env === undefined ? {} : { env }) });
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

test("an unmanaged Agent spawn passes through and is logged", async (t) => {
  const { directory, configDir, evidencePath } = await fixture(t);
  const result = await invoke({
    configDir,
    evidencePath,
    payload: { tool_name: "Agent", tool_use_id: "unmanaged-1", tool_input: { subagent_type: "general-purpose", model: "sonnet" } },
    cwd: directory,
  });
  assert.equal(result.code, 0);
  const { readFile } = await import("node:fs/promises");
  assert.match(await readFile(evidencePath, "utf8"), /"reason":"UNMANAGED_ROLE"/);
});

test("a diverging Agent spawn is allowed and recorded rather than denied", async (t) => {
  const { directory, configDir, evidencePath } = await fixture(t);
  const result = await invoke({
    configDir,
    evidencePath,
    payload: { tool_name: "Agent", tool_use_id: "diverging-1", tool_input: { subagent_type: "executor", model: "other-model" } },
    cwd: directory,
  });
  assert.equal(result.code, 0);
  const { readFile } = await import("node:fs/promises");
  assert.match(await readFile(evidencePath, "utf8"), /"reason":"EXPLICIT_MODEL_RETAINED"/);
});

test("a CLAUDE_CODE_SUBAGENT_MODEL override is what the heartbeat names, not the call", async (t) => {
  const { directory, configDir, evidencePath } = await fixture(t);
  const result = await invoke({
    configDir,
    evidencePath,
    // The call agrees with the contract; the environment does not. The runtime resolves
    // the environment first, so that is the model the evidence has to name.
    payload: { tool_name: "Agent", tool_use_id: "env-1", tool_input: { subagent_type: "executor", model: "claude-terra" } },
    cwd: directory,
    env: { ...process.env, CLAUDE_CODE_SUBAGENT_MODEL: "opus" },
  });

  assert.equal(result.code, 0);
  const { readFile } = await import("node:fs/promises");
  const heartbeat = JSON.parse((await readFile(evidencePath, "utf8")).trim().split("\n").at(-1));
  assert.equal(heartbeat.reason, "EXPLICIT_MODEL_RETAINED");
  assert.equal(heartbeat.routed_model, "claude-terra");
  assert.equal(heartbeat.injected_model, null);
});

test("an unspecified model is rewritten to the routed model on stdout", async (t) => {
  const { directory, configDir, evidencePath } = await fixture(t);
  const injectable = { ...contract, targets: { claude: { lanes: { terra: { model: "haiku", provenance: "user-local" } } } } };
  const written = await writeSnapshot(configDir, "contracts", `${JSON.stringify(injectable)}\n`);
  await writeFile(
    join(configDir, ".orbitlane", "claude-report.json"),
    `${JSON.stringify({ schema_version: 2, contract_snapshot: { sha256: written.sha256 } })}\n`,
    "utf8",
  );

  const result = await invoke({
    configDir,
    evidencePath,
    payload: { tool_name: "Agent", tool_use_id: "inject-1", tool_input: { subagent_type: "executor", prompt: "do the thing" } },
    cwd: directory,
  });

  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "ORBITLANE ROUTED_MODEL_INJECTED: executor -> haiku",
      // The rest of the caller's input survives; only the model is filled in.
      updatedInput: { subagent_type: "executor", prompt: "do the thing", model: "haiku" },
    },
  });
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

test("a project-installed hook whose report is gone points at the project, not the global layer", async (t) => {
  const { directory, evidencePath } = await fixture(t);
  const projectRoot = join(directory, "repo");
  await mkdir(projectRoot, { recursive: true });

  const result = await invoke({
    configDir: projectRoot,
    evidencePath,
    payload: { tool_name: "Agent", tool_input: { subagent_type: "executor", model: "claude-terra" } },
    cwd: projectRoot,
    installedScope: "project",
  });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /REPORT_UNREADABLE/);
  assert.match(result.stderr, /installed_scope=project/);
  assert.doesNotMatch(result.stderr, /remedy=reinstall the global layer/);
  assert.match(result.stderr, /orbitlane install --target claude/);
});

test("a globally installed hook whose report is gone points at the global layer", async (t) => {
  const { directory, evidencePath } = await fixture(t);

  const result = await invoke({
    configDir: join(directory, "missing-config"),
    evidencePath,
    payload: { tool_name: "Agent", tool_input: { subagent_type: "executor", model: "claude-terra" } },
    cwd: directory,
    installedScope: "global",
  });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /installed_scope=global/);
  assert.match(result.stderr, /orbitlane install --global/);
});

test("a deny names both scopes so the operator knows which contract decided", async (t) => {
  const { directory, configDir, evidencePath } = await fixture(t);

  // A call with no role name is the remaining deny: it can be neither routed nor
  // classified. Model divergence is no longer a deny, so it cannot carry this case.
  const result = await invoke({
    configDir,
    evidencePath,
    payload: { tool_name: "Agent", tool_input: { model: "other-model" } },
    cwd: directory,
    installedScope: "global",
  });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /INVALID_AGENT_TOOL_INPUT/);
  assert.match(result.stderr, /selected_scope=/);
  assert.match(result.stderr, /installed_scope=global/);
});
