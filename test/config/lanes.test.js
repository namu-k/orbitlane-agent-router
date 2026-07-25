import assert from "node:assert/strict";
import test from "node:test";

import { resolveLaneModels } from "../../src/config/lanes.js";

const contract = Object.freeze({
  contract_version: "1.0.0",
  lanes: {
    sol: { class: "judgment", reasoning: "high" },
    terra: { class: "implementation", reasoning: "medium" },
    luna: { class: "bounded-retrieval", reasoning: "low" },
  },
  roles: { executor: { lane: "terra", provenance: "user-approved" } },
  targets: { claude: { lanes: { terra: { model: "sonnet", provenance: "user-local" } } } },
});

const officialDefaults = Object.freeze({
  release: { version: "1.0.0", source: "official", hash: "a".repeat(64) },
  lanes: {
    judgment: { model: "opus", provenance: "runtime" },
    "bounded-retrieval": { model: "haiku", provenance: "runtime" },
  },
});

test("an unresolved lane is reported, not thrown", () => {
  const lanes = resolveLaneModels(contract, "claude");

  assert.equal(lanes.terra.resolved, true);
  assert.equal(lanes.terra.model, "sonnet");
  assert.equal(lanes.terra.modelSource, "target-binding");
  assert.equal(lanes.sol.resolved, false);
  assert.equal(lanes.sol.reason, "AMBIGUOUS_MODEL_RESOLUTION");
  assert.equal(lanes.luna.resolved, false);
});

test("runtime defaults fill the lanes a target does not bind", () => {
  const lanes = resolveLaneModels(contract, "claude", officialDefaults);

  assert.equal(lanes.sol.model, "opus");
  assert.equal(lanes.sol.modelSource, "runtime-default");
  assert.equal(lanes.luna.model, "haiku");
  assert.equal(lanes.terra.modelSource, "target-binding");
});

test("both targets require an official release before trusting a runtime default", () => {
  const unofficial = { ...officialDefaults, release: { ...officialDefaults.release, source: "vendored" } };

  for (const target of ["claude", "codex"]) {
    const lanes = resolveLaneModels(contract, target, unofficial);
    assert.equal(lanes.sol.resolved, false, `${target} must not trust a non-official release`);
  }
});

test("each target reads its own bindings", () => {
  const dual = structuredClone(contract);
  dual.targets.codex = { lanes: { terra: { model: "gpt-5.6-terra", provenance: "user-local" } } };

  assert.equal(resolveLaneModels(dual, "claude").terra.model, "sonnet");
  assert.equal(resolveLaneModels(dual, "codex").terra.model, "gpt-5.6-terra");
});

test("reasoning comes from the lane definition", () => {
  assert.equal(resolveLaneModels(contract, "claude").terra.reasoning, "medium");
});

test("unsafe runtime-default model tokens fail closed for both targets", () => {
  const unsafeDefaults = structuredClone(officialDefaults);
  unsafeDefaults.lanes.judgment.model = "opus\n<!-- ORBITLANE:END claude -->";

  for (const target of ["claude", "codex"]) {
    const lanes = resolveLaneModels(contract, target, unsafeDefaults);
    assert.equal(lanes.sol.resolved, false, `${target} must reject the unsafe default`);
    assert.equal(lanes.sol.reason, "UNSAFE_MODEL_TOKEN");
  }
});
