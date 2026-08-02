import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { fixtureEnvironment, invokeEstimate } from "./e2e.test.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("offline report excludes fixture content, identifiers, and filesystem locations", async (t) => {
  const { project, env } = await fixtureEnvironment(t);
  const output = join(project, "report.json");
  const result = await invokeEstimate(["--runtime", "auto", "--session", "latest", "--baseline-model", "sol", "--output", output], { cwd: project, env });
  assert.equal(result.code, 0, result.stderr);
  const text = await readFile(output, "utf8");
  const homePattern = ["", "home", ""].join("/");
  for (const forbidden of ["root-1", "child-terra", "child-luna", resolve(project), env.CODEX_HOME, "fixtures/estimate", homePattern]) {
    assert.doesNotMatch(text, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `report contains ${forbidden}`);
  }
});

test("hostile rollout fields cannot escape into an offline report", async (t) => {
  const { project, env } = await fixtureEnvironment(t);
  const output = join(project, "report.json");
  const homePattern = ["", "home", "fixture-user"].join("/");
  await writeFile(join(env.CODEX_HOME, "sessions", "hostile.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "hostile-child", parent_thread_id: "root-1", thread_source: "subagent", cli_version: homePattern } })}\n${JSON.stringify({ type: "turn_context", payload: { model: homePattern } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 0, total_tokens: 1 } }, prompt: "fixture-prompt", response: "fixture-response" } })}\n`);
  const result = await invokeEstimate(["--runtime", "auto", "--session", "latest", "--baseline-model", "sol", "--output", output], { cwd: project, env });
  assert.equal(result.code, 0, result.stderr);
  const text = await readFile(output, "utf8");
  for (const forbidden of [homePattern, "hostile-child", "fixture-prompt", "fixture-response"]) assert.doesNotMatch(text, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("estimator source stays offline and does not load network, subprocess, SDK, or exporter surfaces", async () => {
  const sourceDirectory = join(root, "src", "estimate");
  const files = (await readdir(sourceDirectory)).filter((name) => name.endsWith(".js"));
  const source = await Promise.all(files.map((name) => readFile(join(sourceDirectory, name), "utf8")));
  const all = source.join("\n");
  assert.doesNotMatch(all, /node:(?:http|https|child_process)/);
  assert.doesNotMatch(all, /\bfetch\s*\(/);
  assert.doesNotMatch(all, /(?:@anthropic-ai|openai|otel|opentelemetry|exporter)/i);
});
