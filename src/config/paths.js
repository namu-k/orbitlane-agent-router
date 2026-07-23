import { homedir as osHomedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// A blank override is an unset override: `resolve("")` is the current directory, so
// honouring it would turn a --global install into a stray write wherever the user
// happened to be standing. A relative override has the same failure mode silently.
// `selected` keeps one runtime's broken override from failing the other: a bad
// CLAUDE_CONFIG_DIR must not stop `--target codex`.
function globalRoot(name, value, fallback, selected) {
  if (typeof value !== "string" || value.trim().length === 0) return resolve(fallback);
  if (!isAbsolute(value)) {
    if (!selected) return resolve(fallback);
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

export function resolveTargetPaths({ global = false, configRoot, env = process.env, homedir = osHomedir, cwd = process.cwd, targets = ["codex", "claude"] } = {}) {
  if (global && configRoot !== undefined) {
    throw Object.assign(new Error("GLOBAL_CONFLICTS_CONFIG_ROOT: --global cannot be combined with --config-root"), { code: "GLOBAL_CONFLICTS_CONFIG_ROOT" });
  }
  if (!global) {
    const root = resolve(configRoot ?? cwd());
    return layout(root, join(root, ".claude", "settings.json"));
  }
  const home = homedir();
  const codexRoot = globalRoot("CODEX_HOME", env.CODEX_HOME, join(home, ".codex"), targets.includes("codex"));
  const claudeRoot = globalRoot("CLAUDE_CONFIG_DIR", env.CLAUDE_CONFIG_DIR, join(home, ".claude"), targets.includes("claude"));
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
