import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { readDevToolsActivePort } from "../cdp-live/endpoint";
import { assertChromeReadable, chromeDenied } from "../chrome-access";
import { connectCdp, type CdpSocket } from "../cdp-live/socket";
import { closeRetainedChrome, launchOwnedChromeEndpoint, listedPids, pidsForDataDir } from "../launch";
import { assertNotDailyChrome } from "../profile";
import { cookieMatchesHost, findCookieDb, summarizeDb, summarySql, withCookieDb, type DecryptedCookie } from "../login-import/read";
import { setCookiesOneAtATime } from "../login-import/set-cookies";
import { copyIndexedDb, matchingIndexedDbOrigins, readLocalStorage, setLocalStorageItems, type StorageItem } from "../login-import/storage";
import { boundCookie, boundSessionSites, boundSite, deleteCookieRows, listedBoundSite } from "./bound-sign-in";
import type { ProfileLease } from "./chrome-profile-copy";

interface LoginCookie extends DecryptedCookie { updated: bigint; signature: string }

interface LoginState {
  cookies: LoginCookie[];
  storage: StorageItem[];
  error?: string;
  bound?: true;
}

interface SourceLoginState {
  cookies?: LoginCookie[];
  storage: StorageItem[];
  /** Why Bao could not read the Chrome profile. */
  error?: string;
  /** The site ties its sign-in to the owner's Chrome, so Bao did not read it. */
  bound?: true;
}

/** One sign-in import from the owner's Chrome profile into the Bao profile. */
export interface SignInImport {
  origin: string;
  /** The site's cookies Bao read from the Chrome profile. */
  found: number;
  /** Cookies and storage items Bao wrote into its profile. Cookies it already had are not written again. */
  cookies: number;
  storage: number;
  /** Why the import read or wrote nothing. Bao's profile keeps its saved sign-ins. */
  error?: string;
  /** Bao ran the import again because the opened page asked for a sign-in. */
  retry?: true;
  /** The site ties its sign-in to the owner's Chrome, so Bao read and wrote nothing for it. */
  bound?: true;
}

interface ChromeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires: number;
  session: boolean;
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
}

export function baoAgentProfileDir(home: string): string {
  // Keep mock-keychain cookies separate from the older replay profile's OS-keychain cookies.
  return path.join(home, "agent-browser-profile");
}

function cookieKey(cookie: { name: string; domain: string; path: string; partitionKey?: ChromeCookie["partitionKey"] }): string {
  return JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.partitionKey?.topLevelSite, cookie.partitionKey?.hasCrossSiteAncestor]);
}

function cookieUpdates(directory: string): Map<string, bigint> {
  const db = findCookieDb(directory);
  if (!db) return new Map();
  return withCookieDb(db.file, (sqlite) => {
    const columns = new Set(sqlite.prepare("PRAGMA table_info(cookies)").all().map((row) => String(row.name)));
    if (!columns.has("host_key") || !columns.has("name")) return new Map<string, bigint>();
    return new Map(sqlite.prepare(summarySql(columns)).all().map((row) => {
      const updated = columns.has("last_update_utc")
        ? sqlite.prepare("SELECT CAST(last_update_utc AS TEXT) AS updated FROM cookies WHERE rowid = ?").get(row.id)?.updated : "0";
      const top = String(row.top_frame_site_key ?? "");
      return [cookieKey({ name: String(row.name), domain: String(row.host_key), path: String(row.path),
        partitionKey: top ? { topLevelSite: top, hasCrossSiteAncestor: Number(row.has_cross_site_ancestor) === 1 } : undefined }), BigInt(String(updated ?? "0"))];
    }));
  });
}

function cookieSignature(cookie: ChromeCookie): string {
  return JSON.stringify([cookie.value, cookie.expires, cookie.secure, cookie.httpOnly, cookie.sameSite]);
}

async function connect(portFile: string): Promise<CdpSocket> {
  const endpoint = await readDevToolsActivePort(portFile);
  return connectCdp(endpoint.port, endpoint.browserPath);
}

/** The import's Chrome reaches no host, so it cannot use the copied sign-ins with any site. */
export const OFFLINE_IMPORT_ARGS = ["--disable-background-networking", "--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND"];

