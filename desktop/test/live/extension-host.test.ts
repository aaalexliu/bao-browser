// Throwaway Chrome profile. Public pages and a local fixture only.
// No daily profile, no captcha solving, no fingerprint spoofing.

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { copyFileSync, createWriteStream, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { startApp } from "../../src/app/server";
import { keepSessionCookies } from "../../src/launch";
import { assertNotDailyChrome } from "../../src/profile";
import { EXTENSION_ID } from "../../src/extension/protocol";
import type { WorkflowV2 } from "../../src/v1/schema";
import { testArtifacts } from "../artifacts";

process.env.BAO_CHROME_NO_SANDBOX = process.env.BAO_CHROME_NO_SANDBOX || "1";
process.env.BAO_HEAL_CURSOR_ACCOUNT = "0";
for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CURSOR_API_KEY"]) delete process.env[key];

const BOOKS = "https://books.toscrape.com/";
const BOOKS_ORIGIN = "https://books.toscrape.com/*";
const EXT_DIR = path.resolve("extension/dist");
const ARTIFACTS = testArtifacts("extension-host");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chromeBin(): string {
  // Branded Google Chrome ignores --load-extension. Chrome for Testing still loads the unpacked build.
  const fromEnv = process.env.BAO_PROOF_CHROME;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates = [path.join(homedir(), ".cache/chrome-for-testing/chrome-linux64/chrome")];
  const playwright = path.join(homedir(), ".cache/ms-playwright");
  if (existsSync(playwright)) {
    const hits = readdirSync(playwright)
      .map((name) => path.join(playwright, name, "chrome-linux64", "chrome"))
      .filter((file) => existsSync(file))
      .sort();
    const found = hits[hits.length - 1];
    if (found) candidates.push(found);
  }
  candidates.push("/usr/local/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome");
  const hit = candidates.find((file) => existsSync(file));
  if (!hit) throw new Error("chrome was not found");
  return hit;
}

interface Target {
  url?: string;
  type?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

interface ReplayBody {
  status?: string;
  error?: string;
  message?: string;
  reason?: string;
  runId?: string;
  id?: string;
}

interface HostInfo {
  runtimeErrors?: { message?: string }[];
  manifestErrors?: { message?: string }[];
  runtimeWarnings?: { message?: string }[];
  installWarnings?: { message?: string }[];
  name?: string;
  state?: string;
}

function workflow(id: string, name: string, steps: WorkflowV2["steps"], startUrl = BOOKS): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id,
    name,
    startUrl,
    createdAt: Date.now(),
    inputs: [],
    driver: "extension",
    steps,
  };
}

