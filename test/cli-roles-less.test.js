import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/orbitlane.js", import.meta.url));

const rolesLess = {
  contract_version: "1.0.0",
  lanes: {
    sol: { class: "judgment", reasoning: "high" },
    terra: { class: "implementation", reasoning: "medium" },
    luna: { class: "bounded-retrieval", reasoning: "low" },
  },
  targets: {
    claude: {
      lanes: {
        sol: { model: "opus", provenance: "user-local" },
        terra: { model: "sonnet", provenance: "user-local" },
        luna: { model: "haiku", provenance: "user-local" },
      },
    },
  },
};

export async function isolatedRolesLess(t) {
  const directory = await mkdtemp(join(tmpdir(), "orbitlane-rolesless-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contractPath = join(directory, "contract.json");
  await writeFile(contractPath, `${JSON.stringify(rolesLess)}\n`);
  const claudeHome = join(directory, "home", ".claude");
  const env = {
    ...process.env,
    HOME: join(directory, "home"),
    USERPROFILE: join(directory, "home"),
    CODEX_HOME: join(directory, "home", ".codex"),
    CLAUDE_CONFIG_DIR: claudeHome,
  };
  return { directory, contractPath, claudeHome, env };
}

async function invoke(args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], { ...options, encoding: "utf8" });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test("a roles-less install writes guidance without a guard", async (t) => {
  const { contractPath, claudeHome, env } = await isolatedRolesLess(t);

  const result = await invoke(["install", "--global", "--target", "claude", "--contract", contractPath], { env });

  assert.equal(result.code, 0);
  assert.match(await readFile(join(claudeHome, "CLAUDE.md"), "utf8"), /execution -> sonnet/);
  await assert.rejects(readFile(join(claudeHome, "settings.json"), "utf8"), "no settings hook for a guidance-only install");
  await assert.rejects(readdir(join(claudeHome, ".orbitlane", "hook")), "no vendored runtime for a guidance-only install");
});

test("a roles-less install still records a contract snapshot", async (t) => {
  const { contractPath, claudeHome, env } = await isolatedRolesLess(t);

  await invoke(["install", "--global", "--target", "claude", "--contract", contractPath], { env });

  const report = JSON.parse(await readFile(join(claudeHome, ".orbitlane", "claude-report.json"), "utf8"));
  assert.match(report.contract_snapshot.sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.receipt.install_shape, "guidance-only");
  assert.deepEqual(await readdir(join(claudeHome, ".orbitlane", "contracts")), [`${report.contract_snapshot.sha256}.json`]);
});

test("a roles-less install can be uninstalled", async (t) => {
  const { contractPath, claudeHome, env } = await isolatedRolesLess(t);
  await invoke(["install", "--global", "--target", "claude", "--contract", contractPath], { env });

  const result = await invoke(["uninstall", "--global", "--target", "claude"], { env });

  assert.equal(result.code, 0);
  assert.doesNotMatch(await readFile(join(claudeHome, "CLAUDE.md"), "utf8"), /ORBITLANE:START claude/);
});
