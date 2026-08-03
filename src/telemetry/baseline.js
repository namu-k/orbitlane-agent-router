const SHA256 = /^[a-f0-9]{64}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const VERSION = /^\d+(?:\.\d+)*$/;

const invalid = () => { throw new TypeError("INVALID_BASELINE"); };
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === "string" && value.length > 0;
const timestamp = (value) => nonEmptyString(value) && RFC3339.test(value) && !Number.isNaN(Date.parse(value));

function compareVersions(left, right) {
  if (!VERSION.test(left) || !VERSION.test(right)) invalid();
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

function validateRange(value) {
  if (!isRecord(value) || !nonEmptyString(value.min_inclusive) || !nonEmptyString(value.max_inclusive)) invalid();
  if (compareVersions(value.min_inclusive, value.max_inclusive) > 0) invalid();
}

export function versionInRange(version, range) {
  if (!nonEmptyString(version) || !VERSION.test(version) || !isRecord(range)) return false;
  validateRange(range);
  return compareVersions(version, range.min_inclusive) >= 0 && compareVersions(version, range.max_inclusive) <= 0;
}

function validateCommon(entry) {
  if (!isRecord(entry)
    || !["user_declared", "runtime_default_snapshot", "unknown"].includes(entry.provenance)
    || !["user-declared-profile", "hook-payload", "installer-probe", "unknown"].includes(entry.source_kind)
    || !["not-applicable", "execution-attested", "install-snapshot", "stale", "unknown"].includes(entry.freshness)
    || (entry.source_sha256 !== null && !SHA256.test(entry.source_sha256))
    || (entry.captured_at !== null && !timestamp(entry.captured_at))
    || (entry.upper_bound_model !== undefined && entry.upper_bound_model !== null && !nonEmptyString(entry.upper_bound_model))) invalid();
  if (entry.runtime_version_range !== null) validateRange(entry.runtime_version_range);
}

function validateEntry(entry) {
  validateCommon(entry);
  if (entry.provenance === "user_declared") {
    if (!nonEmptyString(entry.model) || entry.source_kind !== "user-declared-profile" || !SHA256.test(entry.source_sha256 ?? "")
      || !timestamp(entry.captured_at) || entry.freshness !== "not-applicable" || entry.runtime_version_range === null) invalid();
    return;
  }

  if (entry.provenance === "runtime_default_snapshot") {
    if (!nonEmptyString(entry.model) || entry.runtime_version_range === null) invalid();
    const sourceIsValid = (entry.source_kind === "hook-payload" && ["execution-attested", "stale"].includes(entry.freshness))
      || (entry.source_kind === "installer-probe" && ["install-snapshot", "stale"].includes(entry.freshness));
    if (!sourceIsValid || !SHA256.test(entry.source_sha256 ?? "") || !timestamp(entry.captured_at)) invalid();
    return;
  }

  if (entry.source_kind !== "unknown" || entry.source_sha256 !== null || entry.captured_at !== null
    || entry.freshness !== "unknown" || entry.runtime_version_range !== null
    || (entry.model !== null && entry.model !== undefined)) invalid();
}

function result(entry, status, assumptionLabel, model, upperBoundModel) {
  return Object.freeze({
    status,
    assumption_label: assumptionLabel,
    model,
    upper_bound_model: upperBoundModel,
    provenance: entry.provenance,
  });
}

export function resolveBaseline(entry, runtime) {
  validateEntry(entry);
  const upperBound = nonEmptyString(entry.upper_bound_model) ? entry.upper_bound_model : null;

  if (entry.provenance === "unknown") {
    return upperBound === null
      ? result(entry, "unavailable", null, null, null)
      : result(entry, "range_only", "baseline unknown; upper-bound range only", null, upperBound);
  }

  if (!versionInRange(runtime?.version, entry.runtime_version_range)) {
    return result(entry, "unavailable", null, null, null);
  }

  if (entry.provenance === "user_declared") {
    return result(entry, "eligible", "user-declared hypothetical baseline; not an observed runtime default", entry.model, null);
  }

  if (entry.freshness === "execution-attested" && runtime?.version_freshness === "execution-attested") {
    return result(entry, "eligible", null, entry.model, null);
  }

  return upperBound === null
    ? result(entry, "unavailable", null, null, null)
    : result(entry, "range_only", "runtime default is not execution-attested; upper-bound range only", null, upperBound);
}
