import assert from "node:assert/strict";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { loadClaudeEvidence, normalizeClaudeEvents } from "../../src/estimate/claude.js";

const fixtureRoot = resolve("fixtures/estimate/claude");

async function fixtureProject(name) {
  const project = await mkdtemp(join(tmpdir(), "orbitlane-estimate-claude-"));
  const destination = join(project, ".orbitlane", "evidence", "project");
  await cp(join(fixtureRoot, name), destination, { recursive: true });
  return project;
}

test("Claude detailed usage normalizes cache reads and cache writes separately", async () => {
  const evidence = await loadClaudeEvidence({ cwd: await fixtureProject("detailed-exact"), session: "latest" });
  assert.deepEqual(evidence.usage_by_model[0], {
    model: "claude-sonnet-5",
    model_source: "resolved",
    usage: {
      input_tokens: "110",
      cached_input_tokens: "30",
      output_tokens: "40",
      total_tokens: "180",
    },
  });
  assert.equal(evidence.attribution_evidence, "exact-invocation");
  assert.equal(evidence.corrupt_lines, 0);
});

test("latest selects the newest collector and deduplicates valid event IDs", async () => {
  const evidence = await loadClaudeEvidence({ cwd: await fixtureProject("detailed-exact"), session: "latest" });
  assert.equal(evidence.basis.selected_collector_event_count, 2);
  assert.equal(evidence.usage_by_model.length, 1);
  assert.equal(evidence.usage_by_model[0].usage.total_tokens, "180");
});

test("Claude partial evidence retains unknown model usage and corrupt-line diagnostics", async () => {
  const evidence = await loadClaudeEvidence({ cwd: await fixtureProject("partial"), session: "latest" });
  assert.equal(evidence.attribution_evidence, "linked-child");
  assert.equal(evidence.usage_by_model[0].model_source, "resolved");
  assert.equal(evidence.unknown_model_usage.total_tokens, "20");
  assert.equal(evidence.corrupt_lines, 1);
  assert.ok(evidence.total_lines >= 3);
});

test("routing evidence without usage stays non-monetary", async () => {
  const evidence = await loadClaudeEvidence({ cwd: await fixtureProject("routing-only"), session: "latest" });
  assert.equal(evidence.usage_evidence, "none");
  assert.deepEqual(evidence.usage_by_model, []);
  assert.equal(evidence.attribution_evidence, "guidance-only");
});

test("an explicit file is isolated from sibling routing evidence", async () => {
  const project = await fixtureProject("detailed-exact");
  const evidence = await loadClaudeEvidence({ cwd: project, session: join(project, ".orbitlane", "evidence", "project", "execution-usage.v1.jsonl") });
  assert.equal(evidence.attribution_evidence, "linked-child");
  assert.equal(evidence.usage_by_model[0].model, "claude-sonnet-5");
  assert.equal(evidence.basis.selected_collector_event_count, 1);
});

test("normalization handles missing files and model-bearing usage without a join", () => {
  const evidence = normalizeClaudeEvents({ decisions: [], usages: [{
    event_id: "usage-only", event_kind: "execution.usage", observed_at: "2026-08-02T00:00:00Z",
    scope: { collector_instance_ref: "fixture-collector" }, links: { quality: "none", invocation_ref: null },
    usage: { resolved_model: "claude-sonnet-5", total_tokens: 1, billing_units: { input_tokens: 1, cache_read_input_tokens: 0, cache_write_5m_input_tokens: 0, cache_write_1h_input_tokens: 0, output_tokens: 0, web_search_requests: 0, web_fetch_requests: 0 } },
  }], corruptLines: 0, totalLines: 1 });
  assert.equal(evidence.source_kind, "claude-events");
  assert.equal(evidence.attribution_evidence, "linked-child");
  assert.equal(evidence.usage_by_model[0].usage.input_tokens, "1");
});

test("mixed joined and unjoined usage cannot claim exact-invocation attribution", () => {
  const base = { observed_at: "2026-08-02T00:00:00Z", scope: { collector_instance_ref: "fixture-collector" } };
  const usage = (event_id, invocation_ref) => ({ ...base, event_id, event_kind: "execution.usage", links: { quality: invocation_ref ? "exact" : "none", invocation_ref }, usage: { resolved_model: "claude-sonnet-5", total_tokens: 1, billing_units: { input_tokens: 1, cache_read_input_tokens: 0, cache_write_5m_input_tokens: 0, cache_write_1h_input_tokens: 0, output_tokens: 0, web_search_requests: 0, web_fetch_requests: 0 } } });
  const evidence = normalizeClaudeEvents({ decisions: [{ ...base, event_id: "decision", event_kind: "routing.decision", links: { quality: "exact", invocation_ref: "joined" }, routing: { injected_model: "claude-sonnet-5" } }], usages: [usage("joined-usage", "joined"), usage("unjoined-usage", null)], corruptLines: 0, totalLines: 3 });
  assert.equal(evidence.attribution_evidence, "linked-child");
});

test("unsafe model strings are retained only as unknown usage", () => {
  const evidence = normalizeClaudeEvents({ decisions: [], usages: [{ event_kind: "execution.usage", observed_at: "2026-08-02T00:00:00Z", scope: { collector_instance_ref: "fixture-collector" }, usage: { resolved_model: ["", "home", "fixture-user"].join("/"), total_tokens: 1, billing_units: { input_tokens: 1, cache_read_input_tokens: 0, cache_write_5m_input_tokens: 0, cache_write_1h_input_tokens: 0, output_tokens: 0, web_search_requests: 0, web_fetch_requests: 0 } } }], corruptLines: 0, totalLines: 1 });
  assert.deepEqual(evidence.usage_by_model, []);
  assert.equal(evidence.unknown_model_usage.total_tokens, "1");
});
