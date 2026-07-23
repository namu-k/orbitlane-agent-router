import assert from "node:assert/strict";
import test from "node:test";

import { assertCatalogCompatible, stableRoleCatalog } from "../../src/catalog/index.js";
import { delegationDecisionFixtures, projectMarkerBoundedPolicy, projectPolicy } from "../../src/policy/index.js";

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
});

const routesFor = (target) => Object.freeze({
  architect: Object.freeze({ target, lane: "sol", model: "target-architect" }),
  executor: Object.freeze({ target, lane: "terra", model: "target-executor" }),
  explore: Object.freeze({ target, lane: "luna", model: "target-explore" }),
});

test("publishes the portable core catalog with the canonical lane mapping", () => {
  assert.deepEqual(stableRoleCatalog(), {
    architect: { access: "read-only", lane: "sol", responsibility: "architecture and consequential judgment" },
    critic: { access: "read-only", lane: "sol", responsibility: "adversarial review of plans and judgments" },
    executor: { access: "write-and-test", lane: "terra", responsibility: "implementation, fixes, and bounded refactors" },
    "team-executor": { access: "write-and-test", lane: "terra", responsibility: "approved team execution" },
    verifier: { access: "read-and-test", lane: "terra", responsibility: "independent verification and evidence" },
    "test-engineer": { access: "write-and-test", lane: "terra", responsibility: "test design, fixtures, and regression verification" },
    explore: { access: "read-only", lane: "luna", responsibility: "bounded repository lookup" },
  });
});

test("rejects a contract that remaps a stable catalog role to another canonical lane", () => {
  assert.throws(
    () => assertCatalogCompatible({ ...contract, roles: { ...contract.roles, executor: { lane: "sol", provenance: "user-approved" } } }),
    { message: "STABLE_ROLE_CATALOG_MISMATCH: executor must use terra" },
  );
});

test("projects a deterministic marker policy rather than a runtime router", () => {
  const policy = projectPolicy({ target: "codex", contract, routes: routesFor("codex") });

  assert.match(policy, /Policy projection only; it is not runtime router code\./);
  assert.match(policy, /Precedence: system, safety, filesystem, and authority constraints; explicit user prohibitions and topology; explicit skill activation; workflow request; direct-first gate; role to lane to model mapping; runtime capability and evidence boundary\./);
  assert.match(policy, /Resolver order after higher constraints: explicit user role, lane, model, or topology; explicit skill activation; workflow request; plan metadata; deterministic task shape; leader judgment\./);
  assert.match(policy, /Target model routes: architect="target-architect", executor="target-executor", explore="target-explore"\./);
  assert.match(policy, /Direct-first: keep work direct unless a bounded delegation benefit is demonstrated\./);
  assert.match(policy, /Plan size alone never creates an agent instance\./);
  assert.match(policy, /Coupled multi-phase work keeps one persistent primary owner\./);
  assert.match(policy, /Role profiles are stable; agent instances are created on demand only\./);
  assert.match(policy, /Resolver order after higher constraints: explicit user role, lane, model, or topology; explicit skill activation; workflow request; plan metadata; deterministic task shape; leader judgment\./);
  assert.match(policy, /\$executing-plans defines workflow checkpoints and does not automatically create a fresh agent for each task\./);
  assert.match(policy, /Only an explicit subagent workflow opts into a subagent topology\./);
  assert.match(policy, /A skill name in prose is not skill activation\./);
  assert.match(policy, /Resume the existing bounded delegate for follow-up work rather than creating a fresh instance\./);
  assert.match(policy, /Overlapping write scope under an explicit subagent workflow is ROUTE_CONFLICT\./);
  assert.match(policy, /Full transcript or fork context is explicit opt-in only\./);
  assert.match(policy, /Reject an unknown routed role or ambiguous model resolution; never silently fall back\./);
  assert.match(policy, /Report installed roles outside the contract as unmanaged; do not block installation unless strict mode is requested\./);
});

test("requires resolved target models instead of exposing canonical lane names", () => {
  assert.throws(
    () => projectPolicy({ target: "claude", contract }),
    { message: "UNRESOLVED_TARGET_MODEL: architect" },
  );
});

test("rejects canonical lane names, whitespace, lane mismatches, and cross-target routes", () => {
  const cases = [
    { route: { target: "claude", lane: "sol", model: "sol" }, message: "INVALID_TARGET_MODEL_ROUTE: architect" },
    { route: { target: "claude", lane: "sol", model: "   " }, message: "INVALID_TARGET_MODEL_ROUTE: architect" },
    { route: { target: "claude", lane: "terra", model: "opus" }, message: "INVALID_TARGET_MODEL_ROUTE: architect" },
    { route: { target: "codex", lane: "sol", model: "opus" }, message: "INVALID_TARGET_MODEL_ROUTE: architect" },
  ];
  for (const { route, message } of cases) {
    assert.throws(
      () => projectPolicy({ target: "claude", contract, routes: { ...routesFor("claude"), architect: route } }),
      { message },
    );
  }
});

test("projects policy inside the target marker boundary", () => {
  assert.match(projectMarkerBoundedPolicy({ target: "codex", contract, routes: routesFor("codex") }), /^<!-- ORBITLANE:START codex -->\n[\s\S]*<!-- ORBITLANE:END codex -->\n$/);
});

test("golden delegation fixtures bind every expectation to projected policy text", () => {
  const policy = projectPolicy({ target: "claude", contract, routes: routesFor("claude") });
  assert.deepEqual(delegationDecisionFixtures().map((fixture) => fixture.policyText), [
    "A short single-file change stays direct.",
    "A consequential judgment depending on a long conversation stays direct.",
    "Sequential phases sharing state use a persistent primary owner.",
    "Independent platform investigations may use bounded delegates only after the direct-first gate passes.",
    "Follow-up for the same child task resumes the existing bounded delegate.",
    "An explicit full-context request selects full-context.",
    "A skill name appearing only in prose is not activated.",
    "With $executing-plans and a coupled plan, use a persistent executor.",
    "With $executing-plans and independent tasks, delegate only tasks that pass the gate.",
    "With $subagent-driven-development and independent tasks, explicit delegation is allowed.",
    "With $subagent-driven-development and overlapping write scope, record ROUTE_CONFLICT.",
  ]);
  for (const fixture of delegationDecisionFixtures()) {
    assert.equal(typeof fixture.scenario, "string");
    assert.equal(typeof fixture.expected, "string");
    assert.ok(policy.includes(fixture.policyText), `${fixture.scenario} must be represented in the projection`);
  }
});
