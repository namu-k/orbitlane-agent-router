import assert from "node:assert/strict";
import test from "node:test";

import { createClaudeTier1Adapter, probeClaudeTier1Capabilities, resolveClaudeRequestedRoutes } from "../../src/adapters/claude/index.js";
import { markerBoundedPolicy } from "../../src/policy/index.js";
import { projectedGuidanceProvenance } from "../../src/telemetry/identity.js";

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
  targets: { claude: { lanes: { sol: { model: "claude-sol", provenance: "user-local" } } } },
});

const runtimeDefaults = Object.freeze({
  release: { version: "1.0.0", source: "official", hash: "a".repeat(64) },
  lanes: {
    judgment: { model: "claude-default-sol", provenance: "official-default" },
    implementation: { model: "claude-terra", provenance: "official-default" },
    "bounded-retrieval": { model: "claude-luna", provenance: "official-default" },
  },
});

test("resolves Claude requested routes from bindings before release-backed lane defaults", () => {
  assert.deepEqual(resolveClaudeRequestedRoutes(contract, runtimeDefaults), {
    architect: { lane: "sol", model: "claude-sol", modelSource: "target-binding", provenance: "user-local", reasoning: "high" },
    executor: { lane: "terra", model: "claude-terra", modelSource: "runtime-default", provenance: "official-default", reasoning: "medium", release: runtimeDefaults.release },
    explore: { lane: "luna", model: "claude-luna", modelSource: "runtime-default", provenance: "official-default", reasoning: "low", release: runtimeDefaults.release },
  });
});

test("fails closed when Claude cannot resolve a requested model", () => {
  assert.throws(() => resolveClaudeRequestedRoutes(contract, {
    release: runtimeDefaults.release,
    lanes: { implementation: runtimeDefaults.lanes.implementation },
  }), { message: "AMBIGUOUS_MODEL_RESOLUTION: explore" });
});

test("reports an unsafe official runtime default for the routed Claude role", () => {
  assert.throws(() => resolveClaudeRequestedRoutes(contract, {
    release: runtimeDefaults.release,
    lanes: {
      implementation: {
        model: "claude-terra\n<!-- ORBITLANE:END claude -->",
        provenance: "official-default",
      },
      "bounded-retrieval": runtimeDefaults.lanes["bounded-retrieval"],
    },
  }), { message: "UNSAFE_MODEL_TOKEN: executor" });
});

test("Claude rejects its own unsafe binding even when Codex remains valid", () => {
  const dual = structuredClone(contract);
  dual.targets.codex = { lanes: { sol: { model: "gpt-5.6-sol", provenance: "user-local" } } };
  dual.targets.claude.lanes.sol.model = "claude-sol\n<!-- ORBITLANE:END claude -->";

  assert.throws(() => resolveClaudeRequestedRoutes(dual), /UNSAFE_MODEL_TOKEN/);
});

test("rejects an untrusted runtime default and records official release evidence for a default receipt", () => {
  assert.throws(() => resolveClaudeRequestedRoutes(contract, {
    release: { ...runtimeDefaults.release, source: "untrusted" },
    lanes: runtimeDefaults.lanes,
  }), { message: "AMBIGUOUS_MODEL_RESOLUTION: executor" });

  const routes = resolveClaudeRequestedRoutes({ ...contract, targets: undefined }, runtimeDefaults);
  assert.deepEqual(routes.executor.release, runtimeDefaults.release);
});

test("a role resolves even when other lanes are unbound", () => {
  const partial = {
    contract_version: "1.0.0",
    lanes: {
      sol: { class: "judgment", reasoning: "high" },
      terra: { class: "implementation", reasoning: "medium" },
      luna: { class: "bounded-retrieval", reasoning: "low" },
    },
    roles: { executor: { lane: "terra", provenance: "user-approved" } },
    targets: { claude: { lanes: { terra: { model: "sonnet", provenance: "user-local" } } } },
  };

  const routes = resolveClaudeRequestedRoutes(partial);

  assert.equal(routes.executor.model, "sonnet");
  assert.equal(routes.executor.modelSource, "target-binding");
});

test("a routed role whose own lane is unbound still fails", () => {
  const partial = {
    contract_version: "1.0.0",
    lanes: {
      sol: { class: "judgment", reasoning: "high" },
      terra: { class: "implementation", reasoning: "medium" },
      luna: { class: "bounded-retrieval", reasoning: "low" },
    },
    roles: { architect: { lane: "sol", provenance: "user-approved" } },
    targets: { claude: { lanes: { terra: { model: "sonnet", provenance: "user-local" } } } },
  };

  assert.throws(() => resolveClaudeRequestedRoutes(partial), /AMBIGUOUS_MODEL_RESOLUTION: architect/);
});

