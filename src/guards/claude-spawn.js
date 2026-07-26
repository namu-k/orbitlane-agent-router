import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { resolveClaudeRequestedRoutes } from "../adapters/claude/index.js";
import { isInjectableClaudeModel } from "../config/claude-models.js";

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

async function appendJsonLine(path, entry) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function runClaudeSpawnGuard({ input, contract, runtimeDefaults, evidencePath, correlationId, appendHeartbeat, now = () => new Date().toISOString(), scope, contractSha256, reportPath, resolverPolicyVersion }) {
  let result;
  try {
    result = evaluateClaudeAgentSpawn({ input, contract, runtimeDefaults });
  } catch (error) {
    result = Object.freeze({ exitCode: 2, decision: "deny", reason: error.code ?? "GUARD_ERROR", effective_model: "unproven" });
  }
  const heartbeat = Object.freeze({
    correlation_id: correlationId ?? null,
    timestamp: now(),
    decision: result.decision,
    reason: result.reason,
    // What the contract routed the role to, and whether the guard actually wrote it
    // into the call. Requested routing is provable here; the model that ran is not.
    routed_model: result.routed_model ?? null,
    injected_model: result.injected_model ?? null,
    effective_model: "unproven",
    selected_scope: scope ?? null,
    contract_sha256: contractSha256 ?? null,
    report_path: reportPath ?? null,
    resolver_policy_version: resolverPolicyVersion ?? null,
  });
  try {
    await (appendHeartbeat ?? ((entry) => appendJsonLine(evidencePath, entry)))(heartbeat);
  } catch {
    return Object.freeze({ ...result, heartbeat_recorded: false });
  }
  return Object.freeze({ ...result, heartbeat_recorded: true });
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
