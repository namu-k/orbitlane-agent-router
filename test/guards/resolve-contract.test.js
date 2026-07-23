import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeSnapshot } from "../../src/config/snapshots.js";
import { resolveEffectiveContract } from "../../src/guards/resolve-contract.js";

const contract = {
  contract_version: "1.0.0",
  lanes: {
    sol: { class: "judgment", reasoning: "high" },
    terra: { class: "implementation", reasoning: "medium" },
    luna: { class: "bounded-retrieval", reasoning: "low" },
  },
  roles: { executor: { lane: "terra", provenance: "user-approved" } },
};

async function base(t) {
  const directory = await mkdtemp(join(tmpdir(), "orbitlane-resolver-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function installReport(root, body, extra = {}) {
  const written = await writeSnapshot(root, "contracts", `${JSON.stringify(body)}\n`);
  await mkdir(join(root, ".orbitlane"), { recursive: true });
  await writeFile(
    join(root, ".orbitlane", "claude-report.json"),
    `${JSON.stringify({ schema_version: 2, contract_snapshot: { sha256: written.sha256 }, ...extra }, null, 2)}\n`,
    "utf8",
  );
  return written.sha256;
}

test("the nearest project report wins over the global report", async (t) => {
  const directory = await base(t);
  const globalRoot = join(directory, "home", ".claude");
  const projectRoot = join(directory, "repo");
  const nested = join(projectRoot, "packages", "app");
  await mkdir(nested, { recursive: true });

  await installReport(globalRoot, { ...contract, roles: { architect: { lane: "sol", provenance: "user-approved" } } });
  const projectSha = await installReport(projectRoot, contract);

  const resolved = await resolveEffectiveContract({ cwd: nested, claudeConfigDir: globalRoot });

  assert.equal(resolved.scope, "project");
  assert.equal(resolved.contractSha256, projectSha);
  assert.deepEqual(Object.keys(resolved.contract.roles), ["executor"]);
});

test("resolution falls back to the global report when no project report exists", async (t) => {
  const directory = await base(t);
  const globalRoot = join(directory, "home", ".claude");
  const elsewhere = join(directory, "elsewhere");
  await mkdir(elsewhere, { recursive: true });
  await installReport(globalRoot, contract);

  const resolved = await resolveEffectiveContract({ cwd: elsewhere, claudeConfigDir: globalRoot });

  assert.equal(resolved.scope, "global");
});

test("unknown report fields do not change the outcome", async (t) => {
  const directory = await base(t);
  const globalRoot = join(directory, "home", ".claude");
  const projectRoot = join(directory, "repo");
  await mkdir(projectRoot, { recursive: true });
  await installReport(globalRoot, contract);
  const sha = await installReport(projectRoot, contract, { future_field: { nested: true }, another: 42 });

  const resolved = await resolveEffectiveContract({ cwd: projectRoot, claudeConfigDir: globalRoot });

  assert.equal(resolved.scope, "project");
  assert.equal(resolved.contractSha256, sha);
});

test("a corrupt project report denies instead of falling back to global", async (t) => {
  const directory = await base(t);
  const globalRoot = join(directory, "home", ".claude");
  const projectRoot = join(directory, "repo");
  await installReport(globalRoot, contract);
  await mkdir(join(projectRoot, ".orbitlane"), { recursive: true });
  await writeFile(join(projectRoot, ".orbitlane", "claude-report.json"), "{not json", "utf8");

  await assert.rejects(
    resolveEffectiveContract({ cwd: projectRoot, claudeConfigDir: globalRoot }),
    (error) => error.code === "REPORT_CORRUPT",
  );
});

test("a pointerless report denies instead of falling back to global", async (t) => {
  const directory = await base(t);
  const globalRoot = join(directory, "home", ".claude");
  const projectRoot = join(directory, "repo");
  await installReport(globalRoot, contract);
  await mkdir(join(projectRoot, ".orbitlane"), { recursive: true });
  await writeFile(join(projectRoot, ".orbitlane", "claude-report.json"), `${JSON.stringify({ schema_version: 2 })}\n`, "utf8");

  await assert.rejects(
    resolveEffectiveContract({ cwd: projectRoot, claudeConfigDir: globalRoot }),
    (error) => error.code === "REPORT_POINTER_MISSING",
  );
});

test("an unsupported schema version denies with a self-describing code", async (t) => {
  const directory = await base(t);
  const globalRoot = join(directory, "home", ".claude");
  await installReport(globalRoot, contract);
  await writeFile(
    join(globalRoot, ".orbitlane", "claude-report.json"),
    `${JSON.stringify({ schema_version: 99, contract_snapshot: { sha256: "a".repeat(64) } })}\n`,
    "utf8",
  );

  await assert.rejects(
    resolveEffectiveContract({ cwd: join(directory, "nowhere"), claudeConfigDir: globalRoot }),
    (error) => error.code === "UNSUPPORTED_REPORT_SCHEMA",
  );
});

test("a tampered snapshot denies", async (t) => {
  const directory = await base(t);
  const globalRoot = join(directory, "home", ".claude");
  const sha = await installReport(globalRoot, contract);
  await writeFile(join(globalRoot, ".orbitlane", "contracts", `${sha}.json`), "tampered\n", "utf8");

  await assert.rejects(
    resolveEffectiveContract({ cwd: join(directory, "nowhere"), claudeConfigDir: globalRoot }),
    (error) => error.code === "SNAPSHOT_HASH_MISMATCH",
  );
});

// chmod on Windows only toggles the read-only flag, so read access cannot be
// withdrawn there; root ignores the mode entirely.
const cannotDenyReads = process.platform === "win32" ? "chmod does not withdraw read access on Windows" : process.getuid?.() === 0 ? "chmod cannot deny root" : false;

test("an unreadable project report denies instead of falling back to global", { skip: cannotDenyReads }, async (t) => {
  const directory = await base(t);
  const globalRoot = join(directory, "home", ".claude");
  const projectRoot = join(directory, "repo");
  await installReport(globalRoot, { ...contract, roles: { architect: { lane: "sol", provenance: "user-approved" } } });
  await installReport(projectRoot, contract);
  const reportPath = join(projectRoot, ".orbitlane", "claude-report.json");
  await chmod(reportPath, 0o000);
  t.after(() => chmod(reportPath, 0o600).catch(() => {}));
  // The resolver canonicalises cwd first, and on macOS tmpdir() is a symlink
  // (/var -> /private/var), so compare against the canonical path.
  const canonical = join(await realpath(projectRoot), ".orbitlane", "claude-report.json");

  await assert.rejects(
    resolveEffectiveContract({ cwd: projectRoot, claudeConfigDir: globalRoot }),
    (error) => error.code === "REPORT_UNREADABLE" && error.scope === "project" && error.reportPath === canonical,
  );
});

test("a report path that is not a regular file denies at project scope", async (t) => {
  const directory = await base(t);
  const globalRoot = join(directory, "home", ".claude");
  const projectRoot = join(directory, "repo");
  await installReport(globalRoot, contract);
  await mkdir(join(projectRoot, ".orbitlane", "claude-report.json"), { recursive: true });

  await assert.rejects(
    resolveEffectiveContract({ cwd: projectRoot, claudeConfigDir: globalRoot }),
    (error) => error.code === "REPORT_UNREADABLE" && error.scope === "project",
  );
});

test("a present but malformed runtime-defaults pointer denies", async (t) => {
  const directory = await base(t);
  const globalRoot = join(directory, "home", ".claude");
  await installReport(globalRoot, contract, { runtime_defaults_snapshot: { sha256: "not-a-digest" } });

  await assert.rejects(
    resolveEffectiveContract({ cwd: join(directory, "nowhere"), claudeConfigDir: globalRoot }),
    (error) => error.code === "REPORT_POINTER_MALFORMED",
  );
});

test("a symlinked cwd canonicalises before the ancestor walk", async (t) => {
  const directory = await base(t);
  const globalRoot = join(directory, "home", ".claude");
  const projectRoot = join(directory, "repo");
  const nested = join(projectRoot, "packages", "app");
  await mkdir(nested, { recursive: true });
  await installReport(globalRoot, { ...contract, roles: { architect: { lane: "sol", provenance: "user-approved" } } });
  const projectSha = await installReport(projectRoot, contract);

  const link = join(directory, "link-to-app");
  await symlink(nested, link, "dir");

  const resolved = await resolveEffectiveContract({ cwd: link, claudeConfigDir: globalRoot });

  assert.equal(resolved.scope, "project");
  assert.equal(resolved.contractSha256, projectSha);
});

test("a report that parses to a non-object denies with its scope intact", async (t) => {
  const directory = await base(t);
  const globalRoot = join(directory, "home", ".claude");
  const projectRoot = join(directory, "repo");
  await installReport(globalRoot, contract);
  await mkdir(join(projectRoot, ".orbitlane"), { recursive: true });

  for (const body of ["null", "[]", "42", '"text"']) {
    await writeFile(join(projectRoot, ".orbitlane", "claude-report.json"), `${body}\n`, "utf8");
    await assert.rejects(
      resolveEffectiveContract({ cwd: projectRoot, claudeConfigDir: globalRoot }),
      (error) => error.code === "REPORT_CORRUPT" && error.scope === "project",
    );
  }
});

test("a cwd that cannot be canonicalised denies instead of walking the wrong ancestors", async (t) => {
  const directory = await base(t);
  const globalRoot = join(directory, "home", ".claude");
  await installReport(globalRoot, contract);

  await assert.rejects(
    resolveEffectiveContract({
      cwd: join(directory, "repo"),
      claudeConfigDir: globalRoot,
      realpath: async () => { throw Object.assign(new Error("io error"), { code: "EIO" }); },
    }),
    (error) => error.code === "CWD_UNRESOLVABLE",
  );
});
