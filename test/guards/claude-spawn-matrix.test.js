import assert from "node:assert/strict";
import test from "node:test";

import { runClaudeSpawnGuard } from "../../src/guards/claude-spawn.js";

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

const provenance = {
  scope: "project",
  contractSha256: "c".repeat(64),
  reportPath: "/repo/.orbitlane/claude-report.json",
  resolverPolicyVersion: 1,
};

test("a deny survives a heartbeat write failure", async () => {
  // Only an unroutable call still denies; a model that diverges from the contract is
  // an explicit choice and is allowed.
  const result = await runClaudeSpawnGuard({
    input: { model: "wrong-model" },
    contract,
    ...provenance,
    appendHeartbeat: () => { throw new Error("disk full"); },
    now: () => "2026-07-23T00:00:00.000Z",
  });

  assert.equal(result.decision, "deny");
  assert.equal(result.exitCode, 2);
  assert.equal(result.reason, "INVALID_AGENT_TOOL_INPUT");
  assert.equal(result.heartbeat_recorded, false);
});

test("an allow survives a heartbeat write failure without becoming a deny", async () => {
  const result = await runClaudeSpawnGuard({
    input: { subagent_type: "executor", model: "claude-terra" },
    contract,
    ...provenance,
    appendHeartbeat: () => { throw new Error("disk full"); },
    now: () => "2026-07-23T00:00:00.000Z",
  });

  assert.equal(result.decision, "allow");
  assert.equal(result.exitCode, 0);
  assert.equal(result.heartbeat_recorded, false);
});

test("an invalid contract denies instead of failing open", async () => {
  const result = await runClaudeSpawnGuard({
    input: { subagent_type: "executor", model: "claude-terra" },
    contract: { contract_version: "1.0.0" },
    ...provenance,
    appendHeartbeat: () => {},
    now: () => "2026-07-23T00:00:00.000Z",
  });

  assert.equal(result.decision, "deny");
  assert.equal(result.exitCode, 2);
});

test("the heartbeat records which contract decided", async () => {
  const entries = [];
  await runClaudeSpawnGuard({
    input: { subagent_type: "executor", model: "claude-terra" },
    contract,
    ...provenance,
    appendHeartbeat: (entry) => { entries.push(entry); },
    now: () => "2026-07-23T00:00:00.000Z",
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].selected_scope, "project");
  assert.equal(entries[0].contract_sha256, "c".repeat(64));
  assert.equal(entries[0].report_path, "/repo/.orbitlane/claude-report.json");
  assert.equal(entries[0].resolver_policy_version, 1);
});
