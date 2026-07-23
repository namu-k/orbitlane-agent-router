import assert from "node:assert/strict";
import { cp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { isolated } from "./cli-global.test.js";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
async function ephemeralCli(directory) { const target = join(directory, "_npx", "abc123"); await mkdir(target, { recursive: true }); for (const entry of ["bin", "src", "package.json"]) await cp(join(packageRoot, entry), join(target, entry), { recursive: true }); return join(target, "bin", "orbitlane.js"); }
async function invoke(cliPath, args, options = {}) { try { const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], { ...options, encoding: "utf8" }); return { code: 0, stdout, stderr }; } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; } }
test("global Claude is refused from an ephemeral package root", async (t) => { const { directory, contractPath, env } = await isolated(t); const cliPath = await ephemeralCli(directory); const result = await invoke(cliPath, ["install", "--global", "--target", "claude", "--contract", contractPath], { env }); assert.notEqual(result.code, 0); assert.match(result.stdout + result.stderr, /EPHEMERAL_PACKAGE_ROOT/); });
test("global Codex still installs from an ephemeral package root", async (t) => { const { directory, contractPath, codexHome, env } = await isolated(t); const cliPath = await ephemeralCli(directory); const result = await invoke(cliPath, ["install", "--global", "--target", "codex", "--contract", contractPath], { env }); assert.equal(result.code, 0); assert.match(await readFile(join(codexHome, "AGENTS.md"), "utf8"), /ORBITLANE:START codex/); });
test("both keeps Codex success alongside Claude failure", async (t) => { const { directory, contractPath, codexHome, claudeHome, env } = await isolated(t); const cliPath = await ephemeralCli(directory); const result = await invoke(cliPath, ["install", "--global", "--target", "both", "--contract", contractPath], { env }); assert.equal(result.code, 1); assert.match(await readFile(join(codexHome, "AGENTS.md"), "utf8"), /ORBITLANE:START codex/); await assert.rejects(readFile(join(claudeHome, "CLAUDE.md"), "utf8")); });
test("project mode is unaffected by an ephemeral package root", async (t) => { const { directory, contractPath, env } = await isolated(t); const cliPath = await ephemeralCli(directory); const projectRoot = join(directory, "repo"); assert.equal((await invoke(cliPath, ["install", "--target", "claude", "--config-root", projectRoot, "--contract", contractPath], { env })).code, 0); });
