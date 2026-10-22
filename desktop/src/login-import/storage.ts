// localStorage and IndexedDB for the clicked site's origins only.
// localStorage is one LevelDB (or, on the 2026 SQLite migration, one database)
// for every origin. IndexedDB is one directory per origin. Other origins are
// not returned and not copied.

import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { siteOrigin } from "./sites";

export interface StorageItem {
  origin: string;
  key: string;
  value: string;
}

interface LevelDb {
  iterator(): AsyncIterable<[Uint8Array, Uint8Array]>;
  close(): Promise<void>;
}

export function originsForSite(site: string, extra: string[] = []): string[] {
  const clicked = siteOrigin(site);
  const host = new URL(clicked).hostname;
  const out: string[] = [];
  for (const candidate of [clicked, ...extra]) {
    let origin: string;
    try {
      origin = siteOrigin(candidate);
    } catch {
      continue;
    }
    if (new URL(origin).hostname !== host) continue;
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}

/** Chrome's database identifier: scheme_host_port, default port as 0. */
export function indexedDbIdentifier(origin: string): string {
  const url = new URL(origin);
  const scheme = url.protocol.replace(":", "");
  let host = url.hostname.toLowerCase();
  if (host.includes(":")) {
    if (!host.startsWith("[")) host = `[${host}]`;
    host = host.replace(/:/g, "_");
  }
  const port = url.port || "0";
  return `${scheme}_${host}_${port}`;
}

export async function readLocalStorage(profileDir: string, origins: string[]): Promise<StorageItem[]> {
  const wanted = new Set(origins);
  const items: StorageItem[] = [];
  const levelDir = path.join(profileDir, "Local Storage", "leveldb");
  if (existsSync(levelDir)) {
    try {
      items.push(...entriesToItems(await readLevelDb(levelDir), wanted));
    } catch {
      // A profile with no localStorage map is not a failed import.
    }
  }
  const sqliteDir = path.join(profileDir, "Local Storage");
  if (existsSync(sqliteDir)) {
    for (const name of readdirSync(sqliteDir)) {
      if (!/\.(sqlite3?|db)$/i.test(name)) continue;
      try {
        items.push(...readSqliteLocalStorage(path.join(sqliteDir, name), wanted));
      } catch {
        // Not a localStorage database.
      }
    }
  }
  return items;
}

export function matchingIndexedDbOrigins(profileDir: string, origins: string[]): string[] {
  const srcRoot = path.join(profileDir, "IndexedDB");
  if (!existsSync(srcRoot)) return [];
  let names: string[] = [];
  try {
    names = readdirSync(srcRoot);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const origin of origins) {
    const prefix = `${indexedDbIdentifier(origin)}.indexeddb`;
    if (names.some((name) => name.startsWith(prefix) && !name.includes(".."))) found.push(origin);
  }
  return found;
}

export function copyIndexedDb(sourceProfile: string, baoUserData: string, origins: string[]): string[] {
  const srcRoot = path.join(sourceProfile, "IndexedDB");
  if (!existsSync(srcRoot)) return [];
  const destRoot = path.join(baoUserData, "Default", "IndexedDB");
  const copied: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(srcRoot);
  } catch {
    return [];
  }
  for (const origin of origins) {
    const prefix = `${indexedDbIdentifier(origin)}.indexeddb`;
    let any = false;
    for (const name of names) {
      if (!name.startsWith(prefix) || name.includes("..")) continue;
      const from = path.join(srcRoot, name);
      mkdirSync(destRoot, { recursive: true });
      cpSync(from, path.join(destRoot, name), {
        recursive: true,
        filter: (src) => path.basename(src) !== "LOCK",
      });
      any = true;
    }
    if (any) copied.push(origin);
  }
  return copied;
}

/** Chrome can leave LOCK behind after a clean exit. A stale lock blocks the next open. */
export function clearIndexedDbLocks(profileDir: string): void {
  const root = path.join(profileDir, "Default", "IndexedDB");
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const lock = path.join(root, name, "LOCK");
    if (existsSync(lock)) unlinkSync(lock);
  }
}

export async function setLocalStorageItems(
  send: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  items: StorageItem[],
): Promise<number> {
  try {
    await send("DOMStorage.enable", {});
  } catch {
    // setDOMStorageItem still works on current Chrome without the enable call.
  }
  let stored = 0;
  for (const item of items) {
    try {
      await send("DOMStorage.setDOMStorageItem", {
        storageId: { securityOrigin: item.origin, isLocalStorage: true },
        key: item.key,
        value: item.value,
      });
      stored += 1;
    } catch {
      // One bad item does not drop the rest. The value stays out of the error.
    }
  }
  return stored;
}

