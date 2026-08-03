const DECIMAL = /^(?:0|[1-9]\d*)$/;
const RUNTIMES = new Set(["claude", "codex"]);
const BASES = new Set(["heuristic", "user-supplied"]);
const RATE_KEYS = ["input", "cached_input", "output"];
const USAGE_KEYS = ["input_tokens", "cached_input_tokens", "output_tokens", "total_tokens"];
const MILLION = 1_000_000n;

const invalidCatalog = () => { throw new TypeError("INVALID_PRICE_CATALOG"); };
const invalidUsage = () => { throw new TypeError("INVALID_PRICE_USAGE"); };
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isDecimal = (value) => typeof value === "string" && DECIMAL.test(value);
const isModelToken = (value) => typeof value === "string" && value.trim().length > 0;

function deepFreeze(value) {
  if (!isRecord(value) && !Array.isArray(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function normalizeRates(value) {
  if (!isRecord(value) || Object.keys(value).length !== RATE_KEYS.length || !RATE_KEYS.every((key) => isRecord(value[key]))) invalidCatalog();
  const result = {};
  for (const key of RATE_KEYS) {
    const rate = value[key].rate_nanos_per_million_tokens;
    if (Object.keys(value[key]).length !== 1 || !isDecimal(rate)) invalidCatalog();
    result[key] = { rate_nanos_per_million_tokens: rate };
  }
  return deepFreeze(result);
}

function normalizeModel(entry, tokensByRuntime) {
  if (!isRecord(entry) || !RUNTIMES.has(entry.runtime) || !isModelToken(entry.model)
    || !Array.isArray(entry.aliases) || !entry.aliases.every(isModelToken)) invalidCatalog();
  const expected = new Set(["runtime", "model", "aliases", ...RATE_KEYS]);
  if (Object.keys(entry).length !== expected.size || Object.keys(entry).some((key) => !expected.has(key))) invalidCatalog();
  const tokens = tokensByRuntime.get(entry.runtime) ?? new Set();
  for (const token of [entry.model, ...entry.aliases]) {
    if (tokens.has(token)) invalidCatalog();
    tokens.add(token);
  }
  tokensByRuntime.set(entry.runtime, tokens);
  return deepFreeze({
    runtime: entry.runtime,
    model: entry.model,
    aliases: [...entry.aliases],
    ...normalizeRates({ input: entry.input, cached_input: entry.cached_input, output: entry.output }),
  });
}

export function validatePriceCatalog(catalog) {
  if (!isRecord(catalog) || catalog.schema_version !== 1 || !isModelToken(catalog.effective_from)
    || !isModelToken(catalog.source_label) || !isModelToken(catalog.source_note)
    || !BASES.has(catalog.basis) || catalog.currency !== "USD" || !Array.isArray(catalog.models)
    || catalog.models.length === 0) invalidCatalog();
  const expected = new Set(["schema_version", "effective_from", "source_label", "source_note", "basis", "currency", "models"]);
  if (Object.keys(catalog).length !== expected.size || Object.keys(catalog).some((key) => !expected.has(key))) invalidCatalog();
  const tokensByRuntime = new Map();
  const models = catalog.models.map((entry) => normalizeModel(entry, tokensByRuntime));
  return deepFreeze({
    schema_version: 1,
    effective_from: catalog.effective_from,
    source_label: catalog.source_label,
    source_note: catalog.source_note,
    basis: catalog.basis,
    currency: "USD",
    models,
  });
}

export function resolveModelPrice(catalog, runtime, model) {
  const valid = validatePriceCatalog(catalog);
  if (!RUNTIMES.has(runtime) || !isModelToken(model)) return null;
  for (const entry of valid.models) {
    if (entry.runtime !== runtime) continue;
    if (entry.model === model) return deepFreeze({ model: entry.model, match: "exact", rates: entryRates(entry), basis: valid.basis });
    if (entry.aliases.includes(model)) return deepFreeze({ model: entry.model, match: "alias", rates: entryRates(entry), basis: valid.basis });
  }
  return null;
}

function entryRates(entry) {
  return deepFreeze({ input: entry.input, cached_input: entry.cached_input, output: entry.output });
}

export function resolveBaselineModel({ runtime, explicitModel, observedMainModel, contractMainModel, catalog }) {
  for (const [source, candidate] of [["explicit", explicitModel], ["observed", observedMainModel], ["contract", contractMainModel]]) {
    if (!isModelToken(candidate)) continue;
    const price = resolveModelPrice(catalog, runtime, candidate);
    if (price !== null) return deepFreeze({ status: "resolved", model: price.model, source, price });
  }
  return deepFreeze({ status: "unknown", model: null, source: "unknown", price: null });
}

export function roundHalfUp(numerator, denominator) {
  if (typeof numerator !== "bigint" || typeof denominator !== "bigint" || numerator < 0n || denominator <= 0n) {
    throw new TypeError("INVALID_PRICE_ARITHMETIC");
  }
  return (numerator + denominator / 2n) / denominator;
}

function usageVector(usage) {
  if (!isRecord(usage) || Object.keys(usage).length !== USAGE_KEYS.length || !USAGE_KEYS.every((key) => isDecimal(usage[key]))) invalidUsage();
  return usage;
}

function unitCost(tokens, rate) {
  if (!isRecord(rate) || Object.keys(rate).length !== 1 || !isDecimal(rate.rate_nanos_per_million_tokens)) invalidUsage();
  return roundHalfUp(BigInt(tokens) * BigInt(rate.rate_nanos_per_million_tokens), MILLION);
}

function priceCost(usage, rates) {
  if (!isRecord(rates) || Object.keys(rates).length !== RATE_KEYS.length || !RATE_KEYS.every((key) => key in rates)) invalidUsage();
  return unitCost(usage.input_tokens, rates.input)
    + unitCost(usage.cached_input_tokens, rates.cached_input)
    + unitCost(usage.output_tokens, rates.output);
}

export function priceUsageDifference({ usage, routedPrice, baselinePrice }) {
  const validUsage = usageVector(usage);
  const routed = priceCost(validUsage, routedPrice);
  const baseline = priceCost(validUsage, baselinePrice);
  return deepFreeze({
    routed_cost_nanos: routed.toString(),
    baseline_cost_nanos: baseline.toString(),
    raw_estimated_model_cost_difference_nanos: (baseline - routed).toString(),
  });
}
