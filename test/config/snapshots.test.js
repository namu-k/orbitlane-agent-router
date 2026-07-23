import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { planSnapshot, readVerifiedSnapshot, snapshotDigest, snapshotPath, writeSnapshot } from "../../src/config/snapshots.js";

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

test("a digest that is not a lowercase sha256 is rejected before it reaches a path", async (t) => {
  const directory = await root(t);
  for (const digest of ["../../etc/passwd", "A".repeat(64), "abc", `${"a".repeat(64)}/../..`, ""]) {
    assert.throws(() => snapshotPath(directory, "contracts", digest), (error) => error.code === "INVALID_SNAPSHOT_DIGEST");
    await assert.rejects(readVerifiedSnapshot(directory, "contracts", digest), (error) => error.code === "INVALID_SNAPSHOT_DIGEST");
  }
});

test("writeSnapshot publishes atomically and leaves no partial file behind", async (t) => {
  const directory = await root(t);
  const content = `${JSON.stringify({ a: 1 })}\n`;
  const planned = planSnapshot(directory, "contracts", content);

  await assert.rejects(
    writeSnapshot(directory, "contracts", content, {
      writeFile: async () => { throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" }); },
    }),
    (error) => error.code === "ENOSPC",
  );

  await assert.rejects(readVerifiedSnapshot(directory, "contracts", planned.sha256), (error) => error.code === "SNAPSHOT_UNREADABLE");
  assert.deepEqual(await readdir(join(directory, ".orbitlane", "contracts")), []);

  const written = await writeSnapshot(directory, "contracts", content);
  assert.equal(await readFile(written.path, "utf8"), content);
  assert.deepEqual(await readdir(join(directory, ".orbitlane", "contracts")), [`${written.sha256}.json`]);
});

test("an unknown snapshot kind is rejected", async (t) => {
  const directory = await root(t);
  assert.throws(
    () => planSnapshot(directory, "secrets", "{}\n"),
    (error) => error.code === "UNKNOWN_SNAPSHOT_KIND",
  );
});
