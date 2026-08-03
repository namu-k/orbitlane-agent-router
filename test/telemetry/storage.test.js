import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test from "node:test";

import { FILE_MODE_ENFORCED, appendJsonl, readJsonl, readPrivateFile } from "../../src/telemetry/storage.js";

// Every call names the temporary root it just created as its trust anchor. Nothing above
// that is ours to vouch for, and on macOS it is reached through /var -> /private/var.
const temporaryRoot = () => mkdtemp(join(tmpdir(), "orbitlane-telemetry-"));
const unenforcedMode = FILE_MODE_ENFORCED ? false : "chmod does not set POSIX mode bits on Windows";

test("appendJsonl writes private JSONL and readJsonl diagnoses corrupt and partial lines", async () => {
  const trustedBase = await temporaryRoot();
  const path = join(trustedBase, "evidence/events.jsonl");
  assert.deepEqual(await appendJsonl(path, { event_id: "one" }, { trustedBase }), { written: true });
  await writeFile(path, `${await readFile(path, "utf8")}{bad}\n{\"event_id\":\"partial\"`, "utf8");

  const result = await readJsonl(path, { trustedBase });
  assert.deepEqual(result.records, [{ event_id: "one" }]);
  assert.deepEqual(result.corrupt_lines, [2]);
  assert.equal(result.partial_last_line, true);
});

test("appendJsonl creates owner-only evidence", { skip: unenforcedMode }, async () => {
  const trustedBase = await temporaryRoot();
  const path = join(trustedBase, "evidence/events.jsonl");
  assert.deepEqual(await appendJsonl(path, { event_id: "one" }, { trustedBase }), { written: true });
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal((await lstat(dirname(path))).mode & 0o777, 0o700);
});

test("appendJsonl refuses symlinks and safely withdraws telemetry on write failure", async () => {
  const trustedBase = await temporaryRoot();
  const target = join(trustedBase, "target.jsonl");
  await writeFile(target, "", "utf8");
  const link = join(trustedBase, "evidence-link.jsonl");
  await symlink(target, link);
  assert.deepEqual(await appendJsonl(link, { event_id: "one" }, { trustedBase }), { written: false });

  const directory = join(trustedBase, "directory-target");
  await mkdir(directory);
  assert.deepEqual(await appendJsonl(directory, { event_id: "two" }, { trustedBase }), { written: false });
});

test("read and append refuse a symlink below the trusted base", async () => {
  const trustedBase = await temporaryRoot();
  const target = join(trustedBase, "target");
  const linked = join(trustedBase, "linked");
  await mkdir(target);
  await symlink(target, linked);
  const path = [linked, "nested", "events.jsonl"].join(sep);

  assert.deepEqual(await appendJsonl(path, { event_id: "one" }, { trustedBase }), { written: false });
  await assert.rejects(readJsonl(path, { trustedBase }), /UNSAFE_TELEMETRY_PATH/);
});

test("a target escaping the trusted base is refused", async () => {
  const trustedBase = await temporaryRoot();
  const outside = join(trustedBase, "..", "orbitlane-escape.jsonl");
  assert.deepEqual(await appendJsonl(outside, { event_id: "one" }, { trustedBase }), { written: false });
  await assert.rejects(readJsonl(outside, { trustedBase }), /UNSAFE_TELEMETRY_PATH/);
});

test("private reader refuses symlinks and reads the secret back", async () => {
  const secret = join(await temporaryRoot(), "telemetry-hmac.key");
  await writeFile(secret, "key", { mode: 0o600 });
  assert.equal((await readPrivateFile(secret)).toString("utf8"), "key");
  const link = join(dirname(secret), "key-link"); await symlink(secret, link);
  await assert.rejects(readPrivateFile(link), /UNSAFE_TELEMETRY_PATH/);
});

test("private reader refuses group/world-readable secrets", { skip: unenforcedMode }, async () => {
  const secret = join(await temporaryRoot(), "telemetry-hmac.key");
  await writeFile(secret, "key", { mode: 0o644 });
  await assert.rejects(readPrivateFile(secret), /UNSAFE_TELEMETRY_PERMISSIONS/);
});
