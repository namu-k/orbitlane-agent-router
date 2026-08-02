import assert from "node:assert/strict";
import test from "node:test";

import { resolveBaseline } from "../../src/telemetry/baseline.js";

const executionAttestedRuntime = Object.freeze({
  family: "claude",
  version: "2.1.220",
  version_freshness: "execution-attested",
});

const range = Object.freeze({ min_inclusive: "2.1.220", max_inclusive: "2.1.220" });

const userDeclared = (overrides = {}) => ({
  model: "claude-opus-4-8",
  provenance: "user_declared",
  source_kind: "user-declared-profile",
  source_sha256: "a".repeat(64),
  captured_at: "2026-07-27T00:00:00.000Z",
  freshness: "not-applicable",
  runtime_version_range: range,
  ...overrides,
});

const runtimeDefault = (overrides = {}) => ({
  model: "claude-opus-4-8",
  provenance: "runtime_default_snapshot",
  source_kind: "hook-payload",
  source_sha256: "b".repeat(64),
  captured_at: "2026-07-27T00:00:00.000Z",
  freshness: "execution-attested",
  runtime_version_range: range,
  ...overrides,
});

test("user-declared baseline is eligible only as a labeled hypothesis", () => {
  const baseline = resolveBaseline(userDeclared(), executionAttestedRuntime);

  assert.equal(baseline.status, "eligible");
  assert.equal(baseline.model, "claude-opus-4-8");
  assert.match(baseline.assumption_label, /user-declared hypothetical baseline/);
});

test("runtime-default baseline needs execution-attested baseline and runtime freshness", () => {
  assert.deepEqual(resolveBaseline(runtimeDefault(), executionAttestedRuntime), {
    status: "eligible",
    assumption_label: null,
    model: "claude-opus-4-8",
    upper_bound_model: null,
    provenance: "runtime_default_snapshot",
  });

  const installSnapshot = runtimeDefault({
    source_kind: "installer-probe",
    freshness: "install-snapshot",
    upper_bound_model: "claude-opus-4-8",
  });
  const rangeOnly = resolveBaseline(installSnapshot, {
    ...executionAttestedRuntime,
    version_freshness: "install-snapshot",
  });
  assert.equal(rangeOnly.status, "range_only");
  assert.equal(rangeOnly.model, null);
  assert.equal(rangeOnly.upper_bound_model, "claude-opus-4-8");
  assert.match(rangeOnly.assumption_label, /upper-bound range only/);

  assert.equal(resolveBaseline({ ...installSnapshot, upper_bound_model: undefined }, executionAttestedRuntime).status, "unavailable");
});

test("baseline runtime ranges are inclusive and exclude versions outside the range", () => {
  const spanning = userDeclared({
    runtime_version_range: { min_inclusive: "2.1.219", max_inclusive: "2.1.221" },
  });

  assert.equal(resolveBaseline(spanning, { ...executionAttestedRuntime, version: "2.1.219" }).status, "eligible");
  assert.equal(resolveBaseline(spanning, { ...executionAttestedRuntime, version: "2.1.221" }).status, "eligible");
  assert.equal(resolveBaseline(spanning, { ...executionAttestedRuntime, version: "2.1.222" }).status, "unavailable");
});

test("unknown baseline grants only an explicitly declared upper-bound range", () => {
  const unknown = {
    model: null,
    upper_bound_model: "claude-opus-4-8",
    provenance: "unknown",
    source_kind: "unknown",
    source_sha256: null,
    captured_at: null,
    freshness: "unknown",
    runtime_version_range: null,
  };

  const result = resolveBaseline(unknown, executionAttestedRuntime);
  assert.equal(result.status, "range_only");
  assert.equal(result.upper_bound_model, "claude-opus-4-8");
  assert.match(result.assumption_label, /upper-bound range only/);
  assert.equal(resolveBaseline({ ...unknown, upper_bound_model: null }, executionAttestedRuntime).status, "unavailable");
});

test("baseline validation rejects inconsistent provenance, source, hash, timestamps, freshness, and ranges", () => {
  const invalidEntries = [
    userDeclared({ source_kind: "hook-payload" }),
    userDeclared({ source_sha256: "not-a-hash" }),
    userDeclared({ captured_at: "yesterday" }),
    userDeclared({ freshness: "execution-attested" }),
    userDeclared({ runtime_version_range: null }),
    userDeclared({ runtime_version_range: { min_inclusive: "2.1.221", max_inclusive: "2.1.220" } }),
    runtimeDefault({ source_kind: "installer-probe", freshness: "execution-attested" }),
    { ...userDeclared(), provenance: "unknown" },
  ];

  for (const entry of invalidEntries) {
    assert.throws(() => resolveBaseline(entry, executionAttestedRuntime), /INVALID_BASELINE/);
  }
});
