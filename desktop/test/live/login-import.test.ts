// The test Chromium, synthetic profile only. The cookie values and storage values
// below are fixtures. Assertions must not include them in failure text.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright";
import { testChromium as chromium } from "../../src/test-browser.js";
import { startApp } from "../../src/app/server";
import { launchOwnedChrome, pinTestBrowser } from "../../src/launch";
import { encryptCookieValue, LINUX_ITERATIONS, LINUX_PEANUTS, plaintextForCookie } from "../../src/login-import/crypto";
import { indexedDbIdentifier } from "../../src/login-import/storage";
import type { WorkflowV2 } from "../../src/v1/schema";
import { testArtifacts } from "../artifacts";
import { cookieKeys } from "../runtime";
import { assertNoValue, chromeExpiry, tempDir, TINY_PNG, writeCookieDb, writeLocalState } from "../unit/login-import-fixture";

const SESSION = "session-secret-9f3c";
const DEVICE = "device-secret-9f3c";
const OTHER = "other-secret-9f3c";
const ARTIFACTS = testArtifacts("login-import");
const TEST_BROWSER = pinTestBrowser();

/**
 * The test Chromium applies Chromium's field-trial testing config, which keeps
 * IndexedDB in SQLite. The import copies the LevelDB layout, so the profiles
 * that write or read IndexedDB here turn the SQLite store off.
 */
function launchLevelDbProfile(userDataDir: string): ReturnType<typeof launchOwnedChrome> {
  return launchOwnedChrome({ userDataDir, headless: true, args: ["--disable-features=IdbSqliteBackingStore,IdbSqliteOnDiskRollout"] });
}

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate((next) => localStorage.setItem("bao-theme", next), theme);
  await page.waitForFunction((next) => document.documentElement.dataset.theme === next, theme);
}

