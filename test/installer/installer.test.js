import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { installRouting, recoverRouting, uninstallRouting } from "../../src/installer/index.js";

const contract = Object.freeze({ contract_version: "1.0.0" });
const execFileAsync = promisify(execFile);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "orbitlane-installer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function adapter(directory, name, overrides = {}) {
  return {
    runtime: { available: true, version: "1.0.0" },
    supportsVersion: (version) => version === "1.0.0",
    instructionPath: join(directory, `${name}.md`),
    generatedPath: join(directory, `${name}.json`),
    render: () => ({ policy: `${name} policy`, generated: `{"target":"${name}"}` }),
    ...overrides,
  };
}

test("installs a marker-bounded policy without changing bytes outside its block", async (t) => {
  const directory = await fixture(t);
  const codex = adapter(directory, "codex");
  const original = "# User rules\n\nKeep this text exactly.\n";
  await writeFile(codex.instructionPath, original);

  const result = await installRouting(contract, { target: "codex", adapters: { codex } });
  const installed = await readFile(codex.instructionPath, "utf8");

  assert.equal(result.outcomes.codex.status, "installed");
  assert.equal(installed.replace(/<!-- ORBITLANE:START codex -->[\s\S]*?<!-- ORBITLANE:END codex -->\n/, ""), original);
  assert.match(installed, /codex policy/);
});

test("repeating an identical install has no diff", async (t) => {
  const directory = await fixture(t);
  const codex = adapter(directory, "codex");

  await installRouting(contract, { target: "codex", adapters: { codex } });
  const repeat = await installRouting(contract, { target: "codex", adapters: { codex } });

  assert.equal(repeat.outcomes.codex.status, "unchanged");
  assert.equal(repeat.outcomes.codex.manifest, null);
});

test("both keeps a successful target when the other target fails", async (t) => {
  const directory = await fixture(t);
  const codex = adapter(directory, "codex");
  const claude = adapter(directory, "claude");
  await writeFile(claude.instructionPath, "Claude original\n");
  claude.failurePoint = "afterInstructionCommit";

  const result = await installRouting(contract, {
    target: "both",
    adapters: { codex, claude },
  });

  assert.equal(result.outcomes.codex.status, "installed");
  assert.equal(result.outcomes.claude.status, "failed");
  assert.equal(await readFile(claude.instructionPath, "utf8"), "Claude original\n");
  assert.match(await readFile(codex.instructionPath, "utf8"), /ORBITLANE:START codex/);
});

test("uninstall removes only owned files and preserves user edits made after install", async (t) => {
  const directory = await fixture(t);
  const codex = adapter(directory, "codex");
  await writeFile(codex.instructionPath, "# User rules\n");
  await installRouting(contract, { target: "codex", adapters: { codex } });
  const installed = await readFile(codex.instructionPath, "utf8");
  await writeFile(codex.instructionPath, installed.replace("# User rules", "# User rules, edited"));

  const result = await uninstallRouting({ target: "codex", adapters: { codex } });

  assert.equal(result.outcomes.codex.status, "uninstalled");
  assert.equal(await readFile(codex.instructionPath, "utf8"), "# User rules, edited\n");
  await assert.rejects(access(codex.generatedPath));
});

test("installs and surgically removes a Claude Agent PreToolUse hook without replacing user settings", async (t) => {
  const directory = await fixture(t);
  const settingsPath = join(directory, "settings.json");
  const claude = adapter(directory, "claude", {
    settingsPath,
    render: () => ({
      policy: "claude policy",
      generated: '{"target":"claude"}',
      settingsProjection: { command: "node orbitlane-guard.mjs contract.json evidence.json defaults.json" },
    }),
  });
  await writeFile(settingsPath, `${JSON.stringify({ permissions: { allow: ["Read"] }, hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "user-hook" }] }] } }, null, 2)}\n`);

  const installed = await installRouting(contract, { target: "claude", adapters: { claude } });
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(installed.outcomes.claude.status, "installed");
  assert.deepEqual(settings.permissions, { allow: ["Read"] });
  assert.deepEqual(settings.hooks.PreToolUse, [
    { matcher: "Write", hooks: [{ type: "command", command: "user-hook" }] },
    { matcher: "Agent", hooks: [{ type: "command", command: "node orbitlane-guard.mjs contract.json evidence.json defaults.json" }] },
  ]);

  await uninstallRouting({ target: "claude", adapters: { claude } });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { permissions: { allow: ["Read"] }, hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "user-hook" }] }] } });
});

