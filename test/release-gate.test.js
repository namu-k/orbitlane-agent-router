import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

import { evaluateClaudeAgentSpawn } from "../src/guards/claude-spawn.js";
import { projectPolicy } from "../src/policy/index.js";
import { validateContract } from "../src/schema/index.js";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packagePath = resolve(root, "package.json");
const privatePath = ["", "home", process.env.USER ?? "unknown"].join("/");
const contract = Object.freeze({
  contract_version: "1.0.0",
  lanes: { sol: { class: "judgment", reasoning: "high" }, terra: { class: "implementation", reasoning: "medium" }, luna: { class: "bounded-retrieval", reasoning: "low" } },
  roles: { executor: { lane: "terra", provenance: "fixture" } },
  targets: { claude: { lanes: { terra: { model: "claude-terra", provenance: "fixture" } } } },
});

function run(command, args, input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise({ stdout, stderr }) : reject(new Error(`${command} exited ${code}: ${stderr}`)));
    child.stdin.end(input);
  });
}

function runPackageCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise({ stdout, stderr }) : reject(new Error(`${command} exited ${code}: ${stderr}`)));
  });
}

function publicSafetyIssues(path, text) {
  const privateProject = ["orbitlane", "agent", "router", "t2"].join("-");
  const forbidden = [new RegExp(privatePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), /\/home\/[^/\s]+/, /[A-Za-z]:\\Users\\/i, /(?:api[_-]?key|secret|token)\s*[:=]\s*["'][^"']{8,}/i, /wsl\.exe|\\\\wsl\$/i, new RegExp(privateProject, "i")];
  return [
    ...(forbidden.some((pattern) => pattern.test(text)) ? ["private-or-credential-material"] : []),
    ...(/(?:^|\/)(?:evidence|backups?|\.orbitlane-)/i.test(path) ? ["local-artifact-path"] : []),
    ...(/npx orbitlane\s+(?:is )?(?:available|released|published)/i.test(text) ? ["planned-as-shipped"] : []),
  ];
}

// npm 12 reports `npm pack --json` as an object keyed by package name; npm 11 and
// earlier return an array of the same entries. The release gate has to read both,
// because the publish job installs the newest npm to satisfy trusted publishing.
function packReport(stdout) {
  const parsed = JSON.parse(stdout);
  const entries = Array.isArray(parsed) ? parsed : Object.values(parsed);
  const archive = entries[0];
  if (archive === undefined || !Array.isArray(archive.files) || typeof archive.filename !== "string") {
    throw new TypeError(`unrecognised npm pack --json shape: ${stdout.slice(0, 200)}`);
  }
  return archive;
}

function portableContractFromReadme(text) {
  const match = /```json\r?\n([\s\S]*?)\r?\n```/.exec(text);
  if (match === null) throw new TypeError("README has no JSON contract example");
  return JSON.parse(match[1]);
}

test("release package is allowlisted, private-free, and ships its CLI", async () => {
  const [packageText, packed] = await Promise.all([
    readFile(packagePath, "utf8"),
    runPackageCommand("npm", ["pack", "--dry-run", "--json"], { cwd: root }),
  ]);
  const manifest = JSON.parse(packageText);
  const archive = packReport(packed.stdout);
  const paths = archive.files.map((file) => file.path);

  assert.notEqual(manifest.private, true, "the package must be publishable (not private)");
  assert.match(manifest.version, /^\d+\.\d+\.\d+/, "a release requires a semver version");
  assert.deepEqual(manifest.files, ["bin/", "src/", "README.md", "README.ko.md"]);
  assert.ok(paths.includes("bin/orbitlane.js"));
  assert.ok(paths.includes("src/guards/claude-spawn-hook.js"));
  assert.ok(paths.every((path) => !/(^|\/)(?:evidence|backups?|\.orbitlane-)/i.test(path)));
  assert.ok(paths.every((path) => !path.includes(privatePath)));
});

test("public tracked text contains no absolute home paths, credentials, or WSL dependency", async () => {
  const { stdout } = await execFileAsync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  const paths = stdout.trim().split("\n").filter(Boolean);
  const textPaths = paths.filter((path) => /(?:\.md|\.js|\.json|\.yml)$/i.test(path));

  for (const path of textPaths) {
    const text = await readFile(resolve(root, path), "utf8");
    assert.deepEqual(publicSafetyIssues(path, text), [], `${path} contains public-safety material`);
  }
});

test("public-safety scanner rejects representative private, artifact, and premature-release claims", () => {
  assert.notDeepEqual(publicSafetyIssues("docs/evidence/run.json", "safe"), []);
  assert.notDeepEqual(publicSafetyIssues("README.md", ["/", "home", "sample-user"].join("/") + ` ${["api", "key"].join("_")}='${["1234", "5678"].join("")}'`), []);
  assert.notDeepEqual(publicSafetyIssues("README.md", ["npx", "orbitlane", "is", "available"].join(" ")), []);
  assert.notDeepEqual(publicSafetyIssues("README.md", ["orbitlane", "agent", "router", "t2"].join("-")), []);
});

test("README status is release-ready with npm publication pending and bounded to Tier 1 plus scoped guard", async () => {
  const [english, korean] = await Promise.all([readFile(resolve(root, "README.md"), "utf8"), readFile(resolve(root, "README.ko.md"), "utf8")]);
  assert.match(english, /v0\.3\.0 is prepared for release; npm publication is pending\./i);
  assert.match(korean, /v0\.3\.0은 출시 준비가 되었고 npm 공개를 기다리고 있습니다\./);
  assert.doesNotMatch(english, /v0\.3\.0 is published to npm/i);
  assert.doesNotMatch(korean, /v0\.3\.0이 npm에 공개되었습니다/);
  for (const text of [english, korean]) {
    assert.match(text, /Tier 2 roadmap/i);
    assert.match(text, /scoped/i);
  }
  assert.match(english, /not a claim of universal runtime enforcement/i);
  assert.match(english, /npx orbitlane install --target codex --contract <path>/);
  assert.match(korean, /npx orbitlane install --target codex --contract <path>/);

  // The advertised version drifted from package.json once already; pin it.
  const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  for (const text of [english, korean]) assert.match(text, new RegExp(`v${version.replace(/\./g, "\\.")}`), `README must advertise v${version}`);

  const changelog = await readFile(resolve(root, "CHANGELOG.md"), "utf8");
  assert.match(changelog, new RegExp(`^## ${version.replace(/\./g, "\\.")}$`, "m"), `CHANGELOG must have a section for ${version}`);
});

test("the READMEs separate guidance from enforcement", async () => {
  const [english, korean] = await Promise.all([
    readFile(resolve(root, "README.md"), "utf8"),
    readFile(resolve(root, "README.ko.md"), "utf8"),
  ]);

  for (const text of [english, korean]) {
    assert.doesNotMatch(text, /Contract routes:/, "the role-table projection is gone");
  }
  assert.match(english, /guidance/i);
  assert.match(english, /does not install native Codex agent\/model configuration or Claude custom subagent definition files/i);
  assert.match(english, /subagent-shaped entries are requested-route evidence, not installed Claude custom subagent definition files/i);
  assert.match(korean, /Codex native agent\/model configuration이나 Claude custom subagent definition file을 설치하지는 않습니다/);
  assert.match(korean, /요청 route evidence이며 설치된 Claude custom subagent definition file이 아닙니다/);
});

test("the READMEs publish complete portable examples and the v0.2 migration boundary", async () => {
  const [english, korean, changelog] = await Promise.all([
    readFile(resolve(root, "README.md"), "utf8"),
    readFile(resolve(root, "README.ko.md"), "utf8"),
    readFile(resolve(root, "CHANGELOG.md"), "utf8"),
  ]);

  for (const text of [english, korean]) {
    assert.match(text, /"targets":\s*\{/);
    assert.match(text, /"codex":\s*\{/);
    assert.match(text, /"claude":\s*\{/);
    assert.match(text, /"sol":\s*\{\s*"model"/);
    assert.match(text, /"terra":\s*\{\s*"model"/);
    assert.match(text, /"luna":\s*\{\s*"model"/);
    const contractExample = portableContractFromReadme(text);
    assert.deepEqual(validateContract(contractExample), { valid: true, errors: [] });
    for (const target of ["codex", "claude"]) {
      assert.match(projectPolicy({ target, contract: contractExample }), /When delegating, use:/);
    }
  }
  assert.match(english, /Declared roles are checked; runtime roles not declared in the contract pass through as unmanaged\./);
  assert.match(korean, /선언된 roles는 검사하며 contract에 선언되지 않은 runtime role은 unmanaged로 통과합니다\./);
  assert.match(english, /all three lanes \(`sol`, `terra`, and `luna`\).*selected target.*bindings or the runtime's official defaults/i);
  assert.match(korean, /선택한 target.*세 lane\(`sol`, `terra`, `luna`\).*binding 또는 runtime의 공식 default/i);
  assert.match(changelog, /Package upgrade alone does not rewrite an installed scope\./);
  assert.match(changelog, /Conditional contract migration/);
});

test("spawn guard decision p95 remains below the 50ms local budget", () => {
  const samples = [];
  for (let index = 0; index < 101; index += 1) {
    const start = performance.now();
    const result = evaluateClaudeAgentSpawn({ input: { subagent_type: "executor", model: "claude-terra" }, contract });
    samples.push(performance.now() - start);
    assert.equal(result.decision, "allow");
  }
  samples.sort((left, right) => left - right);
  assert.ok(samples[Math.ceil(samples.length * 0.95) - 1] < 50, `p95=${samples[Math.ceil(samples.length * 0.95) - 1]}ms`);
});

test("CI exercises tests on three operating systems and keeps publish manual", async () => {
  const [ci, publish] = await Promise.all([
    readFile(resolve(root, ".github/workflows/ci.yml"), "utf8"),
    readFile(resolve(root, ".github/workflows/publish.yml"), "utf8"),
  ]);
  assert.match(ci, /ubuntu-latest/);
  assert.match(ci, /macos-latest/);
  assert.match(ci, /windows-latest/);
  assert.match(ci, /npm test/);
  assert.doesNotMatch(ci, /cache:\s*npm/);
  assert.match(publish, /workflow_dispatch/);
  assert.match(publish, /npm publish/);
});

test("release-gate dry run executes the packed CLI, scoped guard, and rollback locally", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "orbitlane-release-gate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packed = packReport((await runPackageCommand("npm", ["pack", "--json", "--pack-destination", directory], { cwd: root })).stdout);
  const tarball = resolve(directory, packed.filename);
  assert.ok(packed.files.every((file) => !/(?:evidence|backups?|\.orbitlane-)/i.test(file.path)));
  await runPackageCommand("npm", ["install", "--ignore-scripts", "--no-package-lock", "--prefix", directory, tarball]);

  const installedRoot = resolve(directory, "node_modules", "orbitlane");
  const cli = resolve(installedRoot, "bin", "orbitlane.js");
  assert.match((await execFileAsync(process.execPath, [cli, "--help"], { encoding: "utf8" })).stdout, /Usage: orbitlane/);
  const cliStart = performance.now();
  assert.match((await runPackageCommand("npx", ["--no-install", "--prefix", directory, "orbitlane", "--help"])).stdout, /Usage: orbitlane/);
  assert.ok(performance.now() - cliStart < 2000, `initial CLI=${performance.now() - cliStart}ms`);

  const configDir = resolve(directory, "claude-config");
  const evidencePath = resolve(directory, "heartbeat.jsonl");
  const { writeSnapshot } = await import(pathToFileURL(resolve(installedRoot, "src", "config", "snapshots.js")).href);
  const snapshot = await writeSnapshot(configDir, "contracts", `${JSON.stringify(contract)}\n`);
  await mkdir(resolve(configDir, ".orbitlane"), { recursive: true });
  await writeFile(resolve(configDir, ".orbitlane", "claude-report.json"), `${JSON.stringify({ schema_version: 2, contract_snapshot: { sha256: snapshot.sha256 } })}\n`);
  await run(process.execPath, [resolve(installedRoot, "src", "guards", "claude-spawn-hook.js"), configDir, evidencePath], JSON.stringify({ tool_name: "Agent", tool_use_id: "release-gate", tool_input: { subagent_type: "executor", model: "claude-terra" } }));
  assert.match(await readFile(evidencePath, "utf8"), /CONTRACT_MATCH/);

  const installer = await import(pathToFileURL(resolve(installedRoot, "src", "installer", "index.js")).href);
  const target = { runtime: { available: true, version: "fixture" }, supportsVersion: () => true, instructionPath: resolve(directory, "rollback.md"), generatedPath: resolve(directory, "rollback.json"), failurePoint: "afterInstructionCommit", render: () => ({ policy: "rollback policy", generated: "generated" }) };
  await writeFile(target.instructionPath, "before\n");
  const result = await installer.installRouting({ contract_version: "1.0.0" }, { target: "codex", adapters: { codex: target } });
  assert.equal(result.outcomes.codex.status, "failed");
  assert.equal(await readFile(target.instructionPath, "utf8"), "before\n");
  assert.ok((await readdir(directory)).some((name) => name.startsWith(".orbitlane-codex-")));
});
