import assert from "node:assert/strict";
import test from "node:test";

import { hmacRef, projectedGuidanceProvenance } from "../../src/telemetry/identity.js";

test("policy provenance hashes exact marker-bounded bytes", () => {
  const policy = "<!-- ORBITLANE:START claude -->\nroute\n<!-- ORBITLANE:END claude -->\n";
  const provenance = projectedGuidanceProvenance(policy);

  assert.equal(provenance.projected_guidance_bytes, Buffer.byteLength(policy, "utf8"));
  assert.match(provenance.policy_projection_sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => projectedGuidanceProvenance(policy.trimEnd()), /INVALID_POLICY_PROJECTION/);
});

test("HMAC references are deterministic without exposing raw identifiers", () => {
  const ref = hmacRef("test-key", "session-123");

  assert.equal(ref, hmacRef("test-key", "session-123"));
  assert.notEqual(ref, hmacRef("test-key", "session-456"));
  assert.match(ref, /^[a-f0-9]{64}$/);
  assert.ok(!ref.includes("session-123"));
});
