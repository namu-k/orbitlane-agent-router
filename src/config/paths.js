import { homedir as osHomedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// A blank override is an unset override: `resolve("")` is the current directory, so
// honouring it would turn a --global install into a stray write wherever the user
// happened to be standing. A relative override has the same failure mode silently.
function globalRoot(name, value, fallback) {
  if (typeof value !== "string" || value.trim().length === 0) return resolve(fallback);
  if (!isAbsolute(value)) {
    throw Object.assign(new Error(`GLOBAL_HOME_NOT_ABSOLUTE: ${name} must be an absolute path, got ${JSON.stringify(value)}`), { code: "GLOBAL_HOME_NOT_ABSOLUTE" });
  }
  return resolve(value);
}

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
  const codexRoot = globalRoot("CODEX_HOME", env.CODEX_HOME, join(home, ".codex"));
  const claudeRoot = globalRoot("CLAUDE_CONFIG_DIR", env.CLAUDE_CONFIG_DIR, join(home, ".claude"));
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
