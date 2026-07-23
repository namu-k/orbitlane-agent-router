import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { isolated } from "./cli-global.test.js";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/orbitlane.js", import.meta.url));
async function invoke(args, options = {}) { try { const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], { ...options, encoding: "utf8" }); return { code: 0, stdout, stderr }; } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; } }

test("uninstall works without --contract after the contract file is gone", async (t) => { const { contractPath, claudeHome, codexHome, env } = await isolated(t); await invoke(["install", "--global", "--target", "both", "--contract", contractPath], { env }); await rm(contractPath); const result = await invoke(["uninstall", "--global", "--target", "both"], { env }); assert.equal(result.code, 0); assert.doesNotMatch(await readFile(join(claudeHome, "CLAUDE.md"), "utf8"), /ORBITLANE:START claude/); assert.doesNotMatch(await readFile(join(codexHome, "AGENTS.md"), "utf8"), /ORBITLANE:START codex/); assert.deepEqual(JSON.parse(await readFile(join(claudeHome, "settings.json"), "utf8")), {}); });
test("a corrupt Claude receipt fails that target and leaves settings untouched", async (t) => { const { contractPath, claudeHome, env } = await isolated(t); await invoke(["install", "--global", "--target", "claude", "--contract", contractPath], { env }); const before = await readFile(join(claudeHome, "settings.json"), "utf8"); await writeFile(join(claudeHome, ".orbitlane", "claude-report.json"), "{not json", "utf8"); const result = await invoke(["uninstall", "--global", "--target", "claude"], { env }); assert.notEqual(result.code, 0); assert.match(result.stdout + result.stderr, /RECEIPT_UNVERIFIABLE/); assert.equal(await readFile(join(claudeHome, "settings.json"), "utf8"), before); });
test("a missing snapshot still permits uninstall when the receipt verifies", async (t) => { const { contractPath, claudeHome, env } = await isolated(t); await invoke(["install", "--global", "--target", "claude", "--contract", contractPath], { env }); await rm(join(claudeHome, ".orbitlane", "contracts"), { recursive: true, force: true }); const result = await invoke(["uninstall", "--global", "--target", "claude"], { env }); assert.equal(result.code, 0); assert.deepEqual(JSON.parse(await readFile(join(claudeHome, "settings.json"), "utf8")), {}); });
test("one target's broken receipt does not block the other target", async (t) => { const { contractPath, claudeHome, codexHome, env } = await isolated(t); await invoke(["install", "--global", "--target", "both", "--contract", contractPath], { env }); await writeFile(join(claudeHome, ".orbitlane", "claude-report.json"), "{not json", "utf8"); await invoke(["uninstall", "--global", "--target", "both"], { env }); assert.doesNotMatch(await readFile(join(codexHome, "AGENTS.md"), "utf8"), /ORBITLANE:START codex/); assert.match(await readFile(join(claudeHome, "CLAUDE.md"), "utf8"), /ORBITLANE:START claude/); });
