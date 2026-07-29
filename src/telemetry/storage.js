import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;

function assertCurrentOwner(info) {
  if (currentUid !== undefined && info.uid !== currentUid) throw new Error("UNSAFE_TELEMETRY_OWNER");
}

async function assertSafeAncestry(path, { create = false } = {}) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const segment of relative(root, absolute).split(sep).filter(Boolean)) {
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

async function privateDirectory(path) {
  await assertSafeAncestry(path, { create: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("UNSAFE_TELEMETRY_PATH");
  assertCurrentOwner(info);
  await chmod(path, DIRECTORY_MODE);
}

async function privateFile(path) {
  const info = await lstat(path).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("UNSAFE_TELEMETRY_PATH");
  if (info) {
    assertCurrentOwner(info);
    await chmod(path, FILE_MODE);
  }
}

export async function appendJsonl(path, event) {
  try {
    if (typeof path !== "string" || path.length === 0) throw new TypeError("INVALID_TELEMETRY_PATH");
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line, "utf8") >= 4096) throw new RangeError("OVERSIZED_TELEMETRY_EVENT");
    await privateDirectory(dirname(path));
    await privateFile(path);
    const handle = await open(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, FILE_MODE);
    try {
      await handle.write(line, null, "utf8");
      await handle.chmod(FILE_MODE);
    } finally {
      await handle.close();
    }
    return Object.freeze({ written: true });
  } catch {
    return Object.freeze({ written: false });
  }
}

export async function readJsonl(path) {
  let content;
  try {
    if (!await assertSafeAncestry(dirname(path))) return Object.freeze({ records: Object.freeze([]), corrupt_lines: Object.freeze([]), partial_last_line: false });
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("UNSAFE_TELEMETRY_PATH");
    assertCurrentOwner(info);
    content = await readFile(path, "utf8");
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
