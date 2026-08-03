const DECIMAL = /^(?:0|[1-9]\d*)$/;
const SIGNED_DECIMAL = /^-?(?:0|[1-9]\d*)$/;
const USAGE_POINTS = Object.freeze({ detailed: 35, session: 25, "total-only": 15, none: 0 });
const MODEL_POINTS = Object.freeze({ resolved: 25, observed: 18, inferred: 10, unknown: 0 });
const ATTRIBUTION_POINTS = Object.freeze({ "exact-invocation": 25, "linked-child": 18, "spawn-allocation": 10, "guidance-only": 5, none: 0 });

const invalid = () => { throw new TypeError("INVALID_CONFIDENCE_INPUT"); };
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const decimal = (value) => typeof value === "string" && DECIMAL.test(value);

function pricePoints({ price_basis: basis, price_match: match, baseline_source: source }) {
  if (basis === "heuristic") return 5;
  if (basis !== "user-supplied" || !["exact", "alias"].includes(match)) return 0;
  return match === "exact" && source === "explicit" ? 15 : 10;
}

function runtimeCap(input) {
  if (input.runtime === "claude") {
    if (input.source_kind === "routing-only" || input.usage_evidence === "none") return 54;
    return input.attribution_evidence === "exact-invocation" ? 100 : 79;
  }
  if (input.runtime === "codex") {
    if (input.source_kind === "codex-linked-children") return 65;
    if (input.source_kind === "none" || input.usage_evidence === "none") return 34;
    return 45;
  }
  invalid();
}

function pointsFor(map, value) {
  if (!own(map, value)) invalid();
  return map[value];
}

function lineCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

export function gradeForScore(score) {
  if (!Number.isSafeInteger(score) || score < 0 || score > 100) throw new TypeError("INVALID_CONFIDENCE_SCORE");
  if (score >= 80) return "High";
  if (score >= 55) return "Medium";
  if (score >= 35) return "Low";
  return "Insufficient";
}

export function adjustReferenceAmount(rawNanos, score) {
  if (typeof rawNanos !== "string" || !SIGNED_DECIMAL.test(rawNanos) || !Number.isSafeInteger(score) || score < 0 || score > 100) {
    throw new TypeError("INVALID_REFERENCE_AMOUNT");
  }
  const raw = BigInt(rawNanos);
  const magnitude = raw < 0n ? -raw : raw;
  const adjusted = (magnitude * BigInt(score) + 50n) / 100n;
  return (raw < 0n ? -adjusted : adjusted).toString();
}

export function scoreConfidence(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)
    || !decimal(input.priced_included_usage) || !decimal(input.total_observed_usage)
    || typeof input.baseline_known !== "boolean") invalid();
  const priced = BigInt(input.priced_included_usage);
  const total = BigInt(input.total_observed_usage);
  if (priced > total) invalid();
  const corruptLines = lineCount(input.corrupt_lines);
  const totalLines = lineCount(input.total_lines);
  const dimensions = Object.freeze({
    usage: pointsFor(USAGE_POINTS, input.usage_evidence),
    model: pointsFor(MODEL_POINTS, input.model_evidence),
    attribution: pointsFor(ATTRIBUTION_POINTS, input.attribution_evidence),
    price_baseline: pricePoints(input),
  });
  const dimensionSum = Object.values(dimensions).reduce((sum, points) => sum + points, 0);
  const coverageScore = total === 0n ? 0 : Number((BigInt(dimensionSum) * priced) / total);
  const integrityPenalty = Math.min(10, Math.ceil((10 * corruptLines) / Math.max(1, totalLines)));
  const scoreBeforeCap = Math.max(0, coverageScore - integrityPenalty);
  const cap = runtimeCap(input);
  const score = input.baseline_known ? Math.min(cap, scoreBeforeCap) : 0;
  const grade = gradeForScore(score);
  const warnings = [];
  if (!input.baseline_known) warnings.push("UNKNOWN_BASELINE");
  if (total === 0n) warnings.push("NO_OBSERVED_USAGE");
  else if (priced < total) warnings.push("PARTIAL_PRICED_COVERAGE");
  if (corruptLines > 0) warnings.push("CORRUPT_INPUT_LINES");
  return Object.freeze({
    dimensions,
    dimension_sum: dimensionSum,
    coverage: Object.freeze({ priced_included_usage: priced.toString(), total_observed_usage: total.toString() }),
    integrity_penalty: integrityPenalty,
    score_before_cap: scoreBeforeCap,
    runtime_cap: cap,
    score,
    grade,
    money_allowed: score >= 35,
    warnings: Object.freeze(warnings),
  });
}
