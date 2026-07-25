import { assertCatalogCompatible } from "../catalog/index.js";
import { resolveLaneModels } from "../config/lanes.js";
import { isMarkerSafeModelToken, validateContractForTarget } from "../schema/index.js";

// The projected kernel. Four lines: a delegation nudge, the main-session boundary
// (which also carries escalation), this target's tier->model binding, and the one
// conflict rule kept from the old policy block. Everything else the old projection
// said is either the runtime's own job or the agent's judgment.
const KERNEL = Object.freeze([
  "- Prefer direct work; delegate to a subagent when the delegation boundary is clear and the benefit is concrete.",
  "- Keep judgment that needs full context, discipline, or confidentiality in the main session. A delegate that meets a new consequential judgment outside its assigned scope stops and asks the main session to decide.",
  "- When delegating, use: execution -> {terra}, bounded lookup -> {luna}, delegated verification and analysis -> {sol}.",
  "- Record ROUTE_CONFLICT when parallel delegates hold overlapping write scope on the same file.",
]);

const KERNEL_LANES = Object.freeze(["sol", "terra", "luna"]);

export function projectPolicy({ target, contract, runtimeDefaults }) {
  if (target !== "codex" && target !== "claude") throw new TypeError("target must be codex or claude");
  const validation = validateContractForTarget(contract, target);
  if (!validation.valid) throw new TypeError(`INVALID_CONTRACT: ${validation.errors.join(", ")}`);
  // Kept even though the kernel no longer reads roles: a contract that remaps a
  // stable-catalog role to the wrong lane must still be caught here.
  assertCatalogCompatible(contract);

  const lanes = resolveLaneModels(contract, target, runtimeDefaults);
  // The kernel embeds all three model names, so an unresolved lane has no honest
  // rendering. Fail rather than emit a placeholder or drop the line.
  const unsafeDefault = KERNEL_LANES.find((laneId) => lanes[laneId]?.reason === "UNSAFE_MODEL_TOKEN");
  if (unsafeDefault !== undefined) throw new TypeError(`UNSAFE_MODEL_TOKEN: runtime default for ${unsafeDefault} cannot appear in a marker-bounded projection`);
  const unresolved = KERNEL_LANES.filter((laneId) => lanes[laneId]?.resolved !== true);
  if (unresolved.length > 0) throw new TypeError(`AMBIGUOUS_MODEL_RESOLUTION: ${unresolved.join(", ")} for target ${target}`);
  const unsafeResolved = KERNEL_LANES.find((laneId) => !isMarkerSafeModelToken(lanes[laneId].model));
  if (unsafeResolved !== undefined) throw new TypeError(`UNSAFE_MODEL_TOKEN: ${unsafeResolved} cannot appear in a marker-bounded projection`);

  const body = KERNEL
    .map((line) => KERNEL_LANES.reduce((text, laneId) => text.replaceAll(`{${laneId}}`, lanes[laneId].model), line))
    .join("\n");
  return `${body}\n`;
}

export function markerBoundedPolicy(target, policy) {
  return `<!-- ORBITLANE:START ${target} -->\n${policy}<!-- ORBITLANE:END ${target} -->\n`;
}

export function projectMarkerBoundedPolicy({ target, contract, runtimeDefaults }) {
  return markerBoundedPolicy(target, projectPolicy({ target, contract, runtimeDefaults }));
}
