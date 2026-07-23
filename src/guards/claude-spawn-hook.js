import { RESOLVER_POLICY_VERSION, resolveEffectiveContract } from "./resolve-contract.js";
import { runClaudeSpawnGuard } from "./claude-spawn.js";

const decodeArgument = (value) => typeof value === "string" && value.startsWith("base64:")
  ? Buffer.from(value.slice("base64:".length), "base64").toString("utf8")
  : value;

const [claudeConfigDir, evidencePath] = process.argv.slice(2).map(decodeArgument);

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
      const scope = error.scope ?? "global";
      const remedy = scope === "project"
        ? "reinstall this project: orbitlane install --target claude --contract <path>"
        : "reinstall the global layer: orbitlane install --global --target claude --contract <path>";
      process.stderr.write(`${error.code ?? "GUARD_ERROR"} selected_scope=${scope} report_path=${error.reportPath ?? "unknown"} remedy=${remedy}\n`);
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
      if (result.exitCode === 2) process.stderr.write(`${result.reason} selected_scope=${resolved.scope} report_path=${resolved.reportPath}\n`);
      process.exitCode = result.exitCode;
    }
  }
}
