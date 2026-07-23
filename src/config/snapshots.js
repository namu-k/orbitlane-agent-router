import { createHash } from "node:crypto";
import { mkdir, readFile as fsReadFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const KINDS = new Set(["contracts", "runtime-defaults"]);

function fail(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

export function snapshotDigest(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function snapshotPath(root, kind, sha256) {
  if (!KINDS.has(kind)) throw fail("UNKNOWN_SNAPSHOT_KIND", kind);
  return join(root, ".orbitlane", kind, `${sha256}.json`);
}

export function planSnapshot(root, kind, content) {
  const sha256 = snapshotDigest(content);
  return Object.freeze({ sha256, path: snapshotPath(root, kind, sha256) });
}

export async function writeSnapshot(root, kind, content) {
  const planned = planSnapshot(root, kind, content);
  let existing;
  try { existing = await fsReadFile(planned.path, "utf8"); } catch { existing = undefined; }
  if (existing !== undefined) {
    if (snapshotDigest(existing) !== planned.sha256) throw fail("SNAPSHOT_HASH_MISMATCH", planned.path);
    return planned;
  }
  await mkdir(dirname(planned.path), { recursive: true });
  await writeFile(planned.path, content, "utf8");
  return planned;
}

export async function readVerifiedSnapshot(root, kind, sha256, { readFile = fsReadFile } = {}) {
  const path = snapshotPath(root, kind, sha256);
  let content;
  try { content = await readFile(path, "utf8"); } catch { throw fail("SNAPSHOT_UNREADABLE", path); }
  if (snapshotDigest(content) !== sha256) throw fail("SNAPSHOT_HASH_MISMATCH", path);
  return content;
}
