import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { resolveEffectiveContract } from "../guards/resolve-contract.js";
import { readJsonl } from "../telemetry/storage.js";
import { reduceModelEvidence } from "./evidence.js";

const DECISION_FILE = "routing-decisions.v1.jsonl";
const USAGE_FILE = "execution-usage.v1.jsonl";
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value) => typeof value === "string" && value.length > 0;
const safeModel = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}

function eventCollector(event) {
  return nonEmpty(event?.scope?.collector_instance_ref) ? event.scope.collector_instance_ref : null;
}

function validTimestamp(event) {
  return nonEmpty(event?.observed_at) && !Number.isNaN(Date.parse(event.observed_at));
}

function deduplicate(events) {
  const eventIds = new Set();
  return events.filter((event) => {
    if (!nonEmpty(event?.event_id)) return true;
    if (eventIds.has(event.event_id)) return false;
    eventIds.add(event.event_id);
    return true;
  });
}

function usageVector(event) {
  const units = event?.usage?.billing_units;
  if (!isRecord(units) || !count(event?.usage?.total_tokens)
    || !["input_tokens", "cache_read_input_tokens", "cache_write_5m_input_tokens", "cache_write_1h_input_tokens", "output_tokens", "web_search_requests", "web_fetch_requests"].every((key) => count(units[key]))) return null;
  return {
    input_tokens: BigInt(units.input_tokens) + BigInt(units.cache_write_5m_input_tokens) + BigInt(units.cache_write_1h_input_tokens),
    cached_input_tokens: BigInt(units.cache_read_input_tokens),
    output_tokens: BigInt(units.output_tokens),
    total_tokens: BigInt(event.usage.total_tokens),
    server_tool_requests: units.web_search_requests + units.web_fetch_requests,
  };
}

function selectedCollector(events) {
  const candidates = events.filter((event) => eventCollector(event) !== null && validTimestamp(event));
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => right.observed_at.localeCompare(left.observed_at));
  return eventCollector(candidates[0]);
}

function selectedContractModel(decisions) {
  const candidate = decisions.find((event) => event?.routing?.routed_model_class === "sol" && safeModel(event?.routing?.routed_model));
  return candidate?.routing?.routed_model ?? null;
}

function normalized({ decisions, usages, corruptLines, totalLines, contractMainModel = null }) {
  const all = deduplicate([...decisions, ...usages]);
  const collector = selectedCollector(all);
  const chosen = collector === null ? [] : all.filter((event) => eventCollector(event) === collector);
  const chosenDecisions = chosen.filter((event) => event.event_kind === "routing.decision");
  const chosenUsages = chosen.filter((event) => event.event_kind === "execution.usage");
  const decisionsByInvocation = new Map();
  for (const event of chosenDecisions) {
    if (event?.links?.quality === "exact" && nonEmpty(event?.links?.invocation_ref)) decisionsByInvocation.set(event.links.invocation_ref, event);
  }

  const buckets = new Map();
  let unknown = { input_tokens: 0n, cached_input_tokens: 0n, output_tokens: 0n, total_tokens: 0n };
  let exactUsageCount = 0;
  let modelBearingUsageCount = 0;
  let modelBearingUsage = false;
  let serverToolRequests = 0;
  for (const event of chosenUsages) {
    const usage = usageVector(event);
    if (usage === null) continue;
    serverToolRequests += usage.server_tool_requests;
    const decision = event?.links?.quality === "exact" && nonEmpty(event?.links?.invocation_ref)
      ? decisionsByInvocation.get(event.links.invocation_ref) : undefined;
    const resolved = safeModel(event?.usage?.resolved_model) ? event.usage.resolved_model : null;
    const inferred = resolved === null && safeModel(decision?.routing?.injected_model) ? decision.routing.injected_model : null;
    const model = resolved ?? inferred;
    if (model === null) {
      unknown = {
        input_tokens: unknown.input_tokens + usage.input_tokens,
        cached_input_tokens: unknown.cached_input_tokens + usage.cached_input_tokens,
        output_tokens: unknown.output_tokens + usage.output_tokens,
        total_tokens: unknown.total_tokens + usage.total_tokens,
      };
      continue;
    }
    modelBearingUsage = true;
    modelBearingUsageCount += 1;
    if (decision !== undefined) exactUsageCount += 1;
    const current = buckets.get(model) ?? { model, model_source: resolved === null ? "inferred" : "resolved", input_tokens: 0n, cached_input_tokens: 0n, output_tokens: 0n, total_tokens: 0n };
    if (resolved !== null) current.model_source = "resolved";
    current.input_tokens += usage.input_tokens;
    current.cached_input_tokens += usage.cached_input_tokens;
    current.output_tokens += usage.output_tokens;
    current.total_tokens += usage.total_tokens;
    buckets.set(model, current);
  }

  const usageByModel = [...buckets.values()].map((bucket) => ({
    model: bucket.model,
    model_source: bucket.model_source,
    usage: {
      input_tokens: bucket.input_tokens.toString(),
      cached_input_tokens: bucket.cached_input_tokens.toString(),
      output_tokens: bucket.output_tokens.toString(),
      total_tokens: bucket.total_tokens.toString(),
    },
  }));
  const usagePresent = usageByModel.length > 0 || unknown.total_tokens > 0n;
  const modelEvidence = reduceModelEvidence(usageByModel);
  const warnings = [];
  if (corruptLines > 0) warnings.push("CORRUPT_CLAUDE_EVIDENCE_LINES");
  if (serverToolRequests > 0) warnings.push("SERVER_TOOL_REQUESTS_EXCLUDED");
  if (contractMainModel === null) warnings.push("CLAUDE_CONTRACT_BASELINE_UNAVAILABLE");
  if (collector === null) warnings.push("NO_CLAUDE_EVIDENCE");
  return freeze({
    runtime: "claude",
    source_kind: usagePresent ? "claude-events" : chosenDecisions.length > 0 ? "routing-only" : "none",
    usage_evidence: usagePresent ? "detailed" : "none",
    model_evidence: modelEvidence,
    attribution_evidence: modelBearingUsageCount > 0 && exactUsageCount === modelBearingUsageCount ? "exact-invocation" : modelBearingUsage ? "linked-child" : chosenDecisions.length > 0 ? "guidance-only" : "none",
    usage_by_model: usageByModel,
    unknown_model_usage: {
      input_tokens: unknown.input_tokens.toString(),
      cached_input_tokens: unknown.cached_input_tokens.toString(),
      output_tokens: unknown.output_tokens.toString(),
      total_tokens: unknown.total_tokens.toString(),
    },
    observed_main_model: selectedContractModel(chosenDecisions),
    contract_main_model: contractMainModel,
    corrupt_lines: corruptLines,
    total_lines: totalLines,
    warnings,
    basis: { selected_collector_event_count: chosen.length, server_tool_requests_excluded: serverToolRequests },
  });
}

