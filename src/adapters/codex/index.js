import { auditInstalledRoles, validateContractForTarget } from "../../schema/index.js";
import { resolveLaneModels } from "../../config/lanes.js";
import { projectPolicy } from "../../policy/index.js";

const CODEX_CAPABILITY_MATRIX = Object.freeze({
  native_role_configuration: Object.freeze({ status: "unproven", scope: "no-native-format-generated" }),
  requested_route: Object.freeze({ status: "configured", scope: "static-projection" }),
  runtime_receipt: Object.freeze({ status: "unproven" }),
  spawn_link: Object.freeze({ status: "unproven" }),
  effective_model: "unproven",
});

export function codexCapabilityMatrix() {
  return structuredClone(CODEX_CAPABILITY_MATRIX);
}

function assertValidContract(contract) {
  const validation = validateContractForTarget(contract, "codex");
  if (!validation.valid) throw new TypeError(`INVALID_CONTRACT: ${validation.errors.join(", ")}`);
}

export function resolveCodexRequestedRoutes(contract, runtimeDefaults) {
  assertValidContract(contract);
  const lanes = resolveLaneModels(contract, "codex", runtimeDefaults);
  const routes = {};
  for (const [role, configuration] of Object.entries(contract.roles ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    const lane = lanes[configuration.lane];
    if (lane?.resolved !== true) throw new TypeError(`${lane?.reason === "UNSAFE_MODEL_TOKEN" ? "UNSAFE_MODEL_TOKEN" : "AMBIGUOUS_MODEL_RESOLUTION"}: ${role}`);
    routes[role] = Object.freeze({
      lane: configuration.lane,
      model: lane.model,
      modelSource: lane.modelSource,
      provenance: lane.provenance,
      reasoning: lane.reasoning,
    });
  }
  return Object.freeze(routes);
}

export function createCodexTier1Adapter(contract, options) {
  const routes = resolveCodexRequestedRoutes(contract, options.runtimeDefaults);
  const mainLane = resolveLaneModels(contract, "codex", options.runtimeDefaults).sol;
  const audit = auditInstalledRoles(contract, options.installedRoles ?? []);
  return Object.freeze({
    instructionPath: options.instructionPath,
    generatedPath: options.generatedPath,
    runtime: options.runtime,
    supportsVersion: options.supportsVersion,
    render() {
      return Object.freeze({
        policy: projectPolicy({ target: "codex", contract, runtimeDefaults: options.runtimeDefaults }),
        generated: `${JSON.stringify({
          adapter: "codex-omx",
          tier: "tier1",
          configuration_enforced: false,
          semantic_policy_audited: true,
          role_binding_enforced: false,
          ...(mainLane?.resolved === true ? { baseline_binding: {
            lane: "sol",
            configured_model: mainLane.model,
            evidence: "contract-configured",
            effective_model: "unproven",
          } } : {}),
          requested_routes: Object.fromEntries(Object.entries(routes).map(([role, route]) => [role, {
            requested_model: route.model,
            resolution: route.modelSource,
            provenance: route.provenance,
            effective_model: "unproven",
          }])),
          audit,
          capabilities: codexCapabilityMatrix(),
          enforcement_scope: "none (guidance only)",
          status: "guidance only",
        }, null, 2)}\n`,
      });
    },
  });
}
