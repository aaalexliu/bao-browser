// Import one site's cookies from a Chrome user-data directory into Bao's
// Chrome. Nothing in this file reads a profile unless click.clicked is true.
// Return values omit cookie values.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { launchOwnedChrome } from "../launch";
import { assertNotDailyChrome } from "../profile";
import { KEYCHAIN_PREVIEW, keyRingFromSources, keychainMessage, type KeySources } from "./keys";
import { judgeSignedIn, type ProbeObservation } from "./probe";
import { buildReport } from "./report";
import {
  chromeUserDataExists,
  findCookieDb,
  loadDb,
  readLocalState,
  summarizeDb,
  withCookieDb,
  type DecryptedCookie,
  type ProfileInfo,
} from "./read";
import { setCookiesOneAtATime, type CookieSetter } from "./set-cookies";
import { siteHost, siteOrigin } from "./sites";
import { copyIndexedDb, matchingIndexedDbOrigins, originsForSite, readLocalStorage, setLocalStorageItems, type StorageItem } from "./storage";
import {
  ConsentRequired,
  headline,
  type ImportClick,
  type PublicImportResult,
  type PublicPreview,
  type PublicProfile,
  type SiteLoginConfig,
} from "./types";

export interface ClickInput {
  site?: string;
  clicked?: boolean;
}

export function assertClick(click: ClickInput | undefined): asserts click is ImportClick {
  if (!click || click.clicked !== true || typeof click.site !== "string" || !click.site.trim()) {
    throw new ConsentRequired();
  }
  let url: URL;
  try {
    url = new URL(click.site);
  } catch {
    throw new ConsentRequired();
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.hostname === "*") {
    throw new ConsentRequired();
  }
}

export async function previewChromeProfiles(opts: {
  click: ClickInput;
  chromeUserData: string;
  config: Pick<SiteLoginConfig, "botCookies"> & { origins?: string[] };
  now?: number;
  platform?: NodeJS.Platform;
}): Promise<PublicPreview> {
  assertClick(opts.click);
  const site = opts.click.site;
  const origin = siteOrigin(site);
  const host = siteHost(site);
  if (!chromeUserDataExists(opts.chromeUserData)) {
    return {
      site: origin,
      host,
      botCookies: opts.config.botCookies,
      profiles: [],
      chromeFound: false,
      keychainNote: opts.platform === "darwin" ? KEYCHAIN_PREVIEW : null,
    };
  }
  const cache = readLocalState(opts.chromeUserData);
  const now = opts.now ?? Date.now();
  const profiles = await Promise.all(Object.entries(cache)
    .filter(([directory]) => safeDirectory(directory))
    .map(([directory, info]) => summarizeProfile(opts.chromeUserData, directory, info, host, opts.config.botCookies, now, site, opts.config.origins ?? [])));
  return {
    site: origin,
    host,
    botCookies: opts.config.botCookies,
    profiles,
    chromeFound: true,
    keychainNote: opts.platform === "darwin" ? KEYCHAIN_PREVIEW : null,
  };
}