export function normalizeClaudeEvents({ decisions, usages, corruptLines = 0, totalLines = 0, contractMainModel = null }) {
  if (!Array.isArray(decisions) || !Array.isArray(usages) || !Number.isSafeInteger(corruptLines) || corruptLines < 0
    || !Number.isSafeInteger(totalLines) || totalLines < 0 || (contractMainModel !== null && !nonEmpty(contractMainModel))) {
    throw new TypeError("INVALID_CLAUDE_EVIDENCE");
  }
  return normalized({ decisions, usages, corruptLines, totalLines, contractMainModel });
}

async function readEvidenceFiles(directory) {
  const [decision, usage] = await Promise.all([readJsonl(join(directory, DECISION_FILE)), readJsonl(join(directory, USAGE_FILE))]);
  return { records: [...decision.records, ...usage.records], corruptLines: decision.corrupt_lines.length + usage.corrupt_lines.length,
    totalLines: decision.records.length + usage.records.length + decision.corrupt_lines.length + usage.corrupt_lines.length + Number(decision.partial_last_line) + Number(usage.partial_last_line) };
}

async function contractMainModel(cwd) {
  try {
    const resolved = await resolveEffectiveContract({ cwd, claudeConfigDir: join(cwd, ".claude") });
    const model = resolved.contract?.targets?.claude?.lanes?.sol?.model;
    return safeModel(model) ? model : null;
  } catch {
    return null;
  }
}

export async function loadClaudeEvidence({ cwd = process.cwd(), session = "latest" } = {}) {
  const project = resolve(cwd);
  const standardDirectory = join(project, ".orbitlane", "evidence", "project");
  let loaded;
  let canUseContract = false;
  if (session === "latest") {
    loaded = await readEvidenceFiles(standardDirectory);
    canUseContract = true;
  } else if (typeof session === "string" && session.length > 0) {
    const path = resolve(project, session);
    const info = await lstat(path).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (info === null) throw new Error("CLAUDE_EVIDENCE_PATH_NOT_FOUND");
    if (info.isDirectory()) loaded = await readEvidenceFiles(path);
    else if (info.isFile()) {
      const file = await readJsonl(path);
      loaded = { records: [...file.records], corruptLines: file.corrupt_lines.length,
        totalLines: file.records.length + file.corrupt_lines.length + Number(file.partial_last_line) };
    } else throw new Error("CLAUDE_EVIDENCE_PATH_UNSAFE");
  } else throw new TypeError("INVALID_CLAUDE_SESSION");
  const decisions = loaded.records.filter((event) => event?.event_kind === "routing.decision");
  const usages = loaded.records.filter((event) => event?.event_kind === "execution.usage");
  return normalized({ decisions, usages, corruptLines: loaded.corruptLines, totalLines: loaded.totalLines,
    contractMainModel: canUseContract ? await contractMainModel(project) : null });
}
