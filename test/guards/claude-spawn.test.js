import assert from "node:assert/strict";
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

test("yields to an explicit model instead of denying, and never blocks on token shape", () => {
  const alias = "sonnet";
  const fullId = "claude-sonnet-4-5-20250929";
  // A denied spawn spends a failed turn plus a retry, so nothing here blocks: an
  // explicit model is honoured and the divergence from the contract is recorded.
  const cases = [
    ["alias contract retains an explicit full identifier", contractFor(alias), { subagent_type: "executor", model: fullId }, "EXPLICIT_MODEL_RETAINED", { declared_model: fullId, routed_model: alias }],
    ["full identifier contract retains an explicit alias", contractFor(fullId), { subagent_type: "executor", model: alias }, "EXPLICIT_MODEL_RETAINED", { declared_model: alias, routed_model: fullId }],
    ["exact alias matches", contractFor(alias), { subagent_type: "executor", model: alias }, "CONTRACT_MATCH", {}],
    ["exact full identifier matches", contractFor(fullId), { subagent_type: "executor", model: fullId }, "CONTRACT_MATCH", {}],
    ["inherit environment model does not count as explicit", contractFor(alias), { subagent_type: "executor", model: alias, environment_model: "inherit" }, "CONTRACT_MATCH", {}],
    ["a diverging environment model is retained, not denied", contractFor(alias), { subagent_type: "executor", environment_model: fullId }, "EXPLICIT_MODEL_RETAINED", { declared_model: fullId, routed_model: alias }],
    ["unmanaged role remains allowed without an explicit model", contractFor(alias), { subagent_type: "general-purpose", environment_model: "inherit" }, "UNMANAGED_ROLE", {}],
  ];

  for (const [name, caseContract, input, reason, extra] of cases) {
    const result = evaluateClaudeAgentSpawn({ input, contract: caseContract });
    assert.deepEqual(result, { exitCode: 0, decision: "allow", reason, effective_model: "unproven", ...extra }, name);
  }
});

test("reads CLAUDE_CODE_SUBAGENT_MODEL above the call, matching the runtime's own order", () => {
  // The runtime resolves the environment variable BEFORE the per-invocation model, so
  // recording the call's model here would name a model the session never ran.
  // https://code.claude.com/docs/en/sub-agents#choose-a-model
  const routed = contractFor("sonnet");

  // Call agrees with the contract, environment overrides it: the environment wins.
  assert.deepEqual(evaluateClaudeAgentSpawn({ input: { subagent_type: "executor", model: "sonnet", environment_model: "opus" }, contract: routed }), {
    exitCode: 0,
    decision: "allow",
    reason: "EXPLICIT_MODEL_RETAINED",
    effective_model: "unproven",
    declared_model: "opus",
    routed_model: "sonnet",
  });

  // Call diverges but the environment agrees with the contract: this is a match, and
  // reporting a divergence would be the same error in the other direction.
  assert.deepEqual(evaluateClaudeAgentSpawn({ input: { subagent_type: "executor", model: "haiku", environment_model: "sonnet" }, contract: routed }), {
    exitCode: 0,
    decision: "allow",
    reason: "CONTRACT_MATCH",
    effective_model: "unproven",
  });

  // `inherit` is not a choice: since v2.1.196 it means "keep resolving", so the call wins.
  assert.deepEqual(evaluateClaudeAgentSpawn({ input: { subagent_type: "executor", model: "haiku", environment_model: "inherit" }, contract: routed }), {
    exitCode: 0,
    decision: "allow",
    reason: "EXPLICIT_MODEL_RETAINED",
    effective_model: "unproven",
    declared_model: "haiku",
    routed_model: "sonnet",
  });
});

test("withholds routing when CLAUDE_CODE_SUBAGENT_MODEL is inherit", () => {
  // From v2.1.196 `inherit` is the same as unset, but before that it forced the main
  // conversation's model and ignored the per-invocation parameter. The guard sees no
  // version, so injecting could be dropped while the heartbeat claimed a route.
  assert.deepEqual(evaluateClaudeAgentSpawn({ input: { subagent_type: "executor", environment_model: "inherit" }, contract: contractFor("haiku") }), {
    exitCode: 0,
    decision: "allow",
    reason: "ROUTED_MODEL_WITHHELD_INHERIT",
    effective_model: "unproven",
    routed_model: "haiku",
  });

  // An unset variable is not `inherit`: resolution reaches the call on every version,
  // so this is the ordinary routing case and must keep injecting.
  assert.equal(evaluateClaudeAgentSpawn({ input: { subagent_type: "executor" }, contract: contractFor("haiku") }).reason, "ROUTED_MODEL_INJECTED");
});

test("does not inject fable even when a lane binds it", () => {
  // Accepted by the runtime, but it needs Claude Code v2.1.170+ (which the guard cannot
  // see) and it is never the cheaper choice. The lane stays guidance-only.
  assert.deepEqual(evaluateClaudeAgentSpawn({ input: { subagent_type: "executor" }, contract: contractFor("fable") }), {
    exitCode: 0,
    decision: "allow",
    reason: "ROUTED_MODEL_NOT_INJECTABLE",
    effective_model: "unproven",
    routed_model: "fable",
  });
});

test("routes an unspecified model to the lane model so the spawn gets the cheaper tier", () => {
  // The whole point of the contract: the caller expressed no preference, so the
  // routed model is written into the call rather than the runtime default running.
  assert.deepEqual(evaluateClaudeAgentSpawn({ input: { subagent_type: "executor" }, contract: contractFor("haiku") }), {
    exitCode: 0,
    decision: "allow",
    reason: "ROUTED_MODEL_INJECTED",
    effective_model: "unproven",
    routed_model: "haiku",
    injected_model: "haiku",
  });
});

