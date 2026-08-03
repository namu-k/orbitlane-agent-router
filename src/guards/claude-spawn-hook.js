import { RESOLVER_POLICY_VERSION, resolveEffectiveContract } from "./resolve-contract.js";
import { runClaudeSpawnGuard } from "./claude-spawn.js";
import { readPrivateFile } from "../telemetry/storage.js";
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";

const decodeArgument = (value) => typeof value === "string" && value.startsWith("base64:")
  ? Buffer.from(value.slice("base64:".length), "base64").toString("utf8")
  : value;

const [claudeConfigDir, evidencePath, installedScopeArgument, telemetryRoot, collectorInstanceRef] = process.argv.slice(2).map(decodeArgument);

// Which layer installed this hook. Distinct from the scope the resolver selects at
// run time: a project hook whose own report is gone falls back to "global" selection
// but still needs a project reinstall. Absent for hooks installed before this became
// part of the argument contract.
const installedScope = installedScopeArgument === "project" || installedScopeArgument === "global" ? installedScopeArgument : undefined;

// Anchors the symlink walk over the evidence path. An install puts the file under the
// config root, which lets every segment below it be checked; but the argv contract admits
// a path anywhere, and there the file's own directory is the deepest honest anchor.
// Refusing the spawn instead would cost a failed turn to defend a path the caller chose.
function telemetryAnchor() {
  if (typeof claudeConfigDir !== "string" || claudeConfigDir.length === 0) return dirname(evidencePath);
  const rest = relative(resolvePath(claudeConfigDir), resolvePath(evidencePath));
  const inside = rest.length > 0 && !isAbsolute(rest) && !rest.split(sep).includes("..");
  return inside ? claudeConfigDir : dirname(evidencePath);
}

const input = await new Promise((resolve, reject) => {
  let body = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { body += chunk; });
  process.stdin.on("end", () => resolve(body));
  process.stdin.on("error", reject);
});

let payload;
try {
  payload = JSON.parse(input);
} catch {
  process.stderr.write("INVALID_HOOK_PAYLOAD\n");
  process.exitCode = 2;
  payload = undefined;
}

if (payload !== undefined) {
  if (payload.tool_name !== "Agent") {
    process.exitCode = 0;
  } else {
    let resolved;
    try {
      resolved = await resolveEffectiveContract({ cwd: process.cwd(), claudeConfigDir });
    } catch (error) {
      const selectedScope = error.scope ?? "global";
      const remedyScope = selectedScope === "project" || installedScope === "project" ? "project" : "global";
      const remedy = remedyScope === "project"
        ? "reinstall this project: orbitlane install --target claude --contract <path>"
        : "reinstall the global layer: orbitlane install --global --target claude --contract <path>";
      process.stderr.write(`${error.code ?? "GUARD_ERROR"} selected_scope=${selectedScope} installed_scope=${installedScope ?? "unknown"} report_path=${error.reportPath ?? "unknown"} remedy=${remedy}\n`);
      process.exitCode = 2;
      resolved = undefined;
    }
    if (resolved !== undefined) {
      // An unreadable key withholds every event downstream, so it cannot stay silent:
      // without it decisionEvent refuses to build an event at all and the guard records
      // nothing, which reads on disk exactly like a session that never spawned an agent.
      let telemetryKey;
      try {
        telemetryKey = await readPrivateFile(join(claudeConfigDir, ".orbitlane", "secrets", "telemetry-hmac.key"));
      } catch (error) {
        if (error?.code !== "ENOENT") process.stderr.write(`TELEMETRY_KEY_UNREADABLE reason=${error?.message ?? error?.code ?? "unknown"}\n`);
      }
      const result = await runClaudeSpawnGuard({
        input: { ...(payload.tool_input ?? payload), environment_model: process.env.CLAUDE_CODE_SUBAGENT_MODEL },
        contract: resolved.contract,
        runtimeDefaults: resolved.runtimeDefaults,
        scope: resolved.scope,
        contractSha256: resolved.contractSha256,
        policyProvenance: resolved.policyProvenance,
        resolverPolicyVersion: RESOLVER_POLICY_VERSION,
        telemetryRoot: evidencePath,
        telemetryBase: telemetryAnchor(),
        collectorInstanceRef,
        telemetryKey,
        identifiers: { session: payload.session_id, turn: payload.turn_id, invocation: payload.tool_use_id },
      });
      if (result.exitCode === 2) process.stderr.write(`${result.reason} selected_scope=${resolved.scope} installed_scope=${installedScope ?? "unknown"} report_path=${resolved.reportPath}\n`);
      else if (typeof result.injected_model === "string") {
        // The caller left the model open, so the contract fills it in. Rewriting the
        // input is the only point at which OrbitLane changes what actually runs; it
        // is built from the real tool input, never from the guard's synthesised view.
        process.stdout.write(`${JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            permissionDecisionReason: `ORBITLANE ${result.reason}: ${payload.tool_input?.subagent_type} -> ${result.injected_model}`,
            updatedInput: { ...(payload.tool_input ?? {}), model: result.injected_model },
          },
        })}\n`);
      }
      process.exitCode = result.exitCode;
    }
  }
}
