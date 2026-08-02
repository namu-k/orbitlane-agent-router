import assert from "node:assert/strict";
import test from "node:test";

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import { allocateRootUsage, isCanonicalDescendant, loadCodexEvidence, normalizeCodexRollouts } from "../../src/estimate/codex.js";

const usage = { input_tokens: "100", cached_input_tokens: "20", output_tokens: "30", total_tokens: "150" };

test("linked children use the last cumulative usage and observed turn model", () => {
  const evidence = normalizeCodexRollouts({
    root: { id: "root-1", cwd: "__PROJECT_CWD__", source: "user", models: ["gpt-5.6-sol"] },
    children: [
      { id: "child-terra", parent_thread_id: "root-1", models: ["gpt-5.6-terra"], usage },
      { id: "child-luna", parent_thread_id: "root-1", models: ["gpt-5.6-luna"], usage: { ...usage, total_tokens: "15" } },
    ],
    spawnObservations: [],
  });
  assert.equal(evidence.source_kind, "codex-linked-children");
  assert.equal(evidence.attribution_evidence, "linked-child");
  assert.deepEqual(evidence.usage_by_model.map(({ model }) => model).sort(), ["gpt-5.6-luna", "gpt-5.6-terra"]);
  assert.equal(evidence.observed_main_model, "gpt-5.6-sol");
});

test("a child with multiple turn models is excluded as unknown-model coverage", () => {
  const evidence = normalizeCodexRollouts({
    root: { id: "root-1", cwd: "__PROJECT_CWD__", source: "user", models: ["gpt-5.6-sol"] },
    children: [{ id: "child", parent_thread_id: "root-1", models: ["gpt-5.6-luna", "gpt-5.6-terra"], usage }],
    spawnObservations: [],
  });
  assert.deepEqual(evidence.usage_by_model, []);
  assert.notEqual(evidence.unknown_model_usage.total_tokens, "0");
  assert.match(evidence.warnings.join("\n"), /multiple turn models/);
});

test("root fallback allocates only the known model share", () => {
  const result = allocateRootUsage({ usage, observedSpawnCount: 2, modelSpawnCounts: new Map([["gpt-5.6-terra", 1]]) });
  assert.equal(result.known_model_share_numerator, "1");
  assert.equal(result.known_model_share_denominator, "4");
  assert.equal(result.usage_by_model[0].usage.total_tokens, "38");
  assert.equal(result.unknown_model_usage.total_tokens, "112");
});

test("allocation distributes rounded units without manufacturing negative unknown usage", () => {
  const result = allocateRootUsage({ usage: { input_tokens: "1", cached_input_tokens: "1", output_tokens: "1", total_tokens: "1" }, observedSpawnCount: 2, modelSpawnCounts: new Map([["gpt-5.6-luna", 1], ["gpt-5.6-terra", 1]]) });
  assert.ok(BigInt(result.unknown_model_usage.total_tokens) >= 0n);
  assert.equal(BigInt(result.usage_by_model.reduce((sum, entry) => sum + BigInt(entry.usage.total_tokens), 0n)) + BigInt(result.unknown_model_usage.total_tokens), 1n);
});

test("duplicate child IDs and corrupt or partial records do not inflate usage or confidence evidence", () => {
  const child = { id: "child", parent_thread_id: "root", models: ["gpt-5.6-terra"], usage, corrupt: 1, total_lines: 3, timestamp: 1 };
  const evidence = normalizeCodexRollouts({ root: { id: "root", models: ["gpt-5.6-sol"], corrupt: 1, total_lines: 2 }, children: [child, { ...child, usage: { ...usage, total_tokens: "300" }, timestamp: 0 }], spawnObservations: [] });
  assert.equal(evidence.usage_by_model.length, 1);
  assert.equal(evidence.usage_by_model[0].usage.total_tokens, "150");
  assert.equal(evidence.corrupt_lines, 2);
  assert.equal(evidence.total_lines, 5);
});

test("fallback resolves a model-less agent_type through the Codex role contract as inferred", () => {
  const evidence = normalizeCodexRollouts({ root: { id: "root", usage, models: [] }, children: [], spawnObservations: [{ model: null, agent_type: "executor" }], contract: { roles: { executor: { lane: "terra" } }, targets: { codex: { lanes: { terra: { model: "gpt-5.6-terra" } } } } } });
  assert.equal(evidence.usage_by_model[0].model, "gpt-5.6-terra");
  assert.equal(evidence.usage_by_model[0].model_source, "inferred");
  assert.equal(evidence.model_evidence, "inferred");
});

