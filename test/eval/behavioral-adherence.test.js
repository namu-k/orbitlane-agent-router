import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateAdherenceObservations,
  behavioralAdherenceScenarios,
  classifyAdherenceObservation,
  createAdherenceObservation,
  createBehavioralAdherenceCases,
  createBehavioralAdherenceEvidenceReport,
  evalConditions,
  measureSpawnGuardHeartbeats,
  parseSpawnGuardHeartbeats,
} from "../../src/eval/behavioral-adherence.js";

const allowHeartbeat = JSON.stringify({ correlation_id: "run-1", timestamp: "2026-07-22T00:00:00.000Z", decision: "allow", reason: "CONTRACT_MATCH", effective_model: "unproven" });
const denyHeartbeat = JSON.stringify({ correlation_id: "run-2", timestamp: "2026-07-22T00:00:01.000Z", decision: "deny", reason: "CONTRACT_MISMATCH", effective_model: "unproven" });

test("fixes six §14.2-derived scenarios, both conditions, and an explicit-delegation adversarial case", () => {
  const scenarios = behavioralAdherenceScenarios();
  assert.equal(scenarios.length, 6);
  assert.deepEqual(evalConditions(), ["baseline", "projected"]);
  assert.deepEqual(scenarios.map(({ id, expected_guard_decisions, repetitions }) => [id, expected_guard_decisions, repetitions]), [
    ["short-single-file", 0, 3], ["long-context-judgment", 0, 3], ["coupled-sequential-plan", 0, 3],
    ["independent-platform-research", 3, 3], ["resume-child-follow-up", 1, 3], ["explicit-delegation-adversarial", 1, 3],
  ]);
  assert.match(scenarios.at(-1).prompt, /\$subagent-driven-development/);
  const cases = createBehavioralAdherenceCases({ projectedPolicyBlock: "<!-- ORBITLANE:START claude -->\npolicy\n<!-- ORBITLANE:END claude -->\n" });
  assert.equal(cases.length, 12);
  assert.equal(cases[0].policy_block, null);
  assert.match(cases[1].policy_block, /ORBITLANE:START/);
  assert.throws(() => createBehavioralAdherenceCases({ projectedPolicyBlock: "not a marker" }), /Claude marker-bounded/);
});

test("creates repeatable observations entirely from an offline fixed heartbeat fixture", () => {
  assert.deepEqual(createAdherenceObservation({
    scenario_id: "explicit-delegation-adversarial", condition: "projected", repetition: 2, heartbeatJsonl: `${allowHeartbeat}\n`,
  }), {
    scenario_id: "explicit-delegation-adversarial", condition: "projected", repetition: 2, expected_guard_decisions: 1,
    measurement: { guard_decision_count: 1, allowed_spawn_request_count: 1, denied_spawn_request_count: 0, actual_spawn: "unproven", effective_model: "unproven" },
    invalid_heartbeat_line_count: 0, classification: "guard-decision-count-matched", fp_fn: "unproven-from-guard-heartbeat-alone",
  });
});

test("parses fixed guard heartbeats and retains malformed lines as diagnostics", () => {
  const parsed = parseSpawnGuardHeartbeats(`${allowHeartbeat}\nnot-json\n${denyHeartbeat}\n`);
  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(parsed.invalid_lines, [{ line: 2, reason: "INVALID_JSON" }]);
  assert.deepEqual(measureSpawnGuardHeartbeats(parsed.entries), {
    guard_decision_count: 2, allowed_spawn_request_count: 1, denied_spawn_request_count: 1,
    actual_spawn: "unproven", effective_model: "unproven",
  });
  assert.deepEqual(parseSpawnGuardHeartbeats(`${JSON.stringify({ timestamp: "2026-07-22T00:00:00.000Z", decision: "allow", reason: "CONTRACT_MATCH" })}\n`).invalid_lines, [{ line: 1, reason: "INVALID_HEARTBEAT" }]);
});

test("classifies predeclared heartbeat-only FP/FN criteria without treating gaps as proof", () => {
  const scenarios = behavioralAdherenceScenarios();
  assert.equal(classifyAdherenceObservation({ scenario: scenarios[3], measurement: { guard_decision_count: 0 } }), "zero-guard-decisions-where-delegation-expected");
  assert.equal(classifyAdherenceObservation({ scenario: scenarios[0], measurement: { guard_decision_count: 1 } }), "guard-decision-observed-where-direct-expected");
  assert.equal(classifyAdherenceObservation({ scenario: scenarios[3], measurement: { guard_decision_count: 3 } }), "guard-decision-count-matched");
  assert.equal(classifyAdherenceObservation({ scenario: scenarios[3], measurement: { guard_decision_count: 3 }, invalidLineCount: 1 }), "unusable-heartbeat-log");
});

test("aggregates and reports observational evidence rather than a pass/fail gate", () => {
  const observations = [
    { scenario_id: "short-single-file", condition: "baseline", repetition: 1, classification: "guard-decision-count-matched", fp_fn: "unproven-from-guard-heartbeat-alone" },
    { scenario_id: "explicit-delegation-adversarial", condition: "projected", repetition: 1, classification: "zero-guard-decisions-where-delegation-expected", fp_fn: "unproven-from-guard-heartbeat-alone" },
  ];
  const aggregate = aggregateAdherenceObservations(observations);
  assert.deepEqual({ repetitions: aggregate.repetitions, classifications: aggregate.classifications }, {
    repetitions: 2,
    classifications: {
      "guard-decision-count-matched": 1, "zero-guard-decisions-where-delegation-expected": 1,
      "guard-decision-observed-where-direct-expected": 0, "guard-decision-count-mismatch": 0, "unusable-heartbeat-log": 0,
    },
  });
  assert.deepEqual(aggregate.completeness, { expected_observations: 36, observed_observations: 2, complete: false });
  assert.deepEqual(aggregate.by_condition, {
    baseline: { observations: 1, classifications: { "guard-decision-count-matched": 1, "zero-guard-decisions-where-delegation-expected": 0, "guard-decision-observed-where-direct-expected": 0, "guard-decision-count-mismatch": 0, "unusable-heartbeat-log": 0 } },
    projected: { observations: 1, classifications: { "guard-decision-count-matched": 0, "zero-guard-decisions-where-delegation-expected": 1, "guard-decision-observed-where-direct-expected": 0, "guard-decision-count-mismatch": 0, "unusable-heartbeat-log": 0 } },
  });
  const report = createBehavioralAdherenceEvidenceReport({ runtime: { name: "Claude Code", version: "FIXED_RUNTIME", model_version: "FIXED_MODEL" }, observations });
  assert.deepEqual(report.gate, { ci: false, pass_fail: false, purpose: "observational-evidence-only" });
  assert.deepEqual(report.claim_boundaries, {
    enforcement: "not-claimed", effective_model: "unproven", token_savings: "unproven", actual_spawn: "unproven-from-guard-heartbeat-alone",
  });
});