async function readChromeLogin(options: { sourceRoot: string; directory: string }, site: string, destination?: string): Promise<SourceLoginState> {
  try { return await readSourceLogin(options, site, destination); }
  catch (failure) {
    const error = chromeDenied(failure, options.sourceRoot) ?? failure;
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Bao source sign-in import unavailable; keeping saved Bao state: ${reason}`);
    return { cookies: [], storage: [], error: reason };
  }
}

async function readSourceLogin(options: { sourceRoot: string; directory: string }, site: string, destination?: string): Promise<SourceLoginState> {
  const profile = path.join(options.sourceRoot, options.directory);
  // The storage readers skip a folder they cannot read, so a refused profile must stop here.
  assertChromeReadable(profile, options.sourceRoot);
  const origins = [new URL(site).origin];
  const storage = await readLocalStorage(profile, origins);
  if (destination && !matchingIndexedDbOrigins(path.join(destination, "Default"), origins).length) copyIndexedDb(profile, destination, origins);
  const db = findCookieDb(profile);
  if (!db || withCookieDb(db.file, (sqlite) => summarizeDb(sqlite, new URL(site).hostname, "include", Date.now()).willImport) === 0) return { storage };
  const temporary = await mkdtemp(path.join(tmpdir(), "bao-login-source-"));
  let source: Awaited<ReturnType<typeof launchOwnedChromeEndpoint>> | undefined;
  let cdp: CdpSocket | undefined;
  try {
    const state = JSON.parse(await readFile(path.join(options.sourceRoot, "Local State"), "utf8")) as Record<string, unknown>;
    state.profile = { last_used: "Default", last_active_profiles: ["Default"] };
    await writeFile(path.join(temporary, "Local State"), JSON.stringify(state));
    const target = path.join(temporary, "Default", ...(db.kind === "network" ? ["Network"] : []), "Cookies");
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(db.file, target);
    for (const suffix of ["-wal", "-shm"]) {
      await copyFile(db.file + suffix, target + suffix).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
    // Chrome decrypts every row it loads, so the copy keeps only the site's own cookies.
    deleteCookieRows(path.join(temporary, "Default"), { keepHost: new URL(site).hostname });
    const updates = cookieUpdates(path.join(temporary, "Default"));
    source = await launchOwnedChromeEndpoint({ userDataDir: temporary, childHome: userInfo().homedir, headless: false,
      loadExtensions: false, background: "none", appendArgs: OFFLINE_IMPORT_ARGS });
    cdp = await connect(source.portFile);
    const { cookies } = await cdp.send<{ cookies: ChromeCookie[] }>("Storage.getCookies");
    const wanted = cookies.filter((cookie) => cookie.session || cookie.expires > Date.now() / 1000);
    return { storage, cookies: wanted.map((cookie, id) => ({
      id, updated: updates.get(cookieKey(cookie)) ?? 0n, signature: cookieSignature(cookie), name: cookie.name, value: cookie.value, hostKey: cookie.domain, path: cookie.path,
      secure: cookie.secure, httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite === "Strict" ? 2 : cookie.sameSite === "Lax" ? 1 : cookie.sameSite === "None" ? 0 : -1,
      expiresUnix: cookie.session ? undefined : cookie.expires, expired: false, partitionKey: cookie.partitionKey, botVendor: null,
    })) };
  } finally {
    cdp?.close();
    try { await source?.close(); }
    finally { await rm(temporary, { recursive: true, force: true }); }
  }
}

async function seedLogin(portFile: string, login: LoginState, boundSites: readonly string[]): Promise<{ cookies: number; storage: number }> {
  const cdp = await connect(portFile);
  let targetId: string | undefined;
  try {
    const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
    const origins = [...new Set(login.storage.map((item) => item.origin))];
    const existing = targetInfos.find((target) => target.type === "page" &&
      (!origins.length || origins.length === 1 && target.url.startsWith(`${origins[0]}/`)));
    let sessionId: string | undefined;
    if (existing) {
      let candidateSession: string | undefined;
      try {
        ({ sessionId: candidateSession } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: existing.targetId, flatten: true }));
        const origin = origins.length ? (await cdp.send<{ frameTree: { frame: { securityOrigin: string } } }>("Page.getFrameTree", {}, candidateSession, 2000)).frameTree.frame.securityOrigin : undefined;
        if (!origins.length || origin === origins[0]) sessionId = candidateSession;
      } catch {} finally {
        if (candidateSession && !sessionId) await cdp.send("Target.detachFromTarget", { sessionId: candidateSession }).catch(() => undefined);
      }
    }
    if (!sessionId) {
      ({ targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: true, hidden: true }));
      ({ sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }));
    }
    const send = (method: string, params: Record<string, unknown> = {}) => cdp.send(method, params, sessionId);
    const outcomes = await setCookiesOneAtATime({ setOne: (cookie) => cdp.send("Network.setCookie", { ...cookie }, sessionId) }, login.cookies, boundSites);
    let stored = 0;
    if (login.storage.length) {
      cdp.on("Fetch.requestPaused", sessionId, (request) => {
        void send("Fetch.fulfillRequest", { requestId: request.requestId, responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "text/html" }],
          body: Buffer.from("<!doctype html><title>Bao</title>").toString("base64") }).catch(() => undefined);
      });
      if (targetId) await send("Fetch.enable", { patterns: origins.map((origin) => ({ urlPattern: `${origin}/*`, resourceType: "Document" })) });
      try {
        for (const origin of origins) {
          if (targetId) await send("Page.navigate", { url: `${origin}/` });
          const deadline = Date.now() + 5000;
          for (;;) {
            const { frameTree } = await cdp.send<{ frameTree: { frame: { securityOrigin: string } } }>("Page.getFrameTree", {}, sessionId, 2000);
            if (frameTree.frame.securityOrigin === origin) break;
            if (Date.now() >= deadline) throw new Error("Bao could not prepare the site's storage");
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          await send("DOMStorage.enable");
          const { entries } = await cdp.send<{ entries: [string, string][] }>("DOMStorage.getDOMStorageItems", {
            storageId: { securityOrigin: origin, isLocalStorage: true },
          }, sessionId);
          const existing = new Set(entries.map(([key]) => key));
          stored += await setLocalStorageItems(send, login.storage.filter((item) => item.origin === origin && !existing.has(item.key)));
        }
      } finally {
        if (targetId) await send("Fetch.disable");
      }
    }
    return { cookies: outcomes.filter((outcome) => outcome.ok).length, storage: stored };
  } finally {
    if (targetId) await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
    cdp.close();
  }
}

/**
 * Opens Bao's lasting profile. Sign-ins come from Chrome profile `directory` in `sourceRoot`. With `unread` instead, Bao could not
 * read Chrome's profiles, so it imports nothing and every import reports that reason.
 */
export async function openBaoChromeForProxy(options: ({ sourceRoot: string; directory: string } | { unread: string }) & {
  home: string; site?: string; detached?: boolean;
  /** Device-bound sites to purge even when the open imports nothing. */
  boundSites?: readonly string[];
}) {
  const profile = baoAgentProfileDir(options.home);
  assertNotDailyChrome(profile);
  const keptWindow = path.join(profile, "bao-kept-window");
  await mkdir(profile, { recursive: true });
  const token = randomUUID();
  const busy = () => new Error("The Bao profile is already open. Close that session before starting another.");
  const lease = (state: ProfileLease["state"]): ProfileLease => ({ state, pid: process.pid, token });
  const claim = () => writeFileSync(keptWindow, JSON.stringify(lease("claimed")), { flag: "wx", mode: 0o600 });
  let reclaim = false;
  try { claim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const marker = readFileSync(keptWindow, "utf8");
    const lease = JSON.parse(marker) as { pid: number; state?: ProfileLease["state"]; retained?: boolean };
    let ownerAlive = true;
    if (Number.isSafeInteger(lease.pid) && lease.pid > 1) {
      try { process.kill(lease.pid, 0); }
      catch (error) { ownerAlive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    }
    const state = lease.state ?? (lease.retained ? "retained" : "claimed");
    if (ownerAlive && state !== "retained") throw busy();
    if (readFileSync(keptWindow, "utf8") !== marker) throw busy();
    unlinkSync(keptWindow);
    try { claim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw busy(); throw error; }
    reclaim = true;
  }
  const ownedLease = (): ProfileLease | undefined => {
    try {
      const current = JSON.parse(readFileSync(keptWindow, "utf8")) as ProfileLease;
      return current.token === token ? current : undefined;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  };
  const ownsProfile = () => Boolean(ownedLease());
  const writeLease = (state: ProfileLease["state"]) => {
    if (ownsProfile()) writeFileSync(keptWindow, JSON.stringify(lease(state)), { mode: 0o600 });
  };
  let chrome: Awaited<ReturnType<typeof launchOwnedChromeEndpoint>> | undefined;
  let launchAttempted = false;
  const close = async () => {
    if (!ownsProfile()) return;
    writeLease("releasing");
    try { await chrome?.close(); }
    finally {
      // An unreadable process list keeps the marker, so the next session reclaims whatever is left.
      if (ownsProfile()) {
        try {
          if (listedPids(profile)?.length === 0) unlinkSync(keptWindow);
          else writeLease("retained");
        } catch (error) {
          if (ownsProfile()) writeLease("retained");
          throw error;
        }
      }
    }
  };
  try {
    if (reclaim) await closeRetainedChrome(profile);
    if (!ownsProfile() || pidsForDataDir(profile).length) throw busy();
    const sourceProfile = "unread" in options ? undefined : path.join(options.sourceRoot, options.directory);
    const boundSites = options.boundSites ?? (sourceProfile ? boundSessionSites(sourceProfile) : []);
    const snapshots = new Map<string, Promise<LoginState>>();
    const snapshot = (site: string, destination?: string) => {
      const url = new URL(site);
      let login = snapshots.get(url.origin);
      if (!login) {
        const read = "unread" in options ? Promise.resolve<SourceLoginState>({ cookies: [], storage: [], error: options.unread })
          : boundSite(site, sourceProfile) || listedBoundSite(site, boundSites) ? Promise.resolve<SourceLoginState>({ cookies: [], storage: [], bound: true })
            : readChromeLogin(options, site, destination);
        login = read.then((source) => ({ cookies: (source.cookies ?? []).filter((cookie) => cookieMatchesHost(cookie.hostKey, url.hostname)
            && !boundCookie(cookie.hostKey, cookie.name, boundSites)), storage: source.storage,
            ...(source.error ? { error: source.error } : {}), ...(source.bound ? { bound: true as const } : {}) }));
        snapshots.set(url.origin, login);
      }
      return login;
    };
    const login = options.site ? await snapshot(options.site, profile) : undefined;
    if (!ownsProfile()) throw busy();
    // Read saved timestamps while Chrome is stopped; observe live changes through CDP.
    const updates = cookieUpdates(path.join(profile, "Default"));
    launchAttempted = true;
    chrome = await launchOwnedChromeEndpoint({ userDataDir: profile, keychain: "mock", headless: false,
      loadExtensions: false, background: "window", detached: options.detached, boundSites });
    const browser = chrome;
    const observed = new Map<string, { signature: string; updated: bigint }>();
    const liveCookies = async (initial = false) => {
      const cdp = await connect(browser.portFile);
      try {
        const { cookies } = await cdp.send<{ cookies: ChromeCookie[] }>("Storage.getCookies");
        const now = BigInt(Date.now()) * 1000n + 11644473600000000n;
        const live = new Map(cookies.map((cookie) => [cookieKey(cookie), cookie]));
        for (const key of observed.keys()) if (!live.has(key)) observed.delete(key);
        for (const [key, cookie] of live) {
          const previous = observed.get(key);
          const signature = cookieSignature(cookie);
          const disk = updates.get(key) ?? 0n;
          const updated = initial ? disk : !previous || previous.signature !== signature ? now : previous.updated;
          observed.set(key, { signature, updated });
        }
        return live;
      } finally { cdp.close(); }
    };
    await liveCookies(true);
    const mergeLogin = async (origin: string, login: LoginState, preferSource = false): Promise<SignInImport> => {
      const report = { origin, found: login.cookies.length, cookies: 0, storage: 0, ...(login.error ? { error: login.error } : {}),
        ...(login.bound ? { bound: true as const } : {}) };
      try {
        if (!login.cookies.length && !login.storage.length) return report;
        const live = await liveCookies();
        const cookies = login.cookies.filter((cookie) => {
          const key = cookieKey({ ...cookie, domain: cookie.hostKey });
          const current = live.get(key);
          return !current || (preferSource ? cookie.signature !== cookieSignature(current) : cookie.updated > observed.get(key)!.updated);
        });
        if (!cookies.length && !login.storage.length) return report;
        const written = await seedLogin(browser.portFile, { cookies, storage: login.storage }, boundSites);
        await liveCookies();
        return { ...report, ...written };
      } catch {
        // A failed write can echo a cookie or storage value, so the report names the step, not the message.
        console.error("Bao sign-in seed unavailable; continuing without import.");
        return { ...report, error: "Bao could not write the sign-in into its profile" };
      }
    };
    const signIn = login && options.site ? await mergeLogin(new URL(options.site).origin, login) : undefined;
    return {
      target: { kind: "bao" as const, portFile: browser.portFile },
      closed: browser.closed, isClosed: browser.isClosed, close,
      async keepOpen() {
        const current = ownedLease();
        if (!current || current.state === "releasing") return;
        writeLease("retained");
        browser.keepOpen();
      },
      /** The import for the site the session opened with. */
      signIn,
      async importLogin(site: string, preferSource = false): Promise<SignInImport> {
        if (!ownsProfile()) throw busy();
        if (!preferSource) snapshots.clear();
        return mergeLogin(new URL(site).origin, await snapshot(site), preferSource);
      },
    };
  } catch (error) {
    if (!launchAttempted && !reclaim) {
      if (ownsProfile()) unlinkSync(keptWindow);
    } else await close();
    throw error;
  }
}
