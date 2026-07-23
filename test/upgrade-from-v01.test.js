import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const hook = fileURLToPath(new URL("../src/guards/claude-spawn-hook.js", import.meta.url));

// Upgrading the package does not rewrite settings.json, so the most common state
// after `npm i -g orbitlane@0.2.0` is a v0.1 hook entry invoking the new runtime:
// three arguments, the first of which is a contract file rather than a config root.
// Every one of those must fail closed and say which layer to reinstall.
const encode = (value) => `base64:${Buffer.from(value, "utf8").toString("base64")}`;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "orbitlane-upgrade-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contractPath = join(directory, "contract.json");
  await writeFile(contractPath, `${JSON.stringify({ contract_version: "1.0.0" })}\n`, "utf8");
  return { directory, contractPath, evidencePath: join(directory, "heartbeats.jsonl") };
}

async function invokeLegacy({ contractPath, evidencePath, runtimeDefaultsPath, cwd }) {
  const args = [hook, encode(contractPath), encode(evidencePath)];
  if (runtimeDefaultsPath !== undefined) args.push(encode(runtimeDefaultsPath));
  const child = execFileAsync(process.execPath, args, { cwd, encoding: "utf8" });
  child.child.stdin.end(JSON.stringify({ tool_name: "Agent", tool_input: { subagent_type: "executor", model: "claude-terra" } }));
  try { await child; return { code: 0, stderr: "" }; } catch (error) { return { code: error.code, stderr: error.stderr }; }
}

test("a v0.1 hook entry meeting a v0.1 project report denies and names the project", async (t) => {
  const { directory, contractPath, evidencePath } = await fixture(t);
  const projectRoot = join(directory, "repo");
  await mkdir(join(projectRoot, ".orbitlane"), { recursive: true });
  // v0.1 reports carry no schema_version and no snapshot pointer.
  await writeFile(join(projectRoot, ".orbitlane", "claude-report.json"), `${JSON.stringify({ adapter: "claude-code", tier: "tier1", configuration_enforced: false })}\n`, "utf8");

  const result = await invokeLegacy({ contractPath, evidencePath, runtimeDefaultsPath: join(directory, "defaults.json"), cwd: projectRoot });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /UNSUPPORTED_REPORT_SCHEMA/);
  assert.match(result.stderr, /selected_scope=project/);
  assert.match(result.stderr, /orbitlane install --target claude/);
});

test("a v0.1 hook entry reports an unknown installed scope rather than guessing", async (t) => {
  const { directory, contractPath, evidencePath } = await fixture(t);
  const elsewhere = join(directory, "elsewhere");
  await mkdir(elsewhere, { recursive: true });

  const result = await invokeLegacy({ contractPath, evidencePath, cwd: elsewhere });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /REPORT_UNREADABLE/);
  assert.match(result.stderr, /installed_scope=unknown/);
});

test("a v0.1 hook entry still lets non-Agent tool calls through", async (t) => {
  const { directory, contractPath, evidencePath } = await fixture(t);
  const child = execFileAsync(process.execPath, [hook, encode(contractPath), encode(evidencePath)], { cwd: directory, encoding: "utf8" });
  child.child.stdin.end(JSON.stringify({ tool_name: "Read", tool_input: {} }));

  await child;
});
