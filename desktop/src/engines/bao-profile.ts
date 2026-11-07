import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { readDevToolsActivePort } from "../cdp-live/endpoint";
import { connectCdp, type CdpSocket } from "../cdp-live/socket";
import { closeRetainedChrome, launchOwnedChromeEndpoint, pidsForDataDir } from "../launch";
import { assertNotDailyChrome } from "../profile";
import { cookieMatchesHost, findCookieDb, summarizeDb, summarySql, withCookieDb, type DecryptedCookie } from "../login-import/read";
import { setCookiesOneAtATime } from "../login-import/set-cookies";
import { copyIndexedDb, matchingIndexedDbOrigins, readLocalStorage, setLocalStorageItems, type StorageItem } from "../login-import/storage";

interface LoginCookie extends DecryptedCookie { updated: bigint }

interface LoginState {
  cookies: LoginCookie[];
  storage: StorageItem[];
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

async function readChromeLogin(options: { sourceRoot: string; directory: string }, site: string, destination?: string): Promise<LoginState> {
  const profile = path.join(options.sourceRoot, options.directory);
  const origins = [new URL(site).origin];
  const storage = await readLocalStorage(profile, origins);
  if (destination && !matchingIndexedDbOrigins(path.join(destination, "Default"), origins).length) copyIndexedDb(profile, destination, origins);
  const db = findCookieDb(profile);
  if (!db || withCookieDb(db.file, (sqlite) => summarizeDb(sqlite, new URL(site).hostname, "include", Date.now()).willImport) === 0) return { cookies: [], storage };
  const temporary = await mkdtemp(path.join(tmpdir(), "bao-login-source-"));
  let source: Awaited<ReturnType<typeof launchOwnedChromeEndpoint>> | undefined;
  let cdp: CdpSocket | undefined;
  try {
    const state = JSON.parse(await readFile(path.join(options.sourceRoot, "Local State"), "utf8"));
    state.profile = { last_used: "Default", last_active_profiles: ["Default"] };
    await writeFile(path.join(temporary, "Local State"), JSON.stringify(state));
    const target = path.join(temporary, "Default", ...(db.kind === "network" ? ["Network"] : []), "Cookies");
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(db.file, target);
    for (const suffix of ["-wal", "-shm"]) {
      await copyFile(db.file + suffix, target + suffix).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
    const updates = cookieUpdates(path.join(temporary, "Default"));
    source = await launchOwnedChromeEndpoint({ userDataDir: temporary, childHome: userInfo().homedir, headless: false, loadExtensions: false });
    cdp = await connect(source.portFile);
    const { cookies } = await cdp.send<{ cookies: ChromeCookie[] }>("Storage.getCookies");
    const wanted = cookies.filter((cookie) => cookieMatchesHost(cookie.domain, new URL(site).hostname) && (cookie.session || cookie.expires > Date.now() / 1000));
    return { storage, cookies: wanted.map((cookie, id) => ({
      id, updated: updates.get(cookieKey(cookie)) ?? 0n, name: cookie.name, value: cookie.value, hostKey: cookie.domain, path: cookie.path,
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

async function seedLogin(portFile: string, login: LoginState): Promise<boolean> {
  const cdp = await connect(portFile);
  let targetId: string | undefined;
  try {
    ({ targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: true }));
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const send = (method: string, params: Record<string, unknown> = {}) => cdp.send(method, params, sessionId);
    const outcomes = await setCookiesOneAtATime({ setOne: (cookie) => cdp.send("Network.setCookie", { ...cookie }, sessionId) }, login.cookies);
    let stored = 0;
    if (login.storage.length) {
      const origins = [...new Set(login.storage.map((item) => item.origin))];
      cdp.on("Fetch.requestPaused", sessionId, (request) => {
        void send("Fetch.fulfillRequest", { requestId: request.requestId, responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "text/html" }],
          body: Buffer.from("<!doctype html><title>Bao</title>").toString("base64") }).catch(() => undefined);
      });
      await send("Fetch.enable", { patterns: origins.map((origin) => ({ urlPattern: `${origin}/*`, resourceType: "Document" })) });
      try {
        for (const origin of origins) {
          await send("Page.navigate", { url: `${origin}/` });
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
        await send("Fetch.disable");
      }
    }
    return outcomes.some((outcome) => outcome.ok) || stored > 0;
  } finally {
    if (targetId) await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
    cdp.close();
  }
}

export async function openBaoChromeForProxy(options: { sourceRoot: string; directory: string; home: string; site?: string; detached?: boolean }) {
  const profile = baoAgentProfileDir(options.home);
  assertNotDailyChrome(profile);
  const keptWindow = path.join(profile, "bao-kept-window");
  await mkdir(profile, { recursive: true });
  const token = randomUUID();
  const busy = () => new Error("The Bao profile is already open. Close that session before starting another.");
  const claim = () => writeFileSync(keptWindow, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
  let reclaim = false;
  try { claim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const marker = readFileSync(keptWindow, "utf8");
    const lease: { pid: number; retained?: boolean } = JSON.parse(marker);
    let ownerAlive = true;
    if (Number.isSafeInteger(lease.pid) && lease.pid > 1) {
      try { process.kill(lease.pid, 0); }
      catch (error) { ownerAlive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    }
    if (ownerAlive && !lease.retained) throw busy();
    if (readFileSync(keptWindow, "utf8") !== marker) throw busy();
    unlinkSync(keptWindow);
    try { claim(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw busy(); throw error; }
    reclaim = true;
  }
  const ownsProfile = () => {
    try { return (JSON.parse(readFileSync(keptWindow, "utf8")) as { token?: string }).token === token; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  };
  const retain = () => {
    if (ownsProfile()) writeFileSync(keptWindow, JSON.stringify({ pid: process.pid, token, retained: true }), { mode: 0o600 });
  };
  let chrome: Awaited<ReturnType<typeof launchOwnedChromeEndpoint>> | undefined;
  let launchAttempted = false;
  const close = async () => {
    if (!ownsProfile()) return;
    retain();
    await chrome?.close();
    if (ownsProfile() && !pidsForDataDir(profile).length) unlinkSync(keptWindow);
  };
  try {
    if (reclaim) await closeRetainedChrome(profile);
    if (!ownsProfile() || pidsForDataDir(profile).length) throw busy();
    const login = options.site ? await readChromeLogin(options, options.site, profile) : undefined;
    if (!ownsProfile()) throw busy();
    launchAttempted = true;
    chrome = await launchOwnedChromeEndpoint({ userDataDir: profile, keychain: "mock", headless: false,
      loadExtensions: false, detached: options.detached });
    const browser = chrome;
    const observed = new Map<string, { signature: string; updated: bigint }>();
    const liveCookies = async (initial = false) => {
      const updates = cookieUpdates(path.join(profile, "Default"));
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
          const updated = initial ? disk : !previous || previous.signature !== signature ? now : previous.updated > disk ? previous.updated : disk;
          observed.set(key, { signature, updated });
        }
        return live;
      } finally { cdp.close(); }
    };
    await liveCookies(true);
    const mergeLogin = async (login: LoginState): Promise<boolean> => {
      const live = await liveCookies();
      const cookies = login.cookies.filter((cookie) => {
        const key = cookieKey({ ...cookie, domain: cookie.hostKey });
        return !live.has(key) || cookie.updated > observed.get(key)!.updated;
      });
      if (!cookies.length && !login.storage.length) return false;
      const changed = await seedLogin(browser.portFile, { cookies, storage: login.storage });
      await liveCookies();
      return changed;
    };
    if (login) await mergeLogin(login);
    return {
      target: { kind: "bao" as const, portFile: browser.portFile },
      closed: browser.closed, isClosed: browser.isClosed, close,
      async keepOpen() {
        if (!ownsProfile()) return;
        retain();
        browser.keepOpen();
      },
      async importLogin(site: string): Promise<boolean> {
        if (!ownsProfile()) throw busy();
        return mergeLogin(await readChromeLogin(options, site));
      },
    };
  } catch (error) {
    if (!launchAttempted && !reclaim) {
      if (ownsProfile()) unlinkSync(keptWindow);
    } else await close();
    throw error;
  }
}
