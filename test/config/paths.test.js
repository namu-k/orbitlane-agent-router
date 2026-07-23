import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import { resolveTargetPaths } from "../../src/config/paths.js";

const homedir = () => join("/", "home", "fixture");

// resolveTargetPaths resolves every root, and on Windows that prepends the current
// drive to a root-relative fixture path. Expectations go through the same call.
const abs = (...parts) => resolve(join(...parts));

test("project mode keeps the existing single-root layout", () => {
  const paths = resolveTargetPaths({ configRoot: join("/", "repo"), env: {}, homedir });

  assert.equal(paths.codex.instructionPath, abs("/", "repo", "AGENTS.md"));
  assert.equal(paths.codex.generatedPath, abs("/", "repo", ".orbitlane", "codex-report.json"));
  assert.equal(paths.claude.instructionPath, abs("/", "repo", "CLAUDE.md"));
  assert.equal(paths.claude.settingsPath, abs("/", "repo", ".claude", "settings.json"));
});

test("project mode falls back to cwd when no config root is given", () => {
  const paths = resolveTargetPaths({ env: {}, homedir, cwd: () => join("/", "work") });

  assert.equal(paths.claude.instructionPath, abs("/", "work", "CLAUDE.md"));
});

test("global mode resolves each runtime home and flattens Claude settings", () => {
  const paths = resolveTargetPaths({ global: true, env: {}, homedir });

  assert.equal(paths.codex.instructionPath, abs("/", "home", "fixture", ".codex", "AGENTS.md"));
  assert.equal(paths.claude.instructionPath, abs("/", "home", "fixture", ".claude", "CLAUDE.md"));
  assert.equal(paths.claude.settingsPath, abs("/", "home", "fixture", ".claude", "settings.json"));
});

test("global mode honours CODEX_HOME and CLAUDE_CONFIG_DIR", () => {
  const env = { CODEX_HOME: join("/", "custom", "codex"), CLAUDE_CONFIG_DIR: join("/", "custom", "claude") };
  const paths = resolveTargetPaths({ global: true, env, homedir });

  assert.equal(paths.codex.instructionPath, abs("/", "custom", "codex", "AGENTS.md"));
  assert.equal(paths.claude.settingsPath, abs("/", "custom", "claude", "settings.json"));
  assert.equal(paths.claude.generatedPath, abs("/", "custom", "claude", ".orbitlane", "claude-report.json"));
});

test("global mode refuses an explicit config root", () => {
  assert.throws(
    () => resolveTargetPaths({ global: true, configRoot: join("/", "repo"), env: {}, homedir }),
    (error) => error.code === "GLOBAL_CONFLICTS_CONFIG_ROOT",
  );
});

test("global mode treats an empty or blank runtime home as unset", () => {
  for (const blank of ["", "   ", "\t\n"]) {
    const paths = resolveTargetPaths({ global: true, env: { CODEX_HOME: blank, CLAUDE_CONFIG_DIR: blank }, homedir });

    assert.equal(paths.codex.root, abs("/", "home", "fixture", ".codex"));
    assert.equal(paths.claude.settingsPath, abs("/", "home", "fixture", ".claude", "settings.json"));
  }
});

test("global mode refuses a relative runtime home instead of anchoring it to cwd", () => {
  for (const env of [{ CODEX_HOME: "codex-home" }, { CLAUDE_CONFIG_DIR: "../claude" }, { CODEX_HOME: "~/.codex" }]) {
    assert.throws(
      () => resolveTargetPaths({ global: true, env, homedir }),
      (error) => error.code === "GLOBAL_HOME_NOT_ABSOLUTE",
    );
  }
});

test("a broken override for one runtime does not fail the other target", () => {
  const env = { CODEX_HOME: "relative-codex", CLAUDE_CONFIG_DIR: join("/", "custom", "claude") };

  const claudeOnly = resolveTargetPaths({ global: true, env, homedir, targets: ["claude"] });
  assert.equal(claudeOnly.claude.settingsPath, abs("/", "custom", "claude", "settings.json"));

  assert.throws(
    () => resolveTargetPaths({ global: true, env, homedir, targets: ["codex"] }),
    (error) => error.code === "GLOBAL_HOME_NOT_ABSOLUTE",
  );
});
