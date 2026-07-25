import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditClaudeSpawnGuard, evaluateClaudeAgentSpawn, runClaudeSpawnGuard } from "../../src/guards/claude-spawn.js";

const contract = Object.freeze({
  contract_version: "1.0.0",
  lanes: {
    sol: { class: "judgment", reasoning: "high" },
    terra: { class: "implementation", reasoning: "medium" },
    luna: { class: "bounded-retrieval", reasoning: "low" },
  },
  roles: { executor: { lane: "terra", provenance: "user-approved" } },
  targets: { claude: { lanes: { terra: { model: "claude-terra", provenance: "user-local" } } } },
});

function contractFor(model) {
  return {
    ...contract,
    targets: { claude: { lanes: { terra: { model, provenance: "user-local" } } } },
  };
}

test("enforces exact model tokens and preserves the unproven effective-model boundary", () => {
  const alias = "sonnet";
  const fullId = "claude-sonnet-4-5-20250929";
  const cases = [
    ["alias contract rejects full identifier", contractFor(alias), { subagent_type: "executor", model: fullId }, 2, "CONTRACT_MISMATCH"],
    ["full identifier contract rejects alias", contractFor(fullId), { subagent_type: "executor", model: alias }, 2, "CONTRACT_MISMATCH"],
    ["exact alias allows", contractFor(alias), { subagent_type: "executor", model: alias }, 0, "CONTRACT_MATCH"],
    ["exact full identifier allows", contractFor(fullId), { subagent_type: "executor", model: fullId }, 0, "CONTRACT_MATCH"],
    ["exact call override allows", contractFor(alias), { subagent_type: "executor", model: alias, model_override: alias }, 0, "CONTRACT_MATCH"],
    ["mismatched call override denies", contractFor(alias), { subagent_type: "executor", model: alias, model_override: fullId }, 2, "DETECTABLE_MODEL_OVERRIDE"],
    ["exact environment model allows", contractFor(alias), { subagent_type: "executor", model: alias, environment_model: alias }, 0, "CONTRACT_MATCH"],
    ["inherit environment model allows", contractFor(alias), { subagent_type: "executor", model: alias, environment_model: "inherit" }, 0, "CONTRACT_MATCH"],
    ["mismatched environment model denies", contractFor(alias), { subagent_type: "executor", model: alias, environment_model: fullId }, 2, "DETECTABLE_MODEL_OVERRIDE"],
    ["routed role without an explicit model denies despite metadata", contractFor(alias), { subagent_type: "executor", frontmatter: { model: alias }, environment_model: "inherit", model_override: alias }, 2, "INVALID_AGENT_TOOL_INPUT"],
    ["unmanaged role remains allowed without an explicit model", contractFor(alias), { subagent_type: "general-purpose", frontmatter: { model: alias }, environment_model: "inherit" }, 0, "UNMANAGED_ROLE"],
  ];

  for (const [name, caseContract, input, exitCode, reason] of cases) {
    const result = evaluateClaudeAgentSpawn({ input, contract: caseContract });
    assert.deepEqual(result, { exitCode, decision: exitCode === 0 ? "allow" : "deny", reason, effective_model: "unproven" }, name);
  }
});

test("allows a matching Claude Agent tool spawn and records an unproven heartbeat", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "orbitlane-guard-"));
  const evidencePath = join(directory, "heartbeats.jsonl");
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })); });

  const result = await runClaudeSpawnGuard({
    input: { subagent_type: "executor", model: "claude-terra" },
    contract,
    evidencePath,
    correlationId: "nested-1",
    now: () => "2026-07-22T00:00:00.000Z",
  });

  assert.deepEqual(result, { exitCode: 0, decision: "allow", reason: "CONTRACT_MATCH", effective_model: "unproven", heartbeat_recorded: true });
  assert.deepEqual(JSON.parse(await readFile(evidencePath, "utf8")), {
    correlation_id: "nested-1",
    decision: "allow",
    effective_model: "unproven",
    reason: "CONTRACT_MATCH",
    timestamp: "2026-07-22T00:00:00.000Z",
    selected_scope: null,
    contract_sha256: null,
    report_path: null,
    resolver_policy_version: null,
  });
});

