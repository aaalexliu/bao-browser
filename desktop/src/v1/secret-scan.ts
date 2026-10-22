// Byte search for a secret in saved artifacts. The scanner does not print the secret.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export function filesContaining(root: string, secret: string): string[] {
  if (!secret || !root) return [];
  const needle = Buffer.from(secret);
  const hits: string[] = [];
  const walk = (dir: string) => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!stat.isFile() || stat.size > 40_000_000) continue;
      const buf = readFileSync(full);
      if (buf.includes(needle)) hits.push(full);
    }
  };
  walk(root);
  return hits;
}