test("never infers native configuration from runtime flags or caller-supplied artifact bytes", () => {
  assert.deepEqual(probeClaudeTier1Capabilities({
    runtime: { available: true, version: "1.0.0" },
    supportsVersion: () => true,
    nativeArtifacts: [{ path: "executor.md", content: "---\nname: \"executor\"\ndescription: \"Executor\"\nmodel: \"claude-terra\"\neffort: \"medium\"\n---\n" }],
  }).native_role_configuration, { status: "unproven", scope: "no-native-artifact-discovery" });
  assert.deepEqual(probeClaudeTier1Capabilities({
    runtime: { available: false, version: "1.0.0" },
    supportsVersion: () => true,
    nativeArtifacts: [],
  }).native_role_configuration, { status: "unproven", scope: "no-native-artifact-discovery" });
  const executorArtifact = { path: "executor.md", content: "---\nname: \"executor\"\ndescription: \"Executor\"\nmodel: \"claude-terra\"\neffort: \"medium\"\n---\n" };
  assert.deepEqual(probeClaudeTier1Capabilities({
    runtime: { available: true, version: "1.0.0" },
    supportsVersion: () => true,
    nativeArtifacts: [executorArtifact, executorArtifact],
    expectedRoutes: { executor: { model: "claude-terra", reasoning: "medium" }, explore: { model: "claude-luna", reasoning: "low" } },
  }).native_role_configuration, { status: "unproven", scope: "no-native-artifact-discovery" });
  assert.deepEqual(probeClaudeTier1Capabilities({
    runtime: { available: true, version: "1.0.0" },
    supportsVersion: () => true,
    nativeArtifacts: [{ path: "executor.md", content: "---\nname: null\ndescription: \"Executor\"\nmodel: \"claude-terra\"\neffort: \"medium\"\n---\n" }],
  }).native_role_configuration, { status: "unproven", scope: "no-native-artifact-discovery" });
  assert.deepEqual(probeClaudeTier1Capabilities({
    runtime: { available: true, version: "1.0.0" },
    supportsVersion: () => true,
    nativeArtifacts: [{}],
  }).native_role_configuration, { status: "unproven", scope: "no-native-artifact-discovery" });
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

  assert.match(rendered.policy, /execution -> claude-terra, bounded lookup -> claude-luna, delegated verification and analysis -> claude-sol\./);
  assert.equal(generated.tier, "tier1");
  assert.equal(generated.configuration_enforced, false);
  assert.equal(generated.semantic_policy_audited, true);
  assert.equal(generated.role_binding_enforced, false);
  assert.equal(generated.status, "partial enforcement");
  assert.deepEqual(generated.audit.unmanaged, ["third-party"]);
  assert.deepEqual(generated.requested_routes.architect, {
    requested_model: "claude-sol",
    resolution: "target-binding",
    provenance: "user-local",
    // `claude-sol` is not a model the Agent tool accepts, so this role is projected
    // as guidance but the guard will never write it into a spawn.
    injectable: false,
    effective_model: "unproven",
  });
  assert.deepEqual(generated.requested_routes.executor.release, runtimeDefaults.release);
  assert.deepEqual(generated.subagents.executor.frontmatter, {
    name: "executor",
    model: "claude-terra",
    effort: "medium",
  });
  assert.match(generated.native_artifacts["executor.md"], /^---\nname: "executor"\ndescription: "Stable executor role"\nmodel: "claude-terra"\neffort: "medium"\n---\n/m);
  assert.match(generated.subagents.executor.instructions, /Full transcript context requires explicit opt-in/);
  assert.doesNotMatch(generated.subagents.executor.instructions, /conversation log|prior messages/i);
  assert.deepEqual(generated.capabilities.reasoning, {
    effort: "supported",
    thinking: "session-inherited",
    effective: "unproven",
  });
  assert.deepEqual(generated.capabilities.claude_agent_pre_dispatch, { status: "unproven", scope: "Agent tool only" });
  assert.deepEqual(generated.capabilities.native_role_configuration, { status: "unproven", scope: "no-native-artifact-discovery" });
});

test("Claude report receipts exact marker-bounded policy bytes", () => {
  const rendered = createClaudeTier1Adapter(contract, {
    instructionPath: "/tmp/CLAUDE.md",
    generatedPath: "/tmp/orbitlane-claude.json",
    runtimeDefaults,
  }).render();
  const report = JSON.parse(rendered.generated);
  const bounded = markerBoundedPolicy("claude", rendered.policy);

  assert.equal(report.policy_provenance.projected_guidance_bytes, Buffer.byteLength(bounded, "utf8"));
  assert.deepEqual(report.policy_provenance, projectedGuidanceProvenance(bounded));
  assert.match(report.policy_provenance.policy_projection_sha256, /^[a-f0-9]{64}$/);
});

test("a roles-less install claims no native configuration and no enforcement", () => {
  const rolesLess = {
    contract_version: "1.0.0",
    lanes: {
      sol: { class: "judgment", reasoning: "high" },
      terra: { class: "implementation", reasoning: "medium" },
      luna: { class: "bounded-retrieval", reasoning: "low" },
    },
    targets: {
      claude: {
        lanes: {
          sol: { model: "opus", provenance: "user-local" },
          terra: { model: "sonnet", provenance: "user-local" },
          luna: { model: "haiku", provenance: "user-local" },
        },
      },
    },
  };

  const adapter = createClaudeTier1Adapter(rolesLess, {
    instructionPath: "/tmp/CLAUDE.md",
    generatedPath: "/tmp/claude-report.json",
    settingsPath: "/tmp/settings.json",
    contractSha256: "a".repeat(64),
  });
  const report = JSON.parse(adapter.render(rolesLess).generated);

  assert.equal(report.enforcement_scope, "none (roles omitted)");
  assert.deepEqual(report.capabilities.native_role_configuration, {
    status: "not-applicable",
    scope: "roles-omitted",
  });
  assert.deepEqual(report.requested_routes, {});
  assert.deepEqual(report.subagents, {});
  assert.deepEqual(report.native_artifacts, {});
  assert.equal(report.status, "guidance only");
  assert.equal(report.capabilities.effective_model, "unproven");
});

test("a roles-bearing install names its scoped enforcement", () => {
  const report = JSON.parse(createClaudeTier1Adapter(contract, {
    instructionPath: "/tmp/CLAUDE.md",
    generatedPath: "/tmp/claude-report.json",
    settingsPath: "/tmp/settings.json",
    contractSha256: "a".repeat(64),
    runtimeDefaults,
  }).render(contract).generated);

  assert.equal(report.enforcement_scope, "scoped-request-check");
});
