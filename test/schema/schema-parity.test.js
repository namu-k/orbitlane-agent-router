import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalLanes, claudeCapabilityMatrix } from "../../src/schema/index.js";

// The published JSON Schemas (with `$id` URLs) are consumed by external adapters,
// while index.js is the enforced/tested path. These parity tests fail if either
// source drifts from the other on the canonical facts.

const schema = async (name) => JSON.parse(
  await readFile(new URL(`../../src/schema/${name}`, import.meta.url), "utf8"),
);

const LANE_TO_DEF = { sol: "solLane", terra: "terraLane", luna: "lunaLane" };

test("contract.schema.json lane consts match the enforced canonical lanes", async () => {
  const contractSchema = await schema("contract.schema.json");
  const lanes = canonicalLanes();

  assert.deepEqual(
    contractSchema.properties.lanes.required,
    Object.keys(lanes),
    "schema required lanes must equal the canonical lane ids",
  );

  for (const [laneId, expected] of Object.entries(lanes)) {
    const def = contractSchema.$defs[LANE_TO_DEF[laneId]];
    assert.equal(def.properties.class.const, expected.class, `${laneId}.class const`);
    assert.equal(def.properties.reasoning.const, expected.reasoning, `${laneId}.reasoning const`);
  }
});

test("the JSON schema and validateRoles agree on absent versus empty roles", async () => {
  const contractSchema = JSON.parse(
    await readFile(new URL("../../src/schema/contract.schema.json", import.meta.url), "utf8"),
  );

  assert.ok(!contractSchema.required.includes("roles"), "roles must not be required by the JSON schema");
  assert.equal(contractSchema.properties.roles.minProperties, 1, "an empty roles object must stay invalid");
});

test("the JSON schema mirrors the marker-safe model-token grammar", async () => {
  const contractSchema = await schema("contract.schema.json");
  assert.equal(
    contractSchema.$defs.modelBinding.properties.model.pattern,
    "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
  );
});

test("capability-matrix.schema.json reasoning consts match the enforced capability", async () => {
  const capabilitySchema = await schema("capability-matrix.schema.json");
  const { reasoning } = claudeCapabilityMatrix();

  for (const [field, value] of Object.entries(reasoning)) {
    assert.equal(
      capabilitySchema.properties.reasoning.properties[field].const,
      value,
      `reasoning.${field} const`,
    );
  }
});

test("telemetry schema is a closed kind-specific contract", async () => {
  const telemetry = await schema("routing-telemetry-event.schema.json");
  assert.equal(telemetry.additionalProperties, false);
  assert.equal(telemetry.$defs.billingUnits.additionalProperties, false);
  assert.deepEqual(telemetry.$defs.billingUnits.required, [
    "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_write_5m_input_tokens",
    "cache_write_1h_input_tokens", "web_search_requests", "web_fetch_requests",
  ]);
  const execution = telemetry.oneOf.find((branch) => branch.properties.event_kind.const === "execution.usage");
  assert.equal(execution.properties.provenance.$ref, "#/$defs/executionProvenance");
  assert.deepEqual(telemetry.$defs.executionProvenance.properties.policy_projection_sha256, false);
  assert.deepEqual(telemetry.$defs.executionProvenance.properties.projected_guidance_bytes, false);
  assert.ok(telemetry.$defs.routing.required.includes("routing_outcome"));
});
