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
    codex: { lanes: { sol: { model: "codex-sol", provenance: "fixture" }, terra: { model: "codex-terra", provenance: "fixture" }, luna: { model: "codex-luna", provenance: "fixture" } } },
    claude: { lanes: { sol: { model: "claude-sol", provenance: "fixture" }, terra: { model: "claude-terra", provenance: "fixture" }, luna: { model: "claude-luna", provenance: "fixture" } } },
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

test("CLI encodes the guard arguments it controls before placing them in a shell command", async (t) => {
  const { directory, contractPath } = await fixture(t);
  // No `%` here: cmd would expand it, so install refuses such a root outright and
  // the next test covers that path. `$(...)` is inert on both shells.
  const configRoot = join(directory, "$(not-a-command)-root");

  await invoke(["install", "--target", "claude", "--config-root", configRoot, "--contract", contractPath]);

  const command = JSON.parse(await readFile(join(configRoot, ".claude", "settings.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command;
  // Every argument after the interpreter and the script is base64, so no user text
  // from the config root, the evidence path or the scope reaches the shell verbatim.
  // Quoting differs per platform: POSIX single-quotes, cmd double-quotes.
  const [, , ...encoded] = command.match(/'(?:[^']|'"'"')*'|"(?:[^"])*"/g) ?? [];
  assert.equal(encoded.length, 3);
  for (const argument of encoded) assert.match(argument, /^(['"])base64:[A-Za-z0-9+/=]+\1$/);
});

// The hook now lives under the config root, so its path cannot be base64: node has to
// receive a real path. What must hold is that the shell cannot interpret it.
test("a config root carrying shell metacharacters is quoted, not executed", { skip: process.platform === "win32" ? "cmd quoting is asserted separately" : false }, async (t) => {
  const { directory, contractPath } = await fixture(t);
  const marker = join(directory, "PWNED");
  const configRoot = join(directory, `$(touch ${marker})-root`);

  await invoke(["install", "--target", "claude", "--config-root", configRoot, "--contract", contractPath]);
  const command = JSON.parse(await readFile(join(configRoot, ".claude", "settings.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command;

  const child = execFileAsync("sh", ["-c", command], { encoding: "utf8" });
  child.child.stdin.end(JSON.stringify({ tool_name: "Agent", tool_input: { subagent_type: "executor", model: "claude-terra" } }));
  const { code } = await child.then(() => ({ code: 0 }), (error) => ({ code: error.code }));

  assert.equal(code, 0, "the quoted path must still launch the guard");
  await assert.rejects(readFile(marker, "utf8"), "command substitution inside the config root must not run");
});

test("an install path the target shell would expand is refused up front", { skip: process.platform !== "win32" ? "only cmd expands %VAR% inside quotes" : false }, async (t) => {
  const { directory, contractPath } = await fixture(t);

  // The refusal fails the Claude target, so the CLI exits non-zero and reports the
  // code in its JSON report rather than throwing a usage error on stderr.
  const result = await invoke(["install", "--target", "claude", "--config-root", join(directory, "%ORBITLANE_TEST%"), "--contract", contractPath])
    .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }), (error) => ({ code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }));

  assert.notEqual(result.code, 0);
  assert.match(result.stdout + result.stderr, /UNSAFE_INSTALL_PATH/);
});
