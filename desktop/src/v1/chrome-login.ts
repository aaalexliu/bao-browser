// Site-scoped copy of a Chrome login into Bao's own browser.
// Reads one profile's Cookies database, and only rows for the requested
// domain. The keychain password and cookie values stay in memory for the
// inject call. They are not written to the audit file or to logs.

import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ChromeProfile {
  directory: string;
  name: string;
}

export interface SiteCookie {
  name: string;
  value: string;
  /** Host without a leading dot. */
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  /** Unix seconds. Absent for a session cookie. */
  expires?: number;
}

export interface ImportAudit {
  domain: string;
  count: number;
  at: number;
}

export interface CdpCookie {
  name: string;
  value: string;
  url: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  domain?: string;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
}

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/;

export function assertDomain(domain: string): string {
  const dom = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!DOMAIN_RE.test(dom)) throw new Error("domain must be a hostname like experian.com");
  return dom;
}

/** Exact host, a leading-dot domain cookie, or a subdomain. Not a lookalike. */
export function hostMatches(hostKey: string, domain: string): boolean {
  const dom = assertDomain(domain);
  const host = hostKey.trim().toLowerCase();
  if (!host || /[\s/]/.test(host)) return false;
  const bare = host.startsWith(".") ? host.slice(1) : host;
  if (!DOMAIN_RE.test(bare) && bare !== dom) return false;
  return bare === dom || bare.endsWith(`.${dom}`);
}

export function importConfirmText(domain: string): string {
  return `import your ${assertDomain(domain)} login from Chrome? only cookies for this site are copied`;
}

export function profilesFromLocalState(raw: string): ChromeProfile[] {
  const doc = JSON.parse(raw) as {
    profile?: { info_cache?: Record<string, { name?: string; gaia_name?: string }> };
  };
  const cache = doc.profile?.info_cache;
  if (!cache || typeof cache !== "object") return [];
  const out: ChromeProfile[] = [];
  for (const [directory, info] of Object.entries(cache)) {
    if (!directory || directory.includes("/") || directory.includes("\\") || directory.includes("..")) continue;
    const name = String(info?.name || info?.gaia_name || directory).trim();
    if (!name) continue;
    out.push({ directory, name });
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.directory.localeCompare(b.directory));
  return out;
}

export function chooseProfile(
  profiles: readonly ChromeProfile[],
  requested?: string,
): { ok: true; profile: ChromeProfile } | { ok: false; reason: "none" | "pick" | "unknown" } {
  if (profiles.length === 0) return { ok: false, reason: "none" };
  const want = requested?.trim().toLowerCase();
  if (!want) {
    if (profiles.length === 1) return { ok: true, profile: profiles[0]! };
    return { ok: false, reason: "pick" };
  }
  const hits = profiles.filter((profile) => profile.name.toLowerCase() === want || profile.directory.toLowerCase() === want);
  if (hits.length === 1) return { ok: true, profile: hits[0]! };
  if (hits.length === 0) return { ok: false, reason: "unknown" };
  return { ok: false, reason: "pick" };
}

export function chromeUserDataDir(): string {
  const override = process.env.BAO_CHROME_USER_DATA;
  if (override && override.trim()) return override;
  if (process.platform !== "darwin") throw new Error("Chrome import is only available on macOS");
  return path.join(homedir(), "Library", "Application Support", "Google", "Chrome");
}

export function readProfileNames(localStatePath: string): ChromeProfile[] {
  return profilesFromLocalState(readFileSync(localStatePath, "utf8"));
}

/** Network/Cookies is the current Chrome file. The older path is the fallback. */
export function cookiesDbPath(userDataDir: string, directory: string): string {
  if (!directory || directory.includes("/") || directory.includes("\\") || directory.includes("..")) {
    throw new Error("bad profile");
  }
  const root = path.join(userDataDir, directory);
  const network = path.join(root, "Network", "Cookies");
  const legacy = path.join(root, "Cookies");
  if (existsSync(network)) return network;
  if (existsSync(legacy)) return legacy;
  throw new Error("Chrome cookies database was not found for that profile");
}

