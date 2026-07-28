import { createHash, randomUUID } from "node:crypto";

export const VERSION_SOURCES = Object.freeze(["hook-payload", "installer-probe", "unknown"]);
export const VERSION_FRESHNESS = Object.freeze(["execution-attested", "install-snapshot", "unknown"]);

const MAX_SERIALIZED_BYTES = 4096;
const SHA256 = /^[a-f0-9]{64}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const EVENT_KINDS = new Set(["routing.decision", "execution.usage"]);

const invalid = () => { throw new TypeError("INVALID_TELEMETRY_EVENT"); };
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasString = (value) => typeof value === "string" && value.length > 0;
const rfc3339 = (value) => hasString(value) && RFC3339.test(value) && !Number.isNaN(Date.parse(value));

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function validateRuntime(runtime) {
  if (!isRecord(runtime) || !hasString(runtime.family) || !hasString(runtime.surface)
    || !VERSION_SOURCES.includes(runtime.version_source) || !VERSION_FRESHNESS.includes(runtime.version_freshness)) invalid();

  const exactPairs = {
    "hook-payload": "execution-attested",
    "installer-probe": "install-snapshot",
    unknown: "unknown",
  };
  if (runtime.version_freshness !== exactPairs[runtime.version_source]) invalid();
  if (runtime.version_source === "unknown") {
    if (runtime.version !== null || runtime.version_observed_at !== null) invalid();
  } else if (!hasString(runtime.version) || !rfc3339(runtime.version_observed_at)) {
    invalid();
  }
}

function validateLinks(links) {
  if (!isRecord(links) || !["exact", "none"].includes(links.quality)) invalid();
  const refs = [links.session_ref, links.turn_ref, links.invocation_ref];
  if (links.quality === "exact" && (!refs.every((ref) => typeof ref === "string" && SHA256.test(ref)) || (links.agent_ref !== null && !SHA256.test(links.agent_ref)))) invalid();
  if (links.quality === "none" && (!refs.every((ref) => ref === null) || links.agent_ref !== null)) invalid();
}

function validateScope(scope, kind) {
  if (!isRecord(scope) || !["project", "global"].includes(scope.install_scope) || !hasString(scope.collector_instance_ref)
    || !Number.isInteger(scope.resolver_policy_version)) invalid();
  if (kind === "routing.decision") {
    if (!["project", "global"].includes(scope.selected_scope) || !SHA256.test(scope.contract_sha256)) invalid();
  } else if (scope.selected_scope !== null || scope.contract_sha256 !== null) invalid();
}

function validateRouting(event) {
  const { routing, model_evidence, usage, provenance } = event;
  if (!isRecord(routing) || !isRecord(model_evidence) || usage !== null || !isRecord(provenance)
    || !hasString(routing.role_kind) || !hasString(routing.decision) || !hasString(routing.reason)
    || !["unset", "inherit", "concrete", "unobserved"].includes(routing.environment_override)
    || !SHA256.test(provenance.policy_projection_sha256) || !Number.isInteger(provenance.projected_guidance_bytes)
    || provenance.projected_guidance_bytes < 0) invalid();
  if (routing.role_kind === "builtin" ? !hasString(routing.role_class) || routing.role_ref !== undefined : !SHA256.test(routing.role_ref)) invalid();
}

function validateUsage(event) {
  const { routing, model_evidence, usage, provenance } = event;
  if (routing !== null || !isRecord(model_evidence) || !isRecord(usage) || !isRecord(provenance)
    || !hasString(usage.final_input_model) || !hasString(usage.resolved_model)
    || !Number.isInteger(usage.total_tokens) || usage.total_tokens < 0
    || !["foreground", "async_launched", "unsupported"].includes(usage.completion_mode)) invalid();
}

function stableMaterial(material) {
  const scope = material.scope ?? material;
  const links = material.links ?? material;
  return [
    material.schema_version ?? 1,
    material.event_kind,
    scope.collector_instance_ref,
    links.session_ref,
    links.turn_ref,
    links.invocation_ref,
    links.agent_ref,
  ].join("|");
}

export function eventId(material) {
  if (!isRecord(material) || !hasString(material.event_kind)) invalid();
  return createHash("sha256").update(stableMaterial(material), "utf8").digest("hex");
}

function bounded(event) {
  const limitations = event.provenance.limitations;
  if (!Array.isArray(limitations)) invalid();
  while (Buffer.byteLength(JSON.stringify(event), "utf8") >= MAX_SERIALIZED_BYTES && limitations.length > 0) {
    limitations.pop();
    event.provenance.truncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(event), "utf8") >= MAX_SERIALIZED_BYTES) invalid();
}

export function createEvent(input) {
  if (!isRecord(input) || !EVENT_KINDS.has(input.event_kind) || !rfc3339(input.observed_at)) invalid();
  const event = clone(input);
  validateRuntime(event.runtime);
  validateScope(event.scope, event.event_kind);
  validateLinks(event.links);
  if (event.event_kind === "routing.decision") validateRouting(event);
  else validateUsage(event);

  event.schema = "orbitlane.routing-telemetry";
  event.schema_version = 1;
  event.dedup_quality = event.links.quality;
  event.event_id = event.links.quality === "exact" ? eventId(event) : randomUUID();
  bounded(event);
  return deepFreeze(event);
}
