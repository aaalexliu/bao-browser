import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { readDevToolsActivePort } from "../cdp-live/endpoint";
import { connectCdp, type CdpSocket } from "../cdp-live/socket";
import { launchOwnedChromeEndpoint, pidsForDataDir } from "../launch";
import { assertNotDailyChrome } from "../profile";
import { cookieMatchesHost, findCookieDb, summarizeDb, withCookieDb, type DecryptedCookie } from "../login-import/read";
import { setCookiesOneAtATime } from "../login-import/set-cookies";
import { copyIndexedDb, matchingIndexedDbOrigins, readLocalStorage, setLocalStorageItems, type StorageItem } from "../login-import/storage";

interface LoginState {
  cookies: DecryptedCookie[];
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

async function hasSiteData(profile: string, site: string): Promise<boolean> {
  const origin = new URL(site).origin;
  const directory = path.join(profile, "Default");
  const db = findCookieDb(directory);
  if (db && withCookieDb(db.file, (sqlite) => summarizeDb(sqlite, new URL(site).hostname, "include", Date.now()).willImport) > 0) return true;
  return (await readLocalStorage(directory, [origin])).length > 0 || matchingIndexedDbOrigins(directory, [origin]).length > 0;
}

async function connect(portFile: string): Promise<CdpSocket> {
  const endpoint = await readDevToolsActivePort(portFile);
  return connectCdp(endpoint.port, endpoint.browserPath);
}

async function readChromeLogin(options: { sourceRoot: string; directory: string }, site: string, destination?: string): Promise<LoginState> {
  const profile = path.join(options.sourceRoot, options.directory);
  const origins = [new URL(site).origin];
  const storage = await readLocalStorage(profile, origins);
  if (destination) copyIndexedDb(profile, destination, origins);
  const db = findCookieDb(profile);
  if (!db) return { cookies: [], storage };
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
    source = await launchOwnedChromeEndpoint({ userDataDir: temporary, childHome: userInfo().homedir, headless: false, loadExtensions: false });
    cdp = await connect(source.portFile);
    const { cookies } = await cdp.send<{ cookies: ChromeCookie[] }>("Storage.getCookies");
    const wanted = cookies.filter((cookie) => cookieMatchesHost(cookie.domain, new URL(site).hostname) && (cookie.session || cookie.expires > Date.now() / 1000));
    return { storage, cookies: wanted.map((cookie, id) => ({
      id, name: cookie.name, value: cookie.value, hostKey: cookie.domain, path: cookie.path,
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
            const result = await cdp.send<{ result: { value?: string } }>("Runtime.evaluate", { expression: "location.origin", returnByValue: true }, sessionId);
            if (result.result.value === origin) break;
            if (Date.now() >= deadline) throw new Error("Bao could not prepare the site's storage");
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          stored += await setLocalStorageItems(send, login.storage.filter((item) => item.origin === origin));
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
  if (await readFile(keptWindow, "utf8").catch(() => "") === "kept") {
    if (pidsForDataDir(profile).length) {
      const previous = await connect(path.join(profile, "DevToolsActivePort"));
      try { await previous.send("Browser.close", {}, undefined, 3000).catch(() => undefined); }
      finally { previous.close(); }
      const deadline = Date.now() + 5000;
      while (pidsForDataDir(profile).length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }
  if (pidsForDataDir(profile).length) throw new Error("The Bao profile is already open. Close that session before starting another.");
  await rm(keptWindow, { force: true });
  const login = options.site && !await hasSiteData(profile, options.site)
    ? await readChromeLogin(options, options.site, profile) : undefined;
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: profile, keychain: "mock", headless: false,
    loadExtensions: false, detached: options.detached });
  try {
    if (login) await seedLogin(chrome.portFile, login);
    return {
      target: { kind: "bao" as const, portFile: chrome.portFile },
      closed: chrome.closed, isClosed: chrome.isClosed, close: chrome.close,
      async keepOpen() {
        await writeFile(keptWindow, "kept");
        chrome.keepOpen();
      },
      async importLogin(site: string, force = false): Promise<boolean> {
        if (!force && await hasSiteData(profile, site)) return false;
        return seedLogin(chrome.portFile, await readChromeLogin(options, site));
      },
    };
  } catch (error) {
    await chrome.close();
    throw error;
  }
}
