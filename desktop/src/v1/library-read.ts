import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import path from "node:path";

export interface BoundedRead {
  maxBytes: number;
}

export function libraryRunFiles(root: string): string[] {
  const dir = path.join(root, "runs");
  if (lstatSync(root).isSymbolicLink() || lstatSync(dir).isSymbolicLink()) throw new Error("Library links are not allowed");
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[A-Za-z0-9_-]{1,128}\.json$/.test(entry.name))
    .map((entry) => ({ name: entry.name, at: lstatSync(path.join(dir, entry.name)).mtimeMs }))
    .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name))
    .map((entry) => entry.name.slice(0, -5));
}

/** Read only regular files within this Library, without following Library links. */
export function readLibraryFile(root: string, parts: readonly string[], maxBytes: number): Buffer {
  return readLibrarySnapshot(root, parts, maxBytes).bytes;
}

export function readLibrarySnapshot(root: string, parts: readonly string[], maxBytes: number): { bytes: Buffer; modifiedAtMs: number } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("invalid read limit");
  if (parts.some((part) => !part || part === "." || part === ".." || /[/\\\0]/.test(part))) throw new Error("invalid Library path");
  const base = path.resolve(root);
  if (lstatSync(base).isSymbolicLink()) throw new Error("Library links are not allowed");
  const canonical = realpathSync(base);
  const check = (): string => {
    let file = canonical;
    for (const [index, part] of parts.entries()) {
      file = path.join(file, part);
      const info = lstatSync(file);
      if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) throw new Error("Library links are not allowed");
    }
    return file;
  };
  const file = check();
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) throw new Error("Library file is unavailable or too large");
    check();
    const current = lstatSync(file);
    if (current.dev !== info.dev || current.ino !== info.ino) throw new Error("Library file changed during read");
    const bytes = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > maxBytes || size !== info.size || [fstatSync(fd), lstatSync(check())].some((current) =>
      current.dev !== info.dev || current.ino !== info.ino || current.size !== info.size
      || current.mtimeMs !== info.mtimeMs || current.ctimeMs !== info.ctimeMs)) throw new Error("Library file changed during read");
    return { bytes: bytes.subarray(0, size), modifiedAtMs: info.mtimeMs };
  } finally {
    closeSync(fd);
  }
}
