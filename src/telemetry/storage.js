import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;

// Windows has no POSIX mode bits. chmod only toggles the read-only attribute there, so a
// file created with 0600 still reports 0666 and the group/world check below rejects every
// read of our own secret. Enforcing the mode on that platform withdraws the whole feature
// instead of protecting it, so the guarantee is dropped explicitly and reported through
// the event provenance limitation rather than silently faked.
export const FILE_MODE_ENFORCED = process.platform !== "win32";
// Empty where the mode is enforced, so an event can spread it into its own limitations
// and say plainly that its evidence file carries no owner-only guarantee on this host.
export const FILE_MODE_LIMITATIONS = Object.freeze(FILE_MODE_ENFORCED ? [] : ["file-mode-unenforced"]);

// The owner-mismatch throw below is verified by inspection, not by a unit test:
// exercising it needs a file owned by a different UID, which is impractical to
// create portably across the Linux/macOS/Windows CI matrix. Do not remove the
// check to "simplify" — it is the defense against a swapped-in secret owned by
// another account. If a portable fakeroot path emerges, add a test then.
function assertCurrentOwner(info) {
  if (currentUid !== undefined && info.uid !== currentUid) throw new Error("UNSAFE_TELEMETRY_OWNER");
}

// Anchors the walk below. Above it the layout belongs to the OS and the user: macOS
// reaches os.tmpdir() through /var -> /private/var, and a dotfile setup can legitimately
// symlink ~/.claude into a repository. Refusing those defends nothing and disables
// telemetry outright, so the anchor is followed through its own symlinks once and judged
// by its owner — which an attacker who planted the swap cannot fake — while every segment
// below it must still be a real directory.
async function assertTrustedBase(base) {
  const info = await stat(base);
  if (!info.isDirectory()) throw new Error("UNSAFE_TELEMETRY_PATH");
  assertCurrentOwner(info);
}

async function assertSafeAncestry(path, { create = false, trustedBase } = {}) {
  const absolute = resolve(path);
  const base = trustedBase === undefined ? parse(absolute).root : resolve(trustedBase);
  if (trustedBase !== undefined) {
    if (create) await mkdir(base, { recursive: true, mode: DIRECTORY_MODE });
    await assertTrustedBase(base);
  }
  const rest = relative(base, absolute);
  if (isAbsolute(rest) || rest.split(sep).includes("..")) throw new Error("UNSAFE_TELEMETRY_PATH");
  let current = base;
  for (const segment of rest.split(sep).filter(Boolean)) {
    current = join(current, segment);
    let info = await lstat(current).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!info && create) {
      await mkdir(current, { mode: DIRECTORY_MODE });
      info = await lstat(current);
    }
    if (!info) return false;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("UNSAFE_TELEMETRY_PATH");
  }
  return true;
}

async function privateDirectory(path, trustedBase) {
  await assertSafeAncestry(path, { create: true, trustedBase });
  // When the directory is the trusted base itself there is nothing below the anchor to
  // walk, and the anchor is allowed to be a symlink, so follow it the same way.
  const isBase = trustedBase !== undefined && resolve(path) === resolve(trustedBase);
  const info = isBase ? await stat(path) : await lstat(path);
  if (!info.isDirectory() || (!isBase && info.isSymbolicLink())) throw new Error("UNSAFE_TELEMETRY_PATH");
  assertCurrentOwner(info);
  if (FILE_MODE_ENFORCED) await chmod(path, DIRECTORY_MODE);
}

async function assertSafeFileTarget(path) {
  const info = await lstat(path).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("UNSAFE_TELEMETRY_PATH");
  if (info) assertCurrentOwner(info);
}

export async function appendJsonl(path, event, { trustedBase } = {}) {
  try {
    if (typeof path !== "string" || path.length === 0) throw new TypeError("INVALID_TELEMETRY_PATH");
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line, "utf8") >= 4096) throw new RangeError("OVERSIZED_TELEMETRY_EVENT");
    await privateDirectory(dirname(path), trustedBase);
    // Windows does not implement O_NOFOLLOW, so retain the explicit link check there;
    // the opened-handle stat below verifies the object actually opened on every host.
    await assertSafeFileTarget(path);
    const handle = await open(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, FILE_MODE);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("UNSAFE_TELEMETRY_PATH");
      assertCurrentOwner(info);
      if (FILE_MODE_ENFORCED) await handle.chmod(FILE_MODE);
      await handle.write(line, null, "utf8");
    } finally {
      await handle.close();
    }
    return Object.freeze({ written: true });
  } catch {
    return Object.freeze({ written: false });
  }
}

export async function readPrivateFile(path) {
  const initial = await lstat(path);
  if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("UNSAFE_TELEMETRY_PATH");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("UNSAFE_TELEMETRY_PATH");
    assertCurrentOwner(info);
    if (FILE_MODE_ENFORCED && (info.mode & 0o077) !== 0) throw new Error("UNSAFE_TELEMETRY_PERMISSIONS");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readJsonl(path, { trustedBase } = {}) {
  let content;
  try {
    if (!await assertSafeAncestry(dirname(path), { trustedBase })) return Object.freeze({ records: Object.freeze([]), corrupt_lines: Object.freeze([]), partial_last_line: false });
    const initial = await lstat(path);
    if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("UNSAFE_TELEMETRY_PATH");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("UNSAFE_TELEMETRY_PATH");
      assertCurrentOwner(info);
      content = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "ENOENT") return Object.freeze({ records: Object.freeze([]), corrupt_lines: Object.freeze([]), partial_last_line: false });
    throw error;
  }

  const lines = content.split("\n");
  const partial_last_line = content.length > 0 && !content.endsWith("\n");
  const limit = partial_last_line ? lines.length - 1 : lines.length - 1;
  const records = [];
  const corrupt_lines = [];
  for (let index = 0; index < limit; index += 1) {
    if (lines[index].length === 0) continue;
    try { records.push(JSON.parse(lines[index])); } catch { corrupt_lines.push(index + 1); }
  }
  return Object.freeze({ records: Object.freeze(records), corrupt_lines: Object.freeze(corrupt_lines), partial_last_line });
}
