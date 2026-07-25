import assert from "node:assert/strict";
import test from "node:test";

import { codexCapabilityMatrix, createCodexTier1Adapter, resolveCodexRequestedRoutes } from "../../src/adapters/codex/index.js";

const contract = Object.freeze({
  contract_version: "1.0.0",
  lanes: { sol: { class: "judgment", reasoning: "high" }, terra: { class: "implementation", reasoning: "medium" }, luna: { class: "bounded-retrieval", reasoning: "low" } },
  roles: { architect: { lane: "sol", provenance: "user-approved" }, executor: { lane: "terra", provenance: "user-approved" }, explore: { lane: "luna", provenance: "user-approved" } },
  targets: { codex: { lanes: { sol: { model: "codex-sol", provenance: "user-local" } } } },
});

test("resolves Codex requested routes from binding before runtime lane defaults", () => {
  assert.deepEqual(resolveCodexRequestedRoutes(contract, { release: { version: "1", source: "official", hash: "a".repeat(64) }, lanes: { judgment: { model: "codex-default-sol", provenance: "official-default" }, implementation: { model: "codex-terra", provenance: "official-default" }, "bounded-retrieval": { model: "codex-luna", provenance: "official-default" } } }), {
    architect: { lane: "sol", model: "codex-sol", modelSource: "target-binding", provenance: "user-local", reasoning: "high" },
    executor: { lane: "terra", model: "codex-terra", modelSource: "runtime-default", provenance: "official-default", reasoning: "medium" },
    explore: { lane: "luna", model: "codex-luna", modelSource: "runtime-default", provenance: "official-default", reasoning: "low" },
  });
});

test("fails closed when a Codex lane lacks both binding and official default", () => {
  assert.throws(() => resolveCodexRequestedRoutes(contract, { release: { version: "1", source: "official", hash: "a".repeat(64) }, lanes: { implementation: { model: "codex-terra", provenance: "official-default" } } }), { message: "AMBIGUOUS_MODEL_RESOLUTION: explore" });
});

test("codex refuses a runtime default from a non-official release", () => {
  const contract = {
    contract_version: "1.0.0",
    lanes: {
      sol: { class: "judgment", reasoning: "high" },
      terra: { class: "implementation", reasoning: "medium" },
      luna: { class: "bounded-retrieval", reasoning: "low" },
    },
    roles: { executor: { lane: "terra", provenance: "user-approved" } },
  };
  const unofficial = {
    release: { version: "1.0.0", source: "vendored", hash: "a".repeat(64) },
    lanes: { implementation: { model: "gpt-5.6-terra", provenance: "runtime" } },
  };

  assert.throws(() => resolveCodexRequestedRoutes(contract, unofficial), /AMBIGUOUS_MODEL_RESOLUTION/);
});

test("emits a Tier 1 report with separate requested receipts and unproven native/effective capability", () => {
  const adapter = createCodexTier1Adapter(contract, {
    instructionPath: "/tmp/AGENTS.md",
    generatedPath: "/tmp/orbitlane-codex-roles.json",
    runtime: { available: true, version: "1.0.0" },
    supportsVersion: () => true,
    runtimeDefaults: { release: { version: "1.0.0", source: "official", hash: "a".repeat(64) }, lanes: { judgment: { model: "codex-default-sol", provenance: "official-default" }, implementation: { model: "codex-terra", provenance: "official-default" }, "bounded-retrieval": { model: "codex-luna", provenance: "official-default" } } },
    installedRoles: ["architect", "executor", "explore", "third-party"],
  });
  const rendered = adapter.render();
  const generated = JSON.parse(rendered.generated);

  assert.match(rendered.policy, /execution -> codex-terra, bounded lookup -> codex-luna, delegated verification and analysis -> codex-sol\./);
  assert.equal(generated.tier, "tier1");
  assert.equal(generated.configuration_enforced, false);
  assert.equal(generated.semantic_policy_audited, true);
  assert.equal(generated.role_binding_enforced, false);
  assert.equal(generated.status, "guidance only");
  assert.deepEqual(generated.audit.unmanaged, ["third-party"]);
  assert.deepEqual(generated.requested_routes.architect, { requested_model: "codex-sol", resolution: "target-binding", provenance: "user-local", effective_model: "unproven" });
  assert.deepEqual(generated.capabilities, codexCapabilityMatrix());
});

test("codex never claims enforcement it does not have", () => {
  const contract = {
    contract_version: "1.0.0",
    lanes: {
      sol: { class: "judgment", reasoning: "high" },
      terra: { class: "implementation", reasoning: "medium" },
      luna: { class: "bounded-retrieval", reasoning: "low" },
    },
    roles: { executor: { lane: "terra", provenance: "user-approved" } },
    targets: {
      codex: {
        lanes: {
          sol: { model: "gpt-5.6-sol", provenance: "user-local" },
          terra: { model: "gpt-5.6-terra", provenance: "user-local" },
          luna: { model: "gpt-5.6-luna", provenance: "user-local" },
        },
      },
    },
  };

  const report = JSON.parse(createCodexTier1Adapter(contract, {
    instructionPath: "/tmp/AGENTS.md",
    generatedPath: "/tmp/codex-report.json",
  }).render(contract).generated);

  assert.doesNotMatch(report.status, /partial enforcement/);
  assert.equal(report.enforcement_scope, "none (guidance only)");
  assert.equal(report.requested_routes.executor.effective_model, "unproven");
});
