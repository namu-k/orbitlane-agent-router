import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile as fsReadFile, rename as fsRename, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const KINDS = new Set(["contracts", "runtime-defaults"]);
const DIGEST = /^[a-f0-9]{64}$/;
const ABSENT = new Set(["ENOENT", "ENOTDIR"]);

function fail(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

export function snapshotDigest(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function snapshotPath(root, kind, sha256) {
  if (!KINDS.has(kind)) throw fail("UNKNOWN_SNAPSHOT_KIND", kind);
  // The digest becomes a path segment. Validate it here rather than relying on the
  // callers that happen to check it today.
  if (typeof sha256 !== "string" || !DIGEST.test(sha256)) throw fail("INVALID_SNAPSHOT_DIGEST", String(sha256));
  return join(root, ".orbitlane", kind, `${sha256}.json`);
}

export function planSnapshot(root, kind, content) {
  const sha256 = snapshotDigest(content);
  return Object.freeze({ sha256, path: snapshotPath(root, kind, sha256) });
}

export async function writeSnapshot(root, kind, content, { readFile = fsReadFile, writeFile = fsWriteFile, rename = fsRename } = {}) {
  const planned = planSnapshot(root, kind, content);
  let existing;
  try {
    existing = await readFile(planned.path, "utf8");
  } catch (error) {
    // Only a genuinely absent snapshot may be written. Treating EACCES or EIO as
    // absence would publish over bytes we were never able to verify, which is the
    // one thing an immutable content-addressed store must not do.
    if (!ABSENT.has(error?.code)) throw fail("SNAPSHOT_UNREADABLE", `${planned.path} (${error?.code ?? "unknown"})`);
    existing = undefined;
  }
  if (existing !== undefined) {
    if (snapshotDigest(existing) !== planned.sha256) throw fail("SNAPSHOT_HASH_MISMATCH", planned.path);
    return planned;
  }
  const directory = dirname(planned.path);
  await mkdir(directory, { recursive: true });
  // Publish through a same-directory temporary file. A write interrupted by a crash
  // or ENOSPC must not leave a truncated file at the digest-named path: that path is
  // immutable, so every later install of the same contract would fail with
  // SNAPSHOT_HASH_MISMATCH and no recovery short of deleting it by hand.
  const staged = join(directory, `.${planned.sha256}.${randomUUID()}.partial`);
  try {
    await writeFile(staged, content, "utf8");
    await rename(staged, planned.path);
  } catch (error) {
    await rm(staged, { force: true }).catch(() => {});
    throw error;
  }
  return planned;
}

export async function readVerifiedSnapshot(root, kind, sha256, { readFile = fsReadFile } = {}) {
  const path = snapshotPath(root, kind, sha256);
  let content;
  try { content = await readFile(path, "utf8"); } catch { throw fail("SNAPSHOT_UNREADABLE", path); }
  if (snapshotDigest(content) !== sha256) throw fail("SNAPSHOT_HASH_MISMATCH", path);
  return content;
}
