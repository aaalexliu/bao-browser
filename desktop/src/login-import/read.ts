// Read one site's cookies out of a Chrome profile directory.
// Preview selects no value and no encrypted_value column. Import loads those
// columns only for the rowids that match the site and are not skipped.

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifyBotCookie } from "./bot";
import { decryptCookieValue, type KeyRing } from "./crypto";
import type { BotCookiePolicy } from "./types";

const CHROME_EPOCH_US = 11644473600000000n;

export interface CookieRow {
  id: number;
  hostKey: string;
  name: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: number;
  expiresUnix?: number;
  expired: boolean;
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
  botVendor: string | null;
}

export interface ProfileSummary {
  matching: number;
  expired: number;
  botManager: number;
  willImport: number;
  rows: CookieRow[];
}

export interface DecryptedCookie extends CookieRow {
  value: string;
}

export interface LoadResult {
  cookies: DecryptedCookie[];
  skippedBot: { name: string; host: string; vendor: string }[];
  skippedExpired: number;
  failed: { name: string; host: string; reason: string }[];
}

interface SqlStatement {
  all(...args: unknown[]): Record<string, unknown>[];
  get(...args: unknown[]): Record<string, unknown> | undefined;
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  close(): void;
}

interface SqlModule {
  DatabaseSync: new (file: string, options: { readOnly: boolean }) => SqlDatabase;
}

export interface ProfileInfo {
  name?: string;
  gaia_name?: string;
  user_name?: string;
  gaia_picture_file_name?: string;
}

export function cookieMatchesHost(hostKey: string, host: string): boolean {
  const key = hostKey.toLowerCase();
  const wanted = host.toLowerCase();
  if (key === wanted) return true;
  if (!key.startsWith(".")) return false;
  const domain = key.slice(1);
  if (!domain || domain.split(".").length < 2) return false;
  return wanted === domain || wanted.endsWith(`.${domain}`);
}

/** Approximate Chrome stable cutover for each cookie-DB meta version.
 *  The file's meta.version is authoritative. A 129 build cherry-picked onto
 *  schema 24 is detected from the file, not from this table. Meta 24 and
 *  later (Chrome 130 through the 15x line; Chromium main is still 24) store
 *  SHA-256(host_key) in front of the decrypted value. */
export function metaForChromeMajor(major: number): { meta: number; hostPrefix: boolean } {
  const cuts: [number, number][] = [
    [130, 24],
    [124, 23],
    [123, 22],
    [120, 21],
    [119, 20],
    [117, 19],
    [101, 18],
    [100, 17],
    [94, 16],
    [92, 15],
  ];
  for (const [min, meta] of cuts) {
    if (major >= min) return { meta, hostPrefix: meta >= 24 };
  }
  return { meta: 14, hostPrefix: false };
}

export function findCookieDb(profileDir: string): { file: string; kind: "network" | "legacy" } | null {
  const network = path.join(profileDir, "Network", "Cookies");
  if (existsSync(network)) return { file: network, kind: "network" };
  const legacy = path.join(profileDir, "Cookies");
  if (existsSync(legacy)) return { file: legacy, kind: "legacy" };
  return null;
}

