// One place where a lane becomes a model. Both role resolvers and the policy kernel
// read from here, so the model the guard enforces and the model the kernel advertises
// cannot drift apart.
//
// Results are per lane. An unresolved lane is reported, never thrown: the kernel needs
// all three lanes, but a guard only needs the lanes its routed roles actually use, and
// a contract that binds one lane must keep working.
import { isMarkerSafeModelToken } from "../schema/index.js";

function hasOfficialRelease(release) {
  return typeof release?.version === "string" && release.version.length > 0
    && release?.source === "official"
    && /^[a-f0-9]{64}$/.test(release?.hash ?? "");
}

export function resolveLaneModels(contract, target, runtimeDefaults) {
  const defaults = runtimeDefaults?.lanes;
  const releaseValid = hasOfficialRelease(runtimeDefaults?.release);
  const resolved = {};

  for (const [laneId, lane] of Object.entries(contract.lanes ?? {})) {
    const binding = contract.targets?.[target]?.lanes?.[laneId];
    const fallback = defaults?.[lane.class];
    const fallbackUnsafe = releaseValid
      && fallback?.model !== undefined
      && !isMarkerSafeModelToken(fallback.model);
    const fallbackValid = releaseValid
      && isMarkerSafeModelToken(fallback?.model)
      && typeof fallback.provenance === "string" && fallback.provenance.length > 0;
    const model = binding?.model ?? (fallbackValid ? fallback.model : undefined);

    resolved[laneId] = model === undefined
      ? Object.freeze({ resolved: false, reason: fallbackUnsafe ? "UNSAFE_MODEL_TOKEN" : "AMBIGUOUS_MODEL_RESOLUTION" })
      : Object.freeze({
        resolved: true,
        model,
        modelSource: binding ? "target-binding" : "runtime-default",
        provenance: binding?.provenance ?? fallback?.provenance,
        reasoning: lane.reasoning,
        ...(binding ? {} : { release: structuredClone(runtimeDefaults.release) }),
      });
  }
  return Object.freeze(resolved);
}
