import { auditInstalledRoles, validateContract } from "../../schema/index.js";
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
  const validation = validateContract(contract);
  if (!validation.valid) throw new TypeError(`INVALID_CONTRACT: ${validation.errors.join(", ")}`);
}

export function resolveCodexRequestedRoutes(contract, runtimeDefaults) {
  assertValidContract(contract);
  const release = runtimeDefaults?.release;
  const defaults = runtimeDefaults?.lanes;
  const releaseValid = typeof release?.version === "string" && release.version.length > 0
    && typeof release?.source === "string" && release.source.length > 0 && /^[a-f0-9]{64}$/.test(release?.hash ?? "");
  const routes = {};
  for (const [role, configuration] of Object.entries(contract.roles).sort(([left], [right]) => left.localeCompare(right))) {
    const lane = contract.lanes[configuration.lane];
    const binding = contract.targets?.codex?.lanes?.[configuration.lane];
    const defaultBinding = defaults?.[lane.class];
    const defaultValid = releaseValid && typeof defaultBinding?.model === "string" && defaultBinding.model.length > 0
      && typeof defaultBinding.provenance === "string" && defaultBinding.provenance.length > 0;
    const model = binding?.model ?? (defaultValid ? defaultBinding.model : undefined);
    if (!model) throw new TypeError(`AMBIGUOUS_MODEL_RESOLUTION: ${role}`);
    routes[role] = Object.freeze({
      lane: configuration.lane,
      model,
      modelSource: binding ? "target-binding" : "runtime-default",
      provenance: binding?.provenance ?? defaultBinding?.provenance,
      reasoning: lane.reasoning,
    });
  }
  return Object.freeze(routes);
}

export function createCodexTier1Adapter(contract, options) {
  const routes = resolveCodexRequestedRoutes(contract, options.runtimeDefaults);
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
          requested_routes: Object.fromEntries(Object.entries(routes).map(([role, route]) => [role, {
            requested_model: route.model,
            resolution: route.modelSource,
            provenance: route.provenance,
            effective_model: "unproven",
          }])),
          audit,
          capabilities: codexCapabilityMatrix(),
          status: "partial enforcement",
        }, null, 2)}\n`,
      });
    },
  });
}
