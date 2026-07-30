import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { observeClaudeUsage } from "../../src/guards/claude-usage-hook.js";

const fixture = (name) => readFile(new URL(`../../fixtures/hook-payloads/${name}`, import.meta.url), "utf8").then(JSON.parse);

const observe = (payload, appendTelemetry = async () => {}, options = {}) => observeClaudeUsage({
  payload,
  installedScope: "project",
  collectorInstanceRef: "collector-1",
  telemetryRoot: "/does-not-exist/report-free",
  appendTelemetry,
  ...options,
});

test("Post observer records route-applied foreground usage without contract reads", async () => {
  const entries = [];
  const result = await observe(await fixture("claude-foreground-agent-route-applied-v2.1.220.json"), async (entry) => entries.push(entry));

  assert.deepEqual(result, { observed: true, telemetry_recorded: true });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event_kind, "execution.usage");
  assert.deepEqual(entries[0].runtime, {
    family: "claude", version: null, version_source: "unknown", version_observed_at: null,
    version_freshness: "unknown", surface: "PostToolUse:Agent",
  });
  assert.deepEqual(entries[0].scope, {
    install_scope: "project", selected_scope: null, collector_instance_ref: "collector-1",
    contract_sha256: null, resolver_policy_version: 1,
  });
  assert.deepEqual(entries[0].links, {
    session_ref: null, turn_ref: null, invocation_ref: null, agent_ref: null, quality: "none",
  });
  assert.deepEqual(entries[0].usage, {
    final_input_model: "sonnet", resolved_model: "claude-sonnet-5", total_tokens: 20269,
    billing_units: {
      input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 0,
      cache_write_5m_input_tokens: 20264, cache_write_1h_input_tokens: 0,
      web_search_requests: 0, web_fetch_requests: 0,
    },
    completion_mode: "foreground", iteration_count: 1,
  });
  assert.deepEqual(entries[0].provenance, { source: "runtime-hook", limitations: ["link-identifiers-unavailable"] });
  assert.equal("policy_projection_sha256" in entries[0].provenance, false);
});

test("Post observer does not append the original null-model fixture", async () => {
  const entries = [];
  const result = await observe(await fixture("claude-foreground-agent-v2.1.220.json"), async (entry) => entries.push(entry));

  assert.deepEqual(result, { observed: false, telemetry_recorded: false });
  assert.deepEqual(entries, []);
});

test("Post observer does not append async, malformed, or incomplete payloads", async () => {
  const routeApplied = await fixture("claude-foreground-agent-route-applied-v2.1.220.json");
  for (const payload of [
    { ...routeApplied, tool_input: { ...routeApplied.tool_input, run_in_background: true } },
    { ...routeApplied, tool_response: { ...routeApplied.tool_response, resolvedModel: null } },
    { tool_name: "Agent" },
    { ...routeApplied, tool_name: "Bash" },
  ]) {
    const entries = [];
    assert.deepEqual(await observe(payload, async (entry) => entries.push(entry)), { observed: false, telemetry_recorded: false });
    assert.deepEqual(entries, []);
  }
});

test("Post observer safely reports append failure", async () => {
  const result = await observe(await fixture("claude-foreground-agent-route-applied-v2.1.220.json"), async () => { throw new Error("append failed"); });
  assert.deepEqual(result, { observed: true, telemetry_recorded: false });
});

test("Post observer retains a valid observation when event creation fails", async () => {
  const diagnostics = [];
  const result = await observe(await fixture("claude-foreground-agent-route-applied-v2.1.220.json"), async () => {
    assert.fail("event creation failure must not append telemetry");
  }, {
    createTelemetryEvent: () => { throw new Error("payload content must not appear in the diagnostic"); },
    reportDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  assert.deepEqual(result, { observed: true, telemetry_recorded: false });
  assert.deepEqual(diagnostics, ["TELEMETRY_EVENT_CREATION_FAILED"]);
});

test("Post observer has no contract, report, resolver, or subprocess dependency", async () => {
  const source = await readFile(new URL("../../src/guards/claude-usage-hook.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /resolveEffectiveContract|resolve-contract|readFile|child_process|execFile|spawn\(/);
});
