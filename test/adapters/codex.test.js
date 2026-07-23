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
    architect: { target: "codex", lane: "sol", model: "codex-sol", modelSource: "target-binding", provenance: "user-local", reasoning: "high" },
    executor: { target: "codex", lane: "terra", model: "codex-terra", modelSource: "runtime-default", provenance: "official-default", reasoning: "medium" },
    explore: { target: "codex", lane: "luna", model: "codex-luna", modelSource: "runtime-default", provenance: "official-default", reasoning: "low" },
  });
});

test("fails closed when a Codex lane lacks both binding and official default", () => {
  assert.throws(() => resolveCodexRequestedRoutes(contract, { release: { version: "1", source: "official", hash: "a".repeat(64) }, lanes: { implementation: { model: "codex-terra", provenance: "official-default" } } }), { message: "AMBIGUOUS_MODEL_RESOLUTION: explore" });
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

  assert.match(rendered.policy, /OrbitLane policy projection for codex/);
  assert.match(rendered.policy, /Target model routes: architect="codex-sol", executor="codex-terra", explore="codex-luna"\./);
  assert.doesNotMatch(rendered.policy, /Contract routes: architect=sol, executor=terra, explore=luna\./);
  assert.equal(generated.tier, "tier1");
  assert.equal(generated.configuration_enforced, false);
  assert.equal(generated.semantic_policy_audited, true);
  assert.equal(generated.role_binding_enforced, false);
  assert.equal(generated.status, "partial enforcement");
  assert.deepEqual(generated.audit.unmanaged, ["third-party"]);
  assert.deepEqual(generated.requested_routes.architect, { requested_model: "codex-sol", resolution: "target-binding", provenance: "user-local", effective_model: "unproven" });
  assert.deepEqual(generated.capabilities, codexCapabilityMatrix());
});
