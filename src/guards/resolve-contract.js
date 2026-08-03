import { readFile as fsReadFile, realpath as fsRealpath } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readVerifiedSnapshot } from "../config/snapshots.js";

export const RESOLVER_POLICY_VERSION = 1;

const SUPPORTED_SCHEMA_VERSIONS = new Set([2]);
const DIGEST = /^[a-f0-9]{64}$/;

// Only these errno values mean "no report lives here". Every other failure means a
// report is present but unusable, which must deny at project scope rather than let
// the walk continue into the global layer (spec I2: no cross-scope fallback).
const ABSENT = new Set(["ENOENT", "ENOTDIR"]);

function fail(code, detail, scope, reportPath) {
  return Object.assign(new Error(`${code}: ${detail}`), { code, scope, reportPath });
}

function pointerDigest(report, key, reportPath, scope) {
  const pointer = report[key];
  if (pointer === undefined) return undefined;
  const digest = pointer?.sha256;
  if (typeof digest !== "string" || !DIGEST.test(digest)) {
    throw fail("REPORT_POINTER_MALFORMED", `${reportPath} (${key})`, scope, reportPath);
  }
  return digest;
}

async function nearestProjectReport(start, read) {
  let current = start;
  for (;;) {
    const candidate = join(current, ".orbitlane", "claude-report.json");
    try {
      return Object.freeze({ path: candidate, raw: await read(candidate, "utf8") });
    } catch (error) {
      if (!ABSENT.has(error?.code)) {
        throw fail("REPORT_UNREADABLE", `${candidate} (${error?.code ?? "unknown"})`, "project", candidate);
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function resolveEffectiveContract({ cwd, claudeConfigDir, readFile = fsReadFile, realpath = fsRealpath }) {
  let start = cwd;
  try {
    start = await realpath(cwd);
  } catch (error) {
    // A cwd that simply does not exist is not a report problem, but any other
    // canonicalisation failure would silently walk the wrong ancestors from a
    // symlinked directory and could land on the global contract.
    if (!ABSENT.has(error?.code)) throw fail("CWD_UNRESOLVABLE", `${cwd} (${error?.code ?? "unknown"})`, undefined, undefined);
    start = cwd;
  }

  const project = await nearestProjectReport(start, readFile);
  const scope = project === undefined ? "global" : "project";
  const reportPath = project?.path ?? join(claudeConfigDir, ".orbitlane", "claude-report.json");

  let raw = project?.raw;
  if (raw === undefined) {
    try { raw = await readFile(reportPath, "utf8"); } catch (error) { throw fail("REPORT_UNREADABLE", `${reportPath} (${error?.code ?? "unknown"})`, scope, reportPath); }
  }

  let report;
  try { report = JSON.parse(raw); } catch { throw fail("REPORT_CORRUPT", reportPath, scope, reportPath); }
  // `null`, an array or a scalar all parse cleanly. Rejecting them here keeps the
  // scope and the report path on the error instead of throwing a bare TypeError.
  if (report === null || typeof report !== "object" || Array.isArray(report)) throw fail("REPORT_CORRUPT", `${reportPath} (not an object)`, scope, reportPath);

  if (!SUPPORTED_SCHEMA_VERSIONS.has(report.schema_version)) throw fail("UNSUPPORTED_REPORT_SCHEMA", reportPath, scope, reportPath);

  if (report.contract_snapshot === undefined) throw fail("REPORT_POINTER_MISSING", reportPath, scope, reportPath);
  const contractSha256 = pointerDigest(report, "contract_snapshot", reportPath, scope);

  const root = dirname(dirname(reportPath));

  const load = async (kind, digest) => {
    try {
      return JSON.parse(await readVerifiedSnapshot(root, kind, digest, { readFile }));
    } catch (error) {
      throw fail(error.code ?? "SNAPSHOT_UNREADABLE", error.message, scope, reportPath);
    }
  };

  const contract = await load("contracts", contractSha256);

  const runtimeDefaultsSha256 = pointerDigest(report, "runtime_defaults_snapshot", reportPath, scope);
  const runtimeDefaults = runtimeDefaultsSha256 === undefined ? undefined : await load("runtime-defaults", runtimeDefaultsSha256);

  return Object.freeze({ scope, reportPath, contract, runtimeDefaults, contractSha256, policyProvenance: report.policy_provenance, resolverPolicyVersion: RESOLVER_POLICY_VERSION });
}
