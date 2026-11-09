import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { connectCdp } from "../../src/cdp-live/socket";
import { baoAgentProfileDir, openBaoChromeForProxy } from "../../src/engines/bao-profile";
import { BOUND_REASON, boundSessionSites, boundSite, deleteCookieRows, googleSignInCookie } from "../../src/engines/bound-sign-in";
import { copyChromeProfile } from "../../src/engines/chrome-profile-copy";
import { planWorkflowBrowser } from "../../src/engines/workflow-browser";
import * as launches from "../../src/launch";
import { withCookieDb } from "../../src/login-import/read";
import { boundSessions, chromeProfiles } from "../support/chrome-profiles";
import { chromeExpiry, writeCookieDb } from "./login-import-fixture";

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
