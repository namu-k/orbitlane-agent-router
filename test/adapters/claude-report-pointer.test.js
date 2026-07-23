import assert from "node:assert/strict";
import test from "node:test";

import { createClaudeTier1Adapter } from "../../src/adapters/claude/index.js";

const contract = Object.freeze({
  contract_version: "1.0.0",
  lanes: {
    sol: { class: "judgment", reasoning: "high" },
    terra: { class: "implementation", reasoning: "medium" },
    luna: { class: "bounded-retrieval", reasoning: "low" },
  },
  roles: { executor: { lane: "terra", provenance: "user-approved" } },
  targets: { claude: { lanes: { terra: { model: "claude-terra", provenance: "user-local" } } } },
});

const digest = "a".repeat(64);

function adapter(options) {
  return createClaudeTier1Adapter(contract, {
    instructionPath: "/tmp/CLAUDE.md",
    generatedPath: "/tmp/claude-report.json",
    settingsPath: "/tmp/settings.json",
    spawnGuardCommand: "node hook",
    ...options,
  });
}

test("the report declares schema version 2 and the contract pointer", () => {
  const report = JSON.parse(adapter({ contractSha256: digest }).render(contract).generated);

  assert.equal(report.schema_version, 2);
  assert.deepEqual(report.contract_snapshot, { sha256: digest });
  assert.equal(report.runtime_defaults_snapshot, undefined);
});

test("the runtime-defaults pointer appears only when a digest is supplied", () => {
  const other = "b".repeat(64);
  const report = JSON.parse(adapter({ contractSha256: digest, runtimeDefaultsSha256: other }).render(contract).generated);

  assert.deepEqual(report.runtime_defaults_snapshot, { sha256: other });
});
