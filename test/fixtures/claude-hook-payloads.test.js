import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (name) => readFile(new URL(`../../fixtures/hook-payloads/${name}`, import.meta.url), "utf8").then(JSON.parse);

const sortedKeys = (value) => Object.keys(value).sort();
const sensitiveOrRawKeys = new Set([
  "agentId", "agentType", "canReadOutputFile", "content", "cwd", "description",
  "duration_ms", "effort", "isAsync", "outputFile", "payload", "permission_mode",
  "prompt", "prompt_id", "raw", "session_id", "status", "subagent_type",
  "transcript_path", "totalDurationMs",
]);

function assertNoSensitiveOrRawFields(value, path = "fixture") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveOrRawFields(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(sensitiveOrRawKeys.has(key), false, `unexpected ${key} at ${path}`);
    assertNoSensitiveOrRawFields(child, `${path}.${key}`);
  }
}

test("live fixtures establish the foreground/background hook contract", async () => {
  const [foreground, background, metadata] = await Promise.all([
    read("claude-foreground-agent-v2.1.220.json"),
    read("claude-background-agent-v2.1.220.json"),
    read("claude-hook-payload-metadata.json"),
  ]);
  assert.equal(foreground.tool_name, "Agent");
  assert.equal(typeof foreground.tool_use_id, "string");
  assert.equal(typeof foreground.tool_response.resolvedModel, "string");
  assert.equal(typeof foreground.tool_response.totalTokens, "number");
  assert.equal(typeof foreground.tool_response.usage, "object");
  assert.notEqual(foreground.tool_response.usage, null);
  assert.equal(Array.isArray(foreground.tool_response.usage), false);
  assert.equal(background.tool_name, "Agent");
  assert.equal(metadata.runtime_version, "2.1.220");
  assert.equal(metadata.post_payload_version_key, null);
});

test("route-applied foreground fixture is provenance-linked and sanitized", async () => {
  const [foreground, metadata] = await Promise.all([
    read("claude-foreground-agent-route-applied-v2.1.220.json"),
    read("claude-hook-payload-metadata.json"),
  ]);
  assert.deepEqual(sortedKeys(metadata.route_applied_foreground_capture), [
    "caller_specified_model", "completion_mode", "fixture", "guard_injected_model",
    "hook_event_name", "model_source", "run_in_background", "runtime_version",
  ]);
  assert.deepEqual(metadata.route_applied_foreground_capture, {
    fixture: "claude-foreground-agent-route-applied-v2.1.220.json",
    runtime_version: "2.1.220",
    hook_event_name: "PostToolUse",
    completion_mode: "foreground",
    run_in_background: false,
    model_source: "isolated-guard-rewrite",
    caller_specified_model: false,
    guard_injected_model: "sonnet",
  });
  assert.deepEqual(metadata.sanitization.fixed_tool_use_ids, {
    foreground: "TOOL_USE_ID_FOREGROUND",
    background: "TOOL_USE_ID_BACKGROUND",
    route_applied_foreground: "TOOL_USE_ID_FOREGROUND_ROUTE_APPLIED",
  });
  assert.deepEqual(sortedKeys(foreground), ["tool_input", "tool_name", "tool_response", "tool_use_id"]);
  assert.equal(foreground.tool_name, "Agent");
  assert.equal(foreground.tool_use_id, "TOOL_USE_ID_FOREGROUND_ROUTE_APPLIED");
  assert.deepEqual(sortedKeys(foreground.tool_input), ["model", "run_in_background"]);
  assert.equal(foreground.tool_input.run_in_background, false);
  assert.equal(foreground.tool_input.model, "sonnet");
  assert.deepEqual(sortedKeys(foreground.tool_response), ["resolvedModel", "totalTokens", "usage"]);
  assert.equal(typeof foreground.tool_response.resolvedModel, "string");
  assert.equal(typeof foreground.tool_response.totalTokens, "number");
  assert.equal(typeof foreground.tool_response.usage, "object");
  assert.notEqual(foreground.tool_response.usage, null);
  assert.equal(Array.isArray(foreground.tool_response.usage), false);
  assert.deepEqual(sortedKeys(foreground.tool_response.usage), [
    "cache_creation", "cache_creation_input_tokens", "cache_read_input_tokens", "input_tokens",
    "iterations", "output_tokens", "server_tool_use", "service_tier", "speed",
  ]);
  assert.deepEqual(sortedKeys(foreground.tool_response.usage.cache_creation), ["ephemeral_1h_input_tokens", "ephemeral_5m_input_tokens"]);
  assert.deepEqual(sortedKeys(foreground.tool_response.usage.server_tool_use), ["web_fetch_requests", "web_search_requests"]);
  assert.equal(foreground.tool_response.usage.iterations.length, 1);
  assert.deepEqual(sortedKeys(foreground.tool_response.usage.iterations[0]), [
    "cache_creation", "cache_creation_input_tokens", "cache_read_input_tokens", "input_tokens", "output_tokens", "type",
  ]);
  assert.deepEqual(sortedKeys(foreground.tool_response.usage.iterations[0].cache_creation), ["ephemeral_1h_input_tokens", "ephemeral_5m_input_tokens"]);
  assertNoSensitiveOrRawFields(foreground);
});
