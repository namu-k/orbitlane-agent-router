#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClaudeTier1Adapter } from "../src/adapters/claude/index.js";
import { createCodexTier1Adapter } from "../src/adapters/codex/index.js";
import { installRouting, previewRouting, recoverRouting, uninstallRouting } from "../src/installer/index.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = new Set(["codex", "claude", "both"]);

function usage() {
  return "Usage: orbitlane <install|uninstall|recover> --target <codex|claude|both> --contract <path> [--config-root <path>] [--runtime-defaults <path>] [--dry-run]";
}

function parse(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) return Object.freeze({ command: "help" });
  const [command = "install", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--dry-run") options.dryRun = true;
    else if (["--target", "--contract", "--config-root", "--runtime-defaults", "--manifest"].includes(token)) options[token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = rest[++index];
    else throw new TypeError(`UNKNOWN_OPTION: ${token}`);
  }
  if (!["install", "uninstall", "recover"].includes(command)) throw new TypeError(`UNKNOWN_COMMAND: ${command}`);
  if (command !== "recover" && !targets.has(options.target)) throw new TypeError("TARGET_REQUIRED: codex, claude, or both");
  if (command !== "recover" && typeof options.contract !== "string") throw new TypeError("CONTRACT_REQUIRED");
  if (command === "recover" && typeof options.manifest !== "string") throw new TypeError("MANIFEST_REQUIRED");
  return Object.freeze({ command, ...options });
}

async function json(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

function quoteShellArgument(value) {
  if (process.platform === "win32") return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\*)$/, "$1$1")}"`;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function encodedArgument(value) {
  return `base64:${Buffer.from(value, "utf8").toString("base64")}`;
}

function guardCommand(...parts) {
  return parts.map((part, index) => quoteShellArgument(index < 2 ? part : encodedArgument(part))).join(" ");
}

function failedAdapter(error, paths) {
  return Object.freeze({ ...paths, render: () => { throw error; } });
}

function adapters(contract, options) {
  const root = resolve(options.configRoot ?? process.cwd());
  const runtimeDefaults = options.runtimeDefaults === undefined ? undefined : options.runtimeDefaults;
  const generated = join(root, ".orbitlane");
  const codexPaths = { instructionPath: join(root, "AGENTS.md"), generatedPath: join(generated, "codex-report.json") };
  const claudePaths = { instructionPath: join(root, "CLAUDE.md"), generatedPath: join(generated, "claude-report.json"), settingsPath: join(root, ".claude", "settings.json") };
  const selected = options.target === "both" ? ["codex", "claude"] : [options.target];
  const result = {};
  if (selected.includes("codex")) {
    try { result.codex = createCodexTier1Adapter(contract, { ...codexPaths, runtimeDefaults }); } catch (error) { result.codex = failedAdapter(error, codexPaths); }
  }
  if (selected.includes("claude")) {
    try {
      result.claude = createClaudeTier1Adapter(contract, {
        ...claudePaths,
        spawnGuardCommand: guardCommand(process.execPath, join(PACKAGE_ROOT, "src", "guards", "claude-spawn-hook.js"), resolve(options.contract), join(generated, "claude-heartbeats.jsonl"), ...(options.runtimeDefaultsPath === undefined ? [] : [options.runtimeDefaultsPath])),
        runtimeDefaults,
      });
    } catch (error) { result.claude = failedAdapter(error, claudePaths); }
  }
  return Object.freeze(result);
}

function exitCode(report) {
  if (report?.status === "failed") return 2;
  const outcomes = Object.values(report.outcomes ?? {});
  const failures = outcomes.filter((outcome) => outcome.status === "failed").length;
  return failures === 0 ? 0 : failures === outcomes.length ? 2 : 1;
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.command === "help") return null;
  if (options.command === "recover") return recoverRouting({ manifest: { path: resolve(options.manifest) } });
  const contract = await json(options.contract);
  const runtimeDefaults = options.runtimeDefaults === undefined ? undefined : await json(options.runtimeDefaults);
  const targetAdapters = adapters(contract, { ...options, runtimeDefaults, runtimeDefaultsPath: options.runtimeDefaults === undefined ? undefined : resolve(options.runtimeDefaults) });
  if (options.command === "uninstall") return uninstallRouting({ target: options.target, adapters: targetAdapters });
  return options.dryRun ? previewRouting(contract, { target: options.target, adapters: targetAdapters }) : installRouting(contract, { target: options.target, adapters: targetAdapters });
}

try {
  const report = await main();
  if (report === null) process.stdout.write(`${usage()}\n`);
  else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = exitCode(report);
  }
} catch (error) {
  process.stderr.write(`${error.code ?? "CLI_ERROR"}: ${error.message}\n${usage()}\n`);
  process.exitCode = 2;
}
