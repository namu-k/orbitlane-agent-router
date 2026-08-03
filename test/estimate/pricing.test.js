import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  priceUsageDifference,
  resolveBaselineModel,
  resolveModelPrice,
  roundHalfUp,
  validatePriceCatalog,
} from "../../src/estimate/pricing.js";

const bundledCatalogPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "estimate", "default-prices.json");

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

test("the bundled heuristic catalog pins the six approved rate triplets", async () => {
  const raw = JSON.parse(await readFile(bundledCatalogPath, "utf8"));
  assert.deepEqual(
    { schema_version: raw.schema_version, effective_from: raw.effective_from, source_label: raw.source_label, basis: raw.basis, currency: raw.currency },
    { schema_version: 1, effective_from: "2026-08-02", source_label: "orbitlane-heuristic-reference-2026-08-02", basis: "heuristic", currency: "USD" }
  );
  const catalog = validatePriceCatalog(raw);
  // [runtime, model, aliases, input, cached_input, output] — must match docs/superpowers/specs plan table exactly.
  const expected = [
    ["codex", "gpt-5.6-sol", ["sol"], "10000000000", "1000000000", "40000000000"],
    ["codex", "gpt-5.6-terra", ["terra"], "2000000000", "200000000", "8000000000"],
    ["codex", "gpt-5.6-luna", ["luna"], "500000000", "50000000", "2000000000"],
    ["claude", "claude-opus-5", ["opus", "claude-opus-4-8", "claude-opus-4-8[1m]"], "15000000000", "1500000000", "75000000000"],
    ["claude", "claude-sonnet-5", ["sonnet"], "3000000000", "300000000", "15000000000"],
    ["claude", "claude-haiku-4-5-20251001", ["haiku"], "1000000000", "100000000", "5000000000"],
  ];
  assert.equal(catalog.models.length, expected.length, "bundled catalog model count drifted");
  catalog.models.forEach((entry, index) => {
    const [runtime, model, aliases, inputRate, cachedRate, outputRate] = expected[index];
    assert.equal(entry.runtime, runtime);
    assert.equal(entry.model, model);
    assert.deepEqual(entry.aliases, aliases);
    assert.deepEqual({ input: entry.input, cached_input: entry.cached_input, output: entry.output }, rates(inputRate, cachedRate, outputRate));
    const crossRuntime = runtime === "codex" ? "claude" : "codex";
    for (const token of [model, ...aliases]) {
      assert.equal(resolveModelPrice(catalog, runtime, token).model, model, `${token} did not resolve within ${runtime}`);
      assert.equal(resolveModelPrice(catalog, crossRuntime, token), null, `${token} leaked across runtimes into ${crossRuntime}`);
    }
  });
});
