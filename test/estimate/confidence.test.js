import assert from "node:assert/strict";
import test from "node:test";

import { adjustReferenceAmount, gradeForScore, scoreConfidence } from "../../src/estimate/confidence.js";

const highClaudeEvidence = (overrides = {}) => ({
  runtime: "claude",
  source_kind: "claude-events",
  usage_evidence: "detailed",
  model_evidence: "resolved",
  attribution_evidence: "exact-invocation",
  price_basis: "user-supplied",
  price_match: "exact",
  baseline_source: "explicit",
  baseline_known: true,
  priced_included_usage: "100",
  total_observed_usage: "100",
  corrupt_lines: 0,
  total_lines: 3,
  ...overrides,
});

test("strong Claude evidence reaches 100 with all four dimensions", () => {
  const result = scoreConfidence(highClaudeEvidence());
  assert.deepEqual(result.dimensions, { usage: 35, model: 25, attribution: 25, price_baseline: 15 });
  assert.equal(result.score_before_cap, 100);
  assert.equal(result.runtime_cap, 100);
  assert.equal(result.score, 100);
  assert.equal(result.grade, "High");
  assert.equal(result.money_allowed, true);
});

test("Codex linked-child evidence is capped at 65", () => {
  const result = scoreConfidence({
    runtime: "codex", source_kind: "codex-linked-children",
    usage_evidence: "detailed", model_evidence: "observed",
    attribution_evidence: "linked-child", price_basis: "user-supplied",
    price_match: "exact", baseline_source: "explicit", baseline_known: true,
    priced_included_usage: "100", total_observed_usage: "100",
    corrupt_lines: 0, total_lines: 3,
  });
  assert.equal(result.score, 65);
  assert.equal(result.grade, "Medium");
});

test("the runtime caps distinguish missing joins, allocation, and no usage", () => {
  assert.equal(scoreConfidence(highClaudeEvidence({ attribution_evidence: "linked-child" })).runtime_cap, 79);
  assert.equal(scoreConfidence(highClaudeEvidence({ source_kind: "routing-only", usage_evidence: "none", attribution_evidence: "guidance-only", priced_included_usage: "0", total_observed_usage: "0" })).runtime_cap, 54);
  assert.equal(scoreConfidence(highClaudeEvidence({ runtime: "codex", source_kind: "codex-session-allocation", usage_evidence: "session", model_evidence: "observed", attribution_evidence: "spawn-allocation" })).runtime_cap, 45);
  assert.equal(scoreConfidence(highClaudeEvidence({ runtime: "codex", source_kind: "none", usage_evidence: "none", model_evidence: "unknown", attribution_evidence: "none", priced_included_usage: "0", total_observed_usage: "0" })).runtime_cap, 34);
});

test("unknown baseline overrides otherwise high dimensions", () => {
  const result = scoreConfidence(highClaudeEvidence({ baseline_known: false }));
  assert.equal(result.score, 0);
  assert.equal(result.grade, "Insufficient");
  assert.equal(result.money_allowed, false);
});

test("all evidence dimension values have fixed scores", () => {
  const dimension = (field, value) => scoreConfidence(highClaudeEvidence({ [field]: value })).dimensions;
  assert.deepEqual(["detailed", "session", "total-only", "none"].map((value) => dimension("usage_evidence", value).usage), [35, 25, 15, 0]);
  assert.deepEqual(["resolved", "observed", "inferred", "unknown"].map((value) => dimension("model_evidence", value).model), [25, 18, 10, 0]);
  assert.deepEqual(["exact-invocation", "linked-child", "spawn-allocation", "guidance-only", "none"].map((value) => dimension("attribution_evidence", value).attribution), [25, 18, 10, 5, 0]);
  assert.deepEqual([
    scoreConfidence(highClaudeEvidence({ price_basis: "user-supplied", price_match: "exact", baseline_source: "explicit" })).dimensions.price_baseline,
    scoreConfidence(highClaudeEvidence({ price_basis: "user-supplied", price_match: "alias", baseline_source: "contract" })).dimensions.price_baseline,
    scoreConfidence(highClaudeEvidence({ price_basis: "heuristic" })).dimensions.price_baseline,
    scoreConfidence(highClaudeEvidence({ price_basis: "none", price_match: null })).dimensions.price_baseline,
  ], [15, 10, 5, 0]);
});

test("coverage and corrupt lines reduce a bounded score deterministically", () => {
  const result = scoreConfidence(highClaudeEvidence({ priced_included_usage: "50", total_observed_usage: "100", corrupt_lines: 1, total_lines: 3 }));
  assert.equal(result.coverage.priced_included_usage, "50");
  assert.equal(result.coverage.total_observed_usage, "100");
  assert.equal(result.integrity_penalty, 4);
  assert.equal(result.score_before_cap, 46);
  assert.equal(result.score, 46);
  assert.equal(result.grade, "Low");
});

test("grade boundaries and signed adjusted rounding are fixed", () => {
  assert.deepEqual([0, 34, 35, 54, 55, 79, 80, 100].map(gradeForScore), ["Insufficient", "Insufficient", "Low", "Low", "Medium", "Medium", "High", "High"]);
  assert.equal(adjustReferenceAmount("101", 50), "51");
  assert.equal(adjustReferenceAmount("-101", 50), "-51");
  assert.equal(adjustReferenceAmount("0", 100), "0");
});
