import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