export function deriveChromeKey(password: string): Buffer {
  return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

/** Chrome Safe Storage key from the login keychain. macOS prompts. The key is not saved. */
export function readChromeSafeStoragePassword(): string {
  try {
    const out = execFileSync("/usr/bin/security", [
      "find-generic-password",
      "-w",
      "-s",
      "Chrome Safe Storage",
      "-a",
      "Chrome",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (!out) throw new Error("empty");
    return out.replace(/\r?\n$/, "");
  } catch {
    throw new Error("keychain prompt was not approved");
  }
}

export function decryptV10(encrypted: Uint8Array, key: Buffer): string {
  if (encrypted.byteLength < 4) throw new Error("could not decrypt cookies");
  const prefix = Buffer.from(encrypted.subarray(0, 3)).toString("latin1");
  if (prefix !== "v10") throw new Error("could not decrypt cookies");
  try {
    const iv = Buffer.alloc(16, " ");
    const decipher = createDecipheriv("aes-128-cbc", key, iv);
    const plain = Buffer.concat([decipher.update(Buffer.from(encrypted.subarray(3))), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    throw new Error("could not decrypt cookies");
  }
}

const CHROME_EPOCH_SECONDS = 11644473600;

export function chromeExpiresToUnix(expiresUtc: string | number | bigint): number | undefined {
  let raw: bigint;
  try { raw = BigInt(expiresUtc); } catch { return undefined; }
  if (raw <= 0n) return undefined;
  const unix = raw / 1_000_000n - BigInt(CHROME_EPOCH_SECONDS);
  if (unix <= 0n || unix > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(unix);
}

function cookieRow(row: Record<string, unknown>): CookieRow {
  const enc = row.encrypted_value;
  return {
    host_key: String(row.host_key ?? ""),
    name: String(row.name ?? ""),
    value: String(row.value ?? ""),
    encrypted_value: enc instanceof Uint8Array ? enc : null,
    path: String(row.path ?? "/"),
    expires_utc: typeof row.expires_utc === "bigint" ? row.expires_utc.toString() : String(row.expires_utc ?? "0"),
    is_secure: Number(row.is_secure ?? 0),
    is_httponly: Number(row.is_httponly ?? 0),
    samesite: Number(row.samesite ?? -1),
  };
}

interface CookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array | null;
  path: string;
  expires_utc: string;
  is_secure: number;
  is_httponly: number;
  samesite: number;
}

export function readSiteCookieRows(dbPath: string, domain: string): CookieRow[] {
  const dom = assertDomain(domain);
  const suffix = `.${dom}`;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT host_key, name, value, encrypted_value, path, CAST(expires_utc AS TEXT) AS expires_utc, is_secure, is_httponly, samesite
      FROM cookies
      WHERE host_key = ? OR host_key = ? OR substr(host_key, -length(?)) = ?
    `).all(dom, suffix, suffix, suffix);
    return rows.map((row) => cookieRow(row)).filter((row) => hostMatches(row.host_key, dom));
  } finally {
    db.close();
  }
}

function sameSite(value: number): SiteCookie["sameSite"] {
  if (value === 0) return "None";
  if (value === 1) return "Lax";
  if (value === 2) return "Strict";
  return undefined;
}

function asBytes(value: Uint8Array | Buffer | null | undefined): Uint8Array {
  if (!value || value.byteLength === 0) return new Uint8Array();
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

export function decryptSiteCookies(rows: readonly CookieRow[], key: Buffer, domain: string): SiteCookie[] {
  const out: SiteCookie[] = [];
  for (const row of rows) {
    if (!hostMatches(String(row.host_key), domain)) continue;
    const encrypted = asBytes(row.encrypted_value);
    let value = "";
    if (encrypted.byteLength > 0) value = decryptV10(encrypted, key);
    else value = String(row.value || "");
    if (!value) continue;
    const host = String(row.host_key);
    const hostOnly = !host.startsWith(".");
    const bare = hostOnly ? host : host.slice(1);
    const same = sameSite(Number(row.samesite));
    out.push({
      name: String(row.name),
      value,
      domain: bare,
      hostOnly,
      path: row.path || "/",
      secure: Number(row.is_secure) === 1,
      httpOnly: Number(row.is_httponly) === 1,
      sameSite: same === "None" && Number(row.is_secure) !== 1 ? undefined : same,
      expires: chromeExpiresToUnix(row.expires_utc),
    });
  }
  return out;
}

export function toCdpCookies(cookies: readonly SiteCookie[]): CdpCookie[] {
  return cookies.map((cookie) => {
    const cdp: CdpCookie = {
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || "/",
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      url: `https://${cookie.domain}/`,
    };
    if (!cookie.hostOnly) cdp.domain = cookie.domain;
    if (cookie.sameSite) cdp.sameSite = cookie.sameSite;
    if (cookie.expires) cdp.expires = cookie.expires;
    return cdp;
  });
}

export function auditRecord(domain: string, count: number, at = Date.now()): ImportAudit {
  return { domain: assertDomain(domain), count, at };
}

/** The only line written for an import. Domain, count, timestamp. */
export function auditLine(audit: ImportAudit): string {
  return JSON.stringify({ domain: audit.domain, count: audit.count, at: audit.at });
}

export async function withCookiesCopy<T>(source: string, fn: (dbPath: string) => Promise<T> | T): Promise<T> {
  if (path.basename(source) !== "Cookies") throw new Error("cookies database path is not a Cookies file");
  const dir = await mkdtemp(path.join(tmpdir(), "bao-cookies-"));
  const dbPath = path.join(dir, "Cookies");
  try {
    await copyFile(source, dbPath);
    for (const suffix of ["-wal", "-shm"]) {
      const extra = source + suffix;
      if (existsSync(extra)) await copyFile(extra, dbPath + suffix);
    }
    return await fn(dbPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function loadChromeSiteCookies(opts: {
  userDataDir: string;
  profileDir: string;
  domain: string;
  password: string;
}): Promise<{ cookies: SiteCookie[]; audit: ImportAudit }> {
  const domain = assertDomain(opts.domain);
  const source = cookiesDbPath(opts.userDataDir, opts.profileDir);
  const key = deriveChromeKey(opts.password);
  try {
    const cookies = await withCookiesCopy(source, (dbPath) => decryptSiteCookies(readSiteCookieRows(dbPath, domain), key, domain));
    return { cookies, audit: auditRecord(domain, cookies.length) };
  } finally {
    key.fill(0);
  }
}

export interface CdpSession {
  send(method: string, params?: object): Promise<unknown>;
  detach(): Promise<void>;
}

export async function injectCookies(
  page: { context(): { newCDPSession(page: unknown): Promise<CdpSession> } },
  cookies: readonly SiteCookie[],
): Promise<void> {
  if (cookies.length === 0) return;
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Network.setCookies", { cookies: toCdpCookies(cookies) });
  } catch {
    throw new Error("could not import cookies");
  } finally {
    await client.detach().catch(() => undefined);
  }
}

export function safeImportError(err: unknown): string {
  const msg = err instanceof Error ? err.message : "";
  const allowed = new Set([
    "could not decrypt cookies",
    "could not import cookies",
    "Chrome cookies database was not found for that profile",
    "keychain prompt was not approved",
    "domain must be a hostname like experian.com",
    "bad profile",
    "cookies database path is not a Cookies file",
    "Chrome import is only available on macOS",
    "Chrome has no profiles",
  ]);
  if (allowed.has(msg)) return msg;
  return "import failed";
}
