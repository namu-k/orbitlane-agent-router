import { readFile as fsReadFile } from "node:fs/promises";
import { resolve } from "node:path";

// The bytes that get hashed into a snapshot and the value the adapters render from
// must come from the same read. Reading the file twice lets a concurrent replacement
// make the report describe one contract while the snapshot pointer names another.
export async function loadJsonSource(path, { readFile = fsReadFile } = {}) {
  const bytes = await readFile(resolve(path), "utf8");
  return Object.freeze({ bytes, value: JSON.parse(bytes) });
}
