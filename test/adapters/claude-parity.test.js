import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { claudeTier1CapabilityMatrix, createClaudeTier1Adapter } from "../../src/adapters/claude/index.js";

test("Claude generated report capabilities match the fixture-backed Tier 1 capability matrix", async () => {
  const contract = {
    contract_version: "1.0.0",
    lanes: { sol: { class: "judgment", reasoning: "high" }, terra: { class: "implementation", reasoning: "medium" }, luna: { class: "bounded-retrieval", reasoning: "low" } },
    roles: { executor: { lane: "terra", provenance: "user-approved" } },
  };
  const report = JSON.parse(createClaudeTier1Adapter(contract, {
    instructionPath: "/tmp/a",
    generatedPath: "/tmp/b",
    runtime: { available: true, version: "1" },
    supportsVersion: () => true,
    runtimeDefaults: {
      release: { version: "1", source: "official", hash: "a".repeat(64) },
      lanes: { implementation: { model: "claude-terra", provenance: "official-default" } },
    },
  }).render().generated);
  const fixture = JSON.parse(await readFile(new URL("../../fixtures/capabilities/claude-tier1.json", import.meta.url), "utf8"));

  assert.deepEqual(fixture, claudeTier1CapabilityMatrix());
  assert.deepEqual(report.capabilities, claudeTier1CapabilityMatrix());
});