test("import cookies, localStorage, and IndexedDB, then block a dead session", { timeout: 180_000 }, async () => {
  mkdirSync(ARTIFACTS, { recursive: true });
  for (const stale of ["login-picker.png", "login-signed-in.png", "login-signed-out-bot.png", "login-keychain-missed.png"]) {
    rmSync(path.join(ARTIFACTS, stale), { force: true });
  }
  const server = await startSite();
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const userData = tempDir("bao-live-chrome-");
  const home = tempDir("bao-live-home-");
  const baoProfile = path.join(home, "chrome-profile");
  writeLocalState(userData, [
    { directory: "Default", name: "Ada Lovelace", email: "ada@example.com", avatar: TINY_PNG },
    { directory: "Profile 1", name: "Grace Hopper", email: "grace@example.com" },
  ]);
  await writeChromeStorage(userData, port);
  writeLocalState(userData, [
    { directory: "Default", name: "Ada Lovelace", email: "ada@example.com", avatar: TINY_PNG },
    { directory: "Profile 1", name: "Grace Hopper", email: "grace@example.com" },
  ]);
  const session = encryptCookieValue(plaintextForCookie("127.0.0.1", SESSION, true), LINUX_PEANUTS, LINUX_ITERATIONS, "v10");
  const expires = chromeExpiry(Date.now() + 86_400_000);
  writeCookieDb(path.join(userData, "Default", "Network", "Cookies"), 24, [
    { host: "127.0.0.1", name: "session", encrypted: session, path: "/", sameSite: 1, expires },
  ]);
  writeCookieDb(path.join(userData, "Profile 1", "Network", "Cookies"), 24, [
    { host: "127.0.0.1", name: "session", encrypted: session, path: "/", sameSite: 1, expires },
    { host: "127.0.0.1", name: "reese84", value: "bot-body", path: "/", sameSite: 1, expires },
  ]);

  const app = await startApp({
    home,
    chromeUserData: userData,
    baoProfile,
    loginKeys: cookieKeys("synthetic-linux", process.platform),
  });
  const browser = await chromium.launch({ executablePath: TEST_BROWSER, headless: true });
  const ui = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  try {
    await ui.goto(`http://127.0.0.1:${app.port}/`);
    await ui.evaluate(() => localStorage.removeItem("bao-theme"));
    await ui.reload();
    await ui.click("nav button[data-screen=logins]");
    await ui.fill("#login-site", `${origin}/account`);
    await ui.click("#show-profiles");
    try {
      await ui.waitForSelector("[data-import-profile=Default]", { timeout: 30_000 });
    } catch {
      const text = await ui.locator("body").innerText();
      throw new Error(`profile picker did not open\n${text.slice(0, 800)}`);
    }
    const picker = await ui.locator("body").innerText();
    if (!picker.includes("Ada Lovelace") || !picker.includes("ada@example.com")) throw new Error("picker missed Ada");
    if (!picker.includes("Grace Hopper") || !picker.includes("grace@example.com")) throw new Error("picker missed Grace");
    if (!picker.includes("localStorage")) throw new Error("picker missed localStorage counts");
    if (!picker.includes("Advanced")) throw new Error("advanced disclosure was missing");
    assertNoValue(picker, SESSION);
    assertNoValue(picker, DEVICE);
    assertNoValue(picker, OTHER);
    const selected = await ui.locator("[data-import-profile='Profile 1']").getAttribute("aria-pressed");
    if (selected !== "true") throw new Error("profile with the most matches was not selected");
    const initials = (await ui.locator("[data-import-profile='Profile 1'] .avatar").innerText()).trim();
    if (initials !== "GH") throw new Error("profile without a picture did not show initials");
    const adaMark = (await ui.locator("[data-import-profile=Default] .avatar").innerText()).trim();
    if (adaMark !== "AL") throw new Error("flat profile picture did not use initials");
    const adaBg = await ui.locator("[data-import-profile=Default] .avatar").evaluate((el) => el.style.backgroundColor || el.style.background);
    if (!/ff8080|255,\s*128,\s*128/i.test(String(adaBg))) throw new Error("initials were not drawn on the picture color");
    const act = await ui.locator("#act-bar").innerText();
    if (!act.includes("You need to act")) throw new Error("import act bar was missing");
    if (!act.includes("Grace Hopper")) throw new Error("act bar did not name the selected profile");
    await ui.screenshot({ path: path.join(ARTIFACTS, "login-picker-light.png"), fullPage: true });
    await setTheme(ui, "dark");
    await ui.screenshot({ path: path.join(ARTIFACTS, "login-picker-dark.png"), fullPage: true });
    await setTheme(ui, "light");
    await ui.click("#import-decline");
    await ui.waitForFunction(() => !document.querySelector("#act-bar"));
    await ui.click("#show-profiles");
    await ui.waitForSelector("#act-bar");

    await ui.click("[data-import-profile=Default]");
    await ui.click("#import-selected");
    await ui.waitForFunction(() => (document.querySelector("#login-result")?.textContent || "").includes("Signed in: yes"));
    const yes = await ui.locator("#login-result").innerText();
    if (!yes.includes("Signed in: yes")) throw new Error("import did not report signed in");
    if (!yes.includes("localStorage")) throw new Error("import did not report localStorage");
    if (!yes.includes("IndexedDB")) throw new Error("import did not report IndexedDB");
    assertNoValue(yes, SESSION);
    assertNoValue(yes, DEVICE);
    if (await ui.locator("#act-bar").count() !== 0) throw new Error("act bar stayed after import");
    await ui.waitForFunction(() => (document.querySelector("#saved-logins")?.textContent || "").includes("Live"));
    const savedText = await ui.locator("#saved-logins").innerText();
    if (!/UTC|GMT|EDT|EST|PDT|PST/.test(savedText)) throw new Error("probe time has no zone label");
    if (process.env.TZ === "America/New_York" && !/EDT|EST/.test(savedText)) throw new Error("probe time ignored America/New_York");
    await ui.screenshot({ path: path.join(ARTIFACTS, "login-saved-light.png"), fullPage: true });
    await setTheme(ui, "dark");
    await ui.screenshot({ path: path.join(ARTIFACTS, "login-saved-dark.png"), fullPage: true });
    await setTheme(ui, "light");
    const recheck = ui.waitForResponse((res) => res.url().includes("/api/login-sites/recheck") && res.ok());
    await ui.click("[data-recheck]");
    await recheck;
    await ui.waitForFunction(() => (document.querySelector("#saved-logins")?.textContent || "").includes("Live"));

    await ui.click("#login-advanced summary");
    await ui.fill("#login-probe", `${origin}/strict`);
    await ui.click("[data-import-profile=\"Profile 1\"]");
    await ui.click("#import-selected");
    await ui.waitForFunction(() => (document.querySelector("#login-result")?.textContent || "").includes("Imperva"));
    const no = await ui.locator("#login-result").innerText();
    if (!no.includes("Signed in: no")) throw new Error("bot-cookie import did not report signed out");
    if (!no.includes("Imperva")) throw new Error("bot-cookie explanation did not name Imperva");
    if (!no.includes("Sign in once in Bao's window")) throw new Error("bot-cookie explanation missed the sign-in path");
    assertNoValue(no, SESSION);
    assertNoValue(no, "bot-body");
    await ui.waitForFunction(() => (document.querySelector("#saved-logins")?.textContent || "").includes("Needs sign-in"));
    await ui.screenshot({ path: path.join(ARTIFACTS, "login-signed-out-bot-light.png"), fullPage: true });
    await ui.click("[data-remove]");
    await ui.waitForFunction(() => (document.querySelector("#saved-logins")?.textContent || "").includes("No sites yet"));

    await assertRestored(baoProfile, origin, port);
    await assertNeedsSignIn(app.port, app.library, origin);
  } finally {
    await browser.close().catch(() => undefined);
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const keyHome = tempDir("bao-live-key-");
  const keyApp = await startApp({
    home: keyHome,
    chromeUserData: userData,
    baoProfile: path.join(keyHome, "chrome-profile"),
    loginPlatform: "darwin",
    loginKeys: { platform: "darwin", secretError: "prompt-missed" },
  });
  const keyBrowser = await chromium.launch({ executablePath: TEST_BROWSER, headless: true });
  const keyUi = await keyBrowser.newPage({ viewport: { width: 1100, height: 1100 } });
  try {
    await keyUi.goto(`http://127.0.0.1:${keyApp.port}/`);
    await keyUi.click("nav button[data-screen=logins]");
    await keyUi.fill("#login-site", `${origin}/account`);
    await keyUi.click("#show-profiles");
    await keyUi.waitForSelector("[data-import-profile=Default]");
    const note = await keyUi.locator("body").innerText();
    if (!note.includes("Click Always Allow.")) throw new Error("preview missed the keychain copy");
    await keyUi.click("[data-import-profile=Default]");
    await keyUi.click("#import-selected");
    await keyUi.waitForSelector("#login-result");
    const missed = await keyUi.locator("#login-result").innerText();
    if (!missed.includes("Imported 0. Signed in: no.")) throw new Error("missed prompt did not stop the import");
    if (!missed.includes("Click Always Allow.")) throw new Error("missed prompt missed the Always Allow copy");
    if (!missed.includes("A missed prompt does not mean the password was wrong.")) throw new Error("missed prompt copy changed");
    assertNoValue(missed, SESSION);
    if (existsSync(path.join(keyHome, "chrome-profile"))) throw new Error("a missed keychain prompt launched Chrome");
    if (await keyUi.locator("#act-bar").count() !== 0) throw new Error("act bar stayed after the keychain result");
    await keyUi.screenshot({ path: path.join(ARTIFACTS, "login-keychain-missed-light.png"), fullPage: true });
    await setTheme(keyUi, "dark");
    await keyUi.screenshot({ path: path.join(ARTIFACTS, "login-keychain-missed-dark.png"), fullPage: true });
  } finally {
    await keyBrowser.close().catch(() => undefined);
    await keyApp.close();
  }
});

test("a session cookie survives relaunching bao's Chrome", { timeout: 120_000 }, async () => {
  const server = await startSite();
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const baoProfile = tempDir("bao-session-profile-");
  const first = await launchOwnedChrome({ userDataDir: baoProfile, headless: true });
  try {
    const page = first.pages()[0] || await first.newPage();
    await page.goto(`${origin}/login`, { waitUntil: "domcontentloaded" });
    await page.evaluate((value) => { document.cookie = `session=${value}; path=/`; }, SESSION);
    const cookies = await first.cookies(origin);
    const session = cookies.find((cookie) => cookie.name === "session");
    if (!session || session.expires !== -1) throw new Error("the cookie was not a session cookie");
  } finally {
    await first.close();
  }
  const onDisk = sessionCookieOnDisk(baoProfile);
  if (!onDisk) throw new Error("session cookie was not on disk after Chrome exited");
  if (onDisk.expires !== "0") throw new Error("Chrome stored an expiry on the session cookie");
  const again = await launchOwnedChrome({ userDataDir: baoProfile, headless: true });
  try {
    const page = again.pages()[0] || await again.newPage();
    await page.goto(`${origin}/account`, { waitUntil: "domcontentloaded" });
    if (page.url().includes("/login")) throw new Error("session cookie did not survive relaunch");
  } finally {
    await again.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("import a public demo login, then block the run after the cookie is cleared", { timeout: 180_000 }, async () => {
  const userData = tempDir("bao-public-chrome-");
  const home = tempDir("bao-public-home-");
  const baoProfile = path.join(home, "chrome-profile");
  if (userData.includes(`${path.sep}.config${path.sep}google-chrome`) || userData.includes(`${path.sep}Google${path.sep}Chrome`)) {
    throw new Error("the public login used a real Chrome profile");
  }
  await signIntoDemo(userData);
  writeLocalState(userData, [{ directory: "Default", name: "Tom Smith", email: "tomsmith@example.com" }]);
  const app = await startApp({
    home,
    chromeUserData: userData,
    baoProfile,
    loginKeys: cookieKeys("browser", process.platform),
  });
  const browser = await chromium.launch({ executablePath: TEST_BROWSER, headless: true });
  const ui = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  const probe = "https://the-internet.herokuapp.com/secure";
  try {
    await ui.goto(`http://127.0.0.1:${app.port}/`);
    await ui.evaluate(() => localStorage.removeItem("bao-theme"));
    await ui.reload();
    await ui.click("nav button[data-screen=logins]");
    await ui.fill("#login-site", probe);
    await ui.click("#show-profiles");
    await ui.waitForSelector("[data-import-profile=Default]");
    const picker = await ui.locator("body").innerText();
    if (!picker.includes("Tom Smith")) throw new Error("public profile picker missed the throwaway profile");
    if (picker.includes("SuperSecretPassword")) throw new Error("the demo password was shown");
    await ui.click("#import-selected");
    await ui.waitForFunction(() => (document.querySelector("#login-result")?.textContent || "").includes("Signed in: yes"), undefined, { timeout: 60_000 });
    if (await ui.locator("#act-bar").count() !== 0) throw new Error("act bar stayed after the public import");
    await ui.waitForFunction(() => (document.querySelector("#saved-logins")?.textContent || "").includes("Live"));
    const signedIn = await ui.locator("body").innerText();
    if (!signedIn.includes("Signed in: yes") || !signedIn.includes("Live")) throw new Error("public import did not show a live session");
    if (signedIn.includes("SuperSecretPassword")) throw new Error("the demo password was shown");
    await ui.screenshot({ path: path.join(ARTIFACTS, "login-signed-in-light.png"), fullPage: true });

    await clearBaoCookies(baoProfile);
    const workflow: WorkflowV2 = {
      schema: "bao.workflow/v2",
      version: 2,
      id: "wf-public",
      name: "Public gate",
      startUrl: probe,
      inputs: [],
      steps: [{
        id: "s1",
        index: 0,
        action: "click",
        label: "Go",
        surface: "dom",
        timeoutMs: 1000,
        identity: { surface: "dom", role: "button", testId: "missing", path: [] },
      }],
      createdAt: 1,
    };
    app.library.save(workflow);
    await ui.click("nav button[data-screen=replay]");
    await ui.waitForSelector("#wf");
    await ui.selectOption("#wf", workflow.id);
    await ui.click("#run");
    await ui.waitForFunction(() => (document.querySelector("#run-status")?.textContent || "").includes("Needs sign-in"), undefined, { timeout: 60_000 });
    const gate = await ui.locator("#live").innerText();
    if (!gate.includes("Needs sign-in")) throw new Error("the pre-run gate did not block");
    if (!gate.includes("The session is not live")) throw new Error("needs sign-in copy was missing");
    if (gate.includes("SuperSecretPassword")) throw new Error("the demo password was shown");
    await ui.screenshot({ path: path.join(ARTIFACTS, "login-needs-sign-in-light.png"), fullPage: true });
    process.env.BAO_SIGNIN_SHOT = path.join(ARTIFACTS, "login-sign-in-window.png");
    const opened = ui.waitForResponse((res) => res.url().includes("/api/login-import/sign-in"));
    await ui.click("#run-sign-in");
    const signRes = await opened;
    const signBody = await signRes.json() as { opened?: boolean; url?: string; error?: string };
    if (!signRes.ok() || signBody.opened !== true) throw new Error("sign-in did not open Bao's Chrome");
    if (signBody.url !== probe) throw new Error("sign-in did not open the probe URL");
    if (!existsSync(process.env.BAO_SIGNIN_SHOT)) throw new Error("sign-in window shot was not written");
    if (readFileSync(process.env.BAO_SIGNIN_SHOT).length < 5000) throw new Error("sign-in window shot was empty");
    const after = await ui.locator("body").innerText();
    if (after.includes("SuperSecretPassword")) throw new Error("the demo password was shown");
  } finally {
    delete process.env.BAO_SIGNIN_SHOT;
    await browser.close().catch(() => undefined);
    await app.close();
  }
});

test("a public page's localStorage and IndexedDB come back in bao's profile", { timeout: 180_000 }, async () => {
  const stored = "storage-secret-9f3c";
  const userData = tempDir("bao-public-storage-");
  const home = tempDir("bao-public-storage-home-");
  const baoProfile = path.join(home, "chrome-profile");
  const origin = "https://the-internet.herokuapp.com";
  const writer = await launchLevelDbProfile(userData);
  try {
    const page = writer.pages()[0] || await writer.newPage();
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const wrote = await page.evaluate(({ key, value, db }) => {
      localStorage.setItem(key, value);
      return new Promise((resolve) => {
        const open = indexedDB.open(db, 1);
        open.onupgradeneeded = () => { open.result.createObjectStore("notes", { keyPath: "id" }); };
        open.onerror = () => resolve(false);
        open.onsuccess = () => {
          const database = open.result;
          const tx = database.transaction("notes", "readwrite");
          tx.objectStore("notes").put({ id: "1", body: value });
          tx.oncomplete = () => { database.close(); resolve(true); };
          tx.onerror = () => { database.close(); resolve(false); };
        };
      });
    }, { key: STORAGE_KEY, value: stored, db: STORAGE_DB });
    if (wrote !== true) throw new Error("the public page did not accept the storage write");
  } finally {
    await writer.close();
  }
  writeLocalState(userData, [{ directory: "Default", name: "Public Storage", email: "storage@example.com" }]);
  const app = await startApp({
    home,
    chromeUserData: userData,
    baoProfile,
    loginKeys: cookieKeys("browser", process.platform),
  });
  const browser = await chromium.launch({ executablePath: TEST_BROWSER, headless: true });
  const ui = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  try {
    await ui.goto(`http://127.0.0.1:${app.port}/`);
    await ui.evaluate(() => localStorage.removeItem("bao-theme"));
    await ui.reload();
    await ui.click("nav button[data-screen=logins]");
    await ui.fill("#login-site", `${origin}/`);
    await ui.click("#show-profiles");
    await ui.waitForSelector("[data-import-profile=Default]");
    await ui.click("#import-selected");
    await ui.waitForFunction(() => (document.querySelector("#login-result")?.textContent || "").includes("localStorage"), undefined, { timeout: 90_000 });
    const text = await ui.locator("#login-result").innerText();
    if (!text.includes(STORAGE_KEY)) throw new Error("localStorage name was not shown");
    if (!text.includes(STORAGE_DB)) throw new Error("IndexedDB name was not shown");
    if (!/\d+ localStorage item/.test(text)) throw new Error("localStorage count was not shown");
    if (!/\d+ IndexedDB origin/.test(text)) throw new Error("IndexedDB count was not shown");
    assertNoValue(text, stored);
    await ui.screenshot({ path: path.join(ARTIFACTS, "login-storage-public.png"), fullPage: true });
    await readBackPublicStorage(baoProfile, origin, stored);
  } finally {
    await browser.close().catch(() => undefined);
    await app.close();
  }
  assertDistinctShots();
});

async function readBackPublicStorage(baoProfile: string, origin: string, expected: string): Promise<void> {
  const ctx = await launchLevelDbProfile(baoProfile);
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const ok = await page.evaluate(({ key, db, expected: want }) => {
      if (localStorage.getItem(key) !== want) return false;
      return new Promise((resolve) => {
        const open = indexedDB.open(db);
        open.onerror = () => resolve(false);
        open.onsuccess = () => {
          const database = open.result;
          if (!database.objectStoreNames.contains("notes")) { database.close(); resolve(false); return; }
          const req = database.transaction("notes", "readonly").objectStore("notes").get("1");
          req.onsuccess = () => {
            const body = req.result && typeof req.result === "object" ? (req.result as { body?: string }).body : "";
            database.close();
            resolve(body === want);
          };
          req.onerror = () => { database.close(); resolve(false); };
        };
      });
    }, { key: STORAGE_KEY, db: STORAGE_DB, expected });
    if (ok !== true) throw new Error("bao's profile did not read the public storage back");
  } finally {
    await ctx.close();
  }
}

async function signIntoDemo(userData: string): Promise<void> {
  const ctx = await launchOwnedChrome({ userDataDir: userData, headless: true });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    let reached = false;
    for (let attempt = 0; attempt < 2 && !reached; attempt++) {
      await page.goto("https://the-internet.herokuapp.com/login", { waitUntil: "domcontentloaded", timeout: 45_000 });
      const user = page.locator("#username");
      try {
        await user.waitFor({ state: "visible", timeout: 20_000 });
      } catch {
        continue;
      }
      await user.fill("tomsmith");
      await page.locator("#password").fill("SuperSecretPassword!");
      await Promise.all([
        page.waitForURL(/\/secure/, { timeout: 30_000 }),
        page.click("button[type=submit]"),
      ]);
      reached = page.url().includes("/secure");
    }
    const body = await page.locator("body").innerText();
    if (!body.includes("You logged into a secure area")) throw new Error("public demo login did not reach the secure area");
    if (!page.url().includes("/secure")) throw new Error("public demo login did not stay on the secure page");
  } finally {
    await ctx.close();
  }
}

async function clearBaoCookies(baoProfile: string): Promise<void> {
  const ctx = await launchOwnedChrome({ userDataDir: baoProfile, headless: true });
  try {
    await ctx.clearCookies();
  } finally {
    await ctx.close();
  }
}

const STORAGE_KEY = "bao-note";
const STORAGE_DB = "bao-notes";

const SHOTS = [
  "login-picker-light.png",
  "login-picker-dark.png",
  "login-saved-light.png",
  "login-saved-dark.png",
  "login-signed-out-bot-light.png",
  "login-keychain-missed-light.png",
  "login-keychain-missed-dark.png",
  "login-signed-in-light.png",
  "login-needs-sign-in-light.png",
  "login-sign-in-window.png",
  "login-storage-public.png",
];

function assertDistinctShots(): void {
  const hashes = new Map<string, string>();
  const lines: string[] = [];
  for (const name of SHOTS) {
    const file = path.join(ARTIFACTS, name);
    if (!existsSync(file)) throw new Error(`missing screenshot ${name}`);
    const hash = createHash("md5").update(readFileSync(file)).digest("hex");
    for (const [prior, priorHash] of hashes) {
      if (priorHash === hash) throw new Error(`${name} duplicates ${prior}`);
    }
    hashes.set(name, hash);
    lines.push(`${hash}  ${name}`);
  }
  writeFileSync(path.join(ARTIFACTS, "login-shots.md5"), `${lines.join("\n")}\n`);
}

function sessionCookieOnDisk(profile: string): { expires: string } | null {
  const candidates = [
    path.join(profile, "Default", "Network", "Cookies"),
    path.join(profile, "Default", "Cookies"),
  ];
  const file = candidates.find((item) => existsSync(item));
  if (!file) return null;
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (file: string, opts: { readOnly: boolean }) => {
      prepare(sql: string): { get(): { expires_utc: string } | undefined };
      close(): void;
    };
  };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT CAST(expires_utc AS TEXT) AS expires_utc FROM cookies WHERE name = 'session'").get();
    return row ? { expires: String(row.expires_utc) } : null;
  } finally {
    db.close();
  }
}

