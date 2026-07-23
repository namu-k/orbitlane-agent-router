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

test("release package is allowlisted, private-free, and ships its CLI", async () => {
  const [packageText, packed] = await Promise.all([
    readFile(packagePath, "utf8"),
    runPackageCommand("npm", ["pack", "--dry-run", "--json"], { cwd: root }),
  ]);
  const manifest = JSON.parse(packageText);
  const archive = JSON.parse(packed.stdout)[0];
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

test("README status is consistently post-publish and bounded to Tier 1 plus scoped guard", async () => {
  const [english, korean] = await Promise.all([readFile(resolve(root, "README.md"), "utf8"), readFile(resolve(root, "README.ko.md"), "utf8")]);
  assert.match(english, /published to npm/i);
  assert.match(korean, /npm에 공개/);
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
  const packed = JSON.parse((await runPackageCommand("npm", ["pack", "--json", "--pack-destination", directory], { cwd: root })).stdout)[0];
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
