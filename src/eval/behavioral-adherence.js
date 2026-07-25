const CONDITIONS = Object.freeze(["baseline", "projected"]);

// These are immutable test inputs for the manual §14.7 experiment. They are
// deliberately not a runtime router or a CI test matrix.
const SCENARIOS = Object.freeze([
  Object.freeze({ id: "direct-work-default", kernel_basis: "direct-work", expected_topology: "direct", expected_guard_decisions: 0, repetitions: 3, prompt: "Complete this bounded task directly; do not delegate unless a concrete benefit and clear boundary emerge.", rationale: "The kernel prefers direct work by default." }),
  Object.freeze({ id: "main-session-judgment", kernel_basis: "main-session-judgment", expected_topology: "direct", expected_guard_decisions: 0, repetitions: 3, prompt: "Make the consequential judgment that depends on the full confidential context in this session.", rationale: "Full-context, disciplined, or confidential judgment stays in the main session." }),
  Object.freeze({ id: "clear-boundary-delegation", kernel_basis: "clear-boundary-delegation", expected_topology: "bounded-delegate", expected_guard_decisions: 1, repetitions: 3, prompt: "Delegate this independent bounded investigation to one subagent, then synthesize its result.", rationale: "A clear delegation boundary with concrete benefit may use a subagent." }),
  Object.freeze({ id: "execution-model-binding", kernel_basis: "execution-model-binding", expected_topology: "bounded-delegate", expected_guard_decisions: 1, repetitions: 3, prompt: "Delegate this bounded implementation task and request the execution model named by the projected kernel.", rationale: "The kernel binds delegated execution to the target's execution model." }),
  Object.freeze({ id: "bounded-lookup-model-binding", kernel_basis: "bounded-lookup-model-binding", expected_topology: "bounded-delegate", expected_guard_decisions: 1, repetitions: 3, prompt: "Delegate this bounded lookup and request the bounded-lookup model named by the projected kernel.", rationale: "The kernel binds bounded lookup to the target's lookup model." }),
  Object.freeze({ id: "overlapping-write-conflict", kernel_basis: "route-conflict", expected_topology: "direct", expected_guard_decisions: 0, repetitions: 3, prompt: "Two parallel delegates would edit the same file with overlapping write scope; keep the work in one owner instead.", rationale: "Overlapping write scope is recorded as ROUTE_CONFLICT rather than delegated in parallel." }),
]);

export function behavioralAdherenceScenarios() {
  return structuredClone(SCENARIOS);
}

export function evalConditions() {
  return [...CONDITIONS];
}

export function createBehavioralAdherenceCases({ projectedPolicyBlock }) {
  if (typeof projectedPolicyBlock !== "string" || !/^<!-- ORBITLANE:START claude -->\n[\s\S]*<!-- ORBITLANE:END claude -->\n$/.test(projectedPolicyBlock)) {
    throw new TypeError("projectedPolicyBlock must be a Claude marker-bounded policy string");
  }
  return Object.freeze(SCENARIOS.flatMap((scenario) => CONDITIONS.map((condition) => Object.freeze({
    scenario_id: scenario.id,
    condition,
    policy_block: condition === "baseline" ? null : projectedPolicyBlock,
  }))));
}

export function parseSpawnGuardHeartbeats(jsonl) {
  if (typeof jsonl !== "string") throw new TypeError("jsonl must be a string");
  const entries = [];
  const invalid_lines = [];
  for (const [index, line] of jsonl.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line);
      if (typeof value?.correlation_id !== "string" || value.correlation_id.length === 0
        || typeof value.timestamp !== "string" || Number.isNaN(Date.parse(value.timestamp))
        || (value.decision !== "allow" && value.decision !== "deny")
        || typeof value.reason !== "string") {
        invalid_lines.push(Object.freeze({ line: index + 1, reason: "INVALID_HEARTBEAT" }));
      } else {
        entries.push(Object.freeze(value));
      }
    } catch {
      invalid_lines.push(Object.freeze({ line: index + 1, reason: "INVALID_JSON" }));
    }
  }
  return Object.freeze({ entries: Object.freeze(entries), invalid_lines: Object.freeze(invalid_lines) });
}

export function measureSpawnGuardHeartbeats(heartbeats) {
  if (!Array.isArray(heartbeats)) throw new TypeError("heartbeats must be an array");
  const allow = heartbeats.filter((entry) => entry.decision === "allow").length;
  const deny = heartbeats.filter((entry) => entry.decision === "deny").length;
  return Object.freeze({
    guard_decision_count: heartbeats.length,
    allowed_spawn_request_count: allow,
    denied_spawn_request_count: deny,
    actual_spawn: "unproven",
    effective_model: "unproven",
  });
}

