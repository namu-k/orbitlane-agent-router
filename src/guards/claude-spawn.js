import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { resolveClaudeRequestedRoutes } from "../adapters/claude/index.js";

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
  // From here the role is managed, so its model must be declared and must match.
  if (typeof input.model !== "string") {
    return Object.freeze({ exitCode: 2, decision: "deny", reason: "INVALID_AGENT_TOOL_INPUT", effective_model: "unproven" });
  }
  if ((typeof input.model_override === "string" && input.model_override !== route.model)
    || (typeof input.environment_model === "string" && input.environment_model !== "inherit" && input.environment_model !== route.model)) {
    return Object.freeze({ exitCode: 2, decision: "deny", reason: "DETECTABLE_MODEL_OVERRIDE", effective_model: "unproven" });
  }
  if (input.model !== route.model) {
    return Object.freeze({ exitCode: 2, decision: "deny", reason: "CONTRACT_MISMATCH", effective_model: "unproven" });
  }
  return Object.freeze({ exitCode: 0, decision: "allow", reason: "CONTRACT_MATCH", effective_model: "unproven" });
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
