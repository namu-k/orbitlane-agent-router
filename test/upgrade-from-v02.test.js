import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { writeSnapshot } from "../src/config/snapshots.js";
import { resolveEffectiveContract } from "../src/guards/resolve-contract.js";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/orbitlane.js", import.meta.url));
const v02Runtime = fileURLToPath(new URL("../fixtures/v0.2-hook-runtime/", import.meta.url));

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

async function invoke(args, subprocess) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], { ...subprocess, encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function fileTree(root) {
  const entries = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else entries.push(`${relative(root, child)}:${createHash("sha256").update(await readFile(child)).digest("hex")}`);
    }
  }
  await visit(root);
  return entries.sort();
}

async function frozenV02RuntimeTree() {
  return (await fileTree(v02Runtime)).map((entry) => entry.startsWith("src/") ? entry.slice("src/".length) : entry).sort();
}

async function contentDigest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function invokeGuard(hookPath, evidencePath, subprocess) {
  const child = execFileAsync(process.execPath, [hookPath, subprocess.cwd, evidencePath, "project"], { ...subprocess, encoding: "utf8" });
  child.child.stdin.end(JSON.stringify({ tool_name: "Agent", tool_use_id: "v02-upgrade", tool_input: { subagent_type: "executor", model: "claude-terra" } }));
  try {
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test("a v0.2 partial contract keeps running until an optional reinstall needs all kernel lanes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "orbitlane-v02-upgrade-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projectRoot = join(directory, "repo");
  const subprocess = {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: join(directory, "home"),
      USERPROFILE: join(directory, "userprofile"),
      CODEX_HOME: join(directory, "codex-home"),
      CLAUDE_CONFIG_DIR: join(directory, "claude-home"),
      CLAUDE_CODE_SUBAGENT_MODEL: "inherit",
    },
  };
  const fullPath = join(directory, "full.json");
  const partialPath = join(directory, "partial.json");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(fullPath, `${JSON.stringify(fullContract)}\n`);
  await writeFile(partialPath, `${JSON.stringify(partialContract)}\n`);
  assert.equal((await invoke(["install", "--target", "claude", "--config-root", projectRoot, "--contract", fullPath], subprocess)).code, 0);

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
  const hookRoot = join(projectRoot, ".orbitlane", "hook");
  const hookPath = join(hookRoot, "guards", "claude-spawn-hook.js");
  const evidencePath = join(projectRoot, ".orbitlane", "claude-heartbeats.jsonl");
  await rm(hookRoot, { recursive: true, force: true });
  await cp(join(v02Runtime, "src"), hookRoot, { recursive: true });
  await copyFile(join(v02Runtime, "package.json"), join(hookRoot, "package.json"));
  const files = [instructionPath, reportPath, settingsPath];
  const before = await Promise.all(files.map((path) => readFile(path, "utf8")));
  const fileDigestsBefore = await Promise.all(files.map(contentDigest));
  const contractsBefore = await fileTree(join(projectRoot, ".orbitlane", "contracts"));
  const configuredCommand = JSON.parse(before[2]).hooks.PreToolUse[0].hooks[0].command;
  assert.ok(configuredCommand.includes(hookPath), "the configured guard must execute the fixture-replaced hook path");
  assert.deepEqual(await fileTree(hookRoot), await frozenV02RuntimeTree(), "the legacy state must carry the complete v0.2 vendored runtime");
  const beforeGuard = await invokeGuard(hookPath, evidencePath, subprocess);
  assert.equal(beforeGuard.code, 0, beforeGuard.stderr);
  assert.deepEqual(JSON.parse(await readFile(evidencePath, "utf8")).reason, "CONTRACT_MATCH");

  assert.equal((await invoke(["--help"], subprocess)).code, 0, "package-only upgrade/help must not rewrite an installed scope");
  assert.deepEqual(await Promise.all(files.map((path) => readFile(path, "utf8"))), before);

  const failed = await invoke(["install", "--target", "claude", "--config-root", projectRoot, "--contract", partialPath], subprocess);
  assert.equal(failed.code, 2);
  assert.match(failed.stdout + failed.stderr, /AMBIGUOUS_MODEL_RESOLUTION: sol, luna for target claude/);
  assert.deepEqual(await Promise.all(files.map((path) => readFile(path, "utf8"))), before, "failed reinstall must not write");
  assert.deepEqual(await Promise.all(files.map(contentDigest)), fileDigestsBefore, "failed reinstall must preserve instruction, report, and settings bytes");
  assert.deepEqual(await fileTree(hookRoot), await frozenV02RuntimeTree(), "failed reinstall must preserve every vendored runtime file");
  assert.deepEqual(await fileTree(join(projectRoot, ".orbitlane", "contracts")), contractsBefore, "failed reinstall must preserve every contract snapshot");
  const afterGuard = await invokeGuard(hookPath, evidencePath, subprocess);
  assert.equal(afterGuard.code, 0, afterGuard.stderr);
  assert.deepEqual((await readFile(evidencePath, "utf8")).trimEnd().split("\n").map(JSON.parse).map((heartbeat) => heartbeat.reason), ["CONTRACT_MATCH", "CONTRACT_MATCH"]);

  assert.equal((await invoke(["install", "--target", "claude", "--config-root", projectRoot, "--contract", fullPath], subprocess)).code, 0);
  assert.match(await readFile(instructionPath, "utf8"), /execution -> claude-terra/);
  assert.equal(JSON.parse(await readFile(reportPath, "utf8")).receipt.install_shape, "claude-managed-role-guard");
});