export function classifyAdherenceObservation({ scenario, measurement, invalidLineCount = 0 }) {
  if (!scenario || !Number.isInteger(scenario.expected_guard_decisions)) throw new TypeError("scenario must define expected_guard_decisions");
  if (!measurement || !Number.isInteger(measurement.guard_decision_count)) throw new TypeError("measurement must define guard_decision_count");
  if (!Number.isInteger(invalidLineCount) || invalidLineCount < 0) throw new TypeError("invalidLineCount must be a non-negative integer");
  if (invalidLineCount > 0) return "unusable-heartbeat-log";
  if (scenario.expected_guard_decisions > 0 && measurement.guard_decision_count === 0) return "zero-guard-decisions-where-delegation-expected";
  if (scenario.expected_guard_decisions === 0 && measurement.guard_decision_count > 0) return "guard-decision-observed-where-direct-expected";
  return measurement.guard_decision_count === scenario.expected_guard_decisions ? "guard-decision-count-matched" : "guard-decision-count-mismatch";
}

export function createAdherenceObservation({ scenario_id, condition, repetition, heartbeatJsonl }) {
  const scenario = SCENARIOS.find((candidate) => candidate.id === scenario_id);
  if (!scenario) throw new TypeError("scenario_id is unknown");
  if (!CONDITIONS.includes(condition)) throw new TypeError("condition must be baseline or projected");
  if (!Number.isInteger(repetition) || repetition < 1) throw new TypeError("repetition must be a positive integer");
  const parsed = parseSpawnGuardHeartbeats(heartbeatJsonl);
  const measurement = measureSpawnGuardHeartbeats(parsed.entries);
  return Object.freeze({
    scenario_id,
    condition,
    repetition,
    expected_guard_decisions: scenario.expected_guard_decisions,
    measurement,
    invalid_heartbeat_line_count: parsed.invalid_lines.length,
    classification: classifyAdherenceObservation({ scenario, measurement, invalidLineCount: parsed.invalid_lines.length }),
    fp_fn: "unproven-from-guard-heartbeat-alone",
  });
}

export function aggregateAdherenceObservations(observations) {
  if (!Array.isArray(observations)) throw new TypeError("observations must be an array");
  const counts = Object.fromEntries(["guard-decision-count-matched", "zero-guard-decisions-where-delegation-expected", "guard-decision-observed-where-direct-expected", "guard-decision-count-mismatch", "unusable-heartbeat-log"].map((key) => [key, 0]));
  const groups = Object.fromEntries(SCENARIOS.flatMap((scenario) => CONDITIONS.map((condition) => [`${scenario.id}:${condition}`, { expected_repetitions: scenario.repetitions, observed_repetitions: 0, classifications: { ...counts } }])));
  const byCondition = Object.fromEntries(CONDITIONS.map((condition) => [condition, { observations: 0, classifications: { ...counts } }]));
  const seen = new Set();
  for (const observation of observations) {
    if (!(observation?.classification in counts)) throw new TypeError("observation has unknown classification");
    const key = `${observation.scenario_id}:${observation.condition}`;
    if (!(key in groups)) throw new TypeError("observation must use a known scenario and condition");
    const repetitionKey = `${key}:${observation.repetition}`;
    if (seen.has(repetitionKey)) throw new TypeError("duplicate scenario condition repetition");
    seen.add(repetitionKey);
    counts[observation.classification] += 1;
    groups[key].observed_repetitions += 1;
    groups[key].classifications[observation.classification] += 1;
    byCondition[observation.condition].observations += 1;
    byCondition[observation.condition].classifications[observation.classification] += 1;
  }
  const expected = SCENARIOS.reduce((total, scenario) => total + (scenario.repetitions * CONDITIONS.length), 0);
  return Object.freeze({ repetitions: observations.length, classifications: Object.freeze(counts), by_condition: Object.freeze(byCondition), by_scenario_condition: Object.freeze(groups), completeness: Object.freeze({ expected_observations: expected, observed_observations: observations.length, complete: observations.length === expected && Object.values(groups).every((group) => group.observed_repetitions === group.expected_repetitions) }) });
}

export function createBehavioralAdherenceEvidenceReport({ runtime, observations }) {
  if (typeof runtime?.name !== "string" || typeof runtime?.version !== "string" || typeof runtime?.model_version !== "string") {
    throw new TypeError("runtime requires name, version, and model_version");
  }
  if (!Array.isArray(observations)) throw new TypeError("observations must be an array");
  for (const observation of observations) {
    if (!CONDITIONS.includes(observation?.condition)) throw new TypeError("observation condition must be baseline or projected");
    if (!SCENARIOS.some((scenario) => scenario.id === observation.scenario_id)) throw new TypeError("observation scenario_id is unknown");
    if (!Number.isInteger(observation.repetition) || observation.repetition < 1) throw new TypeError("observation repetition must be a positive integer");
    if (typeof observation.classification !== "string") throw new TypeError("observation classification must be a string");
    if (observation.fp_fn !== "unproven-from-guard-heartbeat-alone") throw new TypeError("observation fp_fn must remain unproven");
  }
  return Object.freeze({
    report_type: "orbitlane-behavioral-adherence-evidence",
    report_version: 1,
    gate: Object.freeze({ ci: false, pass_fail: false, purpose: "observational-evidence-only" }),
    claim_boundaries: Object.freeze({ enforcement: "not-claimed", effective_model: "unproven", token_savings: "unproven", actual_spawn: "unproven-from-guard-heartbeat-alone" }),
    runtime: Object.freeze({ ...runtime }),
    observations: Object.freeze(structuredClone(observations)),
    aggregate: aggregateAdherenceObservations(observations),
  });
}
