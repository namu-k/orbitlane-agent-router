import assert from "node:assert/strict";
import test from "node:test";

import { classifyResolution, electWriter, projectEvents } from "../../src/telemetry/projector.js";

const runtime = Object.freeze({
  family: "claude",
  version: "2.1.220",
  version_freshness: "execution-attested",
});

const baseline = Object.freeze({
  model: "claude-opus-4-8",
  provenance: "user_declared",
  source_kind: "user-declared-profile",
  source_sha256: "a".repeat(64),
  captured_at: "2026-07-27T00:00:00.000Z",
  freshness: "not-applicable",
  runtime_version_range: { min_inclusive: "2.1.220", max_inclusive: "2.1.220" },
});

const catalog = Object.freeze({
  models: Object.freeze([
    Object.freeze({
      model_token: "claude-sonnet-5",
      request_aliases: Object.freeze([
        Object.freeze({
          alias: "sonnet",
          runtime_family: "claude",
          runtime_version_range: Object.freeze({ min_inclusive: "2.1.220", max_inclusive: "2.1.220" }),
        }),
      ]),
    }),
  ]),
});

const decision = (overrides = {}) => ({
  event_id: "decision-1",
  event_kind: "routing.decision",
  observed_at: "2026-07-27T00:00:00.000Z",
  runtime,
  scope: {
    install_scope: "project",
    selected_scope: "project",
    collector_instance_ref: "collector-1",
  },
  links: { invocation_ref: "invocation-1", quality: "exact" },
  routing: {
    routing_outcome: "rewrite_emitted",
    injected_model: "sonnet",
  },
  provenance: { source: "runtime-hook" },
  ...overrides,
});

const usage = (overrides = {}) => ({
  event_id: "usage-1",
  event_kind: "execution.usage",
  observed_at: "2026-07-27T00:00:01.000Z",
  runtime,
  scope: {
    install_scope: "project",
    selected_scope: null,
    collector_instance_ref: "collector-1",
  },
  links: { invocation_ref: "invocation-1", quality: "exact" },
  usage: {
    final_input_model: "sonnet",
    resolved_model: "claude-sonnet-5",
    total_tokens: 7,
    billing_units: {
      input_tokens: 1,
      output_tokens: 2,
      cache_read_input_tokens: 0,
      cache_write_5m_input_tokens: 0,
      cache_write_1h_input_tokens: 0,
      web_search_requests: 0,
      web_fetch_requests: 0,
    },
    completion_mode: "foreground",
    iteration_count: 1,
  },
  provenance: { source: "runtime-hook" },
  ...overrides,
});

test("writer election selects only the post emitted by the selected install scope", () => {
  assert.equal(electWriter(decision(), usage()), "SELECTED");
  assert.equal(electWriter(decision(), usage({ scope: { ...usage().scope, install_scope: "global" } })), "ORPHANED_UNSELECTED_SCOPE");
  assert.equal(electWriter(undefined, usage()), "ORPHANED_NO_PRE");
});

test("resolution distinguishes exact full tokens, fresh aliases, unmapped aliases, and conflicts", () => {
  const exact = {
    decision: decision({ routing: { routing_outcome: "rewrite_emitted", injected_model: "claude-sonnet-5" } }),
    usage: usage({ usage: { ...usage().usage, final_input_model: "claude-sonnet-5" } }),
  };
  assert.equal(classifyResolution(exact, catalog), "exact-token");
  assert.equal(classifyResolution({ decision: decision(), usage: usage() }, catalog), "versioned-alias-binding");

  const installSnapshot = usage({ runtime: { ...runtime, version_freshness: "install-snapshot" } });
  assert.equal(classifyResolution({ decision: decision(), usage: installSnapshot }, catalog), "unmapped");
  assert.equal(classifyResolution({
    decision: decision(),
    usage: usage({ usage: { ...usage().usage, resolved_model: "claude-opus-4-8" } }),
  }, catalog), "conflict");
});

test("projector deduplicates IDs, exact-joins by collector and invocation, and reports orphaned posts", () => {
  const selected = usage();
  const unselected = usage({
    event_id: "usage-unselected",
    scope: { ...usage().scope, install_scope: "global" },
  });
  const noPre = usage({
    event_id: "usage-no-pre",
    links: { invocation_ref: "invocation-missing", quality: "exact" },
  });
  const projection = projectEvents({
    decisions: [decision(), decision()],
    usages: [selected, selected, unselected, noPre],
    baseline,
    catalog,
  });

  assert.deepEqual(projection.duplicates, { decisions: 1, usages: 1, total: 2 });
  assert.equal(projection.joined.length, 1);
  assert.equal(projection.joined[0].join_status, "APPLIED_AND_RESOLVED");
  assert.equal(projection.joined[0].resolution, "versioned-alias-binding");
  assert.equal(projection.joined[0].estimate_status, "eligible");
  assert.equal(projection.eligible.length, 1);
  assert.deepEqual(projection.orphaned.map((entry) => entry.election).sort(), [
    "ORPHANED_NO_PRE",
    "ORPHANED_UNSELECTED_SCOPE",
  ]);
  assert.deepEqual(projection.coverage, {
    routing_decisions: 1,
    selected_posts: 1,
    eligible: 1,
    orphaned_unselected_scope: 1,
    orphaned_no_pre: 1,
  });
});

