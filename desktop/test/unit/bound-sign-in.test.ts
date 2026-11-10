import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { connectCdp } from "../../src/cdp-live/socket";
import { baoAgentProfileDir, openBaoChromeForProxy } from "../../src/engines/bao-profile";
import * as bao from "../../src/engines/bao-profile";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import { BOUND_REASON, boundSessionSites, boundSite, deleteCookieRows, googleSignInCookie } from "../../src/engines/bound-sign-in";
import { boundLoginSite } from "../../src/login-import/import-login";
import { copyChromeProfile } from "../../src/engines/chrome-profile-copy";
import { startApp } from "../../src/app/server";
import * as currentChrome from "../../src/cdp-live/current-chrome";
import { testWorkflow } from "../support/workflow";
import { setCookiesOneAtATime } from "../../src/login-import/set-cookies";
import { openWorkflowBrowser, planWorkflowBrowser } from "../../src/engines/workflow-browser";
import * as launches from "../../src/launch";
import { withCookieDb } from "../../src/login-import/read";
import { boundSessions, chromeProfiles } from "../support/chrome-profiles";
import { chromeExpiry, writeCookieDb, writeLocalState } from "./login-import-fixture";

launches.pinTestBrowser();

const later = chromeExpiry(Date.now() + 86_400_000);
const JAR = [
  { host: ".google.com", name: "SID" }, { host: ".google.com", name: "__Secure-1PSIDTS" }, { host: ".google.com", name: "NID" },
  { host: "accounts.google.com", name: "__Host-GAPS" }, { host: ".youtube.com", name: "LOGIN_INFO" },
  { host: ".nytimes.com", name: "NYT-S" }, { host: ".bound.example", name: "session" },
  { host: ".news.example", name: "session" }, { host: ".news.example", name: "SID" },
].map((row) => ({ ...row, value: "fixture", expires: later }));

const rows = (profileDir: string) => withCookieDb(path.join(profileDir, "Cookies"),
  (db) => db.prepare("SELECT host_key, name FROM cookies ORDER BY host_key, name").all().map((row) => `${String(row.host_key)} ${String(row.name)}`));

test("a Google sign-in cookie is one of Google's sign-in names on a Google host", () => {
  for (const [host, name] of [[".google.com", "SID"], [".google.com", "__Secure-3PSIDCC"], [".google.co.uk", "__Secure-1PSIDTS"], ["accounts.google.com", "__Host-1PLSID"],
    [".google.de", "SAPISID"], ["mail.google.com", "OSID"], [".youtube.com", "LOGIN_INFO"], [".google.com", "__Secure-1PSIDRTS"]]) {
    assert.equal(googleSignInCookie(host!, name!), true, `${host} ${name}`);
  }
  for (const [host, name] of [[".google.com", "NID"], [".news.example", "SID"], [".google.com.evil.example", "SID"], [".notgoogle.com", "SID"]]) {
    assert.equal(googleSignInCookie(host!, name!), false, `${host} ${name}`);
  }
});

