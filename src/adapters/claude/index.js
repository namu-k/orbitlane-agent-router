import { auditInstalledRoles, claudeCapabilityMatrix, validateContract } from "../../schema/index.js";
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

function hasOfficialRelease(release) {
  return typeof release?.version === "string" && release.version.length > 0 && release.source === "official"
    && /^[a-f0-9]{64}$/.test(release?.hash ?? "");
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
  const defaults = runtimeDefaults?.lanes;
  const releaseValid = hasOfficialRelease(runtimeDefaults?.release);
  const routes = {};

  for (const [role, configuration] of Object.entries(contract.roles).sort(([left], [right]) => left.localeCompare(right))) {
    const lane = contract.lanes[configuration.lane];
    const binding = contract.targets?.claude?.lanes?.[configuration.lane];
    const fallback = defaults?.[lane.class];
    const fallbackValid = releaseValid && typeof fallback?.model === "string" && fallback.model.length > 0
      && typeof fallback.provenance === "string" && fallback.provenance.length > 0;
    const model = binding?.model ?? (fallbackValid ? fallback.model : undefined);
    if (!model) throw new TypeError(`AMBIGUOUS_MODEL_RESOLUTION: ${role}`);

    routes[role] = Object.freeze({
      lane: configuration.lane,
      model,
      modelSource: binding ? "target-binding" : "runtime-default",
      provenance: binding?.provenance ?? fallback?.provenance,
      reasoning: lane.reasoning,
      ...(binding ? {} : { release: structuredClone(runtimeDefaults.release) }),
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
  const audit = auditInstalledRoles(contract, options.installedRoles ?? []);
  const subagents = Object.fromEntries(Object.entries(routes).map(([role, route]) => [role, subagentProjection(role, route)]));
  const nativeArtifacts = Object.fromEntries(Object.entries(subagents).map(([role, subagent]) => [
    `${role}.md`, nativeSubagentDefinition(role, routes[role], subagent.instructions),
  ]));
  const capabilities = probeClaudeTier1Capabilities({
    runtime: options.runtime,
    supportsVersion: options.supportsVersion,
    nativeArtifacts: Object.entries(nativeArtifacts).map(([path, content]) => ({ path, content })),
    expectedRoutes: routes,
  });

  return Object.freeze({
    instructionPath: options.instructionPath,
    generatedPath: options.generatedPath,
    runtime: options.runtime,
    supportsVersion: options.supportsVersion,
    render() {
      return Object.freeze({
        policy: projectPolicy({ target: "claude", contract }),
        generated: `${JSON.stringify({
          adapter: "claude-code",
          tier: "tier1",
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
          settings_projection: Object.freeze({ hooks: Object.freeze({}) }),
          audit,
          capabilities,
          status: "partial enforcement",
        }, null, 2)}\n`,
      });
    },
  });
}