test("projector never joins a different collector instance or a link-quality-none event", () => {
  const wrongCollector = usage({
    event_id: "usage-other-collector",
    scope: { ...usage().scope, collector_instance_ref: "collector-2" },
  });
  const noLink = usage({
    event_id: "usage-no-link",
    links: { invocation_ref: null, quality: "none" },
  });
  const projection = projectEvents({ decisions: [decision()], usages: [wrongCollector, noLink], baseline, catalog });

  assert.equal(projection.joined[0].join_status, "FAILED_OR_INCOMPLETE");
  assert.equal(projection.joined[0].estimate_status, "evidence_only");
  assert.equal(projection.orphaned.length, 2);
  assert.ok(projection.orphaned.every((entry) => entry.election === "ORPHANED_NO_PRE"));
});

test("projector classifies non-eligible join outcomes without manufacturing point estimates", () => {
  const cases = [
    {
      name: "unmapped",
      post: usage({ runtime: { ...runtime, version_freshness: "unknown", version: null } }),
      expected: "APPLIED_RESOLUTION_UNMAPPED",
    },
    {
      name: "overridden",
      post: usage({ usage: { ...usage().usage, resolved_model: "claude-opus-4-8" } }),
      expected: "APPLIED_BUT_OVERRIDDEN",
    },
    {
      name: "same outcome without applied rewrite",
      post: usage({ usage: { ...usage().usage, final_input_model: "opus" } }),
      expected: "NOT_APPLIED_SAME_OUTCOME",
    },
    {
      name: "different outcome without applied rewrite",
      post: usage({ usage: { ...usage().usage, final_input_model: "opus", resolved_model: "claude-opus-4-8" } }),
      expected: "NOT_APPLIED_DIFFERENT_OUTCOME",
    },
    {
      name: "async",
      post: usage({ usage: { ...usage().usage, completion_mode: "async_launched" } }),
      expected: "ASYNC_USAGE_UNAVAILABLE",
    },
    {
      name: "multi iteration",
      post: usage({ usage: { ...usage().usage, iteration_count: 2 } }),
      expected: "MULTI_ITERATION_UNVERIFIED",
    },
  ];

  for (const entry of cases) {
    const projection = projectEvents({ decisions: [decision()], usages: [entry.post], baseline, catalog });
    assert.equal(projection.joined[0].join_status, entry.expected, entry.name);
    assert.equal(projection.joined[0].estimate_status, "evidence_only", entry.name);
    assert.equal(projection.eligible.length, 0, entry.name);
  }

  const retained = decision({
    routing: { routing_outcome: "explicit_model_retained", injected_model: null },
  });
  assert.equal(projectEvents({ decisions: [retained], usages: [], baseline, catalog }).joined[0].join_status, "EXPLICIT_MODEL_RETAINED");
});

test("unknown usage fields and behavioral records remain evidence-only", () => {
  const unknownUsage = usage({ usage: { ...usage().usage, provider_cost_usd: 1.23 } });
  const behavioral = { event_id: "behavioral-1", event_kind: "behavioral.report", provider_session_cost_usd: 9.99 };
  const projection = projectEvents({ decisions: [decision()], usages: [unknownUsage, behavioral], baseline, catalog });

  assert.equal(projection.joined[0].join_status, "FAILED_OR_INCOMPLETE");
  assert.deepEqual(projection.joined[0].limitations, ["unsupported-usage-fields"]);
  assert.equal(projection.joined[0].estimate_status, "evidence_only");
  assert.deepEqual(projection.ignored, [{ event: behavioral, estimate_status: "evidence_only", reason: "BEHAVIORAL_EVIDENCE_ONLY" }]);
});

test("projector rejects malformed baseline metadata instead of silently granting evidence status", () => {
  assert.throws(() => projectEvents({
    decisions: [decision()],
    usages: [usage()],
    baseline: { ...baseline, source_sha256: "not-a-hash" },
    catalog,
  }), /INVALID_BASELINE/);
});

test("installer snapshot cannot enable versioned alias point reprice", () => {
  const installSnapshotUsage = usage({ runtime: { ...runtime, version_freshness: "install-snapshot" } });
  const projection = projectEvents({
    decisions: [decision()],
    usages: [installSnapshotUsage],
    baseline,
    catalog,
  });

  assert.equal(classifyResolution({ decision: decision(), usage: installSnapshotUsage }, catalog), "unmapped");
  assert.equal(projection.eligible.length, 0);
  assert.equal(projection.joined[0].estimate_status, "evidence_only");
});
