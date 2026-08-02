import assert from "node:assert/strict";
import test from "node:test";

import {
  priceUsageDifference,
  resolveBaselineModel,
  resolveModelPrice,
  roundHalfUp,
  validatePriceCatalog,
} from "../../src/estimate/pricing.js";

const rates = (input, cachedInput, output) => ({
  input: { rate_nanos_per_million_tokens: input },
  cached_input: { rate_nanos_per_million_tokens: cachedInput },
  output: { rate_nanos_per_million_tokens: output },
});

const catalog = validatePriceCatalog({
  schema_version: 1,
  effective_from: "2026-08-02",
  source_label: "test-reference",
  source_note: "Test-only heuristic reference.",
  basis: "heuristic",
  currency: "USD",
  models: [
    { runtime: "codex", model: "gpt-5.6-sol", aliases: ["sol"], ...rates("10000000000", "1000000000", "40000000000") },
    { runtime: "codex", model: "gpt-5.6-terra", aliases: ["terra"], ...rates("2000000000", "200000000", "8000000000") },
    { runtime: "claude", model: "claude-sonnet-5", aliases: ["sonnet"], ...rates("3000000000", "300000000", "15000000000") },
  ],
});

test("prices one million tokens using nanos-per-million units", () => {
  const result = priceUsageDifference({
    usage: { input_tokens: "1000000", cached_input_tokens: "0", output_tokens: "0", total_tokens: "1000000" },
    routedPrice: rates("2000000000", "200000000", "8000000000"),
    baselinePrice: rates("10000000000", "1000000000", "40000000000"),
  });
  assert.equal(result.routed_cost_nanos, "2000000000");
  assert.equal(result.baseline_cost_nanos, "10000000000");
  assert.equal(result.raw_estimated_model_cost_difference_nanos, "8000000000");
});

test("prices zero and negative baseline-relative differences without floating point", () => {
  const usage = { input_tokens: "1", cached_input_tokens: "1", output_tokens: "1", total_tokens: "3" };
  const routedPrice = rates("10000000", "10000000", "10000000");
  const baselinePrice = rates("0", "0", "0");
  const result = priceUsageDifference({ usage, routedPrice, baselinePrice });
  assert.equal(result.routed_cost_nanos, "30");
  assert.equal(result.baseline_cost_nanos, "0");
  assert.equal(result.raw_estimated_model_cost_difference_nanos, "-30");
});

test("roundHalfUp has deterministic half boundaries", () => {
  assert.equal(roundHalfUp(0n, 2n), 0n);
  assert.equal(roundHalfUp(1n, 2n), 1n);
  assert.equal(roundHalfUp(3n, 2n), 2n);
  assert.throws(() => roundHalfUp(-1n, 2n), /INVALID_PRICE_ARITHMETIC/);
  assert.throws(() => roundHalfUp(1n, 0n), /INVALID_PRICE_ARITHMETIC/);
});

test("resolves exact and runtime-local aliases", () => {
  assert.deepEqual(resolveModelPrice(catalog, "codex", "gpt-5.6-terra"), {
    model: "gpt-5.6-terra",
    match: "exact",
    rates: rates("2000000000", "200000000", "8000000000"),
    basis: "heuristic",
  });
  assert.equal(resolveModelPrice(catalog, "claude", "sol"), null);
  assert.equal(resolveModelPrice(catalog, "codex", "sonnet"), null);
  assert.equal(resolveModelPrice(catalog, "claude", "sonnet").match, "alias");
});

test("resolves a baseline in explicit, observed, then contract order", () => {
  assert.equal(resolveBaselineModel({ runtime: "codex", catalog, explicitModel: "terra", observedMainModel: "gpt-5.6-sol", contractMainModel: "sol" }).source, "explicit");
  assert.equal(resolveBaselineModel({ runtime: "codex", catalog, explicitModel: "unknown", observedMainModel: "gpt-5.6-sol", contractMainModel: "sol" }).source, "observed");
  assert.equal(resolveBaselineModel({ runtime: "codex", catalog, explicitModel: null, observedMainModel: null, contractMainModel: "sol" }).source, "contract");
});

test("unknown baseline never borrows another runtime model price", () => {
  assert.deepEqual(resolveBaselineModel({ runtime: "codex", catalog, explicitModel: null,
    observedMainModel: null, contractMainModel: null }), {
    status: "unknown", model: null, source: "unknown", price: null,
  });
});

test("catalog validation rejects invalid decimals, duplicate aliases, and mixed currencies", () => {
  const invalidDecimal = structuredClone(catalog);
  invalidDecimal.models[0].input.rate_nanos_per_million_tokens = "2.5";
  assert.throws(() => validatePriceCatalog(invalidDecimal), /INVALID_PRICE_CATALOG/);

  const duplicateAlias = structuredClone(catalog);
  duplicateAlias.models[1].aliases = ["sol"];
  assert.throws(() => validatePriceCatalog(duplicateAlias), /INVALID_PRICE_CATALOG/);

  const mixedCurrency = structuredClone(catalog);
  mixedCurrency.currency = "EUR";
  assert.throws(() => validatePriceCatalog(mixedCurrency), /INVALID_PRICE_CATALOG/);

  assert.throws(() => priceUsageDifference({
    usage: { input_tokens: "-1", cached_input_tokens: "0", output_tokens: "0", total_tokens: "0" },
    routedPrice: rates("1", "1", "1"), baselinePrice: rates("1", "1", "1"),
  }), /INVALID_PRICE_USAGE/);
});
