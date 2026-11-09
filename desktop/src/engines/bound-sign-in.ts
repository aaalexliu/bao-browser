// Sites whose sign-in lives only in the owner's own Chrome. Google binds its session to a key in the Mac's Secure Enclave
// (Device Bound Session Credentials), so a copied Google session signs the owner out everywhere. The Times counts every browser
// that holds its session as one more device. Bao opens these sites in the owner's running Chrome and never copies their cookies.

import path from "node:path";
import { existsSync } from "node:fs";
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
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (file: string) => {
    prepare(sql: string): { all(): Record<string, unknown>[]; run(...args: unknown[]): unknown };
    exec(sql: string): void;
    close(): void;
  } };
  const sqlite = new DatabaseSync(db.file);
  try {
    // A file that is not a cookie database holds no cookie Chrome could load.
    try { if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cookies'").all().length) return 0; }
    catch (error) { if ((error as { errcode?: number }).errcode === 26) return 0; throw error; }
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