export async function importChromeLogin(opts: {
  click: ClickInput;
  chromeUserData: string;
  profileDirectory: string;
  config: SiteLoginConfig;
  keys: KeySources;
  now?: number;
  setOne?: CookieSetter["setOne"];
  observe?: (probeUrl: string) => Promise<ProbeObservation>;
  restoreStorage?: () => Promise<number>;
  indexedDbOrigins?: number;
}): Promise<PublicImportResult> {
  assertClick(opts.click);
  const origin = siteOrigin(opts.click.site);
  const host = siteHost(opts.click.site);
  const signInUrl = opts.config.probeUrl || origin;
  if (opts.keys.platform === "win32") {
    return unsupported(signInUrl);
  }
  if (opts.keys.platform === "darwin" && !opts.keys.secret) {
    const keychain = keychainMessage(opts.keys.secretError ?? "prompt-missed");
    return buildReport({
      imported: 0,
      signedIn: false,
      skippedBot: [],
      policy: opts.config.botCookies,
      rejected: [],
      failed: [],
      skippedExpired: 0,
      probed: false,
      signInUrl,
      keychain,
      includedBot: 0,
      localStorageItems: 0,
      indexedDbOrigins: 0,
    });
  }
  const loaded = readChosenProfile(opts.chromeUserData, opts.profileDirectory, host, opts.config.botCookies, opts.keys, opts.now ?? Date.now());
  if (!opts.setOne || !opts.observe) {
    throw new Error("Import needs Bao's Chrome.");
  }
  const setter: CookieSetter = { setOne: opts.setOne };
  const outcomes = await setCookiesOneAtATime(setter, loaded.cookies);
  let localStorageItems = 0;
  if (opts.restoreStorage) {
    try {
      localStorageItems = await opts.restoreStorage();
    } catch {
      localStorageItems = 0;
    }
  }
  const indexedDbOrigins = opts.indexedDbOrigins ?? 0;
  const imported = outcomes.filter((item) => item.ok).length;
  const rejected = outcomes.filter((item) => !item.ok).map((item) => ({ name: item.name, host: item.host, reason: item.reason || "Chrome rejected this cookie" }));
  let signedIn = false;
  let probed = false;
  let probeError = false;
  let probeHow: "selector" | "text" | "login-url" | undefined;
  if (imported > 0 || localStorageItems > 0 || indexedDbOrigins > 0) {
    try {
      const obs = await opts.observe(opts.config.probeUrl || origin);
      const judged = judgeSignedIn(obs, {
        selector: opts.config.signedInSelector || undefined,
        text: opts.config.signedInText || undefined,
      });
      signedIn = judged.signedIn;
      probeHow = judged.how;
      probed = true;
    } catch {
      signedIn = false;
      probed = false;
      probeError = true;
    }
  }
  const importedKeys = new Set(outcomes.filter((item) => item.ok).map((item) => `${item.host}\0${item.name}`));
  const includedBot = loaded.cookies.filter((cookie) => cookie.botVendor && importedKeys.has(`${cookie.hostKey}\0${cookie.name}`)).length;
  return buildReport({
    imported,
    signedIn,
    skippedBot: loaded.skippedBot,
    policy: opts.config.botCookies,
    rejected,
    failed: loaded.failed,
    skippedExpired: loaded.skippedExpired,
    probed,
    probeError,
    signInUrl,
    keychain: null,
    probeHow,
    includedBot,
    localStorageItems,
    indexedDbOrigins,
  });
}

export async function importInOwnedChrome(opts: {
  click: ClickInput;
  chromeUserData: string;
  profileDirectory: string;
  baoProfile: string;
  config: SiteLoginConfig;
  keys: KeySources;
  now?: number;
  headless?: boolean;
}): Promise<PublicImportResult> {
  assertClick(opts.click);
  assertNotDailyChrome(opts.baoProfile);
  if (opts.keys.platform === "darwin" && !opts.keys.secret) {
    return importChromeLogin({ ...opts, setOne: async () => ({ success: false }), observe: async () => ({ finalUrl: "", selectorFound: false, bodyText: "" }) });
  }
  if (opts.keys.platform === "win32") {
    return importChromeLogin(opts);
  }
  const profileDir = resolveProfileDir(opts.chromeUserData, opts.profileDirectory);
  const origins = originsForSite(opts.click.site, opts.config.origins ?? []);
  const items = await readLocalStorage(profileDir, origins);
  const indexedDbOrigins = copyIndexedDb(profileDir, opts.baoProfile, origins);
  const headless = opts.headless ?? process.env.BAO_HEADED !== "1";
  const ctx = await launchOwnedChrome({ userDataDir: opts.baoProfile, headless });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    const send = (method: string, params?: Record<string, unknown>) =>
      (cdp as { send(method: string, params?: Record<string, unknown>): Promise<unknown> }).send(method, params);
    return await importChromeLogin({
      ...opts,
      indexedDbOrigins: indexedDbOrigins.length,
      restoreStorage: () => restoreLocalStorage(page, send, items),
      setOne: async (cookie) => {
        const result = await cdp.send("Network.setCookie", cookie) as { success?: boolean };
        return { success: result.success === true };
      },
      observe: (probeUrl) => observePage(page, probeUrl, opts.config.signedInSelector, opts.config.signedInText),
    });
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

export async function openOwnedSignIn(opts: { baoProfile: string; url: string; headless: boolean }): Promise<{ close(): Promise<void> }> {
  assertNotDailyChrome(opts.baoProfile);
  const ctx: BrowserContext = await launchOwnedChrome({ userDataDir: opts.baoProfile, headless: opts.headless });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
  return { close: async () => { await ctx.close().catch(() => undefined); } };
}

async function restoreLocalStorage(
  page: Page,
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  items: StorageItem[],
): Promise<number> {
  const groups = new Map<string, StorageItem[]>();
  for (const item of items) {
    const list = groups.get(item.origin) ?? [];
    list.push(item);
    groups.set(item.origin, list);
  }
  let stored = 0;
  for (const [origin, group] of groups) {
    const pattern = `${origin}/**`;
    await page.route(pattern, (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>bao</title>",
    }));
    try {
      await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 20_000 });
      stored += await setLocalStorageItems(send, group);
    } catch {
      // A navigation failure leaves this origin unset. Other origins still run.
    } finally {
      await page.unroute(pattern).catch(() => undefined);
    }
  }
  return stored;
}

