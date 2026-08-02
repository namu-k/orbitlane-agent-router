import assert from "node:assert/strict";
import test from "node:test";

import { allocateRootUsage, normalizeCodexRollouts } from "../../src/estimate/codex.js";

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
