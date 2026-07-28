import assert from "node:assert/strict";
import test from "node:test";

import { createEvent, eventId } from "../../src/telemetry/event.js";

const exactLinks = Object.freeze({
  session_ref: "a".repeat(64),
  turn_ref: "b".repeat(64),
  invocation_ref: "c".repeat(64),
  agent_ref: null,
  quality: "exact",
});

const routingInput = () => ({
  event_kind: "routing.decision",
  observed_at: "2026-07-27T00:00:00.000Z",
  runtime: {
    family: "claude",
    version: "2.1.220",
    version_source: "hook-payload",
    version_observed_at: "2026-07-27T00:00:00.000Z",
    version_freshness: "execution-attested",
    surface: "PreToolUse:Agent",
  },
  scope: {
    install_scope: "project",
    selected_scope: "project",
    collector_instance_ref: "collector-1",
    contract_sha256: "d".repeat(64),
    resolver_policy_version: 1,
  },
  links: exactLinks,
  routing: {
    role_kind: "builtin",
    role_class: "executor",
    decision: "allow",
    reason: "ROUTED_MODEL_INJECTED",
    requested_model: null,
    routed_model: "sonnet",
    routed_model_class: "terra",
    injected_model: "sonnet",
    injected_model_class: "terra",
    environment_override: "unset",
  },
  model_evidence: {},
  usage: null,
  provenance: {
    source: "runtime-hook",
    limitations: [],
    policy_projection_sha256: "e".repeat(64),
    projected_guidance_bytes: 64,
  },
});

test("policy provenance and exact event IDs are deterministic", () => {
  const first = createEvent(routingInput());
  const second = createEvent({ ...routingInput(), observed_at: "2026-07-27T00:00:01.000Z" });

  assert.equal(first.event_id, second.event_id);
  assert.equal(first.event_id, eventId(first));
  assert.equal(first.dedup_quality, "exact");
  assert.ok(Object.isFrozen(first));
});

test("link quality none uses a UUID and does not claim retry deduplication", () => {
  const event = createEvent({ ...routingInput(), links: { ...exactLinks, session_ref: null, turn_ref: null, invocation_ref: null, quality: "none" } });

  assert.match(event.event_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(event.dedup_quality, "none");
});

test("execution event permits only declared runtime freshness", () => {
  assert.throws(
    () => createEvent({ runtime: { version: "2.1.220", version_source: "hook-payload", version_observed_at: null, version_freshness: "install-snapshot" } }),
    /INVALID_TELEMETRY_EVENT/,
  );
});

test("event constructors reject wrong kind-specific fields and truncate oversized limitations", () => {
  assert.throws(() => createEvent({ ...routingInput(), usage: {} }), /INVALID_TELEMETRY_EVENT/);

  const event = createEvent({
    ...routingInput(),
    provenance: { ...routingInput().provenance, limitations: Array.from({ length: 1_000 }, () => "x".repeat(32)) },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(event), "utf8") < 4096);
  assert.equal(event.provenance.truncated, true);
});
