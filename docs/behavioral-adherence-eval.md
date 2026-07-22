# Behavioral adherence evidence harness (P8, §14.7)

This module is an **observational evidence harness**, not a CI gate. It never
decides release status and must not be wired into CI. Its results do not prove
enforcement, an effective model binding, actual child creation, or token
savings.

## Fixed experiment

`src/eval/behavioral-adherence.js` fixes six scenarios derived from §14.2. Each
is run under both conditions:

- `baseline`: no OrbitLane marker-bounded policy block.
- `projected`: the generated OrbitLane marker-bounded policy block is present.

`createBehavioralAdherenceCases({ projectedPolicyBlock })` materializes this
12-case cross-product and keeps the baseline policy block `null`; each case has
three predeclared repetitions (36 observations total). Callers must
provide the exact generated marker block for the projected condition.

The scenarios cover direct small work, long-context judgment, a coupled plan,
three independent investigations, resuming a child, and an adversarial explicit
`$subagent-driven-development` request. The manual runner must execute the
configured number of repetitions for every scenario/condition pair and retain
the exact prompt, policy condition, heartbeat JSONL, Claude Code version, and
model version outside this repository's public artifacts.

## Manual live-eval procedure

Live execution is intentionally not automated by this package. It requires a
headless Claude Code runtime and a fixed, recorded model version.

1. Install or select the approved headless Claude Code runtime; record its exact
   `claude --version` output as `runtime.version`.
2. Pin the evaluation model according to that runtime's supported headless
   invocation syntax; record the exact provider/model version as
   `runtime.model_version`. Do not substitute a floating alias.
3. For each fixed scenario and each condition, use a fresh evaluation workspace.
   For `resume-child-follow-up`, prepare the named existing child session before
   issuing the fixture prompt.
4. Configure the existing §9.4 Claude spawn guard to write a separate JSONL
   heartbeat file for that repetition. Run the headless prompt manually.
5. Feed the JSONL text to `createAdherenceObservation` with the fixed scenario
   id, condition, and positive repetition number. It records parse diagnostics,
   guard-decision counts, and the predeclared heartbeat-only classification.
6. Call `createBehavioralAdherenceEvidenceReport` with every observation and
   write the resulting JSON report to a private evaluation-results location.

The JSONL heartbeat records **guard decisions for requested Agent-tool spawns**.
`allow` does not prove that a child was created, and no heartbeat does not prove
direct execution: a hook failure can be fail-open. Accordingly the report fixes
`actual_spawn` and `effective_model` to `unproven`, and never emits an
enforcement or token-savings claim.

## Predeclared classification

The harness makes the requested count comparison reproducible, while preserving
the heartbeat-only uncertainty:

- `zero-guard-decisions-where-delegation-expected`: the heartbeat-only proxy
  for the preregistered FP definition (delegation expected, direct observed).
- `guard-decision-observed-where-direct-expected`: the heartbeat-only proxy
  for the preregistered FN definition (direct expected, delegation observed).
- malformed heartbeat input is `unusable-heartbeat-log`, not an adherence
  result.

The report fixes actual `fp_fn` to `unproven-from-guard-heartbeat-alone`; the
proxy labels cannot establish direct execution or child creation. Aggregation
reports every scenario/condition group and whether all 36 preregistered
observations are present. These labels are experimental measurements, not
release verdicts. The report's `by_condition` section makes the baseline and
projected proxy rates comparable as evidence only.

## Offline verification

The harness has no dependencies and no live-runtime test path. Run:

```bash
npm test
```

The fixed `node --test` fixtures cover scenario definitions, JSONL parsing,
measurement, classification, aggregation, and report claim boundaries.
