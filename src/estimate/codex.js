import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const KEYS = ["input_tokens", "cached_input_tokens", "output_tokens", "total_tokens"];
const decimal = (value) => typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value);
const safeToken = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const safeVersion = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
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
function modelBucket(model, usage, source = "observed") { return { model, model_source: source, usage: render(usage) }; }

export function allocateRootUsage({ usage, observedSpawnCount, modelSpawnCounts }) {
  const root = vector(usage);
  if (!Number.isSafeInteger(observedSpawnCount) || observedSpawnCount <= 0 || !(modelSpawnCounts instanceof Map)) throw new TypeError("INVALID_CODEX_ALLOCATION");
  const known = [...modelSpawnCounts.entries()].filter(([model, count]) => safeToken(model) && Number.isSafeInteger(count) && count > 0).sort(([left], [right]) => left.localeCompare(right));
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
  const byModel = known.map(([model]) => modelBucket(model, zero()));
  for (const key of KEYS) {
    const shares = known.map(([model, count], index) => ({ model, index, quotient: allocated[key] * BigInt(count) / BigInt(knownSpawns), remainder: allocated[key] * BigInt(count) % BigInt(knownSpawns) }));
    const assigned = shares.reduce((sum, share) => sum + share.quotient, 0n);
    const remaining = allocated[key] - assigned;
    shares.sort((left, right) => right.remainder === left.remainder ? left.model.localeCompare(right.model) : right.remainder > left.remainder ? 1 : -1);
    for (let index = 0; index < Number(remaining); index += 1) shares[index].quotient += 1n;
    for (const share of shares) byModel[share.index].usage[key] = share.quotient.toString();
  }
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

export function normalizeCodexRollouts({ root, children, spawnObservations = [], contract = null }) {
  const warnings = [];
  const rootModels = Array.isArray(root?.models) ? root.models.filter(safeToken) : [];
  const linkedById = new Map();
  for (const child of Array.isArray(children) ? children : []) {
    if (child?.parent_thread_id !== root?.id || child?.usage === undefined || !safeToken(child?.id)) continue;
    const prior = linkedById.get(child.id);
    if (prior === undefined || (Number(child.timestamp) || 0) > (Number(prior.timestamp) || 0)) linkedById.set(child.id, child);
  }
  const linked = [...linkedById.values()];
  const buckets = [];
  const unknown = zero();
  let mixed = 0;
  for (const child of linked) {
    const usage = vector(child.usage);
    const models = [...new Set((Array.isArray(child.models) ? child.models : []).filter(safeToken))];
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
      contract_main_model: null, corrupt_lines: (root?.corrupt ?? 0) + linked.reduce((sum, child) => sum + (child.corrupt ?? 0), 0), total_lines: (root?.total_lines ?? 0) + linked.reduce((sum, child) => sum + (child.total_lines ?? 0), 0), warnings: frozen(warnings),
      basis: frozen({ linked_child_count: buckets.length, excluded_mixed_model_children: mixed, rollout_contract_version: safeVersion(root?.cli_version) ? root.cli_version : "unknown" }) });
  }
  const rootUsage = root?.usage;
  const observations = Array.isArray(spawnObservations) ? spawnObservations : [];
  if (rootUsage !== undefined && observations.length > 0) {
    const counts = new Map(); const sources = new Map();
    for (const observation of observations) {
      const observed = safeToken(observation?.model) ? observation.model : null;
      const role = safeToken(observation?.agent_type) ? observation.agent_type : null;
      const lane = role === null ? null : contract?.roles?.[role]?.lane;
      const inferred = safeToken(contract?.requested_routes?.[role]?.requested_model) ? contract.requested_routes[role].requested_model
        : typeof lane === "string" && safeToken(contract?.targets?.codex?.lanes?.[lane]?.model) ? contract.targets.codex.lanes[lane].model : null;
      const model = observed ?? inferred;
      if (model === null) continue;
      counts.set(model, (counts.get(model) ?? 0) + 1);
      sources.set(model, observed === null && sources.get(model) !== "observed" ? "inferred" : "observed");
    }
    const allocation = allocateRootUsage({ usage: rootUsage, observedSpawnCount: observations.length, modelSpawnCounts: counts });
    for (const bucket of allocation.usage_by_model) bucket.model_source = sources.get(bucket.model) ?? "observed";
    return frozen({ runtime: "codex", source_kind: "codex-session-allocation", usage_evidence: "session", model_evidence: allocation.usage_by_model.length > 0 ? "observed" : "unknown", attribution_evidence: "spawn-allocation",
      usage_by_model: allocation.usage_by_model, unknown_model_usage: allocation.unknown_model_usage, observed_main_model: rootModels.length === 1 ? rootModels[0] : null,
      contract_main_model: null, corrupt_lines: root?.corrupt ?? 0, total_lines: root?.total_lines ?? 0, warnings: frozen(warnings), basis: allocation });
  }
  return frozen({ runtime: "codex", source_kind: root ? "routing-only" : "none", usage_evidence: "none", model_evidence: "unknown", attribution_evidence: root ? "guidance-only" : "none",
    usage_by_model: frozen([]), unknown_model_usage: frozen(render(unknown)), observed_main_model: rootModels.length === 1 ? rootModels[0] : null, contract_main_model: null,
    corrupt_lines: root?.corrupt ?? 0, total_lines: root?.total_lines ?? 0, warnings: frozen(warnings), basis: frozen({ linked_child_count: 0, excluded_mixed_model_children: mixed, rollout_contract_version: safeVersion(root?.cli_version) ? root.cli_version : "unknown" }) });
}