test("denies a detectable model override even when the declared model matches", () => {
  assert.deepEqual(evaluateClaudeAgentSpawn({ input: { subagent_type: "executor", model: "claude-terra", model_override: "other" }, contract }), {
    exitCode: 2,
    decision: "deny",
    reason: "DETECTABLE_MODEL_OVERRIDE",
    effective_model: "unproven",
  });
});

test("denies a contract-routed role spawned with the wrong model", () => {
  assert.deepEqual(evaluateClaudeAgentSpawn({ input: { subagent_type: "executor", model: "wrong" }, contract }), {
    exitCode: 2,
    decision: "deny",
    reason: "CONTRACT_MISMATCH",
    effective_model: "unproven",
  });
});

test("passes through a subagent type the contract does not route", () => {
  // The contract routes only `executor`; the built-in Claude Code agent types
  // (general-purpose, Explore, Plan, ...) are unmanaged and must not be blocked.
  assert.deepEqual(evaluateClaudeAgentSpawn({ input: { subagent_type: "general-purpose", model: "sonnet" }, contract }), {
    exitCode: 0,
    decision: "allow",
    reason: "UNMANAGED_ROLE",
    effective_model: "unproven",
  });
});

test("passes through an unmanaged role even with no model, but a routed role must declare one", () => {
  // An unmanaged role is out of scope, so a missing model is not the guard's concern.
  assert.deepEqual(evaluateClaudeAgentSpawn({ input: { subagent_type: "Explore" }, contract }), {
    exitCode: 0,
    decision: "allow",
    reason: "UNMANAGED_ROLE",
    effective_model: "unproven",
  });
  // A routed role with no model cannot be checked, so it is denied.
  assert.deepEqual(evaluateClaudeAgentSpawn({ input: { subagent_type: "executor" }, contract }), {
    exitCode: 2,
    decision: "deny",
    reason: "INVALID_AGENT_TOOL_INPUT",
    effective_model: "unproven",
  });
});

test("still denies a detectable override on an unmanaged role's routed collision is not possible", () => {
  // A non-string subagent type cannot be looked up at all.
  assert.deepEqual(evaluateClaudeAgentSpawn({ input: { subagent_type: 42, model: "sonnet" }, contract }), {
    exitCode: 2,
    decision: "deny",
    reason: "INVALID_AGENT_TOOL_INPUT",
    effective_model: "unproven",
  });
});

test("keeps the decision when heartbeat recording fails and keeps invalid input denied", async () => {
  const allowed = await runClaudeSpawnGuard({ input: { subagent_type: "executor", model: "claude-terra" }, contract, appendHeartbeat: async () => { throw new Error("disk error"); } });
  assert.deepEqual(allowed, { exitCode: 0, decision: "allow", reason: "CONTRACT_MATCH", effective_model: "unproven", heartbeat_recorded: false });

  const denied = await runClaudeSpawnGuard({ input: { subagent_type: "executor", model: "wrong" }, contract, appendHeartbeat: async () => { throw new Error("disk error"); } });
  assert.deepEqual(denied, { exitCode: 2, decision: "deny", reason: "CONTRACT_MISMATCH", effective_model: "unproven", heartbeat_recorded: false });

  assert.deepEqual(evaluateClaudeAgentSpawn({ input: null, contract }), { exitCode: 2, decision: "deny", reason: "INVALID_AGENT_TOOL_INPUT", effective_model: "unproven" });
});

test("withdraws scoped enforcement for heartbeat gaps without treating them as spawn evidence", () => {
  assert.deepEqual(auditClaudeSpawnGuard({ expectedCorrelationIds: ["observed", "missing"], heartbeats: [{ correlation_id: "observed", timestamp: "2026-07-22T00:00:00.000Z", decision: "allow", reason: "CONTRACT_MATCH" }] }), {
    claude_agent_pre_dispatch: { status: "unproven", scope: "coverage-withdrawn-heartbeat-gap" },
    effective_model: "unproven",
    missing_heartbeats: ["missing"],
  });
});
