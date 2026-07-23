import assert from "node:assert/strict";
import test from "node:test";

import { createClaudeTier1Adapter, probeClaudeTier1Capabilities, resolveClaudeRequestedRoutes } from "../../src/adapters/claude/index.js";

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
  targets: { claude: { lanes: { sol: { model: "opus", provenance: "user-local" } } } },
});

const runtimeDefaults = Object.freeze({
  release: { version: "1.0.0", source: "official", hash: "a".repeat(64) },
  lanes: {
    judgment: { model: "opus", provenance: "official-default" },
    implementation: { model: "sonnet", provenance: "official-default" },
    "bounded-retrieval": { model: "haiku", provenance: "official-default" },
  },
});

test("resolves Claude requested routes from bindings before release-backed lane defaults", () => {
  assert.deepEqual(resolveClaudeRequestedRoutes(contract, runtimeDefaults), {
    architect: { target: "claude", lane: "sol", model: "opus", modelSource: "target-binding", provenance: "user-local", reasoning: "high" },
    executor: { target: "claude", lane: "terra", model: "sonnet", modelSource: "runtime-default", provenance: "official-default", reasoning: "medium", release: runtimeDefaults.release },
    explore: { target: "claude", lane: "luna", model: "haiku", modelSource: "runtime-default", provenance: "official-default", reasoning: "low", release: runtimeDefaults.release },
  });
});

test("fails closed when Claude cannot resolve a requested model", () => {
  assert.throws(() => resolveClaudeRequestedRoutes(contract, {
    release: runtimeDefaults.release,
    lanes: { implementation: runtimeDefaults.lanes.implementation },
  }), { message: "AMBIGUOUS_MODEL_RESOLUTION: explore" });
});

test("rejects an untrusted runtime default and records official release evidence for a default receipt", () => {
  assert.throws(() => resolveClaudeRequestedRoutes(contract, {
    release: { ...runtimeDefaults.release, source: "untrusted" },
    lanes: runtimeDefaults.lanes,
  }), { message: "AMBIGUOUS_MODEL_RESOLUTION: executor" });

  const routes = resolveClaudeRequestedRoutes({ ...contract, targets: undefined }, runtimeDefaults);
  assert.deepEqual(routes.executor.release, runtimeDefaults.release);
});

test("reports native projection capability only when supported runtime and native artifacts are present", () => {
  assert.deepEqual(probeClaudeTier1Capabilities({
    runtime: { available: true, version: "1.0.0" },
    supportsVersion: () => true,
    nativeArtifacts: [{ path: "executor.md", content: "---\nname: \"executor\"\ndescription: \"Executor\"\nmodel: \"sonnet\"\neffort: \"medium\"\n---\n" }],
  }).native_role_configuration, { status: "configured", scope: "custom-subagent-definitions" });
  assert.deepEqual(probeClaudeTier1Capabilities({
    runtime: { available: false, version: "1.0.0" },
    supportsVersion: () => true,
    nativeArtifacts: [],
  }).native_role_configuration, { status: "unproven", scope: "runtime-or-artifact-unavailable" });
  const executorArtifact = { path: "executor.md", content: "---\nname: \"executor\"\ndescription: \"Executor\"\nmodel: \"sonnet\"\neffort: \"medium\"\n---\n" };
  assert.deepEqual(probeClaudeTier1Capabilities({
    runtime: { available: true, version: "1.0.0" },
    supportsVersion: () => true,
    nativeArtifacts: [executorArtifact, executorArtifact],
    expectedRoutes: { executor: { model: "sonnet", reasoning: "medium" }, explore: { model: "haiku", reasoning: "low" } },
  }).native_role_configuration, { status: "unproven", scope: "runtime-or-artifact-unavailable" });
  assert.deepEqual(probeClaudeTier1Capabilities({
    runtime: { available: true, version: "1.0.0" },
    supportsVersion: () => true,
    nativeArtifacts: [{ path: "executor.md", content: "---\nname: null\ndescription: \"Executor\"\nmodel: \"claude-terra\"\neffort: \"medium\"\n---\n" }],
  }).native_role_configuration, { status: "unproven", scope: "runtime-or-artifact-unavailable" });
  assert.deepEqual(probeClaudeTier1Capabilities({
    runtime: { available: true, version: "1.0.0" },
    supportsVersion: () => true,
    nativeArtifacts: [{}],
  }).native_role_configuration, { status: "unproven", scope: "runtime-or-artifact-unavailable" });
});

test("projects stable Claude subagents and an honest Tier 1 report without transcript injection", () => {
  const adapter = createClaudeTier1Adapter(contract, {
    instructionPath: "/tmp/CLAUDE.md",
    generatedPath: "/tmp/orbitlane-claude.json",
    runtime: { available: true, version: "1.0.0" },
    supportsVersion: () => true,
    runtimeDefaults,
    installedRoles: ["architect", "executor", "explore", "third-party"],
  });
  const rendered = adapter.render();
  const generated = JSON.parse(rendered.generated);

  assert.match(rendered.policy, /OrbitLane policy projection for claude/);
  assert.match(rendered.policy, /Target model routes: architect="opus", executor="sonnet", explore="haiku"\./);
  assert.doesNotMatch(rendered.policy, /Contract routes: architect=sol, executor=terra, explore=luna\./);
  assert.equal(generated.tier, "tier1");
  assert.equal(generated.configuration_enforced, false);
  assert.equal(generated.semantic_policy_audited, true);
  assert.equal(generated.role_binding_enforced, false);
  assert.equal(generated.status, "partial enforcement");
  assert.deepEqual(generated.audit.unmanaged, ["third-party"]);
  assert.deepEqual(generated.requested_routes.architect, {
    requested_model: "opus",
    resolution: "target-binding",
    provenance: "user-local",
    effective_model: "unproven",
  });
  assert.deepEqual(generated.requested_routes.executor.release, runtimeDefaults.release);
  assert.deepEqual(generated.subagents.executor.frontmatter, {
    name: "executor",
    model: "sonnet",
    effort: "medium",
  });
  assert.match(generated.native_artifacts["executor.md"], /^---\nname: "executor"\ndescription: "Stable executor role"\nmodel: "sonnet"\neffort: "medium"\n---\n/m);
  assert.match(generated.subagents.executor.instructions, /Full transcript context requires explicit opt-in/);
  assert.doesNotMatch(generated.subagents.executor.instructions, /conversation log|prior messages/i);
  assert.deepEqual(generated.capabilities.reasoning, {
    effort: "supported",
    thinking: "session-inherited",
    effective: "unproven",
  });
  assert.deepEqual(generated.capabilities.claude_agent_pre_dispatch, { status: "unproven", scope: "Agent tool only" });
});