function parseRollout(text, modifiedAt) {
  const records = []; let corrupt = 0;
  const lines = text.split("\n"); const partial = text.endsWith("\n") ? 0 : 1;
  const complete = partial ? lines.slice(0, -1) : lines;
  for (const line of complete) { if (!line) continue; try { records.push(JSON.parse(line)); } catch { corrupt += 1; } }
  const meta = records.find((record) => record?.type === "session_meta")?.payload;
  if (!meta?.id) return null;
  const models = [...new Set(records.filter((record) => record?.type === "turn_context" && safeToken(record.payload?.model)).map((record) => record.payload.model))];
  const token = records.filter((record) => record?.type === "event_msg" && record.payload?.type === "token_count").at(-1)?.payload?.info?.total_token_usage;
  const usage = token && KEYS.every((key) => Number.isSafeInteger(token[key]) && token[key] >= 0) ? Object.fromEntries(KEYS.map((key) => [key, String(token[key])])) : undefined;
  const spawns = records.filter((record) => record?.type === "response_item" && record.payload?.type === "function_call" && record.payload?.name === "spawn_agent").map((record) => {
    try { const args = JSON.parse(record.payload.arguments); return { model: safeToken(args.model) ? args.model : null, agent_type: safeToken(args.agent_type) ? args.agent_type : null }; } catch { return { model: null, agent_type: null }; }
  });
  if (!safeToken(meta.id)) return null;
  const timestamps = [meta.timestamp, meta.created_at, meta.updated_at, ...records.flatMap((record) => [record?.timestamp, record?.payload?.timestamp])]
    .map((value) => typeof value === "string" ? Date.parse(value) : Number.NaN).filter(Number.isFinite);
  return { id: meta.id, parent_thread_id: safeToken(meta.parent_thread_id) ? meta.parent_thread_id : null, cwd: typeof meta.cwd === "string" ? meta.cwd : null, source: meta.thread_source, cli_version: safeVersion(meta.cli_version) ? meta.cli_version : "unknown", models, usage, spawns, corrupt, total_lines: complete.filter(Boolean).length + partial, timestamp: timestamps.length ? Math.max(...timestamps) : modifiedAt };
}
async function rolloutFiles(directory) {
  const entries = await readdir(directory, { recursive: true }).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  return entries.filter((entry) => typeof entry === "string" && entry.endsWith(".jsonl")).map((entry) => join(directory, entry));
}

