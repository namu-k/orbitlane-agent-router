import { resolveBaseline, versionInRange } from "./baseline.js";

const ALLOWED_USAGE_FIELDS = new Set([
  "final_input_model",
  "resolved_model",
  "total_tokens",
  "billing_units",
  "completion_mode",
  "iteration_count",
]);

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === "string" && value.length > 0;

function deduplicate(events) {
  const seen = new Set();
  const unique = [];
  let duplicates = 0;
  for (const event of events ?? []) {
    if (nonEmptyString(event?.event_id)) {
      if (seen.has(event.event_id)) {
        duplicates += 1;
        continue;
      }
      seen.add(event.event_id);
    }
    unique.push(event);
  }
  return { unique, duplicates };
}

function joinKey(event) {
  if (event?.links?.quality !== "exact" || !nonEmptyString(event.links.invocation_ref)
    || !nonEmptyString(event?.scope?.collector_instance_ref)) return null;
  return `${event.scope.collector_instance_ref}\u0000${event.links.invocation_ref}`;
}

function aliasTargets(alias, runtime, catalog) {
  if (!nonEmptyString(alias) || runtime?.version_freshness !== "execution-attested" || !nonEmptyString(runtime.version)
    || !Array.isArray(catalog?.models)) return [];
  const targets = [];
  for (const model of catalog.models) {
    if (!nonEmptyString(model?.model_token) || !Array.isArray(model.request_aliases)) continue;
    for (const binding of model.request_aliases) {
      if (binding?.alias === alias && binding.runtime_family === runtime.family
        && versionInRange(runtime.version, binding.runtime_version_range)) targets.push(model.model_token);
    }
  }
  return [...new Set(targets)];
}

export function electWriter(decision, usage) {
  if (!decision) return "ORPHANED_NO_PRE";
  return usage?.scope?.install_scope === decision?.scope?.selected_scope
    ? "SELECTED"
    : "ORPHANED_UNSELECTED_SCOPE";
}

export function classifyResolution(joined, catalog) {
  const injected = joined?.decision?.routing?.injected_model;
  const finalInput = joined?.usage?.usage?.final_input_model;
  const resolved = joined?.usage?.usage?.resolved_model;
  if (![injected, finalInput, resolved].every(nonEmptyString)) return "unmapped";
  if (injected === finalInput && finalInput === resolved) return "exact-token";

  const targets = aliasTargets(injected, joined.usage.runtime, catalog);
  if (targets.length === 0) return "unmapped";
  return targets.length === 1 && targets[0] === resolved ? "versioned-alias-binding" : "conflict";
}

function hasUnknownUsageFields(event) {
  return !isRecord(event?.usage) || Object.keys(event.usage).some((field) => !ALLOWED_USAGE_FIELDS.has(field));
}

function classifyJoin(decision, usage, catalog) {
  if (decision?.routing?.routing_outcome === "explicit_model_retained") {
    return { join_status: "EXPLICIT_MODEL_RETAINED", resolution: "unmapped" };
  }
  if (!usage || !isRecord(usage.usage)) return { join_status: "FAILED_OR_INCOMPLETE", resolution: "unmapped" };
  if (hasUnknownUsageFields(usage)) {
    return { join_status: "FAILED_OR_INCOMPLETE", resolution: "unmapped", limitations: ["unsupported-usage-fields"] };
  }
  if (usage.usage.completion_mode === "async_launched") return { join_status: "ASYNC_USAGE_UNAVAILABLE", resolution: "unmapped" };
  if (usage.usage.completion_mode !== "foreground" || usage.usage.iteration_count === undefined) {
    return { join_status: "FAILED_OR_INCOMPLETE", resolution: "unmapped" };
  }
  if (usage.usage.iteration_count > 1) return { join_status: "MULTI_ITERATION_UNVERIFIED", resolution: "unmapped" };

  const resolution = classifyResolution({ decision, usage }, catalog);
  const applied = usage.usage.final_input_model === decision?.routing?.injected_model;
  if (applied) {
    if (["exact-token", "versioned-alias-binding"].includes(resolution)) return { join_status: "APPLIED_AND_RESOLVED", resolution };
    if (resolution === "conflict") return { join_status: "APPLIED_BUT_OVERRIDDEN", resolution };
    return { join_status: "APPLIED_RESOLUTION_UNMAPPED", resolution };
  }
  return ["exact-token", "versioned-alias-binding"].includes(resolution)
    ? { join_status: "NOT_APPLIED_SAME_OUTCOME", resolution }
    : { join_status: "NOT_APPLIED_DIFFERENT_OUTCOME", resolution };
}

