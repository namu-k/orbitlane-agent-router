import { auditInstalledRoles, claudeCapabilityMatrix, validateContractForTarget } from "../../schema/index.js";
import { isInjectableClaudeModel } from "../../config/claude-models.js";
import { resolveLaneModels } from "../../config/lanes.js";
import { markerBoundedPolicy, projectPolicy } from "../../policy/index.js";
import { projectedGuidanceProvenance } from "../../telemetry/identity.js";

const CLAUDE_TIER1_CAPABILITIES = Object.freeze({
  requested_route: Object.freeze({ status: "configured", scope: "static-projection" }),
  reasoning: Object.freeze(claudeCapabilityMatrix().reasoning),
  claude_agent_pre_dispatch: Object.freeze({ status: "unproven", scope: "Agent tool only" }),
  runtime_receipt: Object.freeze({ status: "unproven" }),
  effective_model: "unproven",
});

function assertValidContract(contract) {
  const validation = validateContractForTarget(contract, "claude");
  if (!validation.valid) throw new TypeError(`INVALID_CONTRACT: ${validation.errors.join(", ")}`);
}

export function probeClaudeTier1Capabilities() {
  // 0.3 generates requested-route evidence but neither installs Claude custom
  // subagent definitions nor discovers runtime files. Caller-supplied flags and
  // bytes cannot prove a native configuration exists.
  return {
    native_role_configuration: {
      status: "unproven",
      scope: "no-native-artifact-discovery",
    },
    ...structuredClone(CLAUDE_TIER1_CAPABILITIES),
  };
}

export function claudeTier1CapabilityMatrix() {
  return probeClaudeTier1Capabilities();
}

export function resolveClaudeRequestedRoutes(contract, runtimeDefaults) {
  assertValidContract(contract);
  const lanes = resolveLaneModels(contract, "claude", runtimeDefaults);
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
      ...(lane.release === undefined ? {} : { release: lane.release }),
    });
  }
  return Object.freeze(routes);
}

function subagentProjection(role, route) {
  return Object.freeze({
    frontmatter: Object.freeze({ name: role, model: route.model, effort: route.reasoning }),
    instructions: `Stable ${role} role. Create an agent instance only on demand. Full transcript context requires explicit opt-in.`,
  });
}

function nativeSubagentDefinition(role, route, instructions) {
  return `---\nname: ${JSON.stringify(role)}\ndescription: ${JSON.stringify(`Stable ${role} role`)}\nmodel: ${JSON.stringify(route.model)}\neffort: ${JSON.stringify(route.reasoning)}\n---\n\n${instructions}\n`;
}

export function createClaudeTier1Adapter(contract, options) {
  const routes = resolveClaudeRequestedRoutes(contract, options.runtimeDefaults);
  const hasRoles = Object.keys(routes).length > 0;
  const audit = auditInstalledRoles(contract, options.installedRoles ?? []);
  const subagents = Object.fromEntries(Object.entries(routes).map(([role, route]) => [role, subagentProjection(role, route)]));
  const nativeArtifacts = Object.fromEntries(Object.entries(subagents).map(([role, subagent]) => [
    `${role}.md`, nativeSubagentDefinition(role, routes[role], subagent.instructions),
  ]));
  const probedCapabilities = probeClaudeTier1Capabilities();
  const capabilities = hasRoles
    ? probedCapabilities
    : Object.freeze({
      ...probedCapabilities,
      native_role_configuration: Object.freeze({ status: "not-applicable", scope: "roles-omitted" }),
    });
  const hookTuples = options.spawnGuardCommand === undefined
    ? Object.freeze([])
    : Object.freeze([
      Object.freeze({ event: "PreToolUse", matcher: "Agent", command: options.spawnGuardCommand, installed_scope: options.installedScope }),
      Object.freeze({ event: "PostToolUse", matcher: "Agent", command: options.usageObserverCommand, installed_scope: options.installedScope }),
    ]);
  const settingsProjection = options.spawnGuardCommand === undefined
    ? Object.freeze({ hooks: Object.freeze({}) })
    : Object.freeze({ hooks: Object.freeze(Object.groupBy(hookTuples, ({ event }) => event)) });

  return Object.freeze({
    instructionPath: options.instructionPath,
    generatedPath: options.generatedPath,
    settingsPath: options.settingsPath,
    spawnGuardCommand: options.spawnGuardCommand,
    managedAssets: options.managedAssets,
    runtime: options.runtime,
    supportsVersion: options.supportsVersion,
    render() {
      const policy = projectPolicy({ target: "claude", contract, runtimeDefaults: options.runtimeDefaults });
      const policyProvenance = projectedGuidanceProvenance(markerBoundedPolicy("claude", policy));
      return Object.freeze({
        policy,
        settingsProjection: options.spawnGuardCommand === undefined ? undefined : Object.freeze({ hooks: hookTuples }),
        generated: `${JSON.stringify({
          adapter: "claude-code",
          tier: "tier1",
          schema_version: 2,
          contract_snapshot: { sha256: options.contractSha256 },
          policy_provenance: policyProvenance,
          ...(options.runtimeDefaultsSha256 === undefined ? {} : { runtime_defaults_snapshot: { sha256: options.runtimeDefaultsSha256 } }),
          configuration_enforced: false,
          semantic_policy_audited: true,
          role_binding_enforced: false,
          requested_routes: Object.fromEntries(Object.entries(routes).map(([role, route]) => [role, {
            requested_model: route.model,
            resolution: route.modelSource,
            provenance: route.provenance,
            ...(route.release === undefined ? {} : { release: route.release }),
            // Whether the guard can write this model into a spawn that left the model
            // open. A false here means the role is documented but never actually
            // routed, which is the difference between advice and a saved token.
            injectable: isInjectableClaudeModel(route.model),
            effective_model: "unproven",
          }])),
          subagents,
          native_artifacts: nativeArtifacts,
          settings_projection: settingsProjection,
          ...(options.spawnGuardCommand === undefined ? {} : { settings_projection: { ...settingsProjection, guard_command: options.spawnGuardCommand } }),
          receipt: options.spawnGuardCommand === undefined
            ? { version: 1, install_shape: "guidance-only" }
            : {
              version: 2,
              // Compatibility aliases are descriptive only; ownership is the exact
              // tuple array above and never falls back to this single command.
              install_shape: "claude-managed-role-guard",
              guard_command: options.spawnGuardCommand,
              hooks: hookTuples,
              policy_projection_sha256: policyProvenance.policy_projection_sha256,
              projected_guidance_bytes: policyProvenance.projected_guidance_bytes,
              telemetry_root: options.telemetryRoot,
              collector_instance_ref: options.collectorInstanceRef,
              runtime_version_snapshot: options.runtimeVersionSnapshot,
              owned_files: options.ownedFiles ?? [],
              secret_paths: options.secretPaths ?? [],
              evidence_roots: options.evidenceRoots ?? [],
              migration: options.migration,
            },
          audit,
          capabilities,
          enforcement_scope: hasRoles ? "scoped-request-check" : "none (roles omitted)",
          status: hasRoles ? "partial enforcement" : "guidance only",
        }, null, 2)}\n`,
      });
    },
  });
}