test("preserves a user hook in an OrbitLane Agent entry and replaces an older guard command", async (t) => {
  const directory = await fixture(t);
  const settingsPath = join(directory, "settings.json");
  const first = adapter(directory, "claude", { settingsPath, spawnGuardCommand: "node orbitlane-guard-v1.mjs" });
  first.render = () => ({ policy: "claude policy", generated: JSON.stringify({ settings_projection: { guard_command: first.spawnGuardCommand } }), settingsProjection: { command: first.spawnGuardCommand } });
  await installRouting(contract, { target: "claude", adapters: { claude: first } });
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  settings.hooks.PreToolUse[0].hooks.push({ type: "command", command: "user-added" });
  settings.hooks.PreToolUse[0].hooks.push({ type: "command", command: "node user-orbitlane-guard-report.mjs" });
  await writeFile(settingsPath, `${JSON.stringify(settings)}\n`);
  const second = adapter(directory, "claude", { settingsPath, spawnGuardCommand: "node orbitlane-guard-v2.mjs" });
  second.render = () => ({ policy: "claude policy", generated: JSON.stringify({ settings_projection: { guard_command: second.spawnGuardCommand } }), settingsProjection: { command: second.spawnGuardCommand } });
  await installRouting(contract, { target: "claude", adapters: { claude: second } });
  const installed = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(installed.hooks.PreToolUse[0].hooks, [{ type: "command", command: "user-added" }, { type: "command", command: "node user-orbitlane-guard-report.mjs" }]);
  assert.deepEqual(installed.hooks.PreToolUse[1].hooks, [{ type: "command", command: "node orbitlane-guard-v2.mjs" }]);
  await uninstallRouting({ target: "claude", adapters: { claude: second } });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { hooks: { PreToolUse: [{ matcher: "Agent", hooks: [{ type: "command", command: "user-added" }, { type: "command", command: "node user-orbitlane-guard-report.mjs" }] }] } });
});

test("removes settings scaffolding created solely for the OrbitLane hook", async (t) => {
  const directory = await fixture(t);
  const claude = adapter(directory, "claude", { settingsPath: join(directory, "settings.json"), spawnGuardCommand: "node orbitlane-guard.mjs" });
  claude.render = () => ({ policy: "claude policy", generated: "{}", settingsProjection: { command: claude.spawnGuardCommand } });
  await installRouting(contract, { target: "claude", adapters: { claude } });
  await uninstallRouting({ target: "claude", adapters: { claude } });
  assert.deepEqual(JSON.parse(await readFile(claude.settingsPath, "utf8")), {});
});

test("an interrupted commit restores the target snapshot", async (t) => {
  const directory = await fixture(t);
  const codex = adapter(directory, "codex");
  await writeFile(codex.instructionPath, "before\n");
  await writeFile(codex.generatedPath, "before generated\n");

  const result = await installRouting(contract, {
    target: "codex",
    adapters: { codex },
    hooks: { interruptAfterInstructionCommit: true },
  });

  assert.equal(result.outcomes.codex.status, "failed");
  assert.equal(await readFile(codex.instructionPath, "utf8"), "before\n");
  assert.equal(await readFile(codex.generatedPath, "utf8"), "before generated\n");
});

test("keeps the planned dry-run diff when concurrent editing invalidates staging", async (t) => {
  const directory = await fixture(t);
  const codex = adapter(directory, "codex");
  await writeFile(codex.instructionPath, "before\n");

  const result = await installRouting(contract, {
    target: "codex",
    adapters: { codex },
    hooks: { afterStage: async () => writeFile(codex.instructionPath, "concurrent edit\n") },
  });

  assert.equal(result.outcomes.codex.error.code, "TARGET_CONTENT_CHANGED");
  assert.equal(result.outcomes.codex.diff.instruction.before, "before\n");
  assert.equal(result.outcomes.codex.diff.instruction.after.includes("codex policy"), true);
  assert.equal(await readFile(codex.instructionPath, "utf8"), "concurrent edit\n");
});