async function startSite(): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const cookie = req.headers.cookie || "";
    const hasSession = cookie.split(";").some((part) => part.trim() === `session=${SESSION}`);
    const hasBot = /(^|;\s*)reese84=/.test(cookie);
    if (url.pathname === "/login") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><h1>Sign in</h1>");
      return;
    }
    if (url.pathname === "/home") {
      res.writeHead(302, { location: "/login" });
      res.end();
      return;
    }
    if (url.pathname === "/account" || url.pathname === "/strict") {
      const authed = url.pathname === "/strict" ? hasSession && hasBot : hasSession;
      if (!authed) {
        res.writeHead(302, { location: "/login" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><h1 id=\"account\">Welcome back</h1>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><p>ok</p>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function writeChromeStorage(userData: string, port: number): Promise<void> {
  const ctx = await launchLevelDbProfile(userData);
  try {
    assertNoStealth(userData);
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/login`, { waitUntil: "domcontentloaded" });
    await writeOriginState(page, DEVICE);
    await page.goto(`http://localhost:${port}/login`, { waitUntil: "domcontentloaded" });
    await writeOriginState(page, OTHER);
  } finally {
    await ctx.close();
  }
}

async function writeOriginState(page: Page, value: string): Promise<void> {
  await page.evaluate((stored) => {
    localStorage.setItem("device", stored);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("notes", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("notes");
      req.onerror = () => reject(new Error("idb open failed"));
      req.onsuccess = () => {
        const tx = req.result.transaction("notes", "readwrite");
        tx.objectStore("notes").put(stored, "device");
        tx.oncomplete = () => {
          req.result.close();
          resolve(true);
        };
        tx.onerror = () => reject(new Error("idb write failed"));
      };
    });
  }, value);
}

async function assertRestored(baoProfile: string, origin: string, port: number): Promise<void> {
  const idbRoot = path.join(baoProfile, "Default", "IndexedDB");
  const names = existsSync(idbRoot) ? readdirSync(idbRoot) : [];
  const wanted = indexedDbIdentifier(origin);
  const other = indexedDbIdentifier(`http://localhost:${port}`);
  if (!names.some((name) => name.startsWith(`${wanted}.indexeddb`))) {
    throw new Error(`IndexedDB for the clicked origin was not copied (${names.join(", ") || "none"})`);
  }
  if (names.some((name) => name.startsWith(`${other}.indexeddb`))) {
    throw new Error("IndexedDB for a different host was copied");
  }
  if (names.some((name) => name === "LOCK" || name.endsWith("/LOCK"))) throw new Error("LOCK was copied");
  for (const name of names) {
    if (existsSync(path.join(idbRoot, name, "LOCK"))) throw new Error("LOCK was copied into an IndexedDB directory");
  }
  const ctx = await launchLevelDbProfile(baoProfile);
  try {
    assertNoStealth(baoProfile);
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(`${origin}/account`, { waitUntil: "domcontentloaded" });
    if (page.url().includes("/login")) throw new Error("restored session did not stay signed in");
    const device = await page.evaluate(() => localStorage.getItem("device"));
    if (device !== DEVICE) throw new Error("localStorage was not restored");
    const note = await page.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open("notes", 1);
      req.onerror = () => reject(new Error("idb open failed"));
      req.onsuccess = () => {
        const tx = req.result.transaction("notes", "readonly");
        const get = tx.objectStore("notes").get("device");
        get.onsuccess = () => {
          req.result.close();
          resolve(get.result ?? null);
        };
        get.onerror = () => reject(new Error("idb read failed"));
      };
    }));
    if (note !== DEVICE) throw new Error("IndexedDB was not restored");
    await page.goto(`http://localhost:${port}/login`, { waitUntil: "domcontentloaded" });
    const otherValue = await page.evaluate(() => localStorage.getItem("device"));
    if (otherValue !== null) throw new Error("localStorage from another host was restored");
    const otherDb = await page.evaluate(async () => {
      const found = await indexedDB.databases();
      return found.some((db) => db.name === "notes");
    });
    if (otherDb) throw new Error("IndexedDB from another host was restored");
  } finally {
    await ctx.close();
  }
}

