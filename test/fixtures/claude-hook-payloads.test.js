import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (name) => readFile(new URL(`../../fixtures/hook-payloads/${name}`, import.meta.url), "utf8").then(JSON.parse);

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

test("route-applied foreground fixture preserves the final non-empty Agent model", async () => {
  const foreground = await read("claude-foreground-agent-route-applied-v2.1.220.json");
  assert.equal(foreground.tool_name, "Agent");
  assert.equal(foreground.tool_input.run_in_background, false);
  assert.equal(typeof foreground.tool_input.model, "string");
  assert.notEqual(foreground.tool_input.model.length, 0);
  assert.equal(typeof foreground.tool_response.resolvedModel, "string");
  assert.equal(typeof foreground.tool_response.totalTokens, "number");
  assert.equal(typeof foreground.tool_response.usage, "object");
  assert.notEqual(foreground.tool_response.usage, null);
  assert.equal(Array.isArray(foreground.tool_response.usage), false);
});