test("Google, YouTube, the Times, and any site in the profile's device-bound session table stay in the owner's Chrome", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-bound-sites-"));
  try {
    boundSessions(root, ["https://bound.example 3f9a", "https://google.com 77"]);
    assert.deepEqual(boundSessionSites(root), ["bound.example", "google.com"]);
    for (const url of ["https://www.google.com/maps/@40.7,-74", "https://google.co.uk/", "https://accounts.google.com/ListAccounts", "https://www.youtube.com/",
      "https://www.nytimes.com/2026/11/09/dining/best-pizza.html", "https://cooking.nytimes.com/", "https://app.bound.example/inbox"]) {
      assert.equal(boundSite(url, root), true, url);
    }
    for (const url of ["https://news.example/", "https://notnytimes.com/", "https://bound.example.org/", "about:blank"]) assert.equal(boundSite(url, root), false, url);
    assert.equal(boundSite("https://app.bound.example/", path.join(root, "missing")), false, "without the table only the fixed sites stay");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the import's cookie copy keeps only the target site's rows, and a purge drops Google sign-ins, the Times, and device-bound sites", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-cookie-rows-"));
  try {
    const strip = path.join(root, "strip");
    writeCookieDb(path.join(strip, "Cookies"), 24, JAR);
    assert.equal(deleteCookieRows(strip, { keepHost: "www.news.example" }), 7);
    assert.deepEqual(rows(strip), [".news.example SID", ".news.example session"]);
    const purge = path.join(root, "purge");
    writeCookieDb(path.join(purge, "Cookies"), 24, JAR);
    assert.equal(deleteCookieRows(purge, { sites: ["bound.example"] }), 6);
    assert.deepEqual(rows(purge), [".google.com NID", ".news.example SID", ".news.example session"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a Chrome copy carries no Google sign-in, Times cookie, device-bound site cookie, or device-bound session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-copy-bound-"));
  try {
    const sourceRoot = await chromeProfiles(path.join(root, "source"));
    writeCookieDb(path.join(sourceRoot, "Default", "Cookies"), 24, JAR);
    boundSessions(path.join(sourceRoot, "Default"), ["https://bound.example 1"]);
    const copy = await copyChromeProfile({ sourceRoot, directory: "Default", home: path.join(root, "home") });
    try {
      assert.deepEqual(rows(path.join(copy.userDataDir, "Default")), [".google.com NID", ".news.example SID", ".news.example session"]);
      assert.equal(existsSync(path.join(copy.userDataDir, "Default", "Device Bound Sessions")), false);
      assert.equal(rows(path.join(sourceRoot, "Default")).length, JAR.length, "the source profile is unchanged");
    } finally { await copy.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("opening Bao's profile purges the Google sign-in and Times cookies it already holds and keeps the rest", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-purge-"));
  const sourceRoot = await chromeProfiles(path.join(root, "source"));
  const home = path.join(root, "home");
  const launch = launches.launchOwnedChromeEndpoint;
  // No test browser reaches Google or the Times, even with their cookies in the jar.
  const offline = "--host-resolver-rules=MAP * ~NOTFOUND";
  t.mock.method(launches, "launchOwnedChromeEndpoint", (options: Parameters<typeof launch>[0]) => launch({ ...options, headless: true,
    appendArgs: [...options.appendArgs ?? [], offline] }));
  let chrome: Awaited<ReturnType<typeof openBaoChromeForProxy>> | undefined;
  try {
    const previous = await launches.launchOwnedChrome({ userDataDir: baoAgentProfileDir(home), headless: true, appendArgs: [offline] });
    try {
      await previous.addCookies([
        { name: "SID", value: "copied", url: "https://www.google.com" },
        { name: "NID", value: "visitor", url: "https://www.google.com" },
        { name: "NYT-S", value: "copied", url: "https://www.nytimes.com" },
        { name: "session", value: "keep", url: "https://news.example" },
      ]);
    } finally { await previous.close(); }
    chrome = await openBaoChromeForProxy({ sourceRoot, directory: "Default", home });
    const endpoint = await readDevToolsActivePort(chrome.target.portFile);
    const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
    try {
      const { cookies } = await cdp.send<{ cookies: { name: string; domain: string }[] }>("Storage.getCookies");
      assert.deepEqual(cookies.map((cookie) => `${cookie.domain} ${cookie.name}`).sort(), ["news.example session", "www.google.com NID"]);
    } finally { cdp.close(); }
  } finally {
    await chrome?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a workflow run on a site that ties its sign-in to Chrome plans running Chrome, unless it moves files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-workflow-bound-"));
  try {
    const sourceRoot = await chromeProfiles(path.join(root, "source"));
    const options = { home: path.join(root, "home"), sourceRoot, site: "https://www.nytimes.com/" };
    for (const browser of ["bao", "copy"] as const) {
      const plan = await planWorkflowBrowser({ ...options, browser });
      assert.deepEqual({ route: plan.route, why: plan.why }, { route: "current", why: BOUND_REASON }, browser);
      assert.equal((await planWorkflowBrowser({ ...options, browser, movesFiles: true })).route, browser);
    }
    assert.equal((await planWorkflowBrowser({ ...options, site: "https://news.example/", browser: "bao" })).route, "bao");
    const fallback = await planWorkflowBrowser({ ...options, sourceRoot: path.join(root, "no-chrome"), browser: "current", why: "the default" });
    assert.equal(fallback.route, "bao");
    assert.equal(fallback.why, "fallback when running Chrome could not be used");
    await assert.rejects(planWorkflowBrowser({ ...options, sourceRoot: path.join(root, "no-chrome"), browser: "current" }), /could not read Chrome's profiles/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the shared cookie write never writes a Google sign-in, a Times cookie, or a device-bound site's cookie", async () => {
  const written: string[] = [];
  const cookies = JAR.map((row, id) => ({ id, hostKey: row.host, name: row.name, path: "/", secure: true, httpOnly: true, sameSite: 1,
    expired: false, botVendor: null, value: "fixture" }));
  const outcomes = await setCookiesOneAtATime({ async setOne(cookie) { written.push(`${cookie.domain ?? new URL(cookie.url).hostname} ${cookie.name}`); return { success: true }; } },
    cookies, ["bound.example"]);
  assert.deepEqual(written, [".google.com NID", ".news.example session", ".news.example SID"]);
  assert.equal(outcomes.length, 3, "a cookie Bao must not hold is skipped, not reported as written");
});

test("the app's Login sites refuse Google, YouTube, the Times, and a device-bound site before any import or probe", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-login-bound-"));
  const userData = path.join(root, "chrome");
  writeLocalState(userData, [{ directory: "Default", name: "Owner", email: "owner@example.test" }]);
  writeCookieDb(path.join(userData, "Default", "Cookies"), 24, JAR);
  boundSessions(path.join(userData, "Default"), ["https://bound.example 1"]);
  const baoProfile = path.join(root, "home", "chrome-profile");
  const app = await startApp({ home: path.join(root, "home"), chromeUserData: userData, baoProfile, loginPlatform: "darwin",
    loginKeys: { platform: "darwin", secretError: "prompt-missed" } });
  const call = async (method: string, route: string, body: Record<string, unknown>) => {
    const res = await fetch(`http://127.0.0.1:${app.port}${route}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, error: (await res.json() as { error?: string }).error };
  };
  try {
    for (const site of ["https://www.google.com/maps", "https://www.youtube.com/", "https://www.nytimes.com/"]) {
      const host = new URL(site).hostname;
      const line = `The site ${host} ties its sign-in to your Chrome, so Bao does not import it as a Login site. Bao opens it in your running Chrome instead.`;
      assert.deepEqual(await call("POST", "/api/login-import/preview", { site, consent: true }), { status: 400, error: line }, site);
      assert.deepEqual(await call("POST", "/api/login-import", { site, consent: true, profile: "Default" }), { status: 400, error: line }, site);
      assert.deepEqual(await call("POST", "/api/login-import/sign-in", { site, consent: true }), { status: 400, error: line }, site);
      assert.deepEqual(await call("PUT", "/api/login-sites", { origin: site }), { status: 400, error: line }, site);
    }
    const boundLine = "The site app.bound.example ties its sign-in to your Chrome, so Bao does not import it as a Login site. Bao opens it in your running Chrome instead.";
    assert.deepEqual(await call("POST", "/api/login-import", { site: "https://app.bound.example/", consent: true, profile: "Default" }), { status: 400, error: boundLine });
    assert.deepEqual(await call("POST", "/api/login-import/preview", { site: "https://app.bound.example/", consent: true }), { status: 400, error: boundLine }, "preview");
    assert.deepEqual(await call("PUT", "/api/login-sites", { origin: "https://app.bound.example/" }), { status: 400, error: boundLine }, "put");
    assert.deepEqual(await call("POST", "/api/login-import/sign-in", { site: "https://app.bound.example/", consent: true }), { status: 400, error: boundLine }, "sign-in");
    const listed = await (await fetch(`http://127.0.0.1:${app.port}/api/login-sites`)).json() as { sites: { origin: string }[] };
    assert.deepEqual(listed.sites, [], "no refused site is saved as a Login site");
    await writeFile(path.join(root, "home", "login-sites.json"), JSON.stringify({ sites: [{ origin: "https://app.bound.example", probeUrl: "https://app.bound.example", signedInSelector: "", signedInText: "", botCookies: "skip", origins: [] }] }));
    assert.deepEqual(await call("POST", "/api/login-sites/recheck", { origin: "https://app.bound.example" }), { status: 400, error: boundLine }, "recheck");
    assert.equal(existsSync(baoProfile), false, "no refused site started Bao's Chrome");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a Chrome copy is not signed in to Chrome: no Google refresh token and no signed-in account, with autofill kept", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-copy-token-"));
  try {
    const sourceRoot = await chromeProfiles(path.join(root, "source"));
    const source = path.join(sourceRoot, "Default");
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void } };
    const web = new DatabaseSync(path.join(source, "Web Data"));
    web.exec("CREATE TABLE token_service (service VARCHAR PRIMARY KEY NOT NULL, encrypted_token BLOB)");
    web.exec("INSERT INTO token_service VALUES ('AccountId-1234', x'7631300102')");
    web.exec("CREATE TABLE autofill (name VARCHAR, value VARCHAR)");
    web.exec("INSERT INTO autofill VALUES ('email', 'owner@example.test')");
    web.close();
    await writeFile(path.join(source, "Preferences"), JSON.stringify({
      account_info: [{ account_id: "1234", email: "owner@example.test", gaia: "1234" }],
      google: { services: { account_id: "1234", last_account_id: "1234", last_gaia_id: "1234", last_username: "owner@example.test", signin_scoped_device_id: "d", kept: 1 } },
      signin: { allowed: true, explicit_browser_signin: true },
      intl: { accept_languages: "en-US" },
    }));
    const copy = await copyChromeProfile({ sourceRoot, directory: "Default", home: path.join(root, "home") });
    try {
      const copied = path.join(copy.userDataDir, "Default");
      const read = (file: string, sql: string) => withCookieDb(file, (db) => db.prepare(sql).all().map((row) => Object.values(row).join(" ")));
      assert.deepEqual(read(path.join(copied, "Web Data"), "SELECT service FROM token_service"), []);
      assert.deepEqual(read(path.join(copied, "Web Data"), "SELECT name, value FROM autofill"), ["email owner@example.test"]);
      const preferences = JSON.parse(await readFile(path.join(copied, "Preferences"), "utf8")) as Record<string, unknown>;
      assert.equal(preferences.account_info, undefined);
      assert.deepEqual(preferences.google, { services: { kept: 1 } });
      assert.deepEqual(preferences.signin, { allowed: true }, "the sign-in policy stays; only the account goes");
      assert.deepEqual(preferences.intl, { accept_languages: "en-US" });
      assert.deepEqual(read(path.join(source, "Web Data"), "SELECT service FROM token_service"), ["AccountId-1234"], "the source profile is unchanged");
    } finally { await copy.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the app's own Bao profile also drops the Google sign-in and Times cookies it holds before its Chrome starts", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-app-purge-"));
  const offline = ["--host-resolver-rules=MAP * ~NOTFOUND"];
  const userDataDir = path.join(root, "home", "chrome-profile");
  try {
    const previous = await launches.launchOwnedChrome({ userDataDir, headless: true, appendArgs: offline });
    try {
      await previous.addCookies([
        { name: "SID", value: "copied", url: "https://www.google.com" },
        { name: "__Secure-1PSIDTS", value: "copied", url: "https://www.google.com" },
        { name: "NID", value: "visitor", url: "https://www.google.com" },
        { name: "NYT-S", value: "copied", url: "https://www.nytimes.com" },
        { name: "session", value: "keep", url: "https://news.example" },
      ]);
    } finally { await previous.close(); }
    const next = await launches.launchOwnedChrome({ userDataDir, headless: true, appendArgs: offline });
    try {
      assert.deepEqual((await next.cookies()).map((cookie) => `${cookie.domain} ${cookie.name}`).sort(), ["news.example session", "www.google.com NID"]);
    } finally { await next.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an app run of a Times page on the Bao profile tries running Chrome, then falls back to the app's own profile", { timeout: 90_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-app-bound-"));
  const home = path.join(root, "home");
  const baoProfile = path.join(home, "chrome-profile");
  const sourceRoot = await chromeProfiles(path.join(root, "source"));
  const tried: string[] = [];
  t.mock.method(currentChrome, "openCurrentChrome", async (options: { root: string }) => { tried.push(options.root); throw new Error("no running Chrome in tests"); });
  const launch = launches.launchOwnedChrome;
  const launched: string[] = [];
  // No test browser reaches the Times.
  t.mock.method(launches, "launchOwnedChrome", (options: Parameters<typeof launch>[0]) => {
    launched.push(options.userDataDir);
    return launch({ ...options, headless: true, appendArgs: [...options.appendArgs ?? [], "--host-resolver-rules=MAP * ~NOTFOUND"] });
  });
  const app = await startApp({ home, baoProfile, chromeProfilesRoot: sourceRoot });
  try {
    app.library.save(testWorkflow({ id: "pizza", startUrl: "https://www.nytimes.com/2026/11/09/dining/best-pizza.html", steps: [] }));
    await fetch(`http://127.0.0.1:${app.port}/api/replay`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "pizza", browser: "bao", args: {} }) });
    assert.deepEqual(tried, [sourceRoot], "the Times page goes to running Chrome even with the Bao profile picked");
    assert.deepEqual(launched, [baoProfile], "the fallback opens the app's own Bao profile, not the agent profile");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a bound site on a named route remembers that route, and the extension gate sends it through the extension", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-bound-plan-"));
  try {
    const sourceRoot = await chromeProfiles(path.join(root, "source"));
    const options = { home: path.join(root, "home"), sourceRoot, site: "https://www.nytimes.com/", browser: "bao" as const };
    const plan = await planWorkflowBrowser(options);
    assert.equal(plan.route, "current");
    assert.equal("from" in plan ? plan.from : undefined, "bao");
    const copy = await planWorkflowBrowser({ ...options, browser: "copy" });
    assert.equal("from" in copy ? copy.from : undefined, "copy");
    const extension = await planWorkflowBrowser({ ...options, extensionRoute: true });
    assert.deepEqual({ route: extension.route, why: extension.why }, { route: "extension", why: BOUND_REASON });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a Login site check with no profile uses the Settings profile, or every profile when none is picked", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-bound-login-"));
  const userData = path.join(root, "chrome");
  writeLocalState(userData, [
    { directory: "Default", name: "Owner", email: "owner@example.test" },
    { directory: "Profile 2", name: "Other", email: "other@example.test" },
  ]);
  boundSessions(path.join(userData, "Default"), ["https://bound.example 1"]);
  boundSessions(path.join(userData, "Profile 2"), ["https://other.example 1"]);
  try {
    assert.match(boundLoginSite("https://bound.example/", userData) ?? "", /bound\.example/);
    assert.match(boundLoginSite("https://other.example/", userData) ?? "", /other\.example/);
    assert.match(boundLoginSite("https://bound.example/", userData, undefined, "Default") ?? "", /bound\.example/);
    assert.equal(boundLoginSite("https://other.example/", userData, undefined, "Default"), undefined);
    assert.match(boundLoginSite("https://other.example/", userData, "Profile 2", "Default") ?? "", /other\.example/,
      "a passed import profile is the one being imported, not the Settings profile");
    assert.match(boundLoginSite("https://www.nytimes.com/") ?? "", /www\.nytimes\.com/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Bao profile open purges the owner list and the imported profile's device-bound sites", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-agent-bound-sites-"));
  const sourceRoot = await chromeProfiles(path.join(root, "source"), {
    Default: { name: "Owner" },
    "Profile 2": { name: "Other" },
  });
  boundSessions(path.join(sourceRoot, "Default"), ["https://bound.example 1"]);
  boundSessions(path.join(sourceRoot, "Profile 2"), ["https://other.example 1"]);
  const seen: string[][] = [];
  t.mock.method(bao, "openBaoChromeForProxy", async (options: { boundSites?: readonly string[] }) => {
    seen.push([...(options.boundSites ?? [])].sort());
    throw new Error("stop before Chrome");
  });
  const home = path.join(root, "home");
  const open = (proxy: AgentBrowserProxy, profile: string) => proxy.execute("open", ["https://news.example/"], "bao", false, profile);
  const agent = (settings?: string) => new AgentBrowserProxy({ home, sourceRoot, executable: process.execPath, ...settings ? { settingsProfile: () => settings } : {} });
  try {
    await assert.rejects(open(agent(), "Profile 2"), /stop before Chrome/);
    assert.deepEqual(seen.at(-1), ["bound.example", "other.example"], "no Settings pick purges every profile, plus the import");
    await assert.rejects(open(agent("Default"), "Profile 2"), /stop before Chrome/);
    assert.deepEqual(seen.at(-1), ["bound.example", "other.example"], "the Settings profile joins the imported profile");
    await assert.rejects(openWorkflowBrowser({ browser: "bao", home, site: "https://news.example/", sourceRoot, profile: "Profile 2" }), /stop before Chrome/);
    assert.deepEqual(seen.at(-1), ["bound.example", "other.example"]);
    await assert.rejects(openWorkflowBrowser({
      browser: "bao", home, site: "https://news.example/", sourceRoot, directory: "Profile 2", profile: "Default",
    }), /stop before Chrome/);
    assert.deepEqual(seen.at(-1), ["bound.example", "other.example"], "a workflow passes the Settings directory and the import profile");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a lasting profile launch drops a device-bound site's cookies when the caller names that site", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-bound-purge-"));
  const userDataDir = path.join(root, "profile");
  const offline = ["--host-resolver-rules=MAP * ~NOTFOUND"];
  try {
    const previous = await launches.launchOwnedChrome({ userDataDir, headless: true, appendArgs: offline });
    try {
      await previous.addCookies([
        { name: "session", value: "bound", url: "https://bound.example" },
        { name: "session", value: "keep", url: "https://news.example" },
      ]);
    } finally { await previous.close(); }
    const next = await launches.launchOwnedChrome({ userDataDir, headless: true, appendArgs: offline, boundSites: ["bound.example"] });
    try {
      assert.deepEqual((await next.cookies()).map((cookie) => `${cookie.domain} ${cookie.name}`).sort(), ["news.example session"]);
    } finally { await next.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the app passes the owner's device-bound sites into a lasting profile launch", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-app-bound-sites-"));
  const home = path.join(root, "home");
  const userData = path.join(root, "chrome");
  writeLocalState(userData, [
    { directory: "Default", name: "Owner", email: "owner@example.test" },
    { directory: "Profile 2", name: "Other", email: "other@example.test" },
  ]);
  boundSessions(path.join(userData, "Default"), ["https://bound.example 1"]);
  boundSessions(path.join(userData, "Profile 2"), ["https://other.example 1"]);
  const seen: string[][] = [];
  t.mock.method(launches, "launchOwnedChrome", async (options: { boundSites?: readonly string[] }) => {
    seen.push([...(options.boundSites ?? [])]);
    throw new Error("stop before Chrome");
  });
  const app = await startApp({ home, chromeUserData: userData, baoProfile: path.join(home, "chrome-profile") });
  const ask = () => fetch(`http://127.0.0.1:${app.port}/api/site/query`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  try {
    assert.equal((await ask()).status, 500);
    assert.deepEqual(seen.at(-1)?.sort(), ["bound.example", "other.example"]);
    app.library.updateSettings({ chromeProfile: "Default" });
    assert.equal((await ask()).status, 500);
    assert.deepEqual(seen.at(-1), ["bound.example"]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
