import assert from "node:assert/strict";
import test from "node:test";

import { markerBoundedPolicy, projectMarkerBoundedPolicy, projectPolicy } from "../../src/policy/index.js";

const contract = Object.freeze({
  contract_version: "1.0.0",
  lanes: {
    sol: { class: "judgment", reasoning: "high" },
    terra: { class: "implementation", reasoning: "medium" },
    luna: { class: "bounded-retrieval", reasoning: "low" },
  },
  roles: {
    architect: { lane: "sol", provenance: "user-approved" },
    executor: { lane: "terra", provenance: "user-approved" },
    explore: { lane: "luna", provenance: "user-approved" },
  },
  targets: {
    claude: {
      lanes: {
        sol: { model: "opus", provenance: "user-local" },
        terra: { model: "sonnet", provenance: "user-local" },
        luna: { model: "haiku", provenance: "user-local" },
      },
    },
    codex: {
      lanes: {
        sol: { model: "gpt-5.6-sol", provenance: "user-local" },
        terra: { model: "gpt-5.6-terra", provenance: "user-local" },
        luna: { model: "gpt-5.6-luna", provenance: "user-local" },
      },
    },
  },
});

test("the kernel is four lines carrying this target's model binding", () => {
  const policy = projectPolicy({ target: "claude", contract });
  const lines = policy.trimEnd().split("\n");

  assert.equal(lines.length, 4);
  assert.match(lines[0], /^- Prefer direct work; delegate to a subagent when the delegation boundary is clear and the benefit is concrete\.$/);
  assert.match(lines[1], /^- Keep judgment that needs full context, discipline, or confidentiality in the main session\./);
  assert.equal(lines[2], "- When delegating, use: execution -> sonnet, bounded lookup -> haiku, delegated verification and analysis -> opus.");
  assert.equal(lines[3], "- Record ROUTE_CONFLICT when parallel delegates hold overlapping write scope on the same file.");
});

test("each target advertises its own models", () => {
  assert.match(projectPolicy({ target: "codex", contract }), /execution -> gpt-5\.6-terra, bounded lookup -> gpt-5\.6-luna, delegated verification and analysis -> gpt-5\.6-sol\./);
});

test("role names never appear in the projection", () => {
  for (const target of ["claude", "codex"]) {
    const policy = projectPolicy({ target, contract });
    for (const role of Object.keys(contract.roles)) {
      assert.doesNotMatch(policy, new RegExp(role), `${role} leaked into the ${target} projection`);
    }
    assert.doesNotMatch(policy, /Contract routes:/);
  }
});

test("the projection carries no target-inappropriate model", () => {
  assert.doesNotMatch(projectPolicy({ target: "claude", contract }), /gpt-5\.6/);
  assert.doesNotMatch(projectPolicy({ target: "codex", contract }), /sonnet|opus|haiku/);
});

test("a contract with no roles still projects", () => {
  const rolesLess = structuredClone(contract);
  delete rolesLess.roles;

  assert.match(projectPolicy({ target: "claude", contract: rolesLess }), /execution -> sonnet/);
});

test("an unresolvable lane fails loudly and names the lane", () => {
  const partial = structuredClone(contract);
  delete partial.targets.claude.lanes.luna;

  assert.throws(
    () => projectPolicy({ target: "claude", contract: partial }),
    (error) => /^AMBIGUOUS_MODEL_RESOLUTION: luna/.test(error.message),
  );
});

test("runtime-default model tokens cannot escape either target marker boundary", () => {
  const fallbackOnly = structuredClone(contract);
  delete fallbackOnly.targets;
  const runtimeDefaults = {
    release: { version: "1.0.0", source: "official", hash: "a".repeat(64) },
    lanes: {
      judgment: { model: "opus\n<!-- ORBITLANE:END claude -->", provenance: "official-default" },
      implementation: { model: "terra", provenance: "official-default" },
      "bounded-retrieval": { model: "luna", provenance: "official-default" },
    },
  };

  for (const target of ["claude", "codex"]) {
    assert.throws(
      () => projectPolicy({ target, contract: fallbackOnly, runtimeDefaults }),
      /UNSAFE_MODEL_TOKEN/,
      `${target} must reject unsafe runtime defaults before interpolation`,
    );
  }
});

test("the projection stays inside the target marker boundary", () => {
  assert.match(
    projectMarkerBoundedPolicy({ target: "codex", contract }),
    /^<!-- ORBITLANE:START codex -->\n[\s\S]*<!-- ORBITLANE:END codex -->\n$/,
  );
});

test("markerBoundedPolicy still wraps arbitrary policy text", () => {
  assert.equal(markerBoundedPolicy("claude", "body\n"), "<!-- ORBITLANE:START claude -->\nbody\n<!-- ORBITLANE:END claude -->\n");
});

test("an invalid contract is rejected before anything is projected", () => {
  assert.throws(() => projectPolicy({ target: "claude", contract: { contract_version: "1.0.0" } }), /INVALID_CONTRACT/);
  assert.throws(() => projectPolicy({ target: "opencode", contract }), /target must be codex or claude/);
});