test("declines to inject a model the Agent tool would reject rather than breaking the spawn", () => {
  // `claude-terra` is not an accepted Agent tool model. Writing it in would turn a
  // working spawn into a failed one, which costs more than leaving it unrouted.
  assert.deepEqual(evaluateClaudeAgentSpawn({ input: { subagent_type: "executor" }, contract: contractFor("claude-terra") }), {
    exitCode: 0,
    decision: "allow",
    reason: "ROUTED_MODEL_NOT_INJECTABLE",
    effective_model: "unproven",
    routed_model: "claude-terra",
  });
});

test("allows a matching Claude Agent spawn when telemetry identifiers are unavailable", async () => {
  const result = await runClaudeSpawnGuard({
    input: { subagent_type: "executor", model: "claude-terra" },
    contract,
    now: () => "2026-07-22T00:00:00.000Z",
  });

  assert.deepEqual(result, { exitCode: 0, decision: "allow", reason: "CONTRACT_MATCH", effective_model: "unproven", telemetry_recorded: false });
});

test("Pre guard appends a routing decision without a legacy heartbeat", async () => {
  const entries = [];
  const result = await runClaudeSpawnGuard({
    input: { subagent_type: "executor" },
    contract: contractFor("haiku"),
    scope: "project",
    contractSha256: "c".repeat(64),
    resolverPolicyVersion: 1,
    telemetryRoot: "/unused",
    collectorInstanceRef: "collector-1",
    telemetryKey: "test-key",
    identifiers: { session: "session-1", turn: "turn-1", invocation: "invoke-1" },
    policyProvenance: { policy_projection_sha256: "e".repeat(64), projected_guidance_bytes: 64 },
    appendTelemetry: async (entry) => { entries.push(entry); return { written: true }; },
    now: () => "2026-07-29T00:00:00.000Z",
  });

  assert.equal(result.telemetry_recorded, true);
  assert.equal("heartbeat_recorded" in result, false);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event_kind, "routing.decision");
  assert.equal(entries[0].routing.reason, "ROUTED_MODEL_INJECTED");
  assert.equal(entries[0].provenance.policy_projection_sha256.length, 64);
  assert.equal(entries[0].provenance.projected_guidance_bytes > 0, true);
  assert.equal("report_path" in entries[0], false);
});

test("reads the tool's own model first when a secondary override field is also present", () => {
  // `model` is the field the Agent tool actually carries; `model_override` is only a
  // fallback for runtimes that surface the choice elsewhere. Neither one denies.
  assert.deepEqual(evaluateClaudeAgentSpawn({ input: { subagent_type: "executor", model: "claude-terra", model_override: "other" }, contract }), {
    exitCode: 0,
    decision: "allow",
    reason: "CONTRACT_MATCH",
    effective_model: "unproven",
  });
});

test("retains a contract-routed role spawned with a different explicit model", () => {
  assert.deepEqual(evaluateClaudeAgentSpawn({ input: { subagent_type: "executor", model: "wrong" }, contract }), {
    exitCode: 0,
    decision: "allow",
    reason: "EXPLICIT_MODEL_RETAINED",
    effective_model: "unproven",
    declared_model: "wrong",
    routed_model: "claude-terra",
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

test("passes an unmanaged role through untouched, model or no model", () => {
  // An unmanaged role is an explicit choice of agent, so the contract stays out of it
  // entirely — it is neither checked nor routed.
  for (const input of [{ subagent_type: "Explore" }, { subagent_type: "Explore", model: "opus" }]) {
    assert.deepEqual(evaluateClaudeAgentSpawn({ input, contract }), {
      exitCode: 0,
      decision: "allow",
      reason: "UNMANAGED_ROLE",
      effective_model: "unproven",
    });
  }
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

test("keeps the routing decision when telemetry storage fails", async () => {
  const telemetry = { scope: "project", contractSha256: "c".repeat(64), collectorInstanceRef: "collector-1", telemetryKey: "test-key", identifiers: { session: "session-1", turn: "turn-1", invocation: "invoke-1" }, policyProvenance: { policy_projection_sha256: "e".repeat(64), projected_guidance_bytes: 64 }, appendTelemetry: async () => { throw new Error("disk error"); } };
  const allowed = await runClaudeSpawnGuard({ input: { subagent_type: "executor", model: "claude-terra" }, contract, ...telemetry });
  assert.deepEqual(allowed, { exitCode: 0, decision: "allow", reason: "CONTRACT_MATCH", effective_model: "unproven", telemetry_recorded: false });

  const retained = await runClaudeSpawnGuard({ input: { subagent_type: "executor", model: "wrong" }, contract, ...telemetry });
  assert.deepEqual(retained, { exitCode: 0, decision: "allow", reason: "EXPLICIT_MODEL_RETAINED", effective_model: "unproven", declared_model: "wrong", routed_model: "claude-terra", telemetry_recorded: false });

  // A call with no role name cannot be routed or classified, so it stays denied.
  assert.deepEqual(evaluateClaudeAgentSpawn({ input: null, contract }), { exitCode: 2, decision: "deny", reason: "INVALID_AGENT_TOOL_INPUT", effective_model: "unproven" });
});

test("withdraws scoped enforcement for heartbeat gaps without treating them as spawn evidence", () => {
  assert.deepEqual(auditClaudeSpawnGuard({ expectedCorrelationIds: ["observed", "missing"], heartbeats: [{ correlation_id: "observed", timestamp: "2026-07-22T00:00:00.000Z", decision: "allow", reason: "CONTRACT_MATCH" }] }), {
    claude_agent_pre_dispatch: { status: "unproven", scope: "coverage-withdrawn-heartbeat-gap" },
    effective_model: "unproven",
    missing_heartbeats: ["missing"],
  });
});
