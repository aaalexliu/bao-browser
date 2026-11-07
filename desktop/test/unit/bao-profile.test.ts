import assert from "node:assert/strict";
import { mkdtemp, rm, access, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { connectCdp } from "../../src/cdp-live/socket";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import { baoAgentProfileDir, openBaoChromeForProxy } from "../../src/engines/bao-profile";
import * as launches from "../../src/launch";
import { TOOLS } from "../../src/mcp/server";
import { readLocalStorage } from "../../src/login-import/storage";

launches.pinTestBrowser();

test("Bao imports one site's cookies and localStorage and keeps its renewed login after a new session", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-lasting-profile-"));
  const sourceRoot = path.join(root, "source");
  const home = path.join(root, "home");
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><title>Account</title><h1>${request.headers.cookie?.includes("login=") ? "Signed in" : "Signed out"}</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const launch = launches.launchOwnedChromeEndpoint;
  let launchCount = 0;
  t.mock.method(launches, "launchOwnedChromeEndpoint", (options: Parameters<typeof launch>[0]) => {
    launchCount++;
    return launch({ ...options, headless: true });
  });
  let chrome: Awaited<ReturnType<typeof openBaoChromeForProxy>> | undefined;
  try {
    const source = await launches.launchOwnedChrome({ userDataDir: sourceRoot, headless: true });
    try {
      await source.addCookies([
        { name: "login", value: "from-source", url: site, httpOnly: true },
        { name: "unrelated", value: "not-imported", url: "https://other.test" },
      ]);
      const page = source.pages()[0]!;
      await page.goto(site);
      await page.evaluate(async () => {
        localStorage.setItem("identity", "source-account");
      });
      await page.route("https://storage.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Storage</title>" }));
      await page.goto("https://storage.test/");
      await page.evaluate(() => localStorage.setItem("identity", "storage-only"));
    } finally { await source.close(); }
    const inspect = async () => {
      const endpoint = await readDevToolsActivePort(chrome!.target.portFile);
      const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
      const { targetInfos } = await cdp.send<{ targetInfos: { type: string; targetId: string }[] }>("Target.getTargets");
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: targetInfos.find((target) => target.type === "page")!.targetId, flatten: true });
      const evaluate = async <T>(expression: string) => (await cdp.send<{ result: { value: T } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
      await cdp.send("Page.navigate", { url: site }, sessionId);
      const deadline = Date.now() + 5000;
      while (await evaluate("document.querySelector('h1')?.textContent") !== "Signed in") {
        if (Date.now() >= deadline) throw new Error("site did not receive the imported login");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return { cdp, evaluate, sessionId };
    };
    assert.deepEqual((await readLocalStorage(path.join(sourceRoot, "Default"), [site, "https://storage.test"])).sort((a, b) => a.origin.localeCompare(b.origin)), [
      { origin: site, key: "identity", value: "source-account" },
      { origin: "https://storage.test", key: "identity", value: "storage-only" },
    ].sort((a, b) => a.origin.localeCompare(b.origin)), "the closed synthetic source contains both saved storage records");
    chrome = await openBaoChromeForProxy({ sourceRoot, directory: "Default", home, site });
    let page = await inspect();
    try {
      const { cookies } = await page.cdp.send<{ cookies: { name: string; value: string }[] }>("Storage.getCookies");
      assert.deepEqual(cookies.map((cookie) => cookie.name), ["login"]);
      assert.equal(await page.evaluate("localStorage.getItem('identity')"), "source-account");
      await page.cdp.send("Network.setCookie", { name: "login", value: "renewed-in-bao", url: site, httpOnly: true }, page.sessionId);
      await page.evaluate("localStorage.setItem('identity', 'bao-account')");
      const before = launchCount;
      assert.equal(await chrome.importLogin(`${site}/another-path`), false);
      const renewed = await page.cdp.send<{ cookies: { name: string; value: string }[] }>("Storage.getCookies");
      assert.equal(renewed.cookies.find((cookie) => cookie.name === "login")?.value, "renewed-in-bao");
      assert.equal(await chrome.importLogin("https://empty.test/"), false);
      assert.equal(await chrome.importLogin("https://storage.test/"), true);
      assert.equal(await chrome.importLogin("https://storage.test/another-path"), false);
      assert.equal(launchCount, before, "checked origins, empty sites, and storage-only sites never launch cookie-extraction Chrome");
    } finally { page.cdp.close(); }
    await chrome.keepOpen();
    assert.notDeepEqual(launches.pidsForDataDir(baoAgentProfileDir(home)), []);
    await access(baoAgentProfileDir(home));
    await rm(sourceRoot, { recursive: true });
    chrome = await openBaoChromeForProxy({ sourceRoot, directory: "Default", home, site });
    page = await inspect();
    try {
      const { cookies } = await page.cdp.send<{ cookies: { name: string; value: string }[] }>("Storage.getCookies");
      assert.equal(cookies.find((cookie) => cookie.name === "login")?.value, "renewed-in-bao");
      assert.equal(await page.evaluate("localStorage.getItem('identity')"), "bao-account");
    } finally { page.cdp.close(); }
    await chrome.close();
    assert.deepEqual(launches.pidsForDataDir(baoAgentProfileDir(home)), []);
    chrome = await openBaoChromeForProxy({ sourceRoot, directory: "Default", home, site });
    page = await inspect();
    try { assert.equal(await page.evaluate("localStorage.getItem('identity')"), "bao-account"); }
    finally { page.cdp.close(); }
  } finally {
    await chrome?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("Bao reclaims dead owners and slow closes but refuses a live owner", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-profile-owner-"));
  const home = path.join(root, "home");
  const profile = baoAgentProfileDir(home);
  const marker = path.join(profile, "bao-kept-window");
  const options = { sourceRoot: path.join(root, "source"), directory: "Default", home };
  const launch = launches.launchOwnedChromeEndpoint;
  let slowClose = false;
  const browsers: Awaited<ReturnType<typeof launch>>[] = [];
  t.mock.method(launches, "launchOwnedChromeEndpoint", async (options: Parameters<typeof launch>[0]) => {
    const chrome = await launch({ ...options, headless: true });
    browsers.push(chrome);
    return { ...chrome, close: async () => { if (!slowClose) await chrome.close(); } };
  });
  let chrome: Awaited<ReturnType<typeof openBaoChromeForProxy>> | undefined;
  try {
    chrome = await openBaoChromeForProxy(options);
    assert.equal(JSON.parse(await readFile(marker, "utf8")).pid, process.pid);
    await assert.rejects(openBaoChromeForProxy(options), /already open/);
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    assert.equal(dead.status, 0);
    const pid = Number(dead.stdout);
    assert.ok(pid > 1);
    await writeFile(marker, JSON.stringify({ pid }));
    chrome = await openBaoChromeForProxy(options);
    assert.notDeepEqual(launches.pidsForDataDir(profile), []);
    assert.equal(JSON.parse(await readFile(marker, "utf8")).pid, process.pid);
    slowClose = true;
    await chrome.close();
    assert.equal(JSON.parse(await readFile(marker, "utf8")).retained, true);
    slowClose = false;
    chrome = await openBaoChromeForProxy(options);
    assert.notDeepEqual(launches.pidsForDataDir(profile), []);
    await chrome.close();
    assert.deepEqual(launches.pidsForDataDir(profile), []);
    await assert.rejects(readFile(marker), /ENOENT/);
  } finally {
    slowClose = false;
    try { await chrome?.close(); }
    finally {
      for (const browser of browsers) await browser.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("browser choice is explicit on open and rejects unknown values", async () => {
  const proxy = new AgentBrowserProxy({ home: "/unused" });
  await assert.rejects(proxy.execute("open", [], "other"), /must be copy or bao/);
  await assert.rejects(proxy.execute("snapshot", [], "bao"), /only accepted on open/);
  const tool = TOOLS.find((item) => item.name === "agent_browser")!;
  assert.deepEqual(tool.inputSchema.properties.browser.enum, ["copy", "bao"]);
});

test("only an explicit mock-keychain launch permits mock flags outside a test lane", () => {
  const profile = "/tmp/bao-owned-profile";
  const args = launches.ownedChromeLaunchArgs([], {}, "darwin", "mock");
  assert.ok(args.includes("--use-mock-keychain"));
  const command = `chrome --user-data-dir=${profile} --remote-debugging-port=45555 ${args.join(" ")}`;
  assert.equal(launches.assessOwnedCommand(command, profile, {}, "mock").ok, true);
  assert.equal(launches.assessOwnedCommand(command, profile, {}).ok, false);
  assert.equal(launches.ownedChromeLaunchArgs([], {}, "darwin").includes("--use-mock-keychain"), false);
});
