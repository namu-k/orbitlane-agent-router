import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalLanes, claudeCapabilityMatrix } from "../../src/schema/index.js";
import { createEvent } from "../../src/telemetry/event.js";

// The published JSON Schemas (with `$id` URLs) are consumed by external adapters,
// while index.js is the enforced/tested path. These parity tests fail if either
// source drifts from the other on the canonical facts.

const schema = async (name) => JSON.parse(
  await readFile(new URL(`../../src/schema/${name}`, import.meta.url), "utf8"),
);

const LANE_TO_DEF = { sol: "solLane", terra: "terraLane", luna: "lunaLane" };

function typeMatches(type, value) {
  if (Array.isArray(type)) return type.some((candidate) => typeMatches(candidate, value));
  return ({ object: value !== null && typeof value === "object" && !Array.isArray(value), array: Array.isArray(value), string: typeof value === "string", integer: Number.isInteger(value), number: typeof value === "number", boolean: typeof value === "boolean", null: value === null })[type];
}

function schemaMatches(schemaNode, value, root) {
  if (schemaNode === false) return false;
  if (schemaNode === true || !schemaNode) return true;
  if (schemaNode.$ref) return schemaMatches(schemaNode.$ref.split("/").slice(1).reduce((node, key) => node[key], root), value, root);
  if (schemaNode.const !== undefined && !Object.is(value, schemaNode.const)) return false;
  if (schemaNode.enum && !schemaNode.enum.some((candidate) => Object.is(candidate, value))) return false;
  if (schemaNode.type && !typeMatches(schemaNode.type, value)) return false;
  if (schemaNode.pattern && (typeof value !== "string" || !(new RegExp(schemaNode.pattern)).test(value))) return false;
  if (schemaNode.minLength !== undefined && (typeof value !== "string" || value.length < schemaNode.minLength)) return false;
  if (schemaNode.minimum !== undefined && (typeof value !== "number" || value < schemaNode.minimum)) return false;
  if (schemaNode.required && (!value || schemaNode.required.some((key) => !Object.hasOwn(value, key)))) return false;
  if (schemaNode.properties && value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(schemaNode.properties)) if (Object.hasOwn(value, key) && !schemaMatches(child, value[key], root)) return false;
    if (schemaNode.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(schemaNode.properties, key))) return false;
  }
  if (schemaNode.items && Array.isArray(value) && !value.every((item) => schemaMatches(schemaNode.items, item, root))) return false;
  if (schemaNode.oneOf && schemaNode.oneOf.filter((child) => schemaMatches(child, value, root)).length !== 1) return false;
  if (schemaNode.anyOf && !schemaNode.anyOf.some((child) => schemaMatches(child, value, root))) return false;
  if (schemaNode.allOf && !schemaNode.allOf.every((child) => schemaMatches(child, value, root))) return false;
  if (schemaNode.not && schemaMatches(schemaNode.not, value, root)) return false;
  if (schemaNode.if && schemaMatches(schemaNode.if, value, root) && schemaNode.then && !schemaMatches(schemaNode.then, value, root)) return false;
  if (schemaNode.if && !schemaMatches(schemaNode.if, value, root) && schemaNode.else && !schemaMatches(schemaNode.else, value, root)) return false;
  return true;
}

const routingInput = () => ({
  event_kind: "routing.decision", observed_at: "2026-07-27T00:00:00.000Z",
  runtime: { family: "claude", version: "2.1.220", version_source: "hook-payload", version_observed_at: "2026-07-27T00:00:00.000Z", version_freshness: "execution-attested", surface: "PreToolUse:Agent" },
  scope: { install_scope: "project", selected_scope: "project", collector_instance_ref: "collector-1", contract_sha256: "d".repeat(64), resolver_policy_version: 1 },
  links: { session_ref: "a".repeat(64), turn_ref: "b".repeat(64), invocation_ref: "c".repeat(64), agent_ref: null, quality: "exact" },
  routing: { role_kind: "builtin", role_class: "executor", decision: "allow", reason: "ROUTED_MODEL_INJECTED", routing_outcome: "rewrite_emitted", requested_model: null, routed_model: "sonnet", routed_model_class: "terra", injected_model: "sonnet", injected_model_class: "terra", environment_override: "unset" },
  model_evidence: {}, usage: null,
  provenance: { source: "runtime-hook", limitations: [], policy_projection_sha256: "e".repeat(64), projected_guidance_bytes: 64 },
});

const usageInput = () => ({
  ...routingInput(), event_kind: "execution.usage", runtime: { ...routingInput().runtime, surface: "PostToolUse:Agent" },
  scope: { ...routingInput().scope, selected_scope: null, contract_sha256: null }, routing: null,
  usage: { final_input_model: "sonnet", resolved_model: "sonnet", total_tokens: 7, billing_units: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_write_5m_input_tokens: 0, cache_write_1h_input_tokens: 0, web_search_requests: 0, web_fetch_requests: 0 }, completion_mode: "foreground" },
  provenance: { source: "runtime-hook", limitations: [] },
});

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

test("telemetry schema and runtime validator reject the same cross-field violations", async () => {
  const telemetry = await schema("routing-telemetry-event.schema.json");
  const validRouting = createEvent(routingInput());
  const validUsage = createEvent(usageInput());
  assert.ok(schemaMatches(telemetry, validRouting, telemetry));
  assert.ok(schemaMatches(telemetry, validUsage, telemetry));

  const cases = [
    [() => ({ ...routingInput(), runtime: { ...routingInput().runtime, version_freshness: "install-snapshot" } }), (event) => { event.runtime.version_freshness = "install-snapshot"; }],
    [() => ({ ...usageInput(), scope: { ...usageInput().scope, selected_scope: "project" } }), (event) => { event.scope.selected_scope = "project"; }],
    [() => ({ ...routingInput(), links: { ...routingInput().links, invocation_ref: null } }), (event) => { event.links.invocation_ref = null; }],
    [() => ({ ...routingInput(), routing: { ...routingInput().routing, routing_outcome: "rewrite_withheld" } }), (event) => { event.routing.routing_outcome = "rewrite_withheld"; }],
    [() => ({ ...routingInput(), routing: { ...routingInput().routing, routed_model_class: null } }), (event) => { event.routing.routed_model_class = null; }],
    [() => ({ ...routingInput(), routing: { ...routingInput().routing, injected_model: null, injected_model_class: null } }), (event) => { event.routing.injected_model = null; event.routing.injected_model_class = null; }],
    [() => ({ ...routingInput(), provenance: { ...routingInput().provenance, limitations: [7] } }), (event) => { event.provenance.limitations = [7]; }],
  ];
  for (const [input, mutate] of cases) {
    assert.throws(() => createEvent(input()), /INVALID_TELEMETRY_EVENT/);
    const candidate = structuredClone(input().event_kind === "routing.decision" ? validRouting : validUsage);
    mutate(candidate);
    assert.equal(schemaMatches(telemetry, candidate, telemetry), false);
  }
});
