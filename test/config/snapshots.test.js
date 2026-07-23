import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { planSnapshot, readVerifiedSnapshot, snapshotDigest, writeSnapshot } from "../../src/config/snapshots.js";

async function root(t) {
  const directory = await mkdtemp(join(tmpdir(), "orbitlane-snapshot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("planSnapshot derives a content-addressed path without touching disk", async (t) => {
  const directory = await root(t);
  const planned = planSnapshot(directory, "contracts", "{}\n");

  assert.equal(planned.sha256, snapshotDigest("{}\n"));
  assert.equal(planned.path, join(directory, ".orbitlane", "contracts", `${planned.sha256}.json`));
  await assert.rejects(readdir(join(directory, ".orbitlane")));
});

test("writeSnapshot stores content under its digest", async (t) => {
  const directory = await root(t);
  const written = await writeSnapshot(directory, "contracts", "{\"a\":1}\n");

  assert.equal(await readFile(written.path, "utf8"), "{\"a\":1}\n");
});

test("writeSnapshot is a no-op when identical content already exists", async (t) => {
  const directory = await root(t);
  const first = await writeSnapshot(directory, "contracts", "{\"a\":1}\n");
  const second = await writeSnapshot(directory, "contracts", "{\"a\":1}\n");

  assert.equal(second.path, first.path);
  assert.deepEqual(await readdir(join(directory, ".orbitlane", "contracts")), [`${first.sha256}.json`]);
});

test("writeSnapshot refuses a digest-named file whose bytes do not match", async (t) => {
  const directory = await root(t);
  const planned = planSnapshot(directory, "contracts", "{\"a\":1}\n");
  await writeSnapshot(directory, "contracts", "{\"a\":1}\n");
  await writeFile(planned.path, "tampered\n", "utf8");

  await assert.rejects(
    writeSnapshot(directory, "contracts", "{\"a\":1}\n"),
    (error) => error.code === "SNAPSHOT_HASH_MISMATCH",
  );
});

test("readVerifiedSnapshot rejects a missing or tampered snapshot", async (t) => {
  const directory = await root(t);
  const written = await writeSnapshot(directory, "runtime-defaults", "{\"b\":2}\n");

  assert.equal(await readVerifiedSnapshot(directory, "runtime-defaults", written.sha256), "{\"b\":2}\n");
  await assert.rejects(
    readVerifiedSnapshot(directory, "runtime-defaults", "0".repeat(64)),
    (error) => error.code === "SNAPSHOT_UNREADABLE",
  );

  await writeFile(written.path, "tampered\n", "utf8");
  await assert.rejects(
    readVerifiedSnapshot(directory, "runtime-defaults", written.sha256),
    (error) => error.code === "SNAPSHOT_HASH_MISMATCH",
  );
});

test("an unknown snapshot kind is rejected", async (t) => {
  const directory = await root(t);
  assert.throws(
    () => planSnapshot(directory, "secrets", "{}\n"),
    (error) => error.code === "UNKNOWN_SNAPSHOT_KIND",
  );
});