test("reports missing and unsupported runtimes explicitly", async (t) => {
  const directory = await fixture(t);
  const missing = adapter(directory, "codex", { runtime: { available: false } });
  const unsupported = adapter(directory, "claude", { runtime: { available: true, version: "0.1.0" } });

  const result = await installRouting(contract, { target: "both", adapters: { codex: missing, claude: unsupported } });

  assert.equal(result.outcomes.codex.error.code, "TARGET_RUNTIME_MISSING");
  assert.equal(result.outcomes.claude.error.code, "TARGET_RUNTIME_UNSUPPORTED");
});

test("both reports a render failure and still installs the independent target", async (t) => {
  const directory = await fixture(t);
  const codex = adapter(directory, "codex", { render: () => { throw new Error("render failed"); } });
  const claude = adapter(directory, "claude");

  const result = await installRouting(contract, { target: "both", adapters: { codex, claude } });

  assert.equal(result.outcomes.codex.status, "failed");
  assert.equal(result.outcomes.codex.error.code, "INSTALL_FAILED");
  assert.equal(result.outcomes.claude.status, "installed");
});

test("a last-hook concurrent edit is retained instead of being overwritten", async (t) => {
  const directory = await fixture(t);
  const codex = adapter(directory, "codex");
  await writeFile(codex.instructionPath, "before\n");

  const result = await installRouting(contract, {
    target: "codex",
    adapters: { codex },
    hooks: { beforeCommit: () => writeFile(codex.instructionPath, "late edit\n") },
  });

  assert.equal(result.outcomes.codex.error.code, "TARGET_CONTENT_CHANGED");
  assert.equal(result.outcomes.codex.diff.instruction.before, "before\n");
  assert.equal(await readFile(codex.instructionPath, "utf8"), "late edit\n");
});

test("persists target-local backup files and a manifest before replacing files", async (t) => {
  const directory = await fixture(t);
  const codex = adapter(directory, "codex");
  await writeFile(codex.instructionPath, "before\n");
  await writeFile(codex.generatedPath, "old generated\n");

  const result = await installRouting(contract, { target: "codex", adapters: { codex } });
  const manifest = result.outcomes.codex.manifest;

  assert.match(manifest.path, /manifest\.json$/);
  assert.deepEqual(JSON.parse(await readFile(manifest.path, "utf8")), manifest);
  for (const backup of manifest.backups) {
    assert.match(backup.path, /backup$/);
    assert.match(backup.hash, /^[a-f0-9]{64}$/);
    assert.equal(typeof backup.timestamp, "string");
    assert.equal(typeof await readFile(backup.path, "utf8"), "string");
  }
});

test("uninstall restores its target when the generated-file commit fails", async (t) => {
  const directory = await fixture(t);
  const codex = adapter(directory, "codex");
  await installRouting(contract, { target: "codex", adapters: { codex } });
  const instruction = await readFile(codex.instructionPath, "utf8");
  const generated = await readFile(codex.generatedPath, "utf8");

  const result = await uninstallRouting({
    target: "codex",
    adapters: { codex },
    hooks: { interruptAfterInstructionCommit: true },
  });

  assert.equal(result.outcomes.codex.status, "failed");
  assert.equal(await readFile(codex.instructionPath, "utf8"), instruction);
  assert.equal(await readFile(codex.generatedPath, "utf8"), generated);
});

test("both uninstalls the independent target when one uninstall rolls back", async (t) => {
  const directory = await fixture(t);
  const codex = adapter(directory, "codex");
  const claude = adapter(directory, "claude");
  await installRouting(contract, { target: "both", adapters: { codex, claude } });
  const claudeInstruction = await readFile(claude.instructionPath, "utf8");
  const claudeGenerated = await readFile(claude.generatedPath, "utf8");
  claude.failurePoint = "afterInstructionCommit";

  const result = await uninstallRouting({ target: "both", adapters: { codex, claude } });

  assert.equal(result.outcomes.codex.status, "uninstalled");
  assert.equal(result.outcomes.claude.status, "failed");
  await assert.rejects(access(codex.generatedPath));
  assert.equal(await readFile(claude.instructionPath, "utf8"), claudeInstruction);
  assert.equal(await readFile(claude.generatedPath, "utf8"), claudeGenerated);
});

