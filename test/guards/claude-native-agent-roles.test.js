import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateClaudeAgentSpawn } from "../../src/guards/claude-spawn.js";
import { validateContract } from "../../src/schema/index.js";

// A contract only routes a spawn when its role name equals the runtime's own agent
// identifier. These tests hold that binding to Claude Code's actual agent types: if
// the identifiers drift, or the role grammar stops admitting them, routing silently
// falls back to UNMANAGED_ROLE and the contract governs nothing.
const contract = JSON.parse(await readFile(fileURLToPath(new URL("../../fixtures/contracts/claude-native-agent-roles.json", import.meta.url)), "utf8"));

test("a contract may name Claude Code's own agent types, capitals included", () => {
  assert.deepEqual(validateContract(contract), { valid: true, errors: [] });
});

test("routes the built-in agent types a session actually spawns", () => {
  const routed = [
    // Bounded lookup is the frequent, cheap-by-nature case: the largest saving.
    ["Explore", "haiku"],
    // Multi-step work drops to the implementation lane, not to the cheapest one.
    ["general-purpose", "sonnet"],
    // Judgment stays expensive on purpose. Routing is about the right lane, not the
    // cheapest lane everywhere.
    ["Plan", "opus"],
  ];

  for (const [subagentType, model] of routed) {
    assert.deepEqual(evaluateClaudeAgentSpawn({ input: { subagent_type: subagentType, prompt: "x" }, contract }), {
      exitCode: 0,
      decision: "allow",
      reason: "ROUTED_MODEL_INJECTED",
      effective_model: "unproven",
      routed_model: model,
      injected_model: model,
    }, subagentType);
  }
});

test("an explicit model still wins over the routed lane", () => {
  const result = evaluateClaudeAgentSpawn({ input: { subagent_type: "Explore", model: "opus" }, contract });
  assert.equal(result.reason, "EXPLICIT_MODEL_RETAINED");
  assert.equal(result.injected_model, undefined);
});

test("an agent type the contract does not name is left alone", () => {
  assert.equal(evaluateClaudeAgentSpawn({ input: { subagent_type: "statusline-setup" }, contract }).reason, "UNMANAGED_ROLE");
});

test("role names stay case-sensitive so a near-miss is visible rather than silently routed", () => {
  // `explore` is not `Explore`. Matching loosely would let a contract claim to govern
  // an agent type that does not exist.
  assert.equal(evaluateClaudeAgentSpawn({ input: { subagent_type: "explore" }, contract }).reason, "UNMANAGED_ROLE");
});
