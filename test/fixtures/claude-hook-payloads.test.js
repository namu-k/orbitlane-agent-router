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