test("preserves user file permissions through install, rollback, and uninstall", async (t) => {
  const directory = await fixture(t);
  const codex = adapter(directory, "codex");
  await writeFile(codex.instructionPath, "before\n");
  await chmod(codex.instructionPath, 0o600);

  await installRouting(contract, { target: "codex", adapters: { codex } });
  assert.equal((await stat(codex.instructionPath)).mode & 0o777, 0o600);
  await uninstallRouting({ target: "codex", adapters: { codex } });
  assert.equal((await stat(codex.instructionPath)).mode & 0o777, 0o600);
  await installRouting(contract, {
    target: "codex",
    adapters: { codex },
    hooks: { interruptAfterInstructionCommit: true },
  });
  assert.equal((await stat(codex.instructionPath)).mode & 0o777, 0o600);
});

test("recovers a persisted target manifest after an interrupted first replacement", async (t) => {
  const directory = await fixture(t);
  const codex = adapter(directory, "codex", { failurePoint: "leaveAfterInstructionCommit" });
  await writeFile(codex.instructionPath, "before\n");
  await writeFile(codex.generatedPath, "generated before\n");

  const interrupted = await installRouting(contract, { target: "codex", adapters: { codex } });
  assert.equal(interrupted.outcomes.codex.error.code, "INTERRUPTED_FOR_RECOVERY");
  assert.match(await readFile(codex.instructionPath, "utf8"), /ORBITLANE:START codex/);

  const recovered = await recoverRouting({ manifest: interrupted.outcomes.codex.manifest });

  assert.equal(recovered.status, "recovered");
  assert.equal(await readFile(codex.instructionPath, "utf8"), "before\n");
  assert.equal(await readFile(codex.generatedPath, "utf8"), "generated before\n");
});

test("staged-content tampering at beforeCommit fails only that target and preserves its destination", async (t) => {
  const directory = await fixture(t);
  const codex = adapter(directory, "codex");
  const claude = adapter(directory, "claude");
  await writeFile(codex.instructionPath, "codex original\n");

  const result = await installRouting(contract, {
    target: "both",
    adapters: { codex, claude },
    hooks: { beforeCommit: async ({ target, manifest }) => {
      if (target === "codex") await writeFile(join(dirname(manifest.path), "instruction.stage"), "tampered stage\n");
    } },
  });

  assert.equal(result.outcomes.codex.status, "failed");
  assert.equal(result.outcomes.codex.error.code, "STAGED_CONTENT_CHANGED");
  assert.equal(result.outcomes.codex.diff.instruction.before, "codex original\n");
  assert.equal(await readFile(codex.instructionPath, "utf8"), "codex original\n");
  assert.equal(result.outcomes.claude.status, "installed");
});

test("recovers a true partially committed transaction after a terminated subprocess", async (t) => {
  const directory = await fixture(t);
  const codex = adapter(directory, "codex");
  await writeFile(codex.instructionPath, "before\n");
  await writeFile(codex.generatedPath, "generated before\n");
  const script = join(directory, "interrupt.mjs");
  await writeFile(script, `
    import { installRouting } from ${JSON.stringify(new URL("../../src/installer/index.js", import.meta.url).href)};
    const adapter = ${JSON.stringify({ ...codex, failurePoint: "terminateAfterInstructionCommit" })};
    adapter.supportsVersion = () => true;
    adapter.render = () => ({ policy: "codex policy", generated: "generated after" });
    await installRouting({ contract_version: "1.0.0" }, { target: "codex", adapters: { codex: adapter } });
  `);

  await assert.rejects(execFileAsync(process.execPath, [script]));
  assert.match(await readFile(codex.instructionPath, "utf8"), /ORBITLANE:START codex/);
  const transaction = (await readdir(directory, { withFileTypes: true })).find((entry) => entry.isDirectory() && entry.name.startsWith(".orbitlane-codex-"));
  const recovered = await recoverRouting({ manifest: { path: join(directory, transaction.name, "manifest.json") } });

  assert.equal(recovered.status, "recovered");
  assert.equal(await readFile(codex.instructionPath, "utf8"), "before\n");
  assert.equal(await readFile(codex.generatedPath, "utf8"), "generated before\n");
});

