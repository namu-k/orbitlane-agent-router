import { resolveClaudeRequestedRoutes } from "../adapters/claude/index.js";
import { isInjectableClaudeModel } from "../config/claude-models.js";
import { createEvent } from "../telemetry/event.js";
import { hmacRef } from "../telemetry/identity.js";
import { FILE_MODE_LIMITATIONS, appendJsonl } from "../telemetry/storage.js";

// An explicit model — on the call, or a concrete CLAUDE_CODE_SUBAGENT_MODEL — is a
// deliberate choice. The router yields to it and records the divergence rather than
// blocking: a denied spawn spends tokens on a failed turn and a retry, which is the
// opposite of what the contract exists to achieve.
//
// The order mirrors the runtime's own resolution, which puts the environment variable
// ABOVE the per-invocation parameter: CLAUDE_CODE_SUBAGENT_MODEL overrides the model
// argument and the frontmatter. Reading the call first would make the heartbeat name a
// model the session never ran. `inherit` is not a choice — since v2.1.196 it means
// "continue resolving", so resolution falls through to the call.
// https://code.claude.com/docs/en/sub-agents#choose-a-model
function explicitModel(input) {
  const environment = input.environment_model === "inherit" ? undefined : input.environment_model;
  for (const candidate of [environment, input.model, input.model_override]) {
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

export function evaluateClaudeAgentSpawn({ input, contract, runtimeDefaults }) {
  // Without a role name there is nothing to look up, managed or not.
  if (typeof input?.subagent_type !== "string") {
    return Object.freeze({ exitCode: 2, decision: "deny", reason: "INVALID_AGENT_TOOL_INPUT", effective_model: "unproven" });
  }
  let routes;
  try { routes = resolveClaudeRequestedRoutes(contract, runtimeDefaults); } catch (error) {
    return Object.freeze({ exitCode: 2, decision: "deny", reason: error.message.startsWith("AMBIGUOUS_MODEL_RESOLUTION") ? "AMBIGUOUS_MODEL_RESOLUTION" : "INVALID_CONTRACT", effective_model: "unproven" });
  }
  const route = routes[input.subagent_type];
  if (route === undefined) {
    // The contract does not route this role, so the guard does not govern it. Pass it
    // through and log it as unmanaged rather than blocking it (spec 9.4). Enforcement
    // applies only to the roles the contract actually routes; the built-in Claude Code
    // agent types stay usable.
    return Object.freeze({ exitCode: 0, decision: "allow", reason: "UNMANAGED_ROLE", effective_model: "unproven" });
  }
  const declared = explicitModel(input);
  if (declared !== undefined) {
    return Object.freeze(declared === route.model
      ? { exitCode: 0, decision: "allow", reason: "CONTRACT_MATCH", effective_model: "unproven" }
      : { exitCode: 0, decision: "allow", reason: "EXPLICIT_MODEL_RETAINED", effective_model: "unproven", declared_model: declared, routed_model: route.model });
  }
  // `inherit` means opposite things across versions and the guard cannot tell them
  // apart: from v2.1.196 it is the same as unset and resolution continues to the call,
  // but before that it forced the main conversation's model and ignored the call
  // outright. Injecting would therefore be silently dropped on an older runtime while
  // the heartbeat claimed a route had been written. No version reaches the hook — the
  // payload carries none and shelling out to read one would blow the latency budget —
  // so withhold routing rather than record something that may not have happened.
  // https://code.claude.com/docs/en/sub-agents#choose-a-model
  if (input.environment_model === "inherit") {
    return Object.freeze({ exitCode: 0, decision: "allow", reason: "ROUTED_MODEL_WITHHELD_INHERIT", effective_model: "unproven", routed_model: route.model });
  }
  // No explicit model: this is the one point where the contract can still route, so
  // fill the lane's model in. A model outside the injectable allowlist is left alone —
  // breaking the spawn costs more than passing it through unrouted.
  if (!isInjectableClaudeModel(route.model)) {
    return Object.freeze({ exitCode: 0, decision: "allow", reason: "ROUTED_MODEL_NOT_INJECTABLE", effective_model: "unproven", routed_model: route.model });
  }
  // Only the model is returned, not a rewritten input: `input` carries fields the
  // guard synthesised (environment_model), which must not leak back into the call.
  return Object.freeze({ exitCode: 0, decision: "allow", reason: "ROUTED_MODEL_INJECTED", effective_model: "unproven", routed_model: route.model, injected_model: route.model });
}

const BUILTIN_ROLES = new Set(["architect", "critic", "executor", "team-executor", "verifier", "test-engineer", "explore"]);
const OUTCOME_BY_REASON = Object.freeze({ ROUTED_MODEL_INJECTED: "rewrite_emitted", CONTRACT_MATCH: "explicit_or_override_match", EXPLICIT_MODEL_RETAINED: "explicit_model_retained", ROUTED_MODEL_WITHHELD_INHERIT: "rewrite_withheld", ROUTED_MODEL_NOT_INJECTABLE: "rewrite_withheld", UNMANAGED_ROLE: "outside_routing_scope", INVALID_AGENT_TOOL_INPUT: "denied_invalid_input", AMBIGUOUS_MODEL_RESOLUTION: "denied_ambiguous_resolution", INVALID_CONTRACT: "denied_invalid_contract" });

function environmentOverride(input) {
  if (input.environment_model === "inherit") return "inherit";
  return typeof input.environment_model === "string" ? "concrete" : "unset";
}

function decisionEvent({ input, result, contract, scope, contractSha256, resolverPolicyVersion, collectorInstanceRef, telemetryKey, identifiers, policyProvenance, now }) {
  if (!telemetryKey || !collectorInstanceRef || !policyProvenance || !["project", "global"].includes(scope)
    || !/^[a-f0-9]{64}$/.test(contractSha256 ?? "") || ![identifiers?.session, identifiers?.turn, identifiers?.invocation].every((value) => typeof value === "string" && value.length > 0)) return undefined;
  const role = input.subagent_type;
  const lane = contract?.roles?.[role]?.lane;
  const roleKind = BUILTIN_ROLES.has(role) ? "builtin" : "custom";
  const requestedModel = explicitModel(input) ?? null;
  const routeClass = result.routed_model === null || result.routed_model === undefined ? null : lane ?? null;
  return createEvent({
    event_kind: "routing.decision", observed_at: now(),
    runtime: { family: "claude", version: null, version_source: "unknown", version_observed_at: null, version_freshness: "unknown", surface: "PreToolUse:Agent" },
    scope: { install_scope: scope, selected_scope: scope, collector_instance_ref: collectorInstanceRef, contract_sha256: contractSha256, resolver_policy_version: resolverPolicyVersion ?? 1 },
    links: { session_ref: hmacRef(telemetryKey, identifiers.session), turn_ref: hmacRef(telemetryKey, identifiers.turn), invocation_ref: hmacRef(telemetryKey, identifiers.invocation), agent_ref: null, quality: "exact" },
    routing: {
      role_kind: roleKind, ...(roleKind === "builtin" ? { role_class: role } : { role_ref: hmacRef(telemetryKey, role) }),
      decision: result.decision, reason: result.reason, routing_outcome: OUTCOME_BY_REASON[result.reason] ?? "unknown_guard_outcome",
      requested_model: requestedModel, routed_model: result.routed_model ?? null, routed_model_class: routeClass,
      injected_model: result.injected_model ?? null, injected_model_class: result.injected_model === undefined ? null : lane ?? null,
      environment_override: environmentOverride(input),
    },
    model_evidence: {}, usage: null,
    provenance: { source: "runtime-hook", limitations: ["effective-model-unproven", ...FILE_MODE_LIMITATIONS], policy_projection_sha256: policyProvenance.policy_projection_sha256, projected_guidance_bytes: policyProvenance.projected_guidance_bytes },
  });
}

export async function runClaudeSpawnGuard({ input, contract, runtimeDefaults, telemetryRoot, telemetryBase, collectorInstanceRef, telemetryKey, identifiers, appendTelemetry, now = () => new Date().toISOString(), scope, contractSha256, policyProvenance, resolverPolicyVersion }) {
  let result;
  try {
    result = evaluateClaudeAgentSpawn({ input, contract, runtimeDefaults });
  } catch (error) {
    result = Object.freeze({ exitCode: 2, decision: "deny", reason: error.code ?? "GUARD_ERROR", effective_model: "unproven" });
  }
  let event;
  try {
    event = decisionEvent({ input, result, contract, scope, contractSha256, resolverPolicyVersion, collectorInstanceRef, telemetryKey, identifiers, policyProvenance, now });
    if (event === undefined) return Object.freeze({ ...result, telemetry_recorded: false });
    const outcome = await (appendTelemetry ?? ((entry) => appendJsonl(telemetryRoot, entry, { trustedBase: telemetryBase })))(event);
    return Object.freeze({ ...result, telemetry_recorded: outcome?.written !== false });
  } catch {
    return Object.freeze({ ...result, telemetry_recorded: false });
  }
}

export function auditClaudeSpawnGuard({ expectedCorrelationIds = [], heartbeats = [] }) {
  const valid = heartbeats.filter((heartbeat) => typeof heartbeat?.correlation_id === "string" && heartbeat.correlation_id.length > 0
    && typeof heartbeat.timestamp === "string" && !Number.isNaN(Date.parse(heartbeat.timestamp))
    && (heartbeat.decision === "allow" || heartbeat.decision === "deny") && typeof heartbeat.reason === "string");
  const observed = new Set(valid.map((heartbeat) => heartbeat.correlation_id));
  const missing = expectedCorrelationIds.filter((id) => !observed.has(id));
  return Object.freeze({
    claude_agent_pre_dispatch: Object.freeze(missing.length === 0
      ? { status: "enforced", scope: "Agent tool only" }
      : { status: "unproven", scope: "coverage-withdrawn-heartbeat-gap" }),
    effective_model: "unproven",
    missing_heartbeats: Object.freeze(missing),
  });
}