async function parsedRollouts(files, allowedRoot) {
  if (files.length === 0) return [];
  const canonicalRoot = await realpath(allowedRoot);
  return (await Promise.all(files.map(async (file) => {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw Object.assign(new Error("CODEX_EVIDENCE_PATH_UNSAFE"), { code: "CODEX_EVIDENCE_PATH_UNSAFE" });
    const canonicalFile = await realpath(file);
    if (!canonicalFile.startsWith(`${canonicalRoot}/`)) throw Object.assign(new Error("CODEX_EVIDENCE_PATH_UNSAFE"), { code: "CODEX_EVIDENCE_PATH_UNSAFE" });
    const [text, details] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    const rollout = parseRollout(text, details.mtimeMs);
    return rollout === null ? null : { ...rollout, file };
  }))).filter(Boolean);
}

async function canonical(path) {
  try { return await realpath(resolve(path)); } catch { return null; }
}

async function matchingRoots(rollouts, cwd) {
  const target = await canonical(cwd);
  if (target === null) return [];
  const checked = await Promise.all(rollouts.filter((entry) => entry.source === "user" && typeof entry.cwd === "string").map(async (entry) => ({ entry, cwd: await canonical(entry.cwd) })));
  return checked.filter(({ cwd: candidate }) => candidate === target).map(({ entry }) => entry);
}

async function codexRouteContract(cwd) {
  let current = await canonical(cwd);
  while (current !== null) {
    try {
      const report = JSON.parse(await readFile(join(current, ".orbitlane", "codex-report.json"), "utf8"));
      const requested = report?.requested_routes;
      if (requested && typeof requested === "object" && !Array.isArray(requested)) return Object.freeze({ requested_routes: requested });
      return null;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR" && error?.name !== "SyntaxError") return null;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export async function loadCodexEvidence({ cwd = process.cwd(), session = "latest", env = process.env, homedir = osHomedir, contract = undefined } = {}) {
  const home = typeof homedir === "function" ? homedir() : homedir;
  const root = typeof env.CODEX_HOME === "string" && env.CODEX_HOME.trim() && isAbsolute(env.CODEX_HOME) ? resolve(env.CODEX_HOME) : join(home, ".codex");
  if (typeof session !== "string" || session.length === 0) throw new TypeError("INVALID_CODEX_SESSION");
  const candidatePath = session === "latest" ? null : resolve(cwd, session);
  const candidateInfo = candidatePath === null ? null : await lstat(candidatePath).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  let files = await rolloutFiles(join(root, "sessions"));
  if (candidateInfo?.isFile()) files = [...new Set([candidatePath, ...await rolloutFiles(join(candidatePath, ".."))])];
  else if (candidateInfo?.isDirectory()) files = await rolloutFiles(candidatePath);
  else if (candidateInfo !== null) throw new Error("CODEX_EVIDENCE_PATH_UNSAFE");
  const rollouts = await parsedRollouts(files, candidateInfo?.isFile() ? join(candidatePath, "..") : candidateInfo?.isDirectory() ? candidatePath : join(root, "sessions"));
  let selected;
  if (session === "latest") {
    const roots = await matchingRoots(rollouts, cwd);
    selected = roots.sort((left, right) => right.timestamp - left.timestamp || left.id.localeCompare(right.id) || left.file.localeCompare(right.file))[0];
  } else if (candidateInfo?.isFile()) {
    selected = rollouts.find((entry) => entry.file === candidatePath && entry.source === "user");
    if (selected === undefined) throw new Error("CODEX_EXPLICIT_FILE_NOT_ROOT");
  } else if (candidateInfo?.isDirectory()) {
    const roots = rollouts.filter((entry) => entry.source === "user");
    if (roots.length !== 1) throw new Error(roots.length === 0 ? "CODEX_THREAD_NOT_FOUND" : "CODEX_THREAD_AMBIGUOUS");
    [selected] = roots;
  } else {
    const roots = rollouts.filter((entry) => entry.source === "user" && entry.id === session);
    if (roots.length !== 1) throw new Error(roots.length === 0 ? "CODEX_THREAD_NOT_FOUND" : "CODEX_THREAD_AMBIGUOUS");
    [selected] = roots;
  }
  if (!selected) return normalizeCodexRollouts({ root: null, children: [], spawnObservations: [] });
  return normalizeCodexRollouts({ root: selected, children: rollouts, spawnObservations: selected.spawns, contract: contract ?? await codexRouteContract(cwd) });
}
