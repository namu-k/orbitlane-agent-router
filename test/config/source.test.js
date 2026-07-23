import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadJsonSource } from "../../src/config/source.js";
import { snapshotDigest } from "../../src/config/snapshots.js";

test("the parsed value always comes from the bytes that were returned", async () => {
  const contents = [`${JSON.stringify({ generation: 1 })}\n`, `${JSON.stringify({ generation: 2 })}\n`];
  let reads = 0;
  const readFile = async () => contents[reads++] ?? contents.at(-1);

  const source = await loadJsonSource("/contract.json", { readFile });

  assert.equal(reads, 1);
  assert.deepEqual(source.value, JSON.parse(source.bytes));
  assert.equal(snapshotDigest(source.bytes), snapshotDigest(`${JSON.stringify({ generation: source.value.generation })}\n`));
});

test("a real file round-trips its bytes and its value", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "orbitlane-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "contract.json");
  await writeFile(path, `${JSON.stringify({ contract_version: "1.0.0" })}\n`, "utf8");

  const source = await loadJsonSource(path);

  assert.equal(source.value.contract_version, "1.0.0");
  assert.equal(source.bytes, `${JSON.stringify({ contract_version: "1.0.0" })}\n`);
});

test("invalid JSON fails before anything is hashed", async () => {
  await assert.rejects(loadJsonSource("/contract.json", { readFile: async () => "{not json" }), SyntaxError);
});