export function decodeStorageBytes(bytes: Buffer): string {
  if (bytes.length === 0) return "";
  const tag = bytes[0];
  const rest = bytes.subarray(1);
  if (tag === 0x01) return rest.toString("latin1");
  if (tag === 0x00) return rest.toString("utf16le");
  return bytes.toString("utf16le");
}

export function encodeStorageBytes(value: string, utf16 = false): Buffer {
  if (!utf16 && [...value].every((ch) => ch.charCodeAt(0) <= 0xff)) {
    return Buffer.concat([Buffer.from([0x01]), Buffer.from(value, "latin1")]);
  }
  return Buffer.concat([Buffer.from([0x00]), Buffer.from(value, "utf16le")]);
}

export function localStorageKey(origin: string, itemKey: string, utf16Key = false): Buffer {
  return Buffer.concat([
    Buffer.from("_", "utf8"),
    Buffer.from(origin, "utf8"),
    Buffer.from([0x00]),
    encodeStorageBytes(itemKey, utf16Key),
  ]);
}

function entriesToItems(entries: { key: Buffer; value: Buffer }[], wanted: Set<string>): StorageItem[] {
  const items: StorageItem[] = [];
  for (const entry of entries) {
    const parsed = parseLocalStorageKey(entry.key);
    if (!parsed || !wanted.has(parsed.origin)) continue;
    items.push({ origin: parsed.origin, key: parsed.itemKey, value: decodeStorageBytes(entry.value) });
  }
  return items;
}

function parseLocalStorageKey(key: Buffer): { origin: string; itemKey: string } | null {
  if (key.length < 3 || key[0] !== 0x5f) return null;
  const sep = key.indexOf(0x00, 1);
  if (sep < 0) return null;
  const origin = key.subarray(1, sep).toString("utf8");
  if (!origin.startsWith("http://") && !origin.startsWith("https://")) return null;
  return { origin, itemKey: decodeStorageBytes(key.subarray(sep + 1)) };
}

async function readLevelDb(dir: string): Promise<{ key: Buffer; value: Buffer }[]> {
  const { ClassicLevel } = require("classic-level") as {
    ClassicLevel: new (location: string, options: Record<string, unknown>) => LevelDb;
  };
  const tmp = mkdtempSync(path.join(tmpdir(), "bao-level-"));
  const copy = path.join(tmp, "leveldb");
  cpSync(dir, copy, { recursive: true, filter: (src) => path.basename(src) !== "LOCK" });
  const db = new ClassicLevel(copy, { createIfMissing: false, readOnly: true, keyEncoding: "buffer", valueEncoding: "buffer" });
  const entries: { key: Buffer; value: Buffer }[] = [];
  try {
    for await (const [key, value] of db.iterator()) {
      entries.push({ key: Buffer.from(key), value: Buffer.from(value) });
    }
  } finally {
    await db.close().catch(() => undefined);
    rmSync(tmp, { recursive: true, force: true });
  }
  return entries;
}

function readSqliteLocalStorage(file: string, wanted: Set<string>): StorageItem[] {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (file: string, options: { readOnly: boolean }) => {
      prepare(sql: string): { all(): Record<string, unknown>[] };
      close(): void;
    };
  };
  const tmp = mkdtempSync(path.join(tmpdir(), "bao-lsql-"));
  const dest = path.join(tmp, "local.sqlite");
  try {
    copyFileSync(file, dest);
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(file + ext)) copyFileSync(file + ext, dest + ext);
    }
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  const db = new DatabaseSync(dest, { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row.name)));
    if (!tables.has("maps") || !tables.has("map_entries")) return [];
    const rows = db.prepare("SELECT maps.storage_key AS storage_key, map_entries.key AS item_key, map_entries.value AS item_value FROM maps JOIN map_entries ON map_entries.map_id = maps.row_id").all();
    const items: StorageItem[] = [];
    for (const row of rows) {
      const origin = storageKeyOrigin(asBuffer(row.storage_key));
      if (!origin || !wanted.has(origin)) continue;
      items.push({
        origin,
        key: decodeStorageBytes(asBuffer(row.item_key)),
        value: decodeStorageBytes(asBuffer(row.item_value)),
      });
    }
    return items;
  } finally {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

function storageKeyOrigin(bytes: Buffer): string | null {
  const text = bytes.toString("utf8");
  const origin = text.split("\0")[0] ?? "";
  if (origin.startsWith("http://") || origin.startsWith("https://")) return origin;
  return null;
}

function asBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value);
  return Buffer.alloc(0);
}
