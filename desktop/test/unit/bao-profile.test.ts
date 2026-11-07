import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, access, readFile, writeFile } from "node:fs/promises";
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
      assert.equal(launchCount, before + 1, "later opens refresh cookies while empty and storage-only sites skip extraction Chrome");
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

test("a losing concurrent Bao open cannot alter the opening owner's profile or lease", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-concurrent-profile-"));
  const home = path.join(root, "home");
  const sourceRoot = path.join(root, "source");
  const profile = baoAgentProfileDir(home);
  const marker = path.join(profile, "bao-kept-window");
  const idb = path.join("IndexedDB", "https_loser.test_0.indexeddb.leveldb", "sentinel");
  await mkdir(path.dirname(path.join(sourceRoot, "Default", idb)), { recursive: true });
  await writeFile(path.join(sourceRoot, "Default", idb), "must not reach the winning profile");
  const launch = launches.launchOwnedChromeEndpoint;
  let entered!: () => void;
  const launching = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let failLaunch = false;
  let launchesSeen = 0;
  t.mock.method(launches, "launchOwnedChromeEndpoint", async (options: Parameters<typeof launch>[0]) => {
    if (++launchesSeen === 1) { entered(); await gate; }
    if (failLaunch) throw new Error("synthetic launch failure");
    return launch({ ...options, headless: true });
  });
  const options = { home, sourceRoot, directory: "Default" };
  const opening = openBaoChromeForProxy(options);
  let chrome: Awaited<typeof opening> | undefined;
  try {
    await launching;
    const before = await readFile(marker, "utf8");
    await assert.rejects(openBaoChromeForProxy({ ...options, site: "https://loser.test/" }), /already open/);
    assert.equal(await readFile(marker, "utf8"), before, "the loser cannot overwrite or retain the winner's lease");
    await assert.rejects(access(path.join(profile, "Default", idb)), /ENOENT/);
    assert.equal(launchesSeen, 1);
    release();
    chrome = await opening;
    assert.equal(chrome.isClosed(), false);
    await chrome.close();
    failLaunch = true;
    await assert.rejects(openBaoChromeForProxy(options), /synthetic launch failure/);
    await assert.rejects(readFile(marker), /ENOENT/, "a failed launch releases its own empty profile");
    failLaunch = false;
    chrome = await openBaoChromeForProxy(options);
    assert.equal(chrome.isClosed(), false);
  } finally {
    release();
    chrome ??= await opening.catch(() => undefined);
    await chrome?.close();
    await launches.closeRetainedChrome(profile);
    await rm(root, { recursive: true, force: true });
  }
});