test("recovery rejects corrupt backup or invalid manifest without mutating destinations", async (t) => {
  const directory = await fixture(t);
  const codex = adapter(directory, "codex", { failurePoint: "leaveAfterInstructionCommit" });
  await writeFile(codex.instructionPath, "before\n");
  await writeFile(codex.generatedPath, "generated before\n");
  const interrupted = await installRouting(contract, { target: "codex", adapters: { codex } });
  const manifest = interrupted.outcomes.codex.manifest;
  await writeFile(manifest.backups[0].path, "corrupt backup\n");
  const currentInstruction = await readFile(codex.instructionPath, "utf8");
  const currentGenerated = await readFile(codex.generatedPath, "utf8");

  const corrupted = await recoverRouting({ manifest });
  const invalid = await recoverRouting({ manifest: { path: join(directory, "invalid.json") } });

  assert.equal(corrupted.status, "failed");
  assert.equal(corrupted.error.code, "RECOVERY_INVALID");
  assert.equal(invalid.status, "failed");
  assert.equal(invalid.error.code, "RECOVERY_INVALID");
  assert.equal(await readFile(codex.instructionPath, "utf8"), currentInstruction);
  assert.equal(await readFile(codex.generatedPath, "utf8"), currentGenerated);
});

test("recovery leaves an aborted pre-commit transaction and its concurrent edit untouched", async (t) => {
  const directory = await fixture(t);
  const codex = adapter(directory, "codex");
  await writeFile(codex.instructionPath, "before\n");

  const failed = await installRouting(contract, {
    target: "codex",
    adapters: { codex },
    hooks: { beforeCommit: () => writeFile(codex.instructionPath, "late user edit\n") },
  });
  const recovered = await recoverRouting({ manifest: failed.outcomes.codex.manifest });

  assert.equal(failed.outcomes.codex.error.code, "TARGET_CONTENT_CHANGED");
  assert.equal(recovered.status, "aborted");
  assert.equal(await readFile(codex.instructionPath, "utf8"), "late user edit\n");
});

test("recovery leaves a rolled-back transaction and later user edit untouched", async (t) => {
  const directory = await fixture(t);
  const codex = adapter(directory, "codex");
  await writeFile(codex.instructionPath, "before\n");
  const failed = await installRouting(contract, {
    target: "codex",
    adapters: { codex },
    hooks: { interruptAfterInstructionCommit: true },
  });
  await writeFile(codex.instructionPath, "later user edit\n");

  const recovered = await recoverRouting({ manifest: failed.outcomes.codex.manifest });

  assert.equal(failed.outcomes.codex.error.code, "INSTALL_INTERRUPTED");
  assert.equal(recovered.status, "rolled_back");
  assert.equal(await readFile(codex.instructionPath, "utf8"), "later user edit\n");
});

test("a second recovery is terminal and leaves a later user edit untouched", async (t) => {
  const directory = await fixture(t);
  const codex = adapter(directory, "codex", { failurePoint: "leaveAfterInstructionCommit" });
  await writeFile(codex.instructionPath, "before\n");
  await writeFile(codex.generatedPath, "generated before\n");
  const interrupted = await installRouting(contract, { target: "codex", adapters: { codex } });

  const first = await recoverRouting({ manifest: interrupted.outcomes.codex.manifest });
  await writeFile(codex.instructionPath, "later user edit\n");
  const second = await recoverRouting({ manifest: interrupted.outcomes.codex.manifest });

  assert.equal(first.status, "recovered");
  assert.equal(second.status, "recovered");
  assert.equal(await readFile(codex.instructionPath, "utf8"), "later user edit\n");
});
