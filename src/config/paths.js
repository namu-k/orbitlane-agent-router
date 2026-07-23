import { homedir as osHomedir } from "node:os";
import { join, resolve } from "node:path";

function layout(root, settingsPath) {
  return Object.freeze({
    codex: Object.freeze({
      root,
      instructionPath: join(root, "AGENTS.md"),
      generatedPath: join(root, ".orbitlane", "codex-report.json"),
    }),
    claude: Object.freeze({
      root,
      instructionPath: join(root, "CLAUDE.md"),
      generatedPath: join(root, ".orbitlane", "claude-report.json"),
      settingsPath,
    }),
  });
}

export function resolveTargetPaths({ global = false, configRoot, env = process.env, homedir = osHomedir, cwd = process.cwd } = {}) {
  if (global && configRoot !== undefined) {
    throw Object.assign(new Error("GLOBAL_CONFLICTS_CONFIG_ROOT: --global cannot be combined with --config-root"), { code: "GLOBAL_CONFLICTS_CONFIG_ROOT" });
  }
  if (!global) {
    const root = resolve(configRoot ?? cwd());
    return layout(root, join(root, ".claude", "settings.json"));
  }
  const home = homedir();
  const codexRoot = resolve(env.CODEX_HOME ?? join(home, ".codex"));
  const claudeRoot = resolve(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"));
  const project = layout(claudeRoot, join(claudeRoot, "settings.json"));
  return Object.freeze({
    codex: Object.freeze({
      root: codexRoot,
      instructionPath: join(codexRoot, "AGENTS.md"),
      generatedPath: join(codexRoot, ".orbitlane", "codex-report.json"),
    }),
    claude: project.claude,
  });
}