test("extension replay asks for one origin and does not error with no host permission", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-ext-host-"));
  const home = path.join(root, "bao");
  const chromeHome = path.join(root, "home");
  const profile = path.join(root, "profile");
  const shotDir = path.join(root, "shots");
  assertNotDailyChrome(root);
  assertNotDailyChrome(profile);
  mkdirSync(chromeHome, { recursive: true });
  mkdirSync(profile, { recursive: true });
  mkdirSync(shotDir, { recursive: true });
  keepSessionCookies(profile);
  const debugPort = 9400 + Math.floor(Math.random() * 400);
  assert.notEqual(debugPort, 9222);

  const app = await startApp({
    home,
    extensionHost: true,
    extensionConfigHome: chromeHome,
    extensionHostDirs: [
      path.join(profile, "NativeMessagingHosts"),
      path.join(chromeHome, ".config", "google-chrome-for-testing", "NativeMessagingHosts"),
    ],
  });
  const link = app.extensionLink;
  assert.ok(link, "extension link");
  const logPath = path.join(root, "chrome.log");
  const log = createWriteStream(logPath, { flags: "a" });
  let chrome: ChildProcess | undefined;
  let browser: Browser | undefined;
  let fixture: { server: Server; port: number } | undefined;
  const hostsSeen = new Set<string>();

  const quitChrome = () => {
    spawnSync("pkill", ["-f", `user-data-dir=${profile}`]);
  };

  try {
    const before = link.helloSerial;
    const args = [
      `--user-data-dir=${profile}`,
      `--load-extension=${EXT_DIR}`,
      `--disable-extensions-except=${EXT_DIR}`,
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-networking",
      "--window-size=1280,900",
      "--window-position=40,40",
      `--remote-debugging-port=${debugPort}`,
      "--remote-debugging-address=127.0.0.1",
      "about:blank",
    ];
    if (process.env.BAO_CHROME_NO_SANDBOX === "1") args.push("--no-sandbox", "--disable-dev-shm-usage");
    chrome = spawn(chromeBin(), args, {
      env: {
        ...process.env,
        HOME: chromeHome,
        DISPLAY: process.env.DISPLAY || ":1",
        XAUTHORITY: process.env.XAUTHORITY || path.join(homedir(), ".Xauthority"),
      },
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    chrome.stderr?.pipe(log);
    chrome.unref();
    await link.waitForHello(before, 40_000);

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const context = browser.contexts()[0];
    assert.ok(context, "cdp context");
    const page = context.pages()[0] || await context.newPage();
    await page.goto("chrome://extensions/", { waitUntil: "domcontentloaded", timeout: 20_000 });
    const fresh = await extensionInfo(page);
    assertClean(fresh, "fresh load");
    const quiet = await link.command("net-state", {}, 10_000) as { listening?: boolean; urls?: string[]; allowUrl?: string };
    assert.equal(quiet.listening, false, JSON.stringify(quiet));
    assert.deepEqual(quiet.urls || [], []);
    await page.screenshot({ path: path.join(shotDir, "card.png"), fullPage: true });
    await page.goto(`chrome://extensions/?errors=${EXTENSION_ID}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.screenshot({ path: path.join(shotDir, "errors.png"), fullPage: true });

    app.library.save(workflow("wf-host-deny", "Host deny", []));
    app.library.save(workflow("wf-host-grant", "Host grant", [{
      id: "see-books",
      index: 0,
      action: "verify",
      label: "Books to Scrape",
      surface: "dom",
      timeoutMs: 20_000,
      expect: { kind: "text", match: "Books", timeoutMs: 20_000 },
    }]));

    process.env.BAO_HOST_GRANT_MS = "4000";
    const deniedPromise = postReplay(app.port, "wf-host-deny");
    const deniedAllow = await waitForAllow(link, debugPort, hostsSeen, 8_000);
    assert.equal(deniedAllow.origins, BOOKS_ORIGIN);
    assert.equal(deniedAllow.origins.includes(","), false);
    assert.equal(deniedAllow.origins.includes("<all_urls>"), false);
    assert.equal(/https?:\/\/\*\//.test(deniedAllow.origins), false);
    const allowShot = await shotAllow(browser, shotDir);
    const denied = await deniedPromise;
    assert.equal(denied.statusCode, 200, JSON.stringify(denied.body));
    assert.equal(denied.body.status, "needs_human", JSON.stringify(denied.body));
    assert.equal(denied.body.error, undefined);
    assert.match(String(denied.body.message || ""), /books\.toscrape\.com/);
    assert.match(String(denied.body.message || ""), /not granted in time/);
    assert.ok(denied.body.runId || denied.body.id);
    assert.equal(hostsSeen.has("books.toscrape.com"), false, `navigated before a grant: ${[...hostsSeen].join(" ")}`);
    await sleep(500);
    const afterDeny = await listTargets(debugPort);
    assert.equal(afterDeny.some((item) => hostOf(item.url || "") === "books.toscrape.com"), false);

    process.env.BAO_HOST_GRANT_MS = "25000";
    const grantedPromise = postReplay(app.port, "wf-host-grant");
    const grantedAllow = await waitForAllow(link, debugPort, hostsSeen, 12_000);
    assert.equal(grantedAllow.origins, BOOKS_ORIGIN);
    await grantHost(browser, debugPort, BOOKS_ORIGIN, false);
    const granted = await grantedPromise;
    assert.equal(granted.statusCode, 200, JSON.stringify(granted.body));
    assert.equal(granted.body.status, "passed", JSON.stringify(granted.body));
    assert.equal(granted.body.error, undefined);
    const har = await link.command("flush-har", {}, 10_000) as { entries?: { url?: string }[] };
    const harUrls = (har.entries || []).map((entry) => entry.url || "");
    assert.ok(harUrls.some((url) => url.includes("books.toscrape.com")), `no HAR entry: ${JSON.stringify(harUrls.slice(0, 8))}`);
    const listening = await link.command("net-state", {}, 10_000) as { listening?: boolean; urls?: string[] };
    assert.equal(listening.listening, true, JSON.stringify(listening));
    assert.ok((listening.urls || []).some((url) => url.includes("books.toscrape.com")), JSON.stringify(listening.urls));
    assert.equal((listening.urls || []).includes("<all_urls>"), false);
    assert.equal((listening.urls || []).includes("https://*/*"), false);
    assert.equal((listening.urls || []).includes("http://*/*"), false);
    await page.goto("chrome://extensions/", { waitUntil: "domcontentloaded", timeout: 20_000 });
    assertClean(await extensionInfo(page), "after grant");

    fixture = await startFixture();
    const localOrigin = `http://127.0.0.1:${fixture.port}/*`;
    await grantHost(browser, debugPort, localOrigin, true);
    const opened = await link.command("open", {
      url: `http://127.0.0.1:${fixture.port}/`,
      inject: true,
      grantMs: 1000,
    }, 20_000) as { needsHuman?: boolean; url?: string; error?: string };
    assert.notEqual(opened.needsHuman, true, JSON.stringify(opened));
    const trust = await link.command("measure-debugger", {}, 20_000) as { clickAfter?: boolean; typeAfter?: boolean };
    assert.equal(trust.clickAfter, true, JSON.stringify(trust));
    assert.equal(trust.typeAfter, true, JSON.stringify(trust));
    await page.goto("chrome://extensions/", { waitUntil: "domcontentloaded", timeout: 20_000 });
    assertClean(await extensionInfo(page), "after debugger");

    await closeAllowPages(browser);
    const quotesOrigin = "https://quotes.toscrape.com/*";
    const allPromise = link.command("open", {
      url: "https://quotes.toscrape.com/",
      inject: true,
      grantMs: 25_000,
    }, 50_000).then(
      (value) => value as { needsHuman?: boolean; url?: string; error?: string },
      (err) => ({ needsHuman: true, error: err instanceof Error ? err.message : String(err) }),
    );
    const allAllow = await waitForAllow(link, debugPort, hostsSeen, 12_000, quotesOrigin);
    assert.equal(allAllow.origins, quotesOrigin);
    assert.equal(/https?:\/\/\*\//.test(allAllow.origins), false);
    const allShot = await shotAllow(browser, shotDir);
    await grantHost(browser, debugPort, quotesOrigin, false, "#allow-all", "https://*/*");
    const allOpened = await allPromise;
    assert.notEqual(allOpened.needsHuman, true, JSON.stringify(allOpened));
    assert.equal(await originGranted(browser, debugPort, undefined, "http://*/*"), true);
    const wide = await link.command("net-state", {}, 10_000) as { listening?: boolean; urls?: string[] };
    assert.equal(wide.listening, true, JSON.stringify(wide));
    assert.ok((wide.urls || []).includes("https://*/*"), JSON.stringify(wide.urls));
    assert.ok((wide.urls || []).includes("http://*/*"), JSON.stringify(wide.urls));
    assert.equal((wide.urls || []).includes("<all_urls>"), false);

    const onWorkflow = await link.command("secret-pin", { url: "https://quotes.toscrape.com/login" }, 8_000) as { ok?: boolean };
    const offWorkflow = await link.command("secret-pin", { url: "https://books.toscrape.com/" }, 8_000) as { ok?: boolean };
    assert.equal(onWorkflow.ok, true, JSON.stringify(onWorkflow));
    assert.equal(offWorkflow.ok, false, JSON.stringify(offWorkflow));

    app.library.save(workflow("wf-host-all", "Host all", [], "https://example.com/"));
    process.env.BAO_HOST_GRANT_MS = "8000";
    let promptedAgain = false;
    const watchPrompt = (async () => {
      const start = Date.now();
      while (Date.now() - start < 10_000) {
        const state = await link.command("net-state", {}, 3_000).catch(() => ({})) as { allowUrl?: string };
        if (String(state.allowUrl || "").includes("allow.html")) {
          promptedAgain = true;
          return;
        }
        await sleep(150);
      }
    })();
    const skipped = await postReplay(app.port, "wf-host-all");
    await watchPrompt;
    assert.equal(promptedAgain, false, "all-sites grant still opened allow.html");
    assert.notEqual(skipped.body.status, "needs_human", JSON.stringify(skipped.body));
    assert.equal(/Allow Bao on /.test(String(skipped.body.message || skipped.body.reason || "")), false);

    const ui = browser.contexts()[0];
    assert.ok(ui, "cdp context");
    const settings = await ui.newPage();
    await settings.goto(`http://127.0.0.1:${app.port}/`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await settings.locator("nav button[data-screen='settings']").click();
    await settings.locator("#host-access-status").waitFor({ timeout: 10_000 });
    await settings.waitForFunction(() => (document.getElementById("host-access-status")?.textContent || "").includes("all sites"), undefined, { timeout: 10_000 });
    await settings.locator("#host-access").screenshot({ path: path.join(shotDir, "settings-host.png") });
    await settings.screenshot({ path: path.join(shotDir, "settings.png") });
    await settings.locator("#revoke-hosts").click();
    await settings.waitForFunction(() => (document.getElementById("host-access-status")?.textContent || "").includes("none"), undefined, { timeout: 10_000 });
    const revokedAccess = await fetch(`http://127.0.0.1:${app.port}/api/extension/host-access`).then((res) => res.json()) as { hostAccess?: string };
    assert.equal(revokedAccess.hostAccess, "none", JSON.stringify(revokedAccess));
    const quietAgain = await link.command("net-state", {}, 10_000) as { listening?: boolean; urls?: string[] };
    assert.equal(quietAgain.listening, false, JSON.stringify(quietAgain));
    await settings.close().catch(() => undefined);

    app.library.save(workflow("wf-host-again", "Host again", [], "https://example.org/"));
    process.env.BAO_HOST_GRANT_MS = "3000";
    const againPromise = postReplay(app.port, "wf-host-again");
    const againAllow = await waitForAllow(link, debugPort, hostsSeen, 8_000, "https://example.org/*");
    assert.equal(againAllow.origins, "https://example.org/*");
    assert.equal(againAllow.origins.includes(","), false);
    assert.equal(/https?:\/\/\*\//.test(againAllow.origins), false);
    const again = await againPromise;
    assert.equal(again.statusCode, 200, JSON.stringify(again.body));
    assert.equal(again.body.status, "needs_human", JSON.stringify(again.body));
    assert.match(String(again.body.message || ""), /example\.org/);
    assert.match(String(again.body.message || ""), /not granted in time/);
    assert.equal(hostsSeen.has("example.org"), false, `navigated before a grant: ${[...hostsSeen].join(" ")}`);

    await page.goto("chrome://extensions/?errors=" + EXTENSION_ID, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.screenshot({ path: path.join(shotDir, "errors.png"), fullPage: true });
    await page.goto("chrome://extensions/", { waitUntil: "domcontentloaded", timeout: 20_000 });
    assertClean(await extensionInfo(page), "after revoke");
    await page.screenshot({ path: path.join(shotDir, "card.png"), fullPage: true });

    mkdirSync(ARTIFACTS, { recursive: true });
    copyFileSync(path.join(shotDir, "errors.png"), path.join(ARTIFACTS, "chrome_extensions_error_list.png"));
    copyFileSync(path.join(shotDir, "card.png"), path.join(ARTIFACTS, "chrome_extensions_no_errors.png"));
    if (allowShot) copyFileSync(allowShot, path.join(ARTIFACTS, "chrome_allow_one_origin.png"));
    if (allShot) copyFileSync(allShot, path.join(ARTIFACTS, "chrome_allow_all_sites.png"));
    copyFileSync(path.join(shotDir, "settings-host.png"), path.join(ARTIFACTS, "bao_settings_host_access.png"));
    copyFileSync(path.join(shotDir, "settings.png"), path.join(ARTIFACTS, "bao_settings.png"));
  } catch (err) {
    const tail = readFileSync(logPath, "utf8").slice(-2000);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message}\n--- chrome log ---\n${tail}`);
  } finally {
    await browser?.close().catch(() => undefined);
    quitChrome();
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const left = spawnSync("pgrep", ["-af", `user-data-dir=${profile}`], { encoding: "utf8" }).stdout || "";
      if (!left.trim()) break;
      await sleep(200);
    }
    spawnSync("pkill", ["-9", "-f", `user-data-dir=${profile}`]);
    log.end();
    fixture?.server.close();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function postReplay(port: number, id: string): Promise<{ statusCode: number; body: ReplayBody }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/replay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, args: {} }),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) as ReplayBody : {};
  return { statusCode: res.status, body };
}

async function listTargets(port: number): Promise<Target[]> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) return [];
  return res.json() as Promise<Target[]>;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function originsOf(url: string): string {
  try {
    return new URL(url).searchParams.get("origins") || "";
  } catch {
    return "";
  }
}

function wantedOrigin(origins: string, want?: string): boolean {
  if (!origins) return false;
  if (!want) return true;
  return origins.split(",").map((item) => item.trim()).includes(want);
}

async function closeAllowPages(browser: Browser): Promise<void> {
  for (const context of browser.contexts()) {
    for (const page of [...context.pages()]) {
      if (page.url().includes("/allow.html")) await page.close().catch(() => undefined);
    }
  }
}

async function waitForAllow(
  link: NonNullable<Awaited<ReturnType<typeof startApp>>["extensionLink"]>,
  debugPort: number,
  hostsSeen: Set<string>,
  timeoutMs: number,
  want?: string,
): Promise<{ origins: string; url: string }> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    const listed = await listTargets(debugPort).catch(() => [] as Target[]);
    for (const item of listed) {
      const url = item.url || "";
      const host = hostOf(url);
      if (host && (url.startsWith("http://") || url.startsWith("https://"))) hostsSeen.add(host);
      if (url.includes("/allow.html")) {
        const origins = originsOf(url);
        if (wantedOrigin(origins, want)) return { origins, url };
      }
    }
    const state = await link.command("net-state", {}, 5000).catch(() => ({})) as { allowUrl?: string };
    last = state.allowUrl || last;
    if (wantedOrigin(originsOf(last), want) && last.includes("allow.html")) {
      const match = listed.find((item) => (item.url || "").includes("allow.html") && wantedOrigin(originsOf(item.url || ""), want));
      if (match?.url) return { origins: originsOf(match.url), url: match.url };
    }
    await sleep(200);
  }
  throw new Error(`allow.html did not open (last ${last})`);
}

async function shotAllow(browser: Browser, shotDir: string): Promise<string | undefined> {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (!page.url().includes("allow.html")) continue;
      const file = path.join(shotDir, "allow.png");
      await page.screenshot({ path: file }).catch(() => undefined);
      return file;
    }
  }
  return undefined;
}

async function extensionInfo(page: Page): Promise<HostInfo> {
  return page.evaluate(async (extensionId: string) => {
    const api = (globalThis as unknown as {
      chrome: {
        developerPrivate: Record<string, (...args: unknown[]) => unknown>;
        runtime: { lastError?: { message?: string } };
      };
    }).chrome;
    const call = (method: string, ...args: unknown[]) => new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) reject(new Error(`${method} timed out`));
      }, 8000);
      const done = (value: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const err = api.runtime.lastError?.message;
        if (err) reject(new Error(err));
        else resolve(value);
      };
      try {
        const result = api.developerPrivate[method](...args, done);
        const pending = result as Promise<unknown> | undefined;
        if (pending && typeof pending.then === "function") {
          pending.then(done, (err: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          });
        }
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
    await call("updateProfileConfiguration", { inDeveloperMode: true }).catch(() => undefined);
    const infos = await call("getExtensionsInfo") as HostInfo[] | undefined;
    const info = (infos || []).find((item) => (item as { id?: string }).id === extensionId);
    if (!info) throw new Error(`extension ${extensionId} is not installed`);
    return {
      name: info.name,
      state: info.state,
      runtimeErrors: info.runtimeErrors || [],
      manifestErrors: info.manifestErrors || [],
      runtimeWarnings: info.runtimeWarnings || [],
      installWarnings: info.installWarnings || [],
    };
  }, EXTENSION_ID);
}

function assertClean(info: HostInfo, when: string): void {
  const errors = [
    ...(info.runtimeErrors || []),
    ...(info.manifestErrors || []),
    ...(info.runtimeWarnings || []),
    ...(info.installWarnings || []),
  ];
  assert.equal(errors.length, 0, `${when}: ${JSON.stringify(errors)}`);
}

function findAllowPage(browser: Browser, origin: string): Page | undefined {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const url = page.url();
      if (!url.includes("/allow.html")) continue;
      const listed = originsOf(url).split(",").map((item) => item.trim());
      if (listed.includes(origin)) return page;
    }
  }
  return undefined;
}

async function findAllowTarget(debugPort: number, origin: string): Promise<Target | undefined> {
  const listed = await listTargets(debugPort);
  return listed.find((item) => {
    const url = item.url || "";
    if (!url.includes("/allow.html")) return false;
    return originsOf(url).split(",").map((part) => part.trim()).includes(origin);
  });
}

function cdpCall(wsUrl: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`cdp ${method} timed out`));
    }, 8000);
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`cdp ${method} socket error`));
    });
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) reject(new Error(msg.error.message || `cdp ${method} failed`));
      else resolve(msg.result || {});
    });
  });
}

async function cdpClickAllow(wsUrl: string, button = "#allow"): Promise<void> {
  const id = JSON.stringify(button.replace(/^#/, ""));
  const evaled = await cdpCall(wsUrl, "Runtime.evaluate", {
    expression: `(() => {
      const el = document.getElementById(${id});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
    returnByValue: true,
  });
  const point = (evaled.result as { value?: { x?: number; y?: number } | null } | undefined)?.value;
  if (!point || point.x == null || point.y == null) throw new Error("allow button missing");
  await cdpCall(wsUrl, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await cdpCall(wsUrl, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await cdpCall(wsUrl, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
}

async function openAllowPage(browser: Browser, origin: string): Promise<Page> {
  const context = browser.contexts()[0];
  assert.ok(context, "cdp context");
  const page = await context.newPage();
  const url = `chrome-extension://${EXTENSION_ID}/allow.html?origins=${encodeURIComponent(origin)}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
  return page;
}

async function pressAllow(): Promise<void> {
  const start = Date.now();
  let id = "";
  while (Date.now() - start < 6000) {
    const out = spawnSync("xdotool", ["search", "--name", "Allow Bao"], { encoding: "utf8" });
    const ids = (out.stdout || "").split("\n").map((line) => line.trim()).filter((line) => /^\d+$/.test(line));
    id = ids[ids.length - 1] || "";
    if (id) break;
    await sleep(100);
  }
  assert.ok(id, "Allow Bao window was not found");
  const activate = spawnSync("xdotool", ["windowactivate", "--sync", id], { encoding: "utf8" });
  assert.equal(activate.status, 0, activate.stderr || activate.stdout || "windowactivate failed");
  await sleep(200);
  // Deny is the focused default. Right moves to Allow. XTEST, not --window: Chrome drops XSendEvent.
  const key = spawnSync("xdotool", ["key", "--delay", "80", "Right", "Return"], { encoding: "utf8" });
  assert.equal(key.status, 0, key.stderr || key.stdout || "xdotool key failed");
}

async function originGranted(browser: Browser, debugPort: number, allow: Page | undefined, origin: string): Promise<boolean | "denied"> {
  if (allow) {
    const state = await allow.evaluate(() => ({
      granted: document.body?.dataset.granted || "",
    })).catch(() => undefined);
    if (state?.granted === "true") return true;
    if (state?.granted === "false") return "denied";
  }
  for (const context of browser.contexts()) {
    for (const worker of context.serviceWorkers()) {
      if (!worker.url().includes(EXTENSION_ID)) continue;
      const ok = await worker.evaluate(async (pattern: string) => {
        const api = (globalThis as unknown as {
          chrome: { permissions: { contains: (query: { origins: string[] }) => Promise<boolean> } };
        }).chrome;
        return api.permissions.contains({ origins: [pattern] });
      }, origin).catch(() => false);
      if (ok) return true;
    }
  }
  const listed = await listTargets(debugPort).catch(() => [] as Target[]);
  const worker = listed.find((item) => item.type === "service_worker" && (item.url || "").includes(EXTENSION_ID));
  if (!worker?.webSocketDebuggerUrl) return false;
  const evaled = await cdpCall(worker.webSocketDebuggerUrl, "Runtime.evaluate", {
    expression: `chrome.permissions.contains({ origins: [${JSON.stringify(origin)}] })`,
    awaitPromise: true,
    returnByValue: true,
  }).catch(() => undefined);
  return (evaled?.result as { value?: boolean } | undefined)?.value === true;
}

async function grantHost(
  browser: Browser,
  debugPort: number,
  origin: string,
  pregrant: boolean,
  button = "#allow",
  check = origin,
): Promise<void> {
  let page = findAllowPage(browser, origin);
  let socket = "";
  if (!page) {
    const target = await findAllowTarget(debugPort, origin);
    socket = target?.webSocketDebuggerUrl || "";
  }
  if (!page && !socket) {
    assert.equal(pregrant, true, `allow.html for ${origin} was not open`);
    page = await openAllowPage(browser, origin);
  }
  if (page) {
    await page.bringToFront().catch(() => undefined);
    await page.click(button, { timeout: 8000 });
  } else {
    await cdpClickAllow(socket, button);
  }
  await sleep(700);
  await pressAllow();
  const start = Date.now();
  let outcome: boolean | "denied" = false;
  while (Date.now() - start < 8000) {
    outcome = await originGranted(browser, debugPort, page, check);
    if (outcome === true || outcome === "denied") break;
    await sleep(200);
  }
  assert.equal(outcome, true, `Chrome did not grant ${origin} (${outcome})`);
}

function startFixture(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>worker</title>
      <button id="one">one</button><button id="two">two</button>
      <input id="note">
      <p id="log"></p>
      <script>
        document.getElementById("one").onclick = () => { document.getElementById("log").textContent += "one "; };
        document.getElementById("two").onclick = () => { document.getElementById("log").textContent += "two "; };
      </script>`);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}
