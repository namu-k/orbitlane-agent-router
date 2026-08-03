import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";

import { FILE_MODE_ENFORCED } from "../telemetry/storage.js";

export function combineEstimates({ catalog, estimates }) {
  const runtimes = Object.fromEntries(estimates.map((estimate) => [estimate.runtime, estimate]));
  const included = estimates.filter((estimate) => estimate.status === "estimated" && typeof estimate.confidence_adjusted_reference_amount_nanos === "string");
  const total = included.reduce((sum, estimate) => sum + BigInt(estimate.confidence_adjusted_reference_amount_nanos), 0n);
  return Object.freeze({ schema_version: 1, report_kind: "orbitlane.baseline-model-cost-estimate", catalog: Object.freeze({ effective_from: catalog.effective_from, source_label: catalog.source_label, basis: catalog.basis, currency: catalog.currency }), runtimes: Object.freeze(runtimes), combined: Object.freeze({ confidence_adjusted_reference_amount_nanos: included.length ? total.toString() : null, included_runtimes: included.map((estimate) => estimate.runtime) }), disclaimer: "This is a heuristic estimate, not a billing statement or proven net savings." });
}

export function renderHumanSummary(report) {
  const entries = Object.values(report.runtimes).map((entry) => `${entry.runtime}: ${entry.display ?? entry.confidence_adjusted_reference_amount_nanos}`);
  return `${entries.join("\n")}\n${report.disclaimer}`;
}

export async function writeSafeReport(path, report) {
  const parent = await lstat(dirname(path)).catch(() => null);
  const target = await lstat(path).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!parent?.isDirectory() || parent.isSymbolicLink() || (target && (!target.isFile() || target.isSymbolicLink()))) throw new Error("UNSAFE_ESTIMATE_OUTPUT");
  const handle = await open(path, constants.O_NOFOLLOW | constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY, 0o600);
  try { if (FILE_MODE_ENFORCED) await handle.chmod(0o600); await handle.writeFile(`${JSON.stringify(report)}\n`, "utf8"); } finally { await handle.close(); }
}
