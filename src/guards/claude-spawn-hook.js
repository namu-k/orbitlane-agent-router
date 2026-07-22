import { readFile } from "node:fs/promises";

import { runClaudeSpawnGuard } from "./claude-spawn.js";

const decodeArgument = (value) => typeof value === "string" && value.startsWith("base64:")
  ? Buffer.from(value.slice("base64:".length), "base64").toString("utf8")
  : value;
const [contractPath, evidencePath, runtimeDefaultsPath] = process.argv.slice(2).map(decodeArgument);
const input = await new Promise((resolve, reject) => {
  let body = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { body += chunk; });
  process.stdin.on("end", () => resolve(body));
  process.stdin.on("error", reject);
});

try {
  const payload = JSON.parse(input);
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const runtimeDefaults = runtimeDefaultsPath === undefined ? undefined : JSON.parse(await readFile(runtimeDefaultsPath, "utf8"));
  if (payload.tool_name !== "Agent") process.exit(0);
  const result = await runClaudeSpawnGuard({
    input: { ...(payload.tool_input ?? payload), environment_model: process.env.CLAUDE_CODE_SUBAGENT_MODEL },
    contract,
    runtimeDefaults,
    evidencePath,
    correlationId: payload.tool_use_id ?? null,
    now: () => new Date().toISOString(),
  });
  if (result.exitCode === 2) process.stderr.write(`${result.reason}\n`);
  process.exitCode = result.exitCode;
} catch {
  process.exitCode = 0;
}
