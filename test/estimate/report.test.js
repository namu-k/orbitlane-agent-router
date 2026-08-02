import assert from "node:assert/strict";
import { lstat, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { combineEstimates, writeSafeReport } from "../../src/estimate/report.js";

const catalog = { effective_from: "2026-08-02", source_label: "test", basis: "heuristic", currency: "USD" };
const estimated = { runtime: "claude", status: "estimated", confidence_adjusted_reference_amount_nanos: "42" };
const insufficient = { runtime: "codex", status: "insufficient", confidence_adjusted_reference_amount_nanos: null };
test("combined amount sums only non-Insufficient adjusted references", () => {
  const report = combineEstimates({ catalog, estimates: [estimated, insufficient] });
  assert.equal(report.combined.confidence_adjusted_reference_amount_nanos, "42");
  assert.deepEqual(report.combined.included_runtimes, ["claude"]);
});
test("safe writer refuses symlinks and creates a 0600 regular file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbitlane-report-"));
  const output = join(directory, "report.json"); const link = join(directory, "link.json");
  await symlink(output, link);
  await assert.rejects(writeSafeReport(link, combineEstimates({ catalog, estimates: [estimated, insufficient] })), /UNSAFE_ESTIMATE_OUTPUT/);
  await writeSafeReport(output, combineEstimates({ catalog, estimates: [estimated, insufficient] }));
  assert.equal((await lstat(output)).mode & 0o777, 0o600);
});
