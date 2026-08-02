import { readdir, readFile } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const KEYS = ["input_tokens", "cached_input_tokens", "output_tokens", "total_tokens"];
const decimal = (value) => typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value);
const zero = () => ({ input_tokens: 0n, cached_input_tokens: 0n, output_tokens: 0n, total_tokens: 0n });
const frozen = (value) => Object.freeze(value);
function gcd(left, right) { while (right !== 0n) [left, right] = [right, left % right]; return left; }

function vector(value) {
  if (value === null || typeof value !== "object" || !KEYS.every((key) => decimal(value[key]))) throw new TypeError("INVALID_CODEX_USAGE");
  return Object.fromEntries(KEYS.map((key) => [key, BigInt(value[key])]));
}
function add(left, right) { for (const key of KEYS) left[key] += right[key]; return left; }
function render(value) { return Object.fromEntries(KEYS.map((key) => [key, value[key].toString()])); }
function halfUp(numerator, denominator) { return (numerator + denominator / 2n) / denominator; }
function modelBucket(model, usage) { return { model, model_source: "observed", usage: render(usage) }; }

export function allocateRootUsage({ usage, observedSpawnCount, modelSpawnCounts }) {
  const root = vector(usage);
  if (!Number.isSafeInteger(observedSpawnCount) || observedSpawnCount <= 0 || !(modelSpawnCounts instanceof Map)) throw new TypeError("INVALID_CODEX_ALLOCATION");
  const known = [...modelSpawnCounts.entries()].filter(([model, count]) => typeof model === "string" && Number.isSafeInteger(count) && count > 0);
  const knownSpawns = known.reduce((sum, [, count]) => sum + count, 0);
  const estimatedNumerator = BigInt(observedSpawnCount);
  const estimatedDenominator = BigInt(observedSpawnCount + 2);
  const limitedNumerator = estimatedNumerator * 4n > estimatedDenominator * 3n ? 3n : estimatedNumerator;
  const limitedDenominator = estimatedNumerator * 4n > estimatedDenominator * 3n ? 4n : estimatedDenominator;
  const knownNumerator = limitedNumerator * BigInt(knownSpawns);
  const knownDenominator = limitedDenominator * BigInt(observedSpawnCount);
  const divisor = gcd(knownNumerator, knownDenominator);
  const shareNumerator = knownNumerator / divisor;
  const shareDenominator = knownDenominator / divisor;
  const allocated = Object.fromEntries(KEYS.map((key) => [key, halfUp(root[key] * shareNumerator, shareDenominator)]));
  const byModel = known.map(([model, count]) => {
    const share = Object.fromEntries(KEYS.map((key) => [key, halfUp(allocated[key] * BigInt(count), BigInt(knownSpawns))]));
    return modelBucket(model, share);
  });
  const assigned = byModel.reduce((sum, entry) => add(sum, vector(entry.usage)), zero());
  const unknown = Object.fromEntries(KEYS.map((key) => [key, root[key] - assigned[key]]));
  return frozen({
    formula: "min(0.75,n/(n+2))*known_model_spawns/n",
    observed_spawn_count: observedSpawnCount,
    known_model_spawn_count: knownSpawns,
    known_model_share_numerator: shareNumerator.toString(),
    known_model_share_denominator: shareDenominator.toString(),
    usage_by_model: frozen(byModel), unknown_model_usage: frozen(render(unknown)),
  });
}

