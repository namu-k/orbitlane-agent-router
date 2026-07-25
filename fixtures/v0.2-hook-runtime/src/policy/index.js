import { assertCatalogCompatible } from "../catalog/index.js";
import { validateContract } from "../schema/index.js";

const POLICY_LINES = Object.freeze([
  "OrbitLane policy projection for {target}.",
  "Policy projection only; it is not runtime router code.",
  "Precedence: system, safety, filesystem, and authority constraints; explicit user prohibitions and topology; explicit skill activation; workflow request; direct-first gate; role to lane to model mapping; runtime capability and evidence boundary.",
  "Direct-first: keep work direct unless a bounded delegation benefit is demonstrated.",
  "Plan size alone never creates an agent instance.",
  "Coupled multi-phase work keeps one persistent primary owner.",
  "Role profiles are stable; agent instances are created on demand only.",
  "Resolver order after higher constraints: explicit user role, lane, model, or topology; explicit skill activation; workflow request; plan metadata; deterministic task shape; leader judgment.",
  "$executing-plans defines workflow checkpoints and does not automatically create a fresh agent for each task.",
  "Only an explicit subagent workflow opts into a subagent topology.",
  "A skill name in prose is not skill activation.",
  "Resume the existing bounded delegate for follow-up work rather than creating a fresh instance.",
  "Overlapping write scope under an explicit subagent workflow is ROUTE_CONFLICT.",
  "Full transcript or fork context is explicit opt-in only.",
  "Reject an unknown routed role or ambiguous model resolution; never silently fall back.",
  "Report installed roles outside the contract as unmanaged; do not block installation unless strict mode is requested.",
]);

const DELEGATION_DECISION_FIXTURES = Object.freeze([
  Object.freeze({ scenario: "short single-file change", expected: "direct", policyText: "A short single-file change stays direct." }),
  Object.freeze({ scenario: "consequential judgment depending on a long conversation", expected: "direct", policyText: "A consequential judgment depending on a long conversation stays direct." }),
  Object.freeze({ scenario: "sequential phases sharing state", expected: "persistent-owner", policyText: "Sequential phases sharing state use a persistent primary owner." }),
  Object.freeze({ scenario: "three independent platform investigations", expected: "bounded-delegate", policyText: "Independent platform investigations may use bounded delegates only after the direct-first gate passes." }),
  Object.freeze({ scenario: "follow-up for the same child task", expected: "resume-delegate", policyText: "Follow-up for the same child task resumes the existing bounded delegate." }),
  Object.freeze({ scenario: "user explicitly requests full context", expected: "full-context", policyText: "An explicit full-context request selects full-context." }),
  Object.freeze({ scenario: "skill name appears only in prose", expected: "skill-not-activated", policyText: "A skill name appearing only in prose is not activated." }),
  Object.freeze({ scenario: "$executing-plans with a coupled plan", expected: "persistent executor", policyText: "With $executing-plans and a coupled plan, use a persistent executor." }),
  Object.freeze({ scenario: "$executing-plans with independent tasks", expected: "only gate-approved tasks delegate", policyText: "With $executing-plans and independent tasks, delegate only tasks that pass the gate." }),
  Object.freeze({ scenario: "$subagent-driven-development with independent tasks", expected: "explicit delegation allowed", policyText: "With $subagent-driven-development and independent tasks, explicit delegation is allowed." }),
  Object.freeze({ scenario: "$subagent-driven-development with overlapping write scope", expected: "ROUTE_CONFLICT", policyText: "With $subagent-driven-development and overlapping write scope, record ROUTE_CONFLICT." }),
]);

export function projectPolicy({ target, contract }) {
  if (target !== "codex" && target !== "claude") throw new TypeError("target must be codex or claude");
  const validation = validateContract(contract);
  if (!validation.valid) throw new TypeError(`INVALID_CONTRACT: ${validation.errors.join(", ")}`);
  assertCatalogCompatible(contract);
  const routes = Object.entries(contract.roles).sort(([left], [right]) => left.localeCompare(right)).map(([role, config]) => `${role}=${config.lane}`).join(", ");
  return `${POLICY_LINES.map((line) => line.replace("{target}", target)).join("\n")}\n${DELEGATION_DECISION_FIXTURES.map((fixture) => fixture.policyText).join("\n")}\nContract routes: ${routes}.\n`;
}

export function markerBoundedPolicy(target, policy) {
  return `<!-- ORBITLANE:START ${target} -->\n${policy}<!-- ORBITLANE:END ${target} -->\n`;
}

export function projectMarkerBoundedPolicy({ target, contract }) {
  return markerBoundedPolicy(target, projectPolicy({ target, contract }));
}

export function delegationDecisionFixtures() {
  return structuredClone(DELEGATION_DECISION_FIXTURES);
}