function projectJoin(decision, usage, baseline, catalog) {
  const classified = classifyJoin(decision, usage, catalog);
  const baselineResolution = baseline === undefined || baseline === null
    ? Object.freeze({
      status: "unavailable", assumption_label: null, model: null, upper_bound_model: null, provenance: "unknown",
    })
    : resolveBaseline(baseline, usage?.runtime ?? decision?.runtime);
  const estimateStatus = classified.join_status === "APPLIED_AND_RESOLVED"
    && ["eligible", "range_only"].includes(baselineResolution.status)
    ? baselineResolution.status
    : "evidence_only";
  return Object.freeze({
    decision,
    usage: usage ?? null,
    election: "SELECTED",
    ...classified,
    baseline: baselineResolution,
    estimate_status: estimateStatus,
  });
}

function ignoredEvent(event) {
  const behavioral = typeof event?.event_kind === "string" && event.event_kind.startsWith("behavioral.");
  return Object.freeze({
    event,
    estimate_status: "evidence_only",
    reason: behavioral ? "BEHAVIORAL_EVIDENCE_ONLY" : "UNSUPPORTED_EVENT_KIND",
  });
}

export function projectEvents({ decisions = [], usages = [], baseline, catalog } = {}) {
  const decisionDedup = deduplicate(decisions);
  const usageDedup = deduplicate(usages);
  const ignored = [
    ...decisionDedup.unique.filter((event) => event?.event_kind !== "routing.decision"),
    ...usageDedup.unique.filter((event) => event?.event_kind !== "execution.usage"),
  ].map(ignoredEvent);
  const routingDecisions = decisionDedup.unique.filter((event) => event?.event_kind === "routing.decision");
  const executionUsages = usageDedup.unique.filter((event) => event?.event_kind === "execution.usage");
  const decisionsByKey = new Map();
  for (const event of routingDecisions) {
    const key = joinKey(event);
    if (key !== null && !decisionsByKey.has(key)) decisionsByKey.set(key, event);
  }

  const joined = [];
  const orphaned = [];
  const usedDecisions = new Set();
  for (const event of executionUsages) {
    const decision = decisionsByKey.get(joinKey(event));
    const election = electWriter(decision, event);
    if (election !== "SELECTED") {
      orphaned.push(Object.freeze({ decision: decision ?? null, usage: event, election, estimate_status: "evidence_only" }));
      continue;
    }
    usedDecisions.add(decision);
    joined.push(projectJoin(decision, event, baseline, catalog));
  }
  for (const event of routingDecisions) {
    if (!usedDecisions.has(event)) joined.push(projectJoin(event, null, baseline, catalog));
  }

  const eligible = joined.filter((entry) => entry.estimate_status === "eligible");
  const rangeOnly = joined.filter((entry) => entry.estimate_status === "range_only");
  const evidenceOnly = [...joined.filter((entry) => entry.estimate_status === "evidence_only"), ...orphaned, ...ignored];
  const orphanedUnselected = orphaned.filter((entry) => entry.election === "ORPHANED_UNSELECTED_SCOPE").length;
  const orphanedNoPre = orphaned.filter((entry) => entry.election === "ORPHANED_NO_PRE").length;

  return Object.freeze({
    joined: Object.freeze(joined),
    eligible: Object.freeze(eligible),
    range_only: Object.freeze(rangeOnly),
    evidence_only: Object.freeze(evidenceOnly),
    orphaned: Object.freeze(orphaned),
    ignored: Object.freeze(ignored),
    duplicates: Object.freeze({
      decisions: decisionDedup.duplicates,
      usages: usageDedup.duplicates,
      total: decisionDedup.duplicates + usageDedup.duplicates,
    }),
    coverage: Object.freeze({
      routing_decisions: routingDecisions.length,
      selected_posts: joined.filter((entry) => entry.usage !== null).length,
      eligible: eligible.length,
      orphaned_unselected_scope: orphanedUnselected,
      orphaned_no_pre: orphanedNoPre,
    }),
  });
}
