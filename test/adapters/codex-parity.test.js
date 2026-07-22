import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { codexCapabilityMatrix, createCodexTier1Adapter } from "../../src/adapters/codex/index.js";

test("Codex generated report capabilities match the fixture-backed capability matrix", async () => {
  const contract = { contract_version: "1.0.0", lanes: { sol: { class: "judgment", reasoning: "high" }, terra: { class: "implementation", reasoning: "medium" }, luna: { class: "bounded-retrieval", reasoning: "low" } }, roles: { executor: { lane: "terra", provenance: "user-approved" } } };
  const options = { instructionPath: "/tmp/a", generatedPath: "/tmp/b", runtime: { available: true, version: "1" }, supportsVersion: () => true, runtimeDefaults: { release: { version: "1", source: "official", hash: "a".repeat(64) }, lanes: { implementation: { model: "codex-terra", provenance: "official-default" } } } };
  const report = JSON.parse(createCodexTier1Adapter(contract, options).render().generated);
  const fixture = JSON.parse(await readFile(new URL("../../fixtures/capabilities/codex.json", import.meta.url), "utf8"));
  assert.deepEqual(fixture, codexCapabilityMatrix());
  assert.deepEqual(report.capabilities, codexCapabilityMatrix());
});
