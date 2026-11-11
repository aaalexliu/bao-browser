import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";

export function socketRoot(home: string): string {
  const hash = createHash("sha256").update(path.resolve(home)).digest("hex").slice(0, 16);
  return `/tmp/bao-${hash}`;
}

export function assertSocketPath(socketPath: string): void {
  const bytes = Buffer.byteLength(socketPath);
  if (bytes > 103) throw new Error(`Unix socket path is ${bytes} bytes (maximum 103): ${socketPath}`);
}

export function prepareSocketPath(home: string, name: string): string {
  const root = socketRoot(home);
  const socketPath = path.join(root, name);
  assertSocketPath(socketPath);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return socketPath;
}

export function createSocketSession(home: string): string {
  const dir = mkdtempSync(prepareSocketPath(home, "proxy-"));
  assertSocketPath(path.join(dir, "bao.sock"));
  return dir;
}