export function withCookieDb<T>(file: string, fn: (db: SqlDatabase) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-cookies-"));
  const dest = path.join(dir, "Cookies");
  try {
    copyFileSync(file, dest);
    for (const ext of ["-wal", "-shm"]) {
      const side = file + ext;
      if (existsSync(side)) copyFileSync(side, dest + ext);
    }
    const db = openReadonly(dest);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function summarizeDb(db: SqlDatabase, host: string, policy: BotCookiePolicy, nowMs: number): ProfileSummary {
  const columns = tableColumns(db);
  if (!columns.has("host_key") || !columns.has("name")) {
    return { matching: 0, expired: 0, botManager: 0, willImport: 0, rows: [] };
  }
  const rows = db.prepare(summarySql(columns)).all().map((row) => toCookieRow(row, nowMs));
  return tally(rows.filter((row) => cookieMatchesHost(row.hostKey, host)), policy);
}

export function loadDb(db: SqlDatabase, host: string, policy: BotCookiePolicy, ring: KeyRing, nowMs: number): LoadResult {
  const summary = summarizeDb(db, host, policy, nowMs);
  const meta = readMetaVersion(db);
  const cookies: DecryptedCookie[] = [];
  const skippedBot: LoadResult["skippedBot"] = [];
  const failed: LoadResult["failed"] = [];
  let skippedExpired = 0;
  for (const row of summary.rows) {
    if (row.expired) {
      skippedExpired += 1;
      continue;
    }
    if (policy === "skip" && row.botVendor) {
      skippedBot.push({ name: row.name, host: row.hostKey, vendor: row.botVendor });
      continue;
    }
    const secret = db.prepare("SELECT value, encrypted_value FROM cookies WHERE rowid = ?").get(row.id);
    const decoded = decodeRow(secret, row, meta, ring);
    if (!decoded.ok) {
      failed.push({ name: row.name, host: row.hostKey, reason: decoded.reason });
      continue;
    }
    cookies.push({ ...row, value: decoded.value });
  }
  return { cookies, skippedBot, skippedExpired, failed };
}

export function summarySql(columns: Set<string>): string {
  const optional = (name: string, fallback: string) => (columns.has(name) ? name : fallback);
  return [
    "SELECT rowid AS id, host_key, name, path,",
    "CAST(expires_utc AS TEXT) AS expires_utc, has_expires, is_secure, is_httponly,",
    `${optional("samesite", "-1")} AS samesite,`,
    `${optional("top_frame_site_key", "''")} AS top_frame_site_key,`,
    `${optional("has_cross_site_ancestor", "0")} AS has_cross_site_ancestor`,
    "FROM cookies",
  ].join(" ");
}

export function readMetaVersion(db: SqlDatabase): number {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get();
    const n = Number(row?.value ?? 0);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function chromeUserDataExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && existsSync(path.join(dir, "Local State"));
  } catch {
    return false;
  }
}

export function readLocalState(userDataDir: string): Record<string, ProfileInfo> {
  const raw = readFileSync(path.join(userDataDir, "Local State"), "utf8");
  const parsed = JSON.parse(raw) as { profile?: { info_cache?: Record<string, ProfileInfo> } };
  return parsed.profile?.info_cache ?? {};
}

function tally(rows: CookieRow[], policy: BotCookiePolicy): ProfileSummary {
  const live = rows.filter((row) => !row.expired);
  const expired = rows.length - live.length;
  const botManager = live.filter((row) => row.botVendor).length;
  const willImport = policy === "skip" ? live.length - botManager : live.length;
  return { matching: live.length, expired, botManager, willImport, rows };
}

function toCookieRow(row: Record<string, unknown>, nowMs: number): CookieRow {
  const hostKey = String(row.host_key ?? "");
  const expires = big(row.expires_utc);
  const hasExpires = Number(row.has_expires ?? 0) !== 0;
  const top = String(row.top_frame_site_key ?? "");
  const name = String(row.name ?? "");
  return {
    id: Number(row.id),
    hostKey,
    name,
    path: String(row.path ?? "/") || "/",
    secure: Number(row.is_secure ?? 0) === 1,
    httpOnly: Number(row.is_httponly ?? 0) === 1,
    sameSite: Number(row.samesite ?? -1),
    expiresUnix: hasExpires && expires > 0n ? Number((expires - CHROME_EPOCH_US) / 1000000n) : undefined,
    expired: isExpired(expires, hasExpires, nowMs),
    partitionKey: top ? { topLevelSite: top, hasCrossSiteAncestor: Number(row.has_cross_site_ancestor ?? 0) === 1 } : undefined,
    botVendor: classifyBotCookie(name)?.vendor ?? null,
  };
}

function decodeRow(
  secret: Record<string, unknown> | undefined,
  row: CookieRow,
  meta: number,
  ring: KeyRing,
): { ok: true; value: string } | { ok: false; reason: string } {
  const encrypted = asBuffer(secret?.encrypted_value);
  const plain = String(secret?.value ?? "");
  if (encrypted.length > 0 && plain.length > 0) {
    return { ok: false, reason: "plaintext and encrypted value both set" };
  }
  if (encrypted.length === 0) return { ok: true, value: plain };
  return decryptCookieValue(encrypted, row.hostKey, meta, ring);
}

function tableColumns(db: SqlDatabase): Set<string> {
  try {
    return new Set(db.prepare("PRAGMA table_info(cookies)").all().map((row) => String(row.name)));
  } catch {
    return new Set();
  }
}

function isExpired(expiresUtc: bigint, hasExpires: boolean, nowMs: number): boolean {
  if (!hasExpires || expiresUtc <= 0n) return false;
  const unixMs = Number((expiresUtc - CHROME_EPOCH_US) / 1000n);
  return unixMs <= nowMs;
}

function big(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return 0n;
}

function asBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.alloc(0);
}

function openReadonly(file: string): SqlDatabase {
  const { DatabaseSync } = require("node:sqlite") as SqlModule;
  return new DatabaseSync(file, { readOnly: true });
}
