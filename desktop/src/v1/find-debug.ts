// A find miss, written only when BAO_FIND_DEBUG is a directory.
// The scorer is not changed here. The file is the evidence for why a target missed.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export function findDebugDir(): string | undefined {
  const dir = process.env.BAO_FIND_DEBUG;
  if (!dir || dir === "0") return undefined;
  return dir;
}

export interface FindProbeQuery {
  kind: "css" | "text" | "role" | "xpath";
  query: string;
  role?: string;
  name?: string;
}

export function queriesForLocators(locators: { kind: string; value?: string; role?: string; name?: string }[] | undefined): FindProbeQuery[] {
  const out: FindProbeQuery[] = [];
  for (const locator of locators || []) {
    if ((locator.kind === "css" || locator.kind === "text" || locator.kind === "xpath") && locator.value) {
      out.push({ kind: locator.kind, query: locator.value });
    } else if (locator.kind === "role" && locator.role) {
      out.push({ kind: "role", query: `${locator.role} ${locator.name || ""}`.trim(), role: locator.role, name: locator.name || "" });
    }
  }
  return out;
}

export function writeFindDebug(dir: string, name: string, body: unknown, png?: Buffer): void {
  mkdirSync(dir, { recursive: true });
  const safe = name.replace(/[^\w.-]+/g, "_").slice(0, 80);
  writeFileSync(path.join(dir, `${safe}.json`), `${JSON.stringify(body, null, 2)}\n`);
  if (png && png.length) writeFileSync(path.join(dir, `${safe}.png`), png);
}
