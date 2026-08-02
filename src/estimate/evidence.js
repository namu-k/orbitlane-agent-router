const MODEL_EVIDENCE = Object.freeze({
  resolved: 3,
  observed: 2,
  inferred: 1,
});

export function reduceModelEvidence(buckets) {
  if (!Array.isArray(buckets)) throw new TypeError("INVALID_MODEL_EVIDENCE");
  let weakest = "unknown";
  let rank = Infinity;
  for (const bucket of buckets) {
    const source = bucket?.model_source;
    if (!Object.hasOwn(MODEL_EVIDENCE, source)) throw new TypeError("INVALID_MODEL_EVIDENCE");
    if (MODEL_EVIDENCE[source] < rank) {
      weakest = source;
      rank = MODEL_EVIDENCE[source];
    }
  }
  return weakest;
}
