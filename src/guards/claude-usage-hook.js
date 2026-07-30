import { appendJsonl } from "../telemetry/storage.js";
import { createEvent } from "../telemetry/event.js";

const BILLING_UNITS = Object.freeze([
  "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_write_5m_input_tokens",
  "cache_write_1h_input_tokens", "web_search_requests", "web_fetch_requests",
]);

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;
const nonEmptyString = (value) => typeof value === "string" && value.length > 0;

function usageFrom(payload) {
  if (!isRecord(payload) || payload.tool_name !== "Agent" || payload.tool_input?.run_in_background !== false
    || !nonEmptyString(payload.tool_input?.model) || !isRecord(payload.tool_response)) return null;

  const response = payload.tool_response;
  const usage = response.usage;
  if (!nonEmptyString(response.resolvedModel) || !isCount(response.totalTokens) || !isRecord(usage)
    || !isRecord(usage.cache_creation) || !isRecord(usage.server_tool_use) || !Array.isArray(usage.iterations)) return null;

  const billing_units = {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    cache_write_5m_input_tokens: usage.cache_creation.ephemeral_5m_input_tokens,
    cache_write_1h_input_tokens: usage.cache_creation.ephemeral_1h_input_tokens,
    web_search_requests: usage.server_tool_use.web_search_requests,
    web_fetch_requests: usage.server_tool_use.web_fetch_requests,
  };
  if (!BILLING_UNITS.every((unit) => isCount(billing_units[unit]))) return null;

  return Object.freeze({
    final_input_model: payload.tool_input.model,
    resolved_model: response.resolvedModel,
    total_tokens: response.totalTokens,
    billing_units,
    completion_mode: "foreground",
    iteration_count: usage.iterations.length,
  });
}

export async function observeClaudeUsage({ payload, installedScope, collectorInstanceRef, telemetryRoot, appendTelemetry } = {}) {
  const usage = usageFrom(payload);
  if (usage === null || !["project", "global"].includes(installedScope) || !nonEmptyString(collectorInstanceRef)) {
    return Object.freeze({ observed: false, telemetry_recorded: false });
  }

  let event;
  try {
    event = createEvent({
      event_kind: "execution.usage",
      observed_at: new Date().toISOString(),
      runtime: {
        family: "claude", version: null, version_source: "unknown", version_observed_at: null,
        version_freshness: "unknown", surface: "PostToolUse:Agent",
      },
      scope: {
        install_scope: installedScope, selected_scope: null, collector_instance_ref: collectorInstanceRef,
        contract_sha256: null, resolver_policy_version: 1,
      },
      links: { session_ref: null, turn_ref: null, invocation_ref: null, agent_ref: null, quality: "none" },
      routing: null,
      model_evidence: {},
      usage,
      provenance: { source: "runtime-hook", limitations: ["link-identifiers-unavailable"] },
    });
  } catch {
    return Object.freeze({ observed: false, telemetry_recorded: false });
  }

  try {
    const result = await (appendTelemetry ?? ((entry) => appendJsonl(telemetryRoot, entry)))(event);
    return Object.freeze({ observed: true, telemetry_recorded: result?.written !== false });
  } catch {
    return Object.freeze({ observed: true, telemetry_recorded: false });
  }
}

const decodeArgument = (value) => typeof value === "string" && value.startsWith("base64:")
  ? Buffer.from(value.slice("base64:".length), "base64").toString("utf8")
  : value;

async function readStdin() {
  return new Promise((resolve, reject) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => resolve(body));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const [telemetryRoot, installedScope, collectorInstanceRef] = process.argv.slice(2).map(decodeArgument);
  let payload;
  try { payload = JSON.parse(await readStdin()); } catch { return; }
  await observeClaudeUsage({ payload, telemetryRoot, installedScope, collectorInstanceRef });
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
