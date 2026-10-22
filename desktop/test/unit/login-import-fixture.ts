// Synthetic Chrome profile pieces. Tests never open a real user profile.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { indexedDbIdentifier } from "../../src/login-import/storage";

const EPOCH = 11644473600000000n;

export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function chromeExpiry(unixMs: number): bigint {
  return EPOCH + BigInt(unixMs) * 1000n;
}

export interface CookieInsert {
  host: string;
  name: string;
  value?: string;
  encrypted?: Buffer;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: number;
  /** Null is a session cookie. */
  expires?: bigint | null;
  topFrame?: string;
  crossSite?: boolean;
}

export function writeCookieDb(file: string, meta: number, rows: CookieInsert[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  rmSync(file, { force: true });
  rmSync(`${file}-wal`, { force: true });
  rmSync(`${file}-shm`, { force: true });
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (file: string) => {
      exec(sql: string): void;
      prepare(sql: string): { run(...args: unknown[]): void };
      close(): void;
    };
  };
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE cookies (
    creation_utc INTEGER NOT NULL,
    host_key TEXT NOT NULL,
    top_frame_site_key TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    encrypted_value BLOB NOT NULL,
    path TEXT NOT NULL,
    expires_utc INTEGER NOT NULL,
    is_secure INTEGER NOT NULL,
    is_httponly INTEGER NOT NULL,
    last_access_utc INTEGER NOT NULL,
    has_expires INTEGER NOT NULL,
    is_persistent INTEGER NOT NULL,
    priority INTEGER NOT NULL,
    samesite INTEGER NOT NULL,
    source_scheme INTEGER NOT NULL,
    source_port INTEGER NOT NULL,
    last_update_utc INTEGER NOT NULL,
    source_type INTEGER NOT NULL DEFAULT 0,
    has_cross_site_ancestor INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec("CREATE TABLE meta(key TEXT NOT NULL UNIQUE PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO meta(key, value) VALUES ('version', ?)").run(String(meta));
  const insert = db.prepare(`INSERT INTO cookies (
    creation_utc, host_key, top_frame_site_key, name, value, encrypted_value, path, expires_utc,
    is_secure, is_httponly, last_access_utc, has_expires, is_persistent, priority, samesite,
    source_scheme, source_port, last_update_utc, source_type, has_cross_site_ancestor
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const now = chromeExpiry(Date.now());
  for (const row of rows) {
    const hasExpires = row.expires != null;
    insert.run(
      now,
      row.host,
      row.topFrame || "",
      row.name,
      row.value ?? "",
      row.encrypted ?? Buffer.alloc(0),
      row.path ?? "/",
      hasExpires ? row.expires : 0n,
      row.secure ? 1 : 0,
      row.httpOnly ? 1 : 0,
      now,
      hasExpires ? 1 : 0,
      hasExpires ? 1 : 0,
      1,
      row.sameSite ?? -1,
      row.secure ? 2 : 1,
      row.secure ? 443 : 80,
      now,
      0,
      row.crossSite ? 1 : 0,
    );
  }
  db.close();
}

export interface ProfileSeed {
  directory: string;
  name: string;
  email: string;
  avatar?: Buffer | null;
  avatarFile?: string;
}

export function writeLocalState(userData: string, profiles: ProfileSeed[]): void {
  mkdirSync(userData, { recursive: true });
  const info: Record<string, { name: string; gaia_name: string; user_name: string; gaia_picture_file_name?: string }> = {};
  for (const profile of profiles) {
    const dir = path.join(userData, profile.directory);
    mkdirSync(dir, { recursive: true });
    info[profile.directory] = {
      name: profile.name,
      gaia_name: profile.name,
      user_name: profile.email,
    };
    if (profile.avatar) {
      const file = profile.avatarFile || "Google Profile Picture.png";
      info[profile.directory].gaia_picture_file_name = file;
      if (!file.includes("/") && !file.includes("\\") && !file.includes("..")) {
        writeFileSync(path.join(dir, file), profile.avatar);
      }
    }
  }
  writeFileSync(path.join(userData, "Local State"), JSON.stringify({ profile: { info_cache: info } }));
}

export function writeSqliteLocalStorage(file: string, rows: { origin: string; key: Buffer; value: Buffer }[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (file: string) => {
      exec(sql: string): void;
      prepare(sql: string): { run(...args: unknown[]): void };
      close(): void;
    };
  };
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE maps (row_id INTEGER PRIMARY KEY, storage_key BLOB NOT NULL)");
  db.exec("CREATE TABLE map_entries (map_id INTEGER NOT NULL, key BLOB NOT NULL, value BLOB NOT NULL)");
  const map = db.prepare("INSERT INTO maps (storage_key) VALUES (?)");
  const entry = db.prepare("INSERT INTO map_entries (map_id, key, value) VALUES (?, ?, ?)");
  const ids = new Map<string, number>();
  let next = 1;
  for (const row of rows) {
    let id = ids.get(row.origin);
    if (!id) {
      id = next++;
      ids.set(row.origin, id);
      map.run(Buffer.from(`${row.origin}\0`, "utf8"));
    }
    entry.run(id, row.key, row.value);
  }
  db.close();
}

export async function writeLevelStorage(dir: string, entries: { key: Buffer; value: Buffer }[]): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const { ClassicLevel } = require("classic-level") as {
    ClassicLevel: new (location: string, options: Record<string, unknown>) => {
      put(key: Buffer, value: Buffer): Promise<void>;
      close(): Promise<void>;
    };
  };
  const db = new ClassicLevel(dir, { keyEncoding: "buffer", valueEncoding: "buffer" });
  for (const entry of entries) await db.put(entry.key, entry.value);
  await db.close();
}

export function writeIndexedDb(profileDir: string, origin: string, marker: string): string {
  const id = indexedDbIdentifier(origin);
  const dir = path.join(profileDir, "IndexedDB", `${id}.indexeddb.leveldb`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "CURRENT"), marker);
  writeFileSync(path.join(dir, "LOCK"), "held");
  const blob = path.join(profileDir, "IndexedDB", `${id}.indexeddb.blob`);
  mkdirSync(blob, { recursive: true });
  writeFileSync(path.join(blob, "0"), marker);
  return id;
}

export function assertNoValue(haystack: string, secret: string): void {
  if (haystack.includes(secret)) throw new Error("a cookie or storage value was included in the output");
}
