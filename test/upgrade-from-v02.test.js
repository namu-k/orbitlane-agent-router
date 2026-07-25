import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { writeSnapshot } from "../src/config/snapshots.js";
import { resolveEffectiveContract } from "../src/guards/resolve-contract.js";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/orbitlane.js", import.meta.url));

const lanes = {
  sol: { class: "judgment", reasoning: "high" },
  terra: { class: "implementation", reasoning: "medium" },
  luna: { class: "bounded-retrieval", reasoning: "low" },
};

const fullContract = {
  contract_version: "1.0.0",
  lanes,
  roles: { executor: { lane: "terra", provenance: "user-approved" } },
  targets: { claude: { lanes: {
    sol: { model: "claude-sol", provenance: "user-local" },
    terra: { model: "claude-terra", provenance: "user-local" },
    luna: { model: "claude-luna", provenance: "user-local" },
  } } },
};

const partialContract = {
  contract_version: "1.0.0",
  lanes,
  roles: { executor: { lane: "terra", provenance: "user-approved" } },
  targets: { claude: { lanes: { terra: { model: "claude-terra", provenance: "user-local" } } } },
};

async function invoke(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], { encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test("a v0.2 partial contract keeps running until an optional reinstall needs all kernel lanes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "orbitlane-v02-upgrade-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projectRoot = join(directory, "repo");
  const fullPath = join(directory, "full.json");
  const partialPath = join(directory, "partial.json");
  await writeFile(fullPath, `${JSON.stringify(fullContract)}\n`);
  await writeFile(partialPath, `${JSON.stringify(partialContract)}\n`);
  assert.equal((await invoke(["install", "--target", "claude", "--config-root", projectRoot, "--contract", fullPath])).code, 0);

  const instructionPath = join(projectRoot, "CLAUDE.md");
  const reportPath = join(projectRoot, ".orbitlane", "claude-report.json");
  const settingsPath = join(projectRoot, ".claude", "settings.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const partialSnapshot = await writeSnapshot(projectRoot, "contracts", `${JSON.stringify(partialContract)}\n`);
  const legacyReport = {
    ...report,
    schema_version: 2,
    contract_snapshot: { sha256: partialSnapshot.sha256 },
    settings_projection: report.settings_projection,
  };
  delete legacyReport.receipt;
  await writeFile(instructionPath, "<!-- ORBITLANE:START claude -->\n- Legacy 0.2 routing policy.\n<!-- ORBITLANE:END claude -->\n");
  await writeFile(reportPath, `${JSON.stringify(legacyReport, null, 2)}\n`);

  const effective = await resolveEffectiveContract({ cwd: projectRoot, claudeConfigDir: projectRoot });
  assert.equal(effective.contract.roles.executor.lane, "terra", "the legacy guard still resolves its content-addressed partial snapshot");
  const files = [instructionPath, reportPath, settingsPath, join(projectRoot, ".orbitlane", "hook", "guards", "claude-spawn-hook.js"), partialSnapshot.path];
  const before = await Promise.all(files.map((path) => readFile(path, "utf8")));

  assert.equal((await invoke(["--help"])).code, 0, "package-only upgrade/help must not rewrite an installed scope");
  assert.deepEqual(await Promise.all(files.map((path) => readFile(path, "utf8"))), before);

  const failed = await invoke(["install", "--target", "claude", "--config-root", projectRoot, "--contract", partialPath]);
  assert.equal(failed.code, 2);
  assert.match(failed.stdout + failed.stderr, /AMBIGUOUS_MODEL_RESOLUTION: sol, luna for target claude/);
  assert.deepEqual(await Promise.all(files.map((path) => readFile(path, "utf8"))), before, "failed reinstall must not write");

  assert.equal((await invoke(["install", "--target", "claude", "--config-root", projectRoot, "--contract", fullPath])).code, 0);
  assert.match(await readFile(instructionPath, "utf8"), /execution -> claude-terra/);
  assert.equal(JSON.parse(await readFile(reportPath, "utf8")).receipt.install_shape, "claude-managed-role-guard");
});