export async function observePage(page: Page, probeUrl: string, selector: string, text: string): Promise<ProbeObservation> {
  await page.goto(probeUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
  const finalUrl = page.url();
  const selectorFound = selector ? (await page.locator(selector).count()) > 0 : false;
  const bodyText = text ? await page.locator("body").innerText().catch(() => "") : "";
  return { finalUrl, selectorFound, bodyText };
}

function resolveProfileDir(userDataDir: string, directory: string): string {
  if (!safeDirectory(directory)) throw new Error("Unknown Chrome profile.");
  const cache = readLocalState(userDataDir);
  if (!Object.prototype.hasOwnProperty.call(cache, directory)) throw new Error("Unknown Chrome profile.");
  const profileDir = path.resolve(userDataDir, directory);
  const root = path.resolve(userDataDir);
  if (profileDir !== root && !profileDir.startsWith(root + path.sep)) throw new Error("Unknown Chrome profile.");
  return profileDir;
}

function readChosenProfile(userDataDir: string, directory: string, host: string, policy: SiteLoginConfig["botCookies"], keys: KeySources, now: number) {
  const profileDir = resolveProfileDir(userDataDir, directory);
  const db = findCookieDb(profileDir);
  if (!db) {
    return { cookies: [] as DecryptedCookie[], skippedBot: [], skippedExpired: 0, failed: [] };
  }
  return withCookieDb(db.file, (sqlite) => loadDb(sqlite, host, policy, keyRingFromSources(keys), now));
}

async function summarizeProfile(
  userDataDir: string,
  directory: string,
  info: ProfileInfo,
  host: string,
  policy: SiteLoginConfig["botCookies"],
  now: number,
  site: string,
  extraOrigins: string[],
): Promise<PublicProfile> {
  const profileDir = path.join(userDataDir, directory);
  const db = findCookieDb(profileDir);
  const summary = db ? withCookieDb(db.file, (sqlite) => summarizeDb(sqlite, host, policy, now)) : { matching: 0, expired: 0, botManager: 0, willImport: 0, rows: [] };
  const origins = originsForSite(site, extraOrigins);
  let localStorageItems = 0;
  let indexedDbOrigins = 0;
  try {
    localStorageItems = (await readLocalStorage(profileDir, origins)).length;
    indexedDbOrigins = matchingIndexedDbOrigins(profileDir, origins).length;
  } catch {
    localStorageItems = 0;
    indexedDbOrigins = 0;
  }
  return {
    directory,
    name: info.gaia_name || info.name || directory,
    email: info.user_name || "",
    avatarDataUrl: avatarDataUrl(profileDir, info.gaia_picture_file_name),
    matching: summary.matching,
    expired: summary.expired,
    botManager: summary.botManager,
    willImport: summary.willImport,
    localStorageItems,
    indexedDbOrigins,
    cookieDb: db?.kind ?? "missing",
  };
}

function avatarDataUrl(profileDir: string, fileName: string | undefined): string | null {
  const name = fileName || "Google Profile Picture.png";
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return null;
  const file = path.join(profileDir, name);
  if (!existsSync(file)) return null;
  const buf = readFileSync(file);
  if (buf.length === 0 || buf.length > 512 * 1024) return null;
  const mime = imageMime(buf);
  if (!mime) return null;
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function imageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function safeDirectory(directory: string): boolean {
  return Boolean(directory) && !directory.includes("/") && !directory.includes("\\") && !directory.includes("..");
}

function unsupported(signInUrl: string): PublicImportResult {
  return {
    imported: 0,
    signedIn: false,
    headline: headline(0, false),
    skippedBot: 0,
    skippedExpired: 0,
    rejected: [],
    failed: [],
    message: "This build decrypts Chrome cookies on macOS and Linux. On Windows, sign in once in Bao's window.",
    offerSignIn: true,
    signInUrl,
    keychain: null,
    probed: false,
    localStorageItems: 0,
    indexedDbOrigins: 0,
  };
}
