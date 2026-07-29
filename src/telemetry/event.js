import { createHash, randomUUID } from "node:crypto";

export const VERSION_SOURCES = Object.freeze(["hook-payload", "installer-probe", "unknown"]);
export const VERSION_FRESHNESS = Object.freeze(["execution-attested", "install-snapshot", "unknown"]);

const MAX_SERIALIZED_BYTES = 4096;
const SHA256 = /^[a-f0-9]{64}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const EVENT_KINDS = new Set(["routing.decision", "execution.usage"]);
const BUILTIN_ROLE_CLASSES = new Set(["architect", "critic", "executor", "team-executor", "verifier", "test-engineer", "explore"]);
const MODEL_CLASSES = new Set(["sol", "terra", "luna"]);
const ROUTING_OUTCOMES = new Set(["rewrite_emitted", "explicit_or_override_match", "explicit_model_retained", "rewrite_withheld", "outside_routing_scope", "denied_invalid_input", "denied_ambiguous_resolution", "denied_invalid_contract", "unknown_guard_outcome"]);
const OUTCOME_BY_REASON = Object.freeze({
  ROUTED_MODEL_INJECTED: "rewrite_emitted",
  CONTRACT_MATCH: "explicit_or_override_match",
  EXPLICIT_MODEL_RETAINED: "explicit_model_retained",
  ROUTED_MODEL_WITHHELD_INHERIT: "rewrite_withheld",
  ROUTED_MODEL_NOT_INJECTABLE: "rewrite_withheld",
  UNMANAGED_ROLE: "outside_routing_scope",
  INVALID_AGENT_TOOL_INPUT: "denied_invalid_input",
  AMBIGUOUS_MODEL_RESOLUTION: "denied_ambiguous_resolution",
  INVALID_CONTRACT: "denied_invalid_contract",
});
const BILLING_UNITS = Object.freeze(["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_write_5m_input_tokens", "cache_write_1h_input_tokens", "web_search_requests", "web_fetch_requests"]);
const SENSITIVE_KEY = /^(?:session(?:[_-]?id)?|turn(?:[_-]?id)?|invocation(?:[_-]?id)?|tool(?:[_-]?(?:use)?[_-]?id)?|prompt|cwd|transcript(?:[_-]?path)?|(?:user(?:[_-]?name)?|email)|response|project(?:[_-]?path)?)$/i;

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

function rejectSensitive(value) {
  if (!isRecord(value) && !Array.isArray(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) invalid();
    rejectSensitive(nested);
  }
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
    || !ROUTING_OUTCOMES.has(routing.routing_outcome)
    || !["unset", "inherit", "concrete", "unobserved"].includes(routing.environment_override)
    || !SHA256.test(provenance.policy_projection_sha256) || !Number.isInteger(provenance.projected_guidance_bytes)
    || provenance.projected_guidance_bytes < 0 || !hasString(provenance.source) || !Array.isArray(provenance.limitations)) invalid();
  if (routing.role_kind === "builtin" ? !BUILTIN_ROLE_CLASSES.has(routing.role_class) || routing.role_ref !== undefined : routing.role_kind !== "custom" || !SHA256.test(routing.role_ref) || routing.role_class !== undefined) invalid();
  for (const field of ["requested_model", "routed_model", "injected_model"]) {
    if (routing[field] !== null && !hasString(routing[field])) invalid();
  }
  for (const field of ["routed_model", "injected_model"]) {
    const classField = `${field}_class`;
    if (routing[field] === null ? routing[classField] !== null : !MODEL_CLASSES.has(routing[classField])) invalid();
  }
  if (routing.routing_outcome !== (OUTCOME_BY_REASON[routing.reason] ?? "unknown_guard_outcome")) invalid();
  if (routing.routing_outcome === "rewrite_emitted" && (routing.routed_model === null || routing.injected_model === null)) invalid();
}

function validateUsage(event) {
  const { routing, model_evidence, usage, provenance } = event;
  if (routing !== null || !isRecord(model_evidence) || !isRecord(usage) || !isRecord(provenance)
    || !hasString(usage.final_input_model) || !hasString(usage.resolved_model)
    || !Number.isInteger(usage.total_tokens) || usage.total_tokens < 0
    || !["foreground", "async_launched", "unsupported"].includes(usage.completion_mode)
    || !hasString(provenance.source) || !Array.isArray(provenance.limitations)) invalid();
  if (usage.iteration_count !== undefined && (!Number.isInteger(usage.iteration_count) || usage.iteration_count < 0)) invalid();
  if (!isRecord(usage.billing_units) || Object.keys(usage.billing_units).length !== BILLING_UNITS.length) invalid();
  for (const unit of BILLING_UNITS) if (!Number.isInteger(usage.billing_units[unit]) || usage.billing_units[unit] < 0) invalid();
  if (Object.hasOwn(provenance, "policy_projection_sha256") || Object.hasOwn(provenance, "projected_guidance_bytes")) invalid();
}

function envelope(input) {
  const runtime = input.runtime;
  const scope = input.scope;
  const links = input.links;
  const routing = input.routing;
  const provenance = input.provenance;
  return {
    event_kind: input.event_kind,
    observed_at: input.observed_at,
    runtime: { family: runtime?.family, version: runtime?.version, version_source: runtime?.version_source, version_observed_at: runtime?.version_observed_at, version_freshness: runtime?.version_freshness, surface: runtime?.surface },
    scope: { install_scope: scope?.install_scope, selected_scope: scope?.selected_scope, collector_instance_ref: scope?.collector_instance_ref, contract_sha256: scope?.contract_sha256, resolver_policy_version: scope?.resolver_policy_version },
    links: { session_ref: links?.session_ref, turn_ref: links?.turn_ref, invocation_ref: links?.invocation_ref, agent_ref: links?.agent_ref, quality: links?.quality },
    routing: input.event_kind === "routing.decision" ? {
      role_kind: routing?.role_kind, role_class: routing?.role_class, role_ref: routing?.role_ref,
      decision: routing?.decision, reason: routing?.reason, routing_outcome: routing?.routing_outcome,
      requested_model: routing?.requested_model, routed_model: routing?.routed_model, routed_model_class: routing?.routed_model_class,
      injected_model: routing?.injected_model, injected_model_class: routing?.injected_model_class, environment_override: routing?.environment_override,
    } : null,
    model_evidence: {},
    usage: input.event_kind === "execution.usage" ? {
      final_input_model: input.usage?.final_input_model, resolved_model: input.usage?.resolved_model,
      total_tokens: input.usage?.total_tokens, billing_units: clone(input.usage?.billing_units), completion_mode: input.usage?.completion_mode,
      ...(input.usage?.iteration_count === undefined ? {} : { iteration_count: input.usage.iteration_count }),
    } : null,
    provenance: input.event_kind === "routing.decision" ? {
      source: provenance?.source, limitations: clone(provenance?.limitations), policy_projection_sha256: provenance?.policy_projection_sha256,
      projected_guidance_bytes: provenance?.projected_guidance_bytes,
    } : { source: provenance?.source, limitations: clone(provenance?.limitations) },
  };
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
  if ((input.event_kind === "routing.decision" && input.usage !== null)
    || (input.event_kind === "execution.usage" && input.routing !== null)
    || (input.event_kind === "execution.usage" && (Object.hasOwn(input.provenance ?? {}, "policy_projection_sha256") || Object.hasOwn(input.provenance ?? {}, "projected_guidance_bytes")))) invalid();
  rejectSensitive(input);
  const event = envelope(input);
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
