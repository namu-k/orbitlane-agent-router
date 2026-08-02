import assert from "node:assert/strict";
import test from "node:test";
import { estimateRuntime } from "../../src/estimate/index.js";

const rates = (rate) => ({ input: { rate_nanos_per_million_tokens: rate }, cached_input: { rate_nanos_per_million_tokens: rate }, output: { rate_nanos_per_million_tokens: rate } });
const catalog = { schema_version: 1, effective_from: "2026-08-02", source_label: "test", source_note: "test", basis: "user-supplied", currency: "USD", models: [
  { runtime: "codex", model: "gpt-5.6-sol", aliases: ["sol"], ...rates("9000000000") },
  { runtime: "codex", model: "gpt-5.6-terra", aliases: ["terra"], ...rates("1000000000") },
] };
const evidence = { runtime: "codex", source_kind: "codex-linked-children", usage_evidence: "detailed", model_evidence: "observed", attribution_evidence: "linked-child", usage_by_model: [{ model: "gpt-5.6-terra", model_source: "observed", usage: { input_tokens: "100", cached_input_tokens: "0", output_tokens: "0", total_tokens: "100" } }], unknown_model_usage: { input_tokens: "0", cached_input_tokens: "0", output_tokens: "0", total_tokens: "0" }, observed_main_model: "gpt-5.6-sol", contract_main_model: null, corrupt_lines: 0, total_lines: 1, warnings: [], basis: {} };

test("prices only usage with both routed and baseline rates", () => {
  const result = estimateRuntime({ evidence, catalog, explicitBaselineModel: "sol" });
  assert.equal(result.coverage.priced_included_usage, "100");
  assert.equal(result.coverage.total_observed_usage, "100");
  assert.equal(result.raw_estimated_model_cost_difference_nanos, "800000");
});

test("Insufficient exposes no money even if an internal priced bucket exists", () => {
  const result = estimateRuntime({ evidence: { ...evidence, unknown_model_usage: { input_tokens: "1000", cached_input_tokens: "0", output_tokens: "0", total_tokens: "1000" } }, catalog, explicitBaselineModel: "unknown" });
  assert.equal(result.confidence.grade, "Insufficient");
  assert.equal(result.raw_estimated_model_cost_difference_nanos, null);
  assert.equal(result.confidence_adjusted_reference_amount_nanos, null);
  assert.equal(result.display, "데이터 부족");
});
