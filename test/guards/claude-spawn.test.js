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

  assert.deepEqual(result, { exitCode: 0, decision: "allow", reason: "CONTRACT_MATCH", effective_model: "unproven" });
  assert.deepEqual(JSON.parse(await readFile(evidencePath, "utf8")), {
    correlation_id: "nested-1",
    decision: "allow",
    effective_model: "unproven",
    reason: "CONTRACT_MATCH",
    timestamp: "2026-07-22T00:00:00.000Z",
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

test("denies an Agent tool role or model mismatch with exit code 2", () => {
  assert.deepEqual(evaluateClaudeAgentSpawn({ input: { subagent_type: "executor", model: "wrong" }, contract }), {
    exitCode: 2,
    decision: "deny",
    reason: "CONTRACT_MISMATCH",
    effective_model: "unproven",
  });
  assert.deepEqual(evaluateClaudeAgentSpawn({ input: { subagent_type: "unknown", model: "claude-terra" }, contract }), {
    exitCode: 2,
    decision: "deny",
    reason: "UNCLASSIFIED_ROLE",
    effective_model: "unproven",
  });
});

test("marks operational heartbeat failures as fail-open but keeps invalid input denied", async () => {
  const result = await runClaudeSpawnGuard({ input: { subagent_type: "executor", model: "claude-terra" }, contract, appendHeartbeat: async () => { throw new Error("disk error"); } });
  assert.deepEqual(result, { exitCode: 0, decision: "fail-open", reason: "GUARD_ERROR", effective_model: "unproven" });
  assert.deepEqual(evaluateClaudeAgentSpawn({ input: null, contract }), { exitCode: 2, decision: "deny", reason: "INVALID_AGENT_TOOL_INPUT", effective_model: "unproven" });
});

test("withdraws scoped enforcement for heartbeat gaps without treating them as spawn evidence", () => {
  assert.deepEqual(auditClaudeSpawnGuard({ expectedCorrelationIds: ["observed", "missing"], heartbeats: [{ correlation_id: "observed", timestamp: "2026-07-22T00:00:00.000Z", decision: "allow", reason: "CONTRACT_MATCH" }] }), {
    claude_agent_pre_dispatch: { status: "unproven", scope: "coverage-withdrawn-heartbeat-gap" },
    effective_model: "unproven",
    missing_heartbeats: ["missing"],
  });
});
