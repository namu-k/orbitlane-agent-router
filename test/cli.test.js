import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/orbitlane.js", import.meta.url));

const contract = {
  contract_version: "1.0.0",
  lanes: {
    sol: { class: "judgment", reasoning: "high" },
    terra: { class: "implementation", reasoning: "medium" },
    luna: { class: "bounded-retrieval", reasoning: "low" },
  },
  roles: { executor: { lane: "terra", provenance: "user-approved" } },
  targets: {
    codex: { lanes: { terra: { model: "codex-terra", provenance: "fixture" } } },
    claude: { lanes: { terra: { model: "claude-terra", provenance: "fixture" } } },
  },
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "orbitlane-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contractPath = join(directory, "contract.json");
  await writeFile(contractPath, `${JSON.stringify(contract)}\n`);
  return { directory, configRoot: join(directory, "portable configuration"), contractPath };
}

async function invoke(args, options = {}) {
  return execFileAsync(process.execPath, [cli, ...args], { ...options, encoding: "utf8" });
}

test("CLI exposes a no-network help entry point", async () => {
  const { stdout } = await invoke(["--help"]);
  assert.match(stdout, /Usage: orbitlane/);
});

test("CLI previews platform-neutral both-target diffs without writing", async (t) => {
  const { configRoot, contractPath } = await fixture(t);

  const { stdout } = await invoke(["install", "--target", "both", "--dry-run", "--config-root", configRoot, "--contract", contractPath]);
  const report = JSON.parse(stdout);

  assert.deepEqual(Object.keys(report.outcomes), ["codex", "claude"]);
  assert.equal(report.outcomes.codex.status, "planned");
  assert.equal(report.outcomes.claude.status, "planned");
  await assert.rejects(readFile(join(configRoot, "AGENTS.md"), "utf8"));
  await assert.rejects(readFile(join(configRoot, "CLAUDE.md"), "utf8"));
});

test("CLI installs, uninstalls, and reports each target independently", async (t) => {
  const { configRoot, contractPath } = await fixture(t);
  const base = ["--target", "both", "--config-root", configRoot, "--contract", contractPath];

  const installed = JSON.parse((await invoke(["install", ...base])).stdout);
  assert.equal(installed.outcomes.codex.status, "installed");
  assert.equal(installed.outcomes.claude.status, "installed");
  assert.match(await readFile(join(configRoot, "AGENTS.md"), "utf8"), /ORBITLANE:START codex/);
  assert.match(await readFile(join(configRoot, "CLAUDE.md"), "utf8"), /ORBITLANE:START claude/);

  const removed = JSON.parse((await invoke(["uninstall", ...base])).stdout);
  assert.equal(removed.outcomes.codex.status, "uninstalled");
  assert.equal(removed.outcomes.claude.status, "uninstalled");
});

test("a selected Codex target does not resolve an unrelated Claude route", async (t) => {
  const { configRoot, contractPath } = await fixture(t);
  const codexOnly = { ...contract, targets: { codex: contract.targets.codex } };
  await writeFile(contractPath, `${JSON.stringify(codexOnly)}\n`);

  const report = JSON.parse((await invoke(["install", "--target", "codex", "--config-root", configRoot, "--contract", contractPath])).stdout);
  assert.equal(report.outcomes.codex.status, "installed");
});

test("both preserves a successful target when another adapter cannot resolve a route", async (t) => {
  const { configRoot, contractPath } = await fixture(t);
  const codexOnly = { ...contract, targets: { codex: contract.targets.codex } };
  await writeFile(contractPath, `${JSON.stringify(codexOnly)}\n`);

  await assert.rejects(invoke(["install", "--target", "both", "--config-root", configRoot, "--contract", contractPath]), (error) => {
    const report = JSON.parse(error.stdout);
    return error.code === 1 && report.outcomes.codex.status === "installed" && report.outcomes.claude.status === "failed";
  });
});

test("recover returns a nonzero exit code for an invalid manifest", async (t) => {
  const { directory } = await fixture(t);
  await assert.rejects(invoke(["recover", "--manifest", join(directory, "missing-manifest.json")]), (error) => error.code === 2);
});

test("CLI emits unproven runtime capabilities until an installed release is evidenced", async (t) => {
  const { configRoot, contractPath } = await fixture(t);
  await invoke(["install", "--target", "claude", "--config-root", configRoot, "--contract", contractPath]);
  const generated = JSON.parse(await readFile(join(configRoot, ".orbitlane", "claude-report.json"), "utf8"));
  assert.equal(generated.capabilities.native_role_configuration.status, "unproven");
});

test("CLI encodes user-controlled guard arguments before placing them in a shell command", async (t) => {
  const { directory, contractPath } = await fixture(t);
  const configRoot = join(directory, "$(not-a-command)-%ORBITLANE_TEST%");
  await invoke(["install", "--target", "claude", "--config-root", configRoot, "--contract", contractPath]);
  const settings = await readFile(join(configRoot, ".claude", "settings.json"), "utf8");
  assert.doesNotMatch(settings, /\$\(not-a-command\)/);
  assert.doesNotMatch(settings, /%ORBITLANE_TEST%/);
});
