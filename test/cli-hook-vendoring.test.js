import assert from "node:assert/strict";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { isolated } from "./cli-global.test.js";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const installedCli = fileURLToPath(new URL("../bin/orbitlane.js", import.meta.url));

// npx and dlx unpack into a cache that is evicted without warning. Installing from
// such a root and then deleting it is the case vendoring the hook has to survive.
async function ephemeralCli(directory) {
  const target = join(directory, "_npx", "abc123");
  await mkdir(target, { recursive: true });
  for (const entry of ["bin", "src", "package.json"]) await cp(join(packageRoot, entry), join(target, entry), { recursive: true });
  return { cli: join(target, "bin", "orbitlane.js"), cache: join(directory, "_npx") };
}

async function invoke(cliPath, args, options = {}) { try { const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], { ...options, encoding: "utf8" }); return { code: 0, stdout, stderr }; } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; } }

async function spawnAgent(root, model, scope) {
  const args = [join(root, ".orbitlane", "hook", "guards", "claude-spawn-hook.js"), root, join(root, ".orbitlane", "claude-heartbeats.jsonl"), scope];
  const child = execFileAsync(process.execPath, args, { cwd: root, encoding: "utf8" });
  child.child.stdin.end(JSON.stringify({ tool_name: "Agent", tool_input: { subagent_type: "executor", model } }));
  try { const { stderr } = await child; return { code: 0, stderr }; } catch (error) { return { code: error.code, stderr: error.stderr }; }
}

test("a global Claude guard installed from an evicted npx cache still decides", async (t) => {
  const { directory, contractPath, claudeHome, env } = await isolated(t);
  const { cli, cache } = await ephemeralCli(directory);

  assert.equal((await invoke(cli, ["install", "--global", "--target", "claude", "--contract", contractPath], { env })).code, 0);
  await rm(cache, { recursive: true, force: true });

  assert.equal((await spawnAgent(claudeHome, "claude-terra", "global")).code, 0);
  const denied = await spawnAgent(claudeHome, "other-model", "global");
  assert.equal(denied.code, 2);
  assert.match(denied.stderr, /CONTRACT_MISMATCH/);
});

test("a project Claude guard survives eviction of the package that installed it", async (t) => {
  const { directory, contractPath, env } = await isolated(t);
  const { cli, cache } = await ephemeralCli(directory);
  const projectRoot = join(directory, "repo");

  assert.equal((await invoke(cli, ["install", "--target", "claude", "--config-root", projectRoot, "--contract", contractPath], { env })).code, 0);
  await rm(cache, { recursive: true, force: true });

  assert.equal((await spawnAgent(projectRoot, "claude-terra", "project")).code, 0);
  assert.equal((await spawnAgent(projectRoot, "other-model", "project")).code, 2);
});

test("the vendored runtime declares its own module scope", async (t) => {
  const { directory, contractPath, env } = await isolated(t);
  const projectRoot = join(directory, "commonjs-repo");
  await mkdir(projectRoot, { recursive: true });
  // A host project that declares CommonJS would otherwise capture the copied hook.
  await writeFile(join(projectRoot, "package.json"), `${JSON.stringify({ name: "host", version: "1.0.0" })}\n`, "utf8");

  assert.equal((await invoke(installedCli, ["install", "--target", "claude", "--config-root", projectRoot, "--contract", contractPath], { env })).code, 0);

  assert.deepEqual(JSON.parse(await readFile(join(projectRoot, ".orbitlane", "hook", "package.json"), "utf8")), { type: "module" });
  assert.equal((await spawnAgent(projectRoot, "claude-terra", "project")).code, 0);
});

test("the installed command points into the config root, never at the package", async (t) => {
  const { directory, contractPath, claudeHome, env } = await isolated(t);
  const { cli } = await ephemeralCli(directory);

  await invoke(cli, ["install", "--global", "--target", "claude", "--contract", contractPath], { env });

  const command = JSON.parse(await readFile(join(claudeHome, "settings.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command;
  assert.match(command, /claude-spawn-hook\.js/);
  assert.doesNotMatch(command, /_npx/);
  assert.doesNotMatch(command, /contract\.json/);
});

test("dry-run vendors nothing", async (t) => {
  const { contractPath, claudeHome, env } = await isolated(t);

  assert.equal((await invoke(installedCli, ["install", "--global", "--target", "claude", "--dry-run", "--contract", contractPath], { env })).code, 0);

  await assert.rejects(readdir(join(claudeHome, ".orbitlane", "hook")));
});

test("uninstall reclaims the vendored runtime", async (t) => {
  const { contractPath, claudeHome, env } = await isolated(t);
  await invoke(installedCli, ["install", "--global", "--target", "claude", "--contract", contractPath], { env });
  assert.ok((await readdir(join(claudeHome, ".orbitlane", "hook"))).length > 0);

  assert.equal((await invoke(installedCli, ["uninstall", "--global", "--target", "claude"], { env })).code, 0);

  await assert.rejects(readdir(join(claudeHome, ".orbitlane", "hook")));
});

test("global Codex is unaffected by where the package lives", async (t) => {
  const { directory, contractPath, codexHome, env } = await isolated(t);
  const { cli } = await ephemeralCli(directory);

  assert.equal((await invoke(cli, ["install", "--global", "--target", "codex", "--contract", contractPath], { env })).code, 0);

  assert.match(await readFile(join(codexHome, "AGENTS.md"), "utf8"), /ORBITLANE:START codex/);
});

test("a Claude preparation failure does not stop Codex under --target both", async (t) => {
  const { contractPath, codexHome, claudeHome, env } = await isolated(t);
  // A file where the Claude .orbitlane directory has to go: vendoring and the
  // snapshot store both fail, and only the Claude target may fail with them.
  await mkdir(claudeHome, { recursive: true });
  await writeFile(join(claudeHome, ".orbitlane"), "not a directory\n", "utf8");

  const result = await invoke(installedCli, ["install", "--global", "--target", "both", "--contract", contractPath], { env });

  assert.equal(result.code, 1, "one target failed, the other did not");
  assert.match(await readFile(join(codexHome, "AGENTS.md"), "utf8"), /ORBITLANE:START codex/);
  await assert.rejects(readFile(join(claudeHome, "CLAUDE.md"), "utf8"));
});

test("a Claude-only install still fails loudly when preparation fails", async (t) => {
  const { contractPath, claudeHome, env } = await isolated(t);
  await mkdir(claudeHome, { recursive: true });
  await writeFile(join(claudeHome, ".orbitlane"), "not a directory\n", "utf8");

  const result = await invoke(installedCli, ["install", "--global", "--target", "claude", "--contract", contractPath], { env });

  assert.equal(result.code, 2);
});
