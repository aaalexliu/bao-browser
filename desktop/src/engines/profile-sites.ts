/**
 * Which Chrome profiles have used the site an open asks for. This works while remote debugging is off, when open tabs cannot
 * be read. Bao reads a copy of each profile's Cookies file: the host and the two timestamps of each row, never a name or a value.
 */
import path from "node:path";
import { findCookieDb, withCookieDb } from "../login-import/read";

/** The site's cookies in one profile. lastUsed is a UTC date, YYYY-MM-DD. */
export interface SiteCookies {
  cookies: number;
  lastUsed?: string;
}

export interface ProfileSiteListing {
  /** The site name the counts cover, such as robinhood.com for https://app.robinhood.com/statements. */
  site: string;
  byDirectory: Record<string, SiteCookies>;
  /** A profile whose cookies could not be read. A fixed phrase, never an error that might carry a path. */
  unread: Record<string, string>;
}

const PROFILE_DIRECTORY = /^(?:Default|Profile \d+)$/;

/** Country domains sell names one level down, such as example.co.uk. Without a public suffix list, these cover the common ones. */
const COUNTRY_SECOND_LEVEL = new Set(["ac", "co", "com", "edu", "gov", "net", "or", "org", "ne", "go"]);

/** The site an open asks for: the last two labels of its host, or three under a country domain such as co.uk. */
export function siteOf(url: string): string | undefined {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch { return undefined; }
  if (!host) return undefined;
  if (host.includes(":") || /^\d+(?:\.\d+){3}$/.test(host)) return host;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const keep = labels.at(-1)!.length === 2 && COUNTRY_SECOND_LEVEL.has(labels.at(-2)!) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

function onSite(hostKey: string, site: string): boolean {
  const host = hostKey.replace(/^\./, "").toLowerCase();
  return host === site || host.endsWith(`.${site}`);
}

/**
 * Chrome stores times as microseconds since 1601-01-01 UTC, past the largest exact JavaScript number, so SQLite turns them
 * into Unix milliseconds. Zero, Chrome's "never", comes out below zero.
 */
const COOKIE_TIMES = "SELECT host_key, expires_utc / 1000 - 11644473600000 AS expires_ms, last_access_utc / 1000 - 11644473600000 AS last_ms FROM cookies";

function unixMs(value: unknown): number {
  const ms = Number(value ?? 0);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** Cookies for the site in one profile folder, counting rows that have not expired. Undefined when the profile has no Cookies file. */
export function siteCookies(profileDir: string, site: string, nowMs = Date.now()): SiteCookies | undefined {
  const db = findCookieDb(profileDir);
  if (!db) return undefined;
  const rows = withCookieDb(db.file, (sqlite) => sqlite.prepare(COOKIE_TIMES).all());
  let cookies = 0;
  let last = 0;
  for (const row of rows) {
    if (!onSite(String(row.host_key ?? ""), site)) continue;
    const expires = unixMs(row.expires_ms);
    if (expires && expires < nowMs) continue;
    cookies++;
    last = Math.max(last, unixMs(row.last_ms));
  }
  return { cookies, ...(cookies && last ? { lastUsed: new Date(last).toISOString().slice(0, 10) } : {}) };
}

/**
 * The site's cookie count and last use in each profile. Undefined when the open names no web page.
 * A profile that cannot be read is named in unread; it does not drop the others.
 */
export function listProfileSites(root: string, directories: readonly string[], url: string | undefined, nowMs = Date.now()): ProfileSiteListing | undefined {
  const site = url ? siteOf(url) : undefined;
  if (!site) return undefined;
  const byDirectory: Record<string, SiteCookies> = {};
  const unread: Record<string, string> = {};
  for (const directory of directories) {
    if (!PROFILE_DIRECTORY.test(directory)) continue;
    try {
      const found = siteCookies(path.join(root, directory), site, nowMs);
      if (found) byDirectory[directory] = found;
      else unread[directory] = "no cookie file";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      unread[directory] = code === "EPERM" || code === "EACCES" ? "Chrome's folder is not readable" : "the cookie file could not be read";
    }
  }
  return { site, byDirectory, unread };
}

/** The phrase for one profile, such as `robinhood.com: 31 cookies, last used 2026-11-13`. */
export function siteText(listing: ProfileSiteListing, directory: string): string | undefined {
  const unread = listing.unread[directory];
  if (unread) return `${listing.site} cookies were not read (${unread})`;
  const found = listing.byDirectory[directory];
  if (!found) return undefined;
  if (!found.cookies) return `no ${listing.site} cookies`;
  return `${listing.site}: ${found.cookies} cookie${found.cookies === 1 ? "" : "s"}${found.lastUsed ? `, last used ${found.lastUsed}` : ""}`;
}
