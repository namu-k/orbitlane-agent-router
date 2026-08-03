import { adjustReferenceAmount, scoreConfidence } from "./confidence.js";
import { priceUsageDifference, resolveBaselineModel, resolveModelPrice, validatePriceCatalog } from "./pricing.js";

const measure = (usage, totalOnly) => totalOnly ? BigInt(usage.total_tokens) : BigInt(usage.input_tokens) + BigInt(usage.cached_input_tokens) + BigInt(usage.output_tokens);

export function estimateRuntime({ evidence, catalog, explicitBaselineModel = null }) {
  const validCatalog = validatePriceCatalog(catalog);
  const baseline = resolveBaselineModel({ runtime: evidence.runtime, explicitModel: explicitBaselineModel, observedMainModel: evidence.observed_main_model, contractMainModel: evidence.contract_main_model, catalog: validCatalog });
  let raw = 0n; let included = 0n; let total = measure(evidence.unknown_model_usage, evidence.usage_evidence === "total-only");
  const priceMatches = [];
  for (const bucket of evidence.usage_by_model) {
    const amount = measure(bucket.usage, evidence.usage_evidence === "total-only"); total += amount;
    const routed = resolveModelPrice(validCatalog, evidence.runtime, bucket.model);
    if (routed === null || baseline.price === null) continue;
    const difference = priceUsageDifference({ usage: bucket.usage, routedPrice: routed.rates, baselinePrice: baseline.price.rates });
    raw += BigInt(difference.raw_estimated_model_cost_difference_nanos); included += amount;
    priceMatches.push(routed.match, baseline.price.match);
  }
  const priceMatch = priceMatches.includes("alias") ? "alias" : priceMatches.includes("exact") ? "exact" : null;
  const confidence = scoreConfidence({ ...evidence, baseline_known: baseline.status === "resolved", baseline_source: baseline.source, price_basis: priceMatches.length ? validCatalog.basis : "none", price_match: priceMatch, priced_included_usage: included.toString(), total_observed_usage: total.toString() });
  const allowed = confidence.money_allowed;
  return Object.freeze({ runtime: evidence.runtime, status: allowed ? "estimated" : "insufficient", raw_estimated_model_cost_difference_nanos: allowed ? raw.toString() : null,
    confidence_adjusted_reference_amount_nanos: allowed ? adjustReferenceAmount(raw.toString(), confidence.score) : null, display: allowed ? null : "데이터 부족", confidence,
    baseline: Object.freeze({ status: baseline.status, model: baseline.model, source: baseline.source }), coverage: confidence.coverage,
    models: evidence.usage_by_model.map(({ model, model_source }) => ({ model, model_source })), calculation_basis: Object.freeze({ price_basis: priceMatches.length ? validCatalog.basis : null, price_match: priceMatch, ...evidence.basis }), warnings: Object.freeze([...evidence.warnings, ...confidence.warnings]) });
}
