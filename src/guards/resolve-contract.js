import { readFile as fsReadFile, realpath as fsRealpath } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readVerifiedSnapshot } from "../config/snapshots.js";

export const RESOLVER_POLICY_VERSION = 1;

const SUPPORTED_SCHEMA_VERSIONS = new Set([2]);
const DIGEST = /^[a-f0-9]{64}$/;

function fail(code, detail, scope, reportPath) {
  return Object.assign(new Error(`${code}: ${detail}`), { code, scope, reportPath });
}

async function nearestProjectReport(start, read) {
  let current = start;
  for (;;) {
    const candidate = join(current, ".orbitlane", "claude-report.json");
    try {
      await read(candidate, "utf8");
      return candidate;
    } catch { /* keep walking */ }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function resolveEffectiveContract({ cwd, claudeConfigDir, readFile = fsReadFile, realpath = fsRealpath }) {
  let start = cwd;
  try { start = await realpath(cwd); } catch { start = cwd; }

  const projectReportPath = await nearestProjectReport(start, readFile);
  const scope = projectReportPath === undefined ? "global" : "project";
  const reportPath = projectReportPath ?? join(claudeConfigDir, ".orbitlane", "claude-report.json");

  let raw;
  try { raw = await readFile(reportPath, "utf8"); } catch { throw fail("REPORT_UNREADABLE", reportPath, scope, reportPath); }

  let report;
  try { report = JSON.parse(raw); } catch { throw fail("REPORT_CORRUPT", reportPath, scope, reportPath); }

  if (!SUPPORTED_SCHEMA_VERSIONS.has(report.schema_version)) throw fail("UNSUPPORTED_REPORT_SCHEMA", reportPath, scope, reportPath);

  const contractSha256 = report.contract_snapshot?.sha256;
  if (typeof contractSha256 !== "string" || !DIGEST.test(contractSha256)) throw fail("REPORT_POINTER_MISSING", reportPath, scope, reportPath);

  const root = dirname(dirname(reportPath));

  const load = async (kind, digest) => {
    try {
      return JSON.parse(await readVerifiedSnapshot(root, kind, digest, { readFile }));
    } catch (error) {
      throw fail(error.code ?? "SNAPSHOT_UNREADABLE", error.message, scope, reportPath);
    }
  };

  const contract = await load("contracts", contractSha256);

  const runtimeDefaultsSha256 = report.runtime_defaults_snapshot?.sha256;
  const runtimeDefaults = typeof runtimeDefaultsSha256 === "string" && DIGEST.test(runtimeDefaultsSha256)
    ? await load("runtime-defaults", runtimeDefaultsSha256)
    : undefined;

  return Object.freeze({ scope, reportPath, contract, runtimeDefaults, contractSha256, resolverPolicyVersion: RESOLVER_POLICY_VERSION });
}
