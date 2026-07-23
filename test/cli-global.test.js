import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/orbitlane.js", import.meta.url));
const contract = { contract_version: "1.0.0", lanes: { sol: { class: "judgment", reasoning: "high" }, terra: { class: "implementation", reasoning: "medium" }, luna: { class: "bounded-retrieval", reasoning: "low" } }, roles: { executor: { lane: "terra", provenance: "user-approved" } }, targets: { codex: { lanes: { terra: { model: "codex-terra", provenance: "fixture" } } }, claude: { lanes: { terra: { model: "claude-terra", provenance: "fixture" } } } } };

export async function isolated(t) {
  const directory = await mkdtemp(join(tmpdir(), "orbitlane-global-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contractPath = join(directory, "contract.json");
  await writeFile(contractPath, `${JSON.stringify(contract)}\n`);
  const codexHome = join(directory, "home", ".codex");
  const claudeHome = join(directory, "home", ".claude");
  const env = { ...process.env, HOME: join(directory, "home"), USERPROFILE: join(directory, "home"), CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome };
  return { directory, contractPath, codexHome, claudeHome, env };
}

async function invoke(args, options = {}) { try { const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], { ...options, encoding: "utf8" }); return { code: 0, stdout, stderr }; } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; } }

test("--global writes Claude settings flat in the config home", async (t) => {
  const { contractPath, codexHome, claudeHome, env } = await isolated(t);
  assert.equal((await invoke(["install", "--global", "--target", "both", "--contract", contractPath], { env })).code, 0);
  assert.match(await readFile(join(codexHome, "AGENTS.md"), "utf8"), /ORBITLANE:START codex/);
  assert.match(await readFile(join(claudeHome, "CLAUDE.md"), "utf8"), /ORBITLANE:START claude/);
  assert.equal(JSON.parse(await readFile(join(claudeHome, "settings.json"), "utf8")).hooks.PreToolUse[0].matcher, "Agent");
  await assert.rejects(readFile(join(claudeHome, ".claude", "settings.json"), "utf8"));
});
test("--global with --config-root is refused by code", async (t) => { const { contractPath, directory, env } = await isolated(t); const result = await invoke(["install", "--global", "--config-root", directory, "--target", "claude", "--contract", contractPath], { env }); assert.equal(result.code, 2); assert.match(result.stderr, /GLOBAL_CONFLICTS_CONFIG_ROOT/); });
test("--global dry-run writes nothing at all", async (t) => { const { contractPath, codexHome, claudeHome, env } = await isolated(t); assert.equal((await invoke(["install", "--global", "--target", "both", "--dry-run", "--contract", contractPath], { env })).code, 0); await assert.rejects(readFile(join(codexHome, "AGENTS.md"), "utf8")); await assert.rejects(readFile(join(claudeHome, "CLAUDE.md"), "utf8")); await assert.rejects(readFile(join(claudeHome, "settings.json"), "utf8")); });

test("--global with blank runtime homes falls back to the home directory, never cwd", async (t) => {
  const { contractPath, directory, env } = await isolated(t);
  const cwd = join(directory, "somewhere");
  await mkdir(cwd, { recursive: true });

  const result = await invoke(["install", "--global", "--target", "both", "--contract", contractPath], { env: { ...env, CODEX_HOME: "", CLAUDE_CONFIG_DIR: "  " }, cwd });

  assert.equal(result.code, 0);
  assert.match(await readFile(join(directory, "home", ".codex", "AGENTS.md"), "utf8"), /ORBITLANE:START codex/);
  assert.match(await readFile(join(directory, "home", ".claude", "CLAUDE.md"), "utf8"), /ORBITLANE:START claude/);
  await assert.rejects(readFile(join(cwd, "AGENTS.md"), "utf8"));
  await assert.rejects(readFile(join(cwd, "CLAUDE.md"), "utf8"));
  await assert.rejects(readFile(join(cwd, "settings.json"), "utf8"));
});

test("--global with a relative runtime home is refused by code", async (t) => {
  const { contractPath, env } = await isolated(t);

  const result = await invoke(["install", "--global", "--target", "codex", "--contract", contractPath], { env: { ...env, CODEX_HOME: "relative-codex-home" } });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /GLOBAL_HOME_NOT_ABSOLUTE/);
});
