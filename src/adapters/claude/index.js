import { auditInstalledRoles, claudeCapabilityMatrix, validateContract } from "../../schema/index.js";
import { resolveLaneModels } from "../../config/lanes.js";
import { projectPolicy } from "../../policy/index.js";

const CLAUDE_TIER1_CAPABILITIES = Object.freeze({
  requested_route: Object.freeze({ status: "configured", scope: "static-projection" }),
  reasoning: Object.freeze(claudeCapabilityMatrix().reasoning),
  claude_agent_pre_dispatch: Object.freeze({ status: "unproven", scope: "Agent tool only" }),
  runtime_receipt: Object.freeze({ status: "unproven" }),
  effective_model: "unproven",
});

function assertValidContract(contract) {
  const validation = validateContract(contract);
  if (!validation.valid) throw new TypeError(`INVALID_CONTRACT: ${validation.errors.join(", ")}`);
}

function parseNativeArtifact(artifact) {
  if (typeof artifact?.path !== "string" || !artifact.path.endsWith(".md") || typeof artifact.content !== "string") return null;
  const match = artifact.content.match(/^---\nname: (.+)\ndescription: (.+)\nmodel: (.+)\neffort: (.+)\n---\n/m);
  if (match === null) return null;
  try {
    const parsed = Object.freeze({ path: artifact.path, name: JSON.parse(match[1]), description: JSON.parse(match[2]), model: JSON.parse(match[3]), effort: JSON.parse(match[4]) });
    return [parsed.name, parsed.description, parsed.model, parsed.effort].every((value) => typeof value === "string" && value.length > 0) ? parsed : null;
  } catch {
    return null;
  }
}

function artifactsMatchRoutes(nativeArtifacts, expectedRoutes) {
  const parsed = nativeArtifacts.map(parseNativeArtifact);
  if (parsed.some((artifact) => artifact === null)) return false;
  const expected = Object.entries(expectedRoutes ?? {});
  if (expected.length > 0 && parsed.length !== expected.length) return false;
  const names = new Set(parsed.map((artifact) => artifact.name));
  if (names.size !== parsed.length) return false;
  if (expected.length > 0 && (names.size !== expected.length || expected.some(([role]) => !names.has(role)))) return false;
  return parsed.every((artifact) => artifact.path === `${artifact.name}.md`
    && (expectedRoutes?.[artifact.name] === undefined || (artifact.model === expectedRoutes[artifact.name].model && artifact.effort === expectedRoutes[artifact.name].reasoning)));
}

export function probeClaudeTier1Capabilities({ runtime, supportsVersion, nativeArtifacts = [], expectedRoutes = {} }) {
  const nativeAvailable = runtime?.available === true && typeof supportsVersion === "function"
    && supportsVersion(runtime.version) && artifactsMatchRoutes(nativeArtifacts, expectedRoutes);
  return {
    native_role_configuration: {
      status: nativeAvailable ? "configured" : "unproven",
      scope: nativeAvailable ? "custom-subagent-definitions" : "runtime-or-artifact-unavailable",
    },
    ...structuredClone(CLAUDE_TIER1_CAPABILITIES),
  };
}

export function claudeTier1CapabilityMatrix() {
  return probeClaudeTier1Capabilities({
    runtime: { available: true, version: "fixture" },
    supportsVersion: () => true,
    nativeArtifacts: [{ path: "fixture.md", content: "---\nname: \"fixture\"\ndescription: \"Fixture\"\nmodel: \"fixture\"\neffort: \"medium\"\n---\n" }],
    expectedRoutes: { fixture: { model: "fixture", reasoning: "medium" } },
  });
}

export function resolveClaudeRequestedRoutes(contract, runtimeDefaults) {
  assertValidContract(contract);
  const lanes = resolveLaneModels(contract, "claude", runtimeDefaults);
  const routes = {};

  for (const [role, configuration] of Object.entries(contract.roles ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    const lane = lanes[configuration.lane];
    if (lane?.resolved !== true) throw new TypeError(`AMBIGUOUS_MODEL_RESOLUTION: ${role}`);

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
  const probedCapabilities = probeClaudeTier1Capabilities({
    runtime: options.runtime,
    supportsVersion: options.supportsVersion,
    nativeArtifacts: Object.entries(nativeArtifacts).map(([path, content]) => ({ path, content })),
    expectedRoutes: routes,
  });
  const capabilities = hasRoles
    ? probedCapabilities
    : Object.freeze({ ...probedCapabilities, native_role_configuration: "not-applicable" });
  const settingsProjection = options.spawnGuardCommand === undefined
    ? Object.freeze({ hooks: Object.freeze({}) })
    : Object.freeze({ hooks: Object.freeze({ PreToolUse: Object.freeze([{ matcher: "Agent", hooks: Object.freeze([{ type: "command", command: options.spawnGuardCommand }]) }]) }) });

  return Object.freeze({
    instructionPath: options.instructionPath,
    generatedPath: options.generatedPath,
    settingsPath: options.settingsPath,
    spawnGuardCommand: options.spawnGuardCommand,
    runtime: options.runtime,
    supportsVersion: options.supportsVersion,
    render() {
      return Object.freeze({
        policy: projectPolicy({ target: "claude", contract, runtimeDefaults: options.runtimeDefaults }),
        settingsProjection: options.spawnGuardCommand === undefined ? undefined : Object.freeze({ command: options.spawnGuardCommand }),
        generated: `${JSON.stringify({
          adapter: "claude-code",
          tier: "tier1",
          schema_version: 2,
          contract_snapshot: { sha256: options.contractSha256 },
          ...(options.runtimeDefaultsSha256 === undefined ? {} : { runtime_defaults_snapshot: { sha256: options.runtimeDefaultsSha256 } }),
          configuration_enforced: false,
          semantic_policy_audited: true,
          role_binding_enforced: false,
          requested_routes: Object.fromEntries(Object.entries(routes).map(([role, route]) => [role, {
            requested_model: route.model,
            resolution: route.modelSource,
            provenance: route.provenance,
            ...(route.release === undefined ? {} : { release: route.release }),
            effective_model: "unproven",
          }])),
          subagents,
          native_artifacts: nativeArtifacts,
          settings_projection: settingsProjection,
          ...(options.spawnGuardCommand === undefined ? {} : { settings_projection: { ...settingsProjection, guard_command: options.spawnGuardCommand } }),
          receipt: options.spawnGuardCommand === undefined
            ? { version: 1, install_shape: "guidance-only" }
            : { version: 1, install_shape: "claude-managed-role-guard", guard_command: options.spawnGuardCommand },
          audit,
          capabilities,
          enforcement_scope: hasRoles ? "scoped-request-check" : "none (roles omitted)",
          status: "partial enforcement",
        }, null, 2)}\n`,
      });
    },
  });
}
