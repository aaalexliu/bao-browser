// Sites whose sign-in lives only in the owner's own Chrome. Google binds its session to a key in the Mac's Secure Enclave
// (Device Bound Session Credentials), so a copied Google session signs the owner out everywhere. The Times counts every browser
// that holds its session as one more device. Bao opens these sites in the owner's running Chrome and never copies their cookies.

import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { cookieMatchesHost, findCookieDb, withCookieDb } from "../login-import/read";

export const BOUND_REASON = "this site ties its sign-in to your Chrome";

const GOOGLE_HOST = /(^|\.)(google\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})|youtube\.com)$/;
const KEPT_HOST = /(^|\.)nytimes\.com$/;
const GOOGLE_SIGN_IN = /^(SID|HSID|SSID|APISID|SAPISID|SIDCC|LSID|OSID|__Secure-OSID|LOGIN_INFO|__Host-GAPS|__Host-[13]PLSID|__Secure-[13]PAPISID|__Secure-[13]PSID.*|__Secure-\w*PSIDCC)$/;

function bare(host: string): string {
  return host.replace(/^\./, "").toLowerCase();
}

/** google.com and its subdomains, Google's country domains, and youtube.com. */
export function googleHost(host: string): boolean {
  return GOOGLE_HOST.test(bare(host));
}

/** A cookie that carries a Google sign-in. Bao never writes one into a browser it owns. */
export function googleSignInCookie(hostKey: string, name: string): boolean {
  return googleHost(hostKey) && GOOGLE_SIGN_IN.test(name);
}

