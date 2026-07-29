import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test from "node:test";

import { appendJsonl, readJsonl } from "../../src/telemetry/storage.js";

const temporaryPath = async (name) => join(await mkdtemp(join(tmpdir(), "orbitlane-telemetry-")), name);

test("appendJsonl writes private JSONL and readJsonl diagnoses corrupt and partial lines", async () => {
  const path = await temporaryPath("evidence/events.jsonl");
  assert.deepEqual(await appendJsonl(path, { event_id: "one" }), { written: true });
  await writeFile(path, `${await readFile(path, "utf8")}{bad}\n{\"event_id\":\"partial\"`, "utf8");

  const result = await readJsonl(path);
  assert.deepEqual(result.records, [{ event_id: "one" }]);
  assert.deepEqual(result.corrupt_lines, [2]);
  assert.equal(result.partial_last_line, true);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal((await lstat(dirname(path))).mode & 0o777, 0o700);
});

test("appendJsonl refuses symlinks and safely withdraws telemetry on write failure", async () => {
  const target = await temporaryPath("target.jsonl");
  await writeFile(target, "", "utf8");
  const link = join(dirname(target), "evidence-link.jsonl");
  await symlink(target, link);
  assert.deepEqual(await appendJsonl(link, { event_id: "one" }), { written: false });

  const directory = await temporaryPath("directory-target");
  await mkdir(directory);
  assert.deepEqual(await appendJsonl(directory, { event_id: "two" }), { written: false });
});

test("read and append refuse a symlink in a nested ancestor", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbitlane-telemetry-"));
  const target = join(root, "target");
  const linked = join(root, "linked");
  await mkdir(target);
  await symlink(target, linked);
  const path = [linked, "nested", "events.jsonl"].join(sep);

  assert.deepEqual(await appendJsonl(path, { event_id: "one" }), { written: false });
  await assert.rejects(readJsonl(path), /UNSAFE_TELEMETRY_PATH/);
});