export function normalizeCodexRollouts({ root, children, spawnObservations = [] }) {
  const warnings = [];
  const rootModels = Array.isArray(root?.models) ? root.models.filter((model) => typeof model === "string") : [];
  const linked = (Array.isArray(children) ? children : []).filter((child) => child?.parent_thread_id === root?.id && child?.usage !== undefined);
  const buckets = [];
  const unknown = zero();
  let mixed = 0;
  for (const child of linked) {
    const usage = vector(child.usage);
    const models = [...new Set((Array.isArray(child.models) ? child.models : []).filter((model) => typeof model === "string" && model.length > 0))];
    if (models.length !== 1) {
      add(unknown, usage);
      if (models.length > 1) { mixed += 1; warnings.push("child has multiple turn models"); }
      continue;
    }
    buckets.push(modelBucket(models[0], usage));
  }
  if (buckets.length > 0) {
    return frozen({ runtime: "codex", source_kind: "codex-linked-children", usage_evidence: "detailed", model_evidence: "observed", attribution_evidence: "linked-child",
      usage_by_model: frozen(buckets), unknown_model_usage: frozen(render(unknown)), observed_main_model: rootModels.length === 1 ? rootModels[0] : null,
      contract_main_model: null, corrupt_lines: 0, total_lines: linked.length + 1, warnings: frozen(warnings),
      basis: frozen({ linked_child_count: buckets.length, excluded_mixed_model_children: mixed, rollout_contract_version: root?.cli_version ?? "unknown" }) });
  }
  const rootUsage = root?.usage;
  const observations = Array.isArray(spawnObservations) ? spawnObservations : [];
  if (rootUsage !== undefined && observations.length > 0) {
    const counts = new Map();
    for (const observation of observations) if (typeof observation?.model === "string") counts.set(observation.model, (counts.get(observation.model) ?? 0) + 1);
    const allocation = allocateRootUsage({ usage: rootUsage, observedSpawnCount: observations.length, modelSpawnCounts: counts });
    return frozen({ runtime: "codex", source_kind: "codex-session-allocation", usage_evidence: "session", model_evidence: allocation.usage_by_model.length > 0 ? "observed" : "unknown", attribution_evidence: "spawn-allocation",
      usage_by_model: allocation.usage_by_model, unknown_model_usage: allocation.unknown_model_usage, observed_main_model: rootModels.length === 1 ? rootModels[0] : null,
      contract_main_model: null, corrupt_lines: 0, total_lines: 1, warnings: frozen(warnings), basis: allocation });
  }
  return frozen({ runtime: "codex", source_kind: root ? "routing-only" : "none", usage_evidence: "none", model_evidence: "unknown", attribution_evidence: root ? "guidance-only" : "none",
    usage_by_model: frozen([]), unknown_model_usage: frozen(render(unknown)), observed_main_model: rootModels.length === 1 ? rootModels[0] : null, contract_main_model: null,
    corrupt_lines: 0, total_lines: root ? 1 : 0, warnings: frozen(warnings), basis: frozen({ linked_child_count: 0, excluded_mixed_model_children: mixed, rollout_contract_version: root?.cli_version ?? "unknown" }) });
}

function parseRollout(text) {
  const records = []; let corrupt = 0;
  for (const line of text.split("\n")) { if (!line) continue; try { records.push(JSON.parse(line)); } catch { corrupt += 1; } }
  const meta = records.find((record) => record?.type === "session_meta")?.payload;
  if (!meta?.id) return null;
  const models = [...new Set(records.filter((record) => record?.type === "turn_context" && typeof record.payload?.model === "string").map((record) => record.payload.model))];
  const token = records.filter((record) => record?.type === "event_msg" && record.payload?.type === "token_count").at(-1)?.payload?.info?.total_token_usage;
  const usage = token && KEYS.every((key) => Number.isSafeInteger(token[key]) && token[key] >= 0) ? Object.fromEntries(KEYS.map((key) => [key, String(token[key])])) : undefined;
  const spawns = records.filter((record) => record?.type === "response_item" && record.payload?.type === "function_call" && record.payload?.name === "spawn_agent").map((record) => {
    try { const args = JSON.parse(record.payload.arguments); return { model: typeof args.model === "string" ? args.model : null }; } catch { return { model: null }; }
  });
  return { id: meta.id, parent_thread_id: meta.parent_thread_id, cwd: meta.cwd, source: meta.thread_source, cli_version: meta.cli_version, models, usage, spawns, corrupt };
}
async function rolloutFiles(directory) {
  const entries = await readdir(directory, { recursive: true }).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  return entries.filter((entry) => typeof entry === "string" && entry.endsWith(".jsonl")).map((entry) => join(directory, entry));
}

export async function loadCodexEvidence({ cwd = process.cwd(), session = "latest", env = process.env, homedir = osHomedir } = {}) {
  const home = typeof homedir === "function" ? homedir() : homedir;
  const root = typeof env.CODEX_HOME === "string" && env.CODEX_HOME.trim() && isAbsolute(env.CODEX_HOME) ? resolve(env.CODEX_HOME) : join(home, ".codex");
  const explicit = session !== "latest" && typeof session === "string" && isAbsolute(session) ? session : null;
  const files = explicit ? [explicit] : await rolloutFiles(join(root, "sessions"));
  const rollouts = (await Promise.all(files.map(async (file) => parseRollout(await readFile(file, "utf8").catch(() => ""))))).filter(Boolean);
  const canonicalCwd = resolve(cwd);
  const roots = rollouts.filter((entry) => entry.source === "user" && entry.cwd === canonicalCwd);
  const selected = session === "latest" ? roots.at(-1) : rollouts.find((entry) => entry.id === session) ?? rollouts[0];
  if (!selected) return normalizeCodexRollouts({ root: null, children: [], spawnObservations: [] });
  return normalizeCodexRollouts({ root: selected, children: rollouts, spawnObservations: selected.spawns });
}