test("canonical containment accepts Windows descendants and rejects sibling prefixes", () => {
  const pathApi = { relative: win32.relative, isAbsolute: win32.isAbsolute };
  assert.equal(isCanonicalDescendant("C:\\codex\\sessions", "C:\\codex\\sessions\\root.jsonl", pathApi), true);
  assert.equal(isCanonicalDescendant("C:\\codex\\sessions", "C:\\codex\\sessions-other\\root.jsonl", pathApi), false);
});

test("linked children without usable usage remain in integrity diagnostics", () => {
  const evidence = normalizeCodexRollouts({
    root: { id: "root", corrupt: 1, total_lines: 2 },
    children: [
      { id: "valid", parent_thread_id: "root", models: ["gpt-5.6-terra"], usage, corrupt: 0, total_lines: 1 },
      { id: "invalid", parent_thread_id: "root", models: ["gpt-5.6-luna"], corrupt: 1, total_lines: 3 },
    ],
  });
  assert.equal(evidence.corrupt_lines, 2);
  assert.equal(evidence.total_lines, 6);
});

test("equal-timestamp duplicate children use a deterministic tie-breaker and warn", () => {
  const root = { id: "root" };
  const olderPath = { id: "child", parent_thread_id: "root", models: ["gpt-5.6-terra"], usage, timestamp: 1, file: "/evidence/a.jsonl" };
  const newerPath = { ...olderPath, usage: { ...usage, total_tokens: "300" }, file: "/evidence/b.jsonl" };
  const evidence = normalizeCodexRollouts({ root, children: [newerPath, olderPath] });
  assert.equal(evidence.usage_by_model[0].usage.total_tokens, "150");
  assert.match(evidence.warnings.join("\n"), /DUPLICATE_CHILD_TIE/);
});

test("a production-shaped Codex report supplies only a configured contract baseline", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "orbitlane-estimate-codex-contract-"));
  const sessions = join(project, "codex-home", "sessions");
  await mkdir(sessions, { recursive: true });
  await mkdir(join(project, ".orbitlane"), { recursive: true });
  await writeFile(join(project, ".orbitlane", "codex-report.json"), `${JSON.stringify({
    baseline_binding: { lane: "sol", configured_model: "gpt-5.6-sol", evidence: "contract-configured", effective_model: "unproven" },
    requested_routes: {},
  })}\n`);
  await writeFile(join(sessions, "root.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "root", cwd: project, thread_source: "user" } })}\n`);
  await writeFile(join(sessions, "child.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "child", parent_thread_id: "root", cwd: project, thread_source: "subagent" } })}\n${JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-terra" } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 0, total_tokens: 1 } } } })}\n`);
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(project, { recursive: true, force: true })); });
  const evidence = await loadCodexEvidence({ cwd: project, env: { CODEX_HOME: join(project, "codex-home") } });
  assert.equal(evidence.contract_main_model, "gpt-5.6-sol");
});

test("latest selects the newest canonical-cwd root and explicit IDs reject ambiguity", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "orbitlane-estimate-codex-"));
  const sessions = join(project, "codex-home", "sessions");
  await mkdir(sessions, { recursive: true });
  const rollout = (id, timestamp, model, cwd = project) => `${JSON.stringify({ type: "session_meta", payload: { id, cwd, thread_source: "user", timestamp } })}\n${JSON.stringify({ type: "turn_context", payload: { model } })}\n`;
  await writeFile(join(sessions, "old.jsonl"), rollout("old", "2026-08-02T00:00:00Z", "gpt-5.6-luna"));
  await writeFile(join(sessions, "new.jsonl"), rollout("new", "2026-08-02T00:01:00Z", "gpt-5.6-terra"));
  await writeFile(join(sessions, "duplicate-a.jsonl"), rollout("duplicate", "2026-08-02T00:02:00Z", "gpt-5.6-sol", join(project, "other")));
  await writeFile(join(sessions, "duplicate-b.jsonl"), rollout("duplicate", "2026-08-02T00:03:00Z", "gpt-5.6-sol", join(project, "other")));
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(project, { recursive: true, force: true })); });
  const latest = await loadCodexEvidence({ cwd: project, env: { CODEX_HOME: join(project, "codex-home") } });
  assert.equal(latest.observed_main_model, "gpt-5.6-terra");
  await assert.rejects(loadCodexEvidence({ cwd: project, session: "duplicate", env: { CODEX_HOME: join(project, "codex-home") } }), /CODEX_THREAD_AMBIGUOUS/);
});
