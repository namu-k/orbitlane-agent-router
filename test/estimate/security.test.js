import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
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
  for (const forbidden of ["root-1", "child-terra", "child-luna", resolve(project), env.CODEX_HOME, "fixtures/estimate", "/home/"]) {
    assert.doesNotMatch(text, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `report contains ${forbidden}`);
  }
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