for (const scenario of ["stale SSO", "signed-out home", "signed-out wall"] as const) test(`Bao refreshes ${scenario} from the selected source without repeating an origin`, { timeout: 90_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-source-refresh-"));
  const sourceRoot = path.join(root, "source");
  const home = path.join(root, "home");
  const profile = baoAgentProfileDir(home);
  const server = createServer((request, response) => {
    const url = new URL(request.url!, `http://${request.headers.host}`);
    const redirect = (location: string) => { response.writeHead(302, { location }); response.end(); };
    if (scenario === "stale SSO") {
      if (url.pathname === "/callback") {
        response.setHeader("Set-Cookie", "session=fresh; Path=/");
        redirect(`${site}/mail`); return;
      }
      if (url.hostname === "localhost") {
        if (request.headers.cookie?.includes("sso=fresh")) { redirect(`${site}/callback`); return; }
      } else if (!request.headers.cookie?.includes("session=fresh")) {
        redirect(`${accounts}/login`); return;
      }
    }
    const signedIn = request.headers.cookie?.includes("session=fresh");
    const title = !signedIn && scenario !== "signed-out home" ? "Sign in" : "Account";
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><title>${title}</title><h1>${signedIn ? "Signed in" : "Signed out"}</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const site = `http://127.0.0.1:${port}`;
  const accounts = `http://localhost:${port}`;
  const opened = `${site}/${scenario === "stale SSO" ? "mail" : "home"}`;
  const log = path.join(root, "native.jsonl");
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs');
const {connectCdp}=require(${JSON.stringify(path.resolve(__dirname, "../../src/cdp-live/socket.js"))});
const args=process.argv.slice(2),command=args[args.indexOf('--idle-timeout')+2];
const endpoint=new URL(args[args.indexOf('--cdp')+1]);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({command,args})+'\\n');
(async()=>{
 if(command==='close'){console.log('Closed');return;}
 const tabs=(await (await fetch('http://'+endpoint.host+'/json/list')).json()).filter(t=>t.type==='page');
 if(command==='tab'){console.log(JSON.stringify({data:{tabs:tabs.map((t,i)=>({targetId:t.id,active:i===0}))}}));return;}
 const cdp=await connectCdp(Number(endpoint.port),endpoint.pathname);
 try{
  const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:tabs[0].id,flatten:true});
  await cdp.send('Page.enable',{},sessionId);
  const loaded=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('fixture navigation timed out')),5000);cdp.on('Page.loadEventFired',sessionId,()=>{clearTimeout(timer);resolve();});});
  await cdp.send('Page.navigate',{url:args.at(-1)},sessionId);await loaded;console.log('Opened');
 }finally{cdp.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
`, { mode: 0o700 });
  let observer: Awaited<ReturnType<typeof connectCdp>> | undefined;
  let launchCount = 0;
  const launch = launches.launchOwnedChromeEndpoint;
  t.mock.method(launches, "launchOwnedChromeEndpoint", (options: Parameters<typeof launch>[0]) => {
    launchCount++;
    return launch({ ...options, headless: true });
  });
  const proxy = new AgentBrowserProxy({ home, sourceRoot, executable });
  const writeSource = async (value: string) => {
    const source = await launches.launchOwnedChrome({ userDataDir: sourceRoot, headless: true });
    try {
      await source.addCookies([{ name: scenario === "stale SSO" ? "sso" : "session", value, url: scenario === "stale SSO" ? accounts : site }]);
      if (scenario !== "stale SSO") {
        const page = source.pages()[0]!;
        await page.goto(opened);
        await page.evaluate(() => localStorage.setItem("identity", "source-account"));
      }
    } finally { await source.close(); }
  };
  try {
    const previous = await launches.launchOwnedChrome({ userDataDir: profile, headless: true });
    try {
      await previous.addCookies([
        { name: "session", value: "revoked", url: site },
        { name: "bao-only", value: "keep", url: site },
        { name: "sso", value: "revoked", url: accounts },
      ]);
      if (scenario !== "stale SSO") {
        const page = previous.pages()[0]!;
        await page.goto(opened);
        await page.evaluate(() => localStorage.setItem("identity", "bao-account"));
      }
    } finally { await previous.close(); }
    await writeSource(scenario === "signed-out wall" ? "anonymous" : "fresh");
    const results = await proxy.execute("open", [opened], "bao");
    const commands = () => readFile(log, "utf8").then((text) => text.trim().split("\n").map((line) => JSON.parse(line) as { command: string }));
    assert.equal((await commands()).filter((entry) => entry.command === "open").length, scenario === "stale SSO" ? 2 : 1);
    assert.equal(launchCount, 2, "each open extracts source cookies only once for each needed origin");
    if (scenario === "signed-out wall") {
      assert.equal(JSON.parse(results[0]!.stdout).outcome, "halted");
    } else {
      assert.equal(results[0]!.stdout, "Opened\n");
      const endpoint = await readDevToolsActivePort(path.join(profile, "DevToolsActivePort"));
      observer = await connectCdp(endpoint.port, endpoint.browserPath);
      const { targetInfos } = await observer.send<{ targetInfos: { type: string; url: string; targetId: string }[] }>("Target.getTargets");
      const target = targetInfos.find((target) => target.type === "page" && target.url.startsWith(site))!;
      const { sessionId } = await observer.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      const evaluate = async (expression: string) => (await observer!.send<{ result: { value: string } }>("Runtime.evaluate", { expression, returnByValue: true }, sessionId, 2000)).result.value;
      const cookies = async () => (await observer!.send<{ cookies: { name: string; value: string }[] }>("Storage.getCookies")).cookies;
      assert.equal(await evaluate("document.querySelector('h1').textContent"), "Signed in");
      assert.equal((await cookies()).find((cookie) => cookie.name === "bao-only")?.value, "keep");
      if (scenario === "signed-out home") {
        assert.equal(await evaluate("localStorage.getItem('identity')"), "bao-account");
        await observer.send("Network.setCookie", { name: "session", value: "bao-renewed", url: site }, sessionId);
        await proxy.execute("open", [opened]);
        assert.equal((await cookies()).find((cookie) => cookie.name === "session")?.value, "bao-renewed", "unflushed Bao renewals beat the older source snapshot");
        await writeSource("fresh-again");
        await proxy.execute("open", [opened]);
        assert.equal((await cookies()).find((cookie) => cookie.name === "session")?.value, "fresh-again", "a later explicit open imports a newer daily session");
        assert.equal(await evaluate("localStorage.getItem('identity')"), "bao-account");
      }
    }
  } finally {
    try { await proxy.close(); }
    finally {
      await observer?.close();
      await launches.closeRetainedChrome(profile);
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
