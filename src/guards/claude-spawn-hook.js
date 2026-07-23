import { RESOLVER_POLICY_VERSION, resolveEffectiveContract } from "./resolve-contract.js";
import { runClaudeSpawnGuard } from "./claude-spawn.js";

const decodeArgument = (value) => typeof value === "string" && value.startsWith("base64:")
  ? Buffer.from(value.slice("base64:".length), "base64").toString("utf8")
  : value;

const [claudeConfigDir, evidencePath, installedScopeArgument] = process.argv.slice(2).map(decodeArgument);

// Which layer installed this hook. Distinct from the scope the resolver selects at
// run time: a project hook whose own report is gone falls back to "global" selection
// but still needs a project reinstall. Absent for hooks installed before this became
// part of the argument contract.
const installedScope = installedScopeArgument === "project" || installedScopeArgument === "global" ? installedScopeArgument : undefined;

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
      const result = await runClaudeSpawnGuard({
        input: { ...(payload.tool_input ?? payload), environment_model: process.env.CLAUDE_CODE_SUBAGENT_MODEL },
        contract: resolved.contract,
        runtimeDefaults: resolved.runtimeDefaults,
        evidencePath,
        correlationId: payload.tool_use_id ?? null,
        scope: resolved.scope,
        contractSha256: resolved.contractSha256,
        reportPath: resolved.reportPath,
        resolverPolicyVersion: RESOLVER_POLICY_VERSION,
      });
      if (result.exitCode === 2) process.stderr.write(`${result.reason} selected_scope=${resolved.scope} installed_scope=${installedScope ?? "unknown"} report_path=${resolved.reportPath}\n`);
      process.exitCode = result.exitCode;
    }
  }
}