/** The hosts of the sites a Chrome profile holds device-bound sessions for: the key column of its Device Bound Sessions table. */
export function boundSessionSites(profileDir: string): string[] {
  const file = path.join(profileDir, "Device Bound Sessions");
  if (!existsSync(file)) return [];
  try {
    return withCookieDb(file, (db) => db.prepare("SELECT key FROM dbsc_session_tbl").all().flatMap((row) => {
      const site = /https?:\/\/[^\s/,]+/.exec(String(row.key))?.[0];
      try { return site ? [bare(new URL(site).hostname)] : []; } catch { return []; }
    }));
  } catch (error) {
    console.error(`Bao could not read Chrome's device-bound sessions: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function onSite(host: string, sites: readonly string[]): boolean {
  const wanted = bare(host);
  return sites.some((site) => wanted === site || wanted.endsWith(`.${site}`));
}

const PROFILE_DIR = /^(Default|Profile \d+)$/;

function safeProfileDirectory(directory: string): boolean {
  return Boolean(directory) && !directory.includes("/") && !directory.includes("\\") && !directory.includes("..");
}

/**
 * Profile folders whose device-bound sessions count for a Bao-owned launch or a Login-site refusal.
 * A Settings pick wins. With none, the only profile wins. With several and none picked, every profile counts,
 * so a site bound in any of them is refused and purged.
 */
export function ownerProfileDirs(chromeUserData: string | undefined, settingsDirectory?: string): string[] {
  if (!chromeUserData) return [];
  if (settingsDirectory && safeProfileDirectory(settingsDirectory)) {
    const picked = path.join(chromeUserData, settingsDirectory);
    if (existsSync(picked)) return [picked];
  }
  let names: string[] = [];
  try {
    names = readdirSync(chromeUserData, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && PROFILE_DIR.test(entry.name))
      .map((entry) => entry.name);
  } catch { return []; }
  return names.map((name) => path.join(chromeUserData, name));
}

/** Device-bound site hosts for those profiles. Google and the Times are not in this list; the purge drops them on its own. */
export function ownerBoundSites(chromeUserData: string | undefined, settingsDirectory?: string): string[] {
  const sites = new Set<string>();
  for (const dir of ownerProfileDirs(chromeUserData, settingsDirectory)) {
    for (const site of boundSessionSites(dir)) sites.add(site);
  }
  return [...sites];
}

/** The owner list, plus the profile this open imports from. Google and the Times are purged on their own. */
export function purgeBoundSites(chromeUserData: string | undefined, settingsDirectory: string | undefined, importDir?: string): string[] {
  const sites = new Set(ownerBoundSites(chromeUserData, settingsDirectory));
  if (importDir) for (const site of boundSessionSites(importDir)) sites.add(site);
  return [...sites];
}

/** True when the site is Google, the Times, or a device-bound site in any of the profiles. */
export function boundInProfiles(url: string, profileDirs: readonly string[]): boolean {
  return boundSite(url, undefined) || profileDirs.some((dir) => boundSite(url, dir));
}

/** True when the site's host is in the device-bound host list, including a subdomain of one. */
export function listedBoundSite(url: string, sites: readonly string[]): boolean {
  try { return onSite(new URL(url).hostname, sites); } catch { return false; }
}

/** The site's sign-in stays in the owner's Chrome: Google, the Times, or a site the Chrome profile holds a device-bound session for. */
export function boundSite(url: string, profileDir: string | undefined): boolean {
  let host: string;
  try { host = new URL(url).hostname; } catch { return false; }
  return googleHost(host) || KEPT_HOST.test(bare(host)) || !!profileDir && onSite(host, boundSessionSites(profileDir));
}

/** A cookie Bao must not hold in a browser it owns: a Google sign-in, any Times cookie, or a cookie of a device-bound site. */
export function boundCookie(hostKey: string, name: string, sites: readonly string[]): boolean {
  return googleSignInCookie(hostKey, name) || KEPT_HOST.test(bare(hostKey)) || onSite(hostKey, sites);
}

/**
 * Deletes cookie rows from a stopped Chrome profile's Cookies file: rows `drop` names, or with `keepHost`, every row not on that host.
 * Returns how many rows it deleted. A file that is not a cookie database is left as it is.
 */
export function deleteCookieRows(profileDir: string, drop: { keepHost: string } | { sites: readonly string[] }): number {
  const db = findCookieDb(profileDir);
  if (!db) return 0;
  const sqlite = openSqlite(db.file);
  try {
    // A file that is not a cookie database holds no cookie Chrome could load.
    if (!hasTable(sqlite, "cookies")) return 0;
    const gone = sqlite.prepare("SELECT rowid AS id, host_key, name FROM cookies").all().filter((row) => "keepHost" in drop
      ? !cookieMatchesHost(String(row.host_key), drop.keepHost)
      : boundCookie(String(row.host_key), String(row.name), drop.sites));
    const remove = sqlite.prepare("DELETE FROM cookies WHERE rowid = ?");
    sqlite.exec("BEGIN");
    for (const row of gone) remove.run(row.id);
    sqlite.exec("COMMIT");
    return gone.length;
  } finally { sqlite.close(); }
}

/**
 * Deletes the rows of a stopped Chrome profile's token_service table in Web Data, which hold the refresh tokens of the Google
 * account the profile is signed in to Chrome with. The rest of Web Data, such as autofill, stays. Returns how many rows it deleted.
 */
export function deleteChromeTokens(profileDir: string): number {
  const file = path.join(profileDir, "Web Data");
  if (!existsSync(file)) return 0;
  const sqlite = openSqlite(file);
  try {
    if (!hasTable(sqlite, "token_service")) return 0;
    const gone = sqlite.prepare("SELECT COUNT(*) AS count FROM token_service").all()[0]?.count;
    sqlite.exec("DELETE FROM token_service");
    return Number(gone ?? 0);
  } finally { sqlite.close(); }
}

/** Chrome's own sign-in to a Google account, as a profile's Preferences records it. */
const ACCOUNT_SERVICES = ["account_id", "last_account_id", "last_gaia_id", "last_username", "last_signed_in_username", "username", "consented_to_sync", "signin_scoped_device_id"];
const ACCOUNT_SIGNIN = ["explicit_browser_signin", "primary_account", "last_signed_in_account_id"];

/** A copy of Chrome Preferences without the Google account Chrome is signed in to, so Chrome in a copy is signed out. */
export function signedOutPreferences(preferences: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...preferences };
  delete rest.account_info;
  const google = record(rest.google);
  if (rest.google !== undefined) rest.google = { ...google, services: omit(record(google.services), ACCOUNT_SERVICES) };
  if (rest.signin !== undefined) rest.signin = omit(record(rest.signin), ACCOUNT_SIGNIN);
  return rest;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function omit(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

type Sqlite = { prepare(sql: string): { all(): Record<string, unknown>[]; run(...args: unknown[]): unknown }; exec(sql: string): void; close(): void };

function openSqlite(file: string): Sqlite {
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (file: string) => Sqlite };
  return new DatabaseSync(file);
}

/** False for a missing table and for a file that is not a database. */
function hasTable(sqlite: Sqlite, name: string): boolean {
  try { return sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${name}'`).all().length > 0; }
  catch (error) { if ((error as { errcode?: number }).errcode === 26) return false; throw error; }
}