async function assertNeedsSignIn(port: number, library: { save(doc: WorkflowV2): void }, origin: string): Promise<void> {
  const saved = await fetch(`http://127.0.0.1:${port}/api/login-sites`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      origin,
      probeUrl: `${origin}/home`,
      signedInSelector: "",
      signedInText: "",
      botCookies: "skip",
      origins: [],
    }),
  });
  if (!saved.ok) throw new Error("could not save the site probe");
  const workflow: WorkflowV2 = {
    schema: "bao.workflow/v2",
    version: 2,
    id: "wf-gate",
    name: "Gated",
    startUrl: `${origin}/home`,
    inputs: [],
    steps: [{
      id: "s1",
      index: 0,
      action: "click",
      label: "Go",
      surface: "dom",
      timeoutMs: 1000,
      identity: { surface: "dom", role: "button", testId: "missing", path: [] },
    }],
    createdAt: 1,
  };
  library.save(workflow);
  const res = await fetch(`http://127.0.0.1:${port}/api/replay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: workflow.id, args: {} }),
  });
  const body = await res.json() as { status?: string; steps?: unknown[]; message?: string };
  if (body.status !== "needs-sign-in") throw new Error("a dead session started the run");
  if (!Array.isArray(body.steps) || body.steps.length !== 0) throw new Error("a dead session recorded steps");
  if (body.message !== "Needs sign-in. The session is not live, so Bao did not start the run. Sign in once in Bao's window.") {
    throw new Error("needs sign-in copy changed");
  }
  assertNoValue(JSON.stringify(body), SESSION);
  assertNoValue(JSON.stringify(body), DEVICE);
}

function assertNoStealth(userDataDir: string): void {
  let cmdline = "";
  try {
    const listed = execFileSync("ps", ["-axww", "-o", "command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    for (const cmd of listed.split("\n")) {
      if (cmd.includes(userDataDir) && /chrome/i.test(cmd) && !cmd.includes("--type=")) cmdline = cmd;
    }
  } catch {
    throw new Error("could not inspect the Chrome command line");
  }
  if (!cmdline) throw new Error("owned Chrome was not running");
  if (cmdline.includes("AutomationControlled") || cmdline.includes("remote-debugging-port=9222")) {
    throw new Error("owned Chrome was launched with a stealth or debug flag");
  }
}
