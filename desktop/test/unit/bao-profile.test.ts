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
import * as sockets from "../../src/cdp-live/socket";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import { baoAgentProfileDir, openBaoChromeForProxy } from "../../src/engines/bao-profile";
import * as launches from "../../src/launch";
import { TOOLS } from "../../src/mcp/server";
import { readLocalStorage } from "../../src/login-import/storage";
import { Library } from "../../src/v1/store";
import type { RecordedAgentBrowserCommand } from "../../src/engines/agent-browser-record";
import { browserToolResult } from "../../src/mcp/tool-card";

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
  const launchOptions: Parameters<typeof launch>[0][] = [];
  t.mock.method(launches, "launchOwnedChromeEndpoint", (options: Parameters<typeof launch>[0]) => {
    launchCount++;
    launchOptions.push(options);
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
    assert.equal(launchOptions.length, 2);
    assert.equal(launchOptions[0]!.headless, false, "source Chrome keeps OS-keychain access");
    assert.deepEqual(launchOptions[0]!.appendArgs, ["--no-startup-window"], "sign-in extraction creates no window");
    assert.equal(launchOptions[0]!.keychain, undefined);
    assert.equal(launchOptions[1]!.headless, false, "the lasting Bao browser still opens its window");
    assert.equal(launchOptions[1]!.appendArgs, undefined);
    assert.equal(launchOptions[1]!.keychain, "mock");
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
      assert.deepEqual(launchOptions.at(-1)!.appendArgs, ["--no-startup-window"], "later sign-in refreshes also create no window");
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

test("Bao open skips error frames for storage and survives seed failures", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-error-frame-"));
  const sourceRoot = path.join(root, "source");
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><title>${request.url === "/login" ? "Sign in" : "Fixture"}</title><h1>Ready</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const activeTarget = path.join(root, "active-target");
  const log = path.join(root, "native.jsonl");
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs');
const {connectCdp}=require(${JSON.stringify(path.resolve(__dirname, "../../src/cdp-live/socket.js"))});
const args=process.argv.slice(2),command=args[args.indexOf('--idle-timeout')+2];
const endpoint=new URL(args[args.indexOf('--cdp')+1]);
(async()=>{
 if(command==='close'){console.log('Closed');return;}
 const targetId=fs.readFileSync(${JSON.stringify(activeTarget)},'utf8');
 if(command==='tab'){console.log(JSON.stringify({data:{tabs:[{targetId,active:true}]}}));return;}
 const cdp=await connectCdp(Number(endpoint.port),endpoint.pathname);
 try{
  const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:true});
  await cdp.send('Page.enable',{},sessionId);
  const loaded=new Set();cdp.on('Page.lifecycleEvent',sessionId,e=>{if(e.name==='load')loaded.add(e.loaderId);});
  await cdp.send('Page.setLifecycleEventsEnabled',{enabled:true},sessionId);
  const {loaderId}=await cdp.send('Page.navigate',{url:args.at(-1)},sessionId);
  const deadline=Date.now()+5000;
  while(loaderId&&!loaded.has(loaderId)){if(Date.now()>=deadline)throw new Error('fixture navigation timed out');await new Promise(r=>setTimeout(r,20));}
  fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({command})+'\\n');console.log('Opened');
 }finally{cdp.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
`, { mode: 0o700 });
  const connect = sockets.connectCdp;
  const pageIds = new Set<string>();
  let unverifiable = false;
  let failSeeding = false;
  let hiddenTabs = 0;
  let reusedStorage = 0;
  let seedAttempts = 0;
  const labels: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { labels.push(args); });
  t.mock.method(sockets, "connectCdp", async (...args: Parameters<typeof connect>) => {
    const cdp = await connect(...args);
    const send = cdp.send.bind(cdp);
    const sessions = new Map<string, string>();
    t.mock.method(cdp, "send", async <T>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs?: number): Promise<T> => {
      const reused = pageIds.has(sessions.get(sessionId ?? "") ?? "");
      if (reused && unverifiable && method === "Page.getFrameTree") throw new Error("fixture frame unavailable");
      if (method.startsWith("DOMStorage.")) {
        if (reused) reusedStorage++;
        seedAttempts++;
        if (failSeeding) throw new Error("fixture-private-storage-value");
      }
      if (method === "Target.createTarget" && params.hidden === true) hiddenTabs++;
      const result = await send<T>(method, params, sessionId, timeoutMs);
      if (method === "Target.attachToTarget") sessions.set((result as { sessionId: string }).sessionId, String(params.targetId));
      if (method === "Target.getTargets") {
        for (const target of (result as { targetInfos: { targetId: string; url: string }[] }).targetInfos) {
          if (pageIds.has(target.targetId)) target.url = `${site}/error`;
        }
      }
      return result;
    });
    return cdp;
  });
  const launch = launches.launchOwnedChromeEndpoint;
  const browsers: Awaited<ReturnType<typeof launch>>[] = [];
  t.mock.method(launches, "launchOwnedChromeEndpoint", async (options: Parameters<typeof launch>[0]) => {
    const browser = await launch({ ...options, headless: true });
    browsers.push(browser);
    const endpoint = await readDevToolsActivePort(browser.portFile);
    const cdp = await connect(endpoint.port, endpoint.browserPath);
    try {
      const { targetInfos } = await cdp.send<{ targetInfos: { type: string; targetId: string }[] }>("Target.getTargets");
      const targetId = targetInfos.find((target) => target.type === "page")!.targetId;
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
      const { frameTree } = await cdp.send<{ frameTree: { frame: { securityOrigin: string } } }>("Page.getFrameTree", {}, sessionId);
      assert.notEqual(frameTree.frame.securityOrigin, site, "the fake error target has a nonmatching committed origin");
      pageIds.add(targetId);
      await writeFile(activeTarget, targetId);
    } finally { cdp.close(); }
    return browser;
  });
  const proxy = new AgentBrowserProxy({ home: path.join(root, "home"), sourceRoot, executable });
  const startup = new AgentBrowserProxy({ home: path.join(root, "startup"), sourceRoot, executable });
  try {
    const source = await launches.launchOwnedChrome({ userDataDir: sourceRoot, headless: true });
    try {
      const page = source.pages()[0]!;
      await page.goto(site);
      await page.evaluate(() => localStorage.setItem("identity", "fixture-source-value"));
    } finally { await source.close(); }
    assert.equal((await proxy.execute("open", [site], "bao"))[0]!.stdout, "Opened\n");
    assert.equal(reusedStorage, 0, "a URL match cannot seed storage into an opaque error frame");
    assert.equal(hiddenTabs, 1, "the error frame uses the hidden fulfilled tab instead");
    const endpoint = await readDevToolsActivePort(browsers[0]!.portFile);
    const inspector = await connect(endpoint.port, endpoint.browserPath);
    try {
      const { sessionId } = await inspector.send<{ sessionId: string }>("Target.attachToTarget", { targetId: await readFile(activeTarget, "utf8"), flatten: true });
      const { entries } = await inspector.send<{ entries: [string, string][] }>("DOMStorage.getDOMStorageItems", { storageId: { securityOrigin: site, isLocalStorage: true } }, sessionId);
      assert.deepEqual(entries, [["identity", "fixture-source-value"]], "hidden-tab seeding restores storage for the requested origin");
    } finally { inspector.close(); }
    await proxy.execute("open", [site]);
    assert.ok(reusedStorage > 0, "an ordinary page with the correct committed origin still gets reused");
    assert.equal(hiddenTabs, 1);
    const beforeReuse = reusedStorage;
    unverifiable = true;
    assert.equal((await proxy.execute("open", [site]))[0]!.stdout, "Opened\n");
    assert.equal(reusedStorage, beforeReuse, "unverifiable frames never receive storage operations");
    assert.equal(hiddenTabs, 2);
    unverifiable = false;
    failSeeding = true;
    const beforeFailure = seedAttempts;
    assert.equal((await proxy.execute("open", [site]))[0]!.stdout, "Opened\n", "a failed later seed cannot prevent native navigation");
    assert.ok(seedAttempts > beforeFailure);
    const wall = await proxy.execute("open", [`${site}/login`]);
    assert.equal((JSON.parse(wall[0]!.stdout) as { outcome: string }).outcome, "halted", "a failed wall seed reaches normal owner wait");
    await proxy.close();
    assert.equal((await startup.execute("open", [site], "bao"))[0]!.stdout, "Opened\n", "a failed startup seed cannot prevent native navigation");
    const commands = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { command: string });
    assert.equal(commands.filter((entry) => entry.command === "open").length, 6);
    assert.ok(labels.some(([label]) => label === "Bao sign-in seed unavailable; continuing without import."));
    assert.doesNotMatch(JSON.stringify(labels), /fixture-private-storage-value|fixture-source-value/);
  } finally {
    try { await proxy.close(); await startup.close(); }
    finally {
      for (const browser of browsers) await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
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
    assert.equal((JSON.parse(await readFile(marker, "utf8")) as { pid: number }).pid, process.pid);
    await assert.rejects(openBaoChromeForProxy(options), /already open/);
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    assert.equal(dead.status, 0);
    const pid = Number(dead.stdout);
    assert.ok(pid > 1);
    await writeFile(marker, JSON.stringify({ pid }));
    chrome = await openBaoChromeForProxy(options);
    assert.notDeepEqual(launches.pidsForDataDir(profile), []);
    assert.equal((JSON.parse(await readFile(marker, "utf8")) as { pid: number }).pid, process.pid);
    slowClose = true;
    await chrome.close();
    assert.equal((JSON.parse(await readFile(marker, "utf8")) as { retained: boolean }).retained, true);
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

for (const scenario of ["stale SSO", "signed-out home", "signed-out wall", "newer anonymous wall", "unavailable source", "unavailable SSO source", "native same-origin wall", "native SSO wall", "failed wall retry"] as const) test(`Bao refreshes ${scenario} from the selected source without repeating an origin`, { timeout: 90_000 }, async (t) => {
  const native = scenario === "native same-origin wall" || scenario === "native SSO wall";
  if (native && !process.env.AGENT_BROWSER_PROXY_BINARY) { t.skip("set AGENT_BROWSER_PROXY_BINARY to exercise the real native daemon"); return; }
  const root = await mkdtemp(path.join(tmpdir(), "bao-source-refresh-"));
  const sourceRoot = path.join(root, "source");
  const home = path.join(root, "home");
  const profile = baoAgentProfileDir(home);
  const sso = scenario === "stale SSO" || scenario === "unavailable SSO source" || scenario === "native SSO wall";
  const unavailable = scenario === "unavailable source" || scenario === "unavailable SSO source";
  const olderSource = scenario === "newer anonymous wall" || scenario === "stale SSO" || native || scenario === "failed wall retry";
  const server = createServer((request, response) => {
    const url = new URL(request.url!, `http://${request.headers.host}`);
    const redirect = (location: string) => { response.writeHead(302, { location }); response.end(); };
    if (sso) {
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
    const title = url.pathname === "/login" || !signedIn && scenario !== "signed-out home" ? "Sign in" : "Account";
    response.setHeader("Content-Type", "text/html");
    response.end(`<!doctype html><title>${title}</title><h1>${signedIn ? "Signed in" : "Signed out"}</h1>`);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const site = `http://127.0.0.1:${port}`;
  const accounts = `http://localhost:${port}`;
  const opened = `${site}/${sso ? "mail" : "home"}`;
  const log = path.join(root, "native.jsonl");
  const activeTarget = path.join(root, "active-target");
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs');
const {connectCdp}=require(${JSON.stringify(path.resolve(__dirname, "../../src/cdp-live/socket.js"))});
const args=process.argv.slice(2),command=args[args.indexOf('--idle-timeout')+2];
const endpoint=new URL(args[args.indexOf('--cdp')+1]);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({command,args})+'\\n');
(async()=>{
 if(command==='close'){console.log('Closed');return;}
 if(${scenario === "failed wall retry"} && command==='open' && fs.readFileSync(${JSON.stringify(log)},'utf8').trim().split('\\n').filter(line=>JSON.parse(line).command==='open').length===2){console.error('synthetic daemon retry failure');process.exitCode=1;return;}
 const tabs=(await (await fetch('http://'+endpoint.host+'/json/list')).json()).filter(t=>t.type==='page');
 const active=fs.readFileSync(${JSON.stringify(activeTarget)},'utf8');
 if(command==='tab'){console.log(JSON.stringify({data:{tabs:tabs.map(t=>({targetId:t.id,active:t.id===active}))}}));return;}
 const cdp=await connectCdp(Number(endpoint.port),endpoint.pathname);
 try{
  const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:active,flatten:true});
  await cdp.send('Page.enable',{},sessionId);
  const loaded=new Set();
  cdp.on('Page.lifecycleEvent',sessionId,event=>{if(event.name==='load')loaded.add(event.loaderId);});
  await cdp.send('Page.setLifecycleEventsEnabled',{enabled:true},sessionId);
  const {loaderId}=await cdp.send('Page.navigate',{url:args.at(-1)},sessionId);
  const deadline=Date.now()+5000;
  while(loaderId&&!loaded.has(loaderId)){if(Date.now()>=deadline)throw new Error('fixture navigation timed out');await new Promise(resolve=>setTimeout(resolve,20));}
  console.log('Opened');
 }finally{cdp.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
`, { mode: 0o700 });
  let observer: Awaited<ReturnType<typeof connectCdp>> | undefined;
  let launchCount = 0;
  const launch = launches.launchOwnedChromeEndpoint;
  t.mock.method(launches, "launchOwnedChromeEndpoint", async (options: Parameters<typeof launch>[0]) => {
    launchCount++;
    if (unavailable && path.basename(options.userDataDir).startsWith("bao-login-source-")) throw new Error("synthetic source launch failure");
    const browser = await launch({ ...options, headless: true });
    if (options.userDataDir === profile) {
      const endpoint = await readDevToolsActivePort(browser.portFile);
      const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
      try {
        const { targetInfos } = await cdp.send<{ targetInfos: { type: string; targetId: string }[] }>("Target.getTargets");
        await writeFile(activeTarget, targetInfos.find((target) => target.type === "page")!.targetId);
      } finally { cdp.close(); }
    }
    return browser;
  });
  const proxy = new AgentBrowserProxy({ home, sourceRoot, executable: native ? process.env.AGENT_BROWSER_PROXY_BINARY : executable });
  const writeSource = async (value: string) => {
    const source = await launches.launchOwnedChrome({ userDataDir: sourceRoot, headless: true });
    try {
      await source.addCookies([{ name: sso ? "sso" : "session", value, url: sso ? accounts : site }]);
      if (scenario === "stale SSO") await source.addCookies([{ name: "analytics", value: "anonymous", url: site }]);
      if (!sso) {
        const page = source.pages()[0]!;
        await page.goto(opened);
        await page.evaluate(() => localStorage.setItem("identity", "source-account"));
      }
    } finally { await source.close(); }
  };
  try {
    if (olderSource) await writeSource("fresh");
    const previous = await launches.launchOwnedChrome({ userDataDir: profile, headless: true });
    try {
      await previous.addCookies([
        { name: "session", value: scenario === "unavailable source" ? "fresh" : "revoked", url: site },
        { name: "bao-only", value: "keep", url: site },
        { name: "sso", value: "revoked", url: accounts },
      ]);
      if (!sso) {
        const page = previous.pages()[0]!;
        await page.goto(opened);
        await page.evaluate(() => localStorage.setItem("identity", "bao-account"));
      }
    } finally { await previous.close(); }
    if (!olderSource) await writeSource(scenario === "signed-out wall" ? "anonymous" : "fresh");
    if (scenario === "failed wall retry") {
      await assert.rejects(proxy.execute("open", [opened], "bao"), /Bao sign-in retry failed: synthetic daemon retry failure/);
      const capture = new Library(home).readRun(proxy.lastCommand!.runId);
      const step = (capture.steps as RecordedAgentBrowserCommand[])[0]!;
      assert.equal(step.status, "failed");
      assert.equal(step.native.isError, true);
      assert.match(step.native.error!, /Bao sign-in retry failed/);
      assert.deepEqual(step.native.results, [{ stdout: "Opened\n", stderr: "", exitCode: 0 }]);
      const card = browserToolResult("open", step.native.results, proxy.lastCommand, proxy.activeRunId, step.native.error);
      assert.equal(card.isError, true);
      assert.ok(card.content.some((item) => item.text === "Opened\n"), "the UI fallback retains exact native output beside the error");
      return;
    }
    if (native) {
      const copy = await proxy.execute("open", ["about:blank"]);
      assert.equal(copy[0]!.exitCode, 0, copy[0]!.stderr);
      await assert.rejects(proxy.execute("open", [opened], "bao"), /close/i);
      await proxy.close();
      launchCount = 0;
    }
    const results = await proxy.execute("open", [opened], "bao");
    assert.equal(results[0]!.exitCode, 0, results[0]!.stderr);
    const commands = () => readFile(log, "utf8").then((text) => text.trim().split("\n").map((line) => JSON.parse(line) as { command: string }));
    if (!native) assert.equal((await commands()).filter((entry) => entry.command === "open").length, scenario === "stale SSO" || scenario === "newer anonymous wall" ? 2 : 1, JSON.stringify(results));
    assert.equal(launchCount, 2, "each open extracts source cookies only once for each needed origin");
    if (scenario === "signed-out wall" || scenario === "unavailable SSO source") {
      assert.equal((JSON.parse(results[0]!.stdout) as { outcome: string }).outcome, "halted");
    } else {
      if (!native) assert.equal(results[0]!.stdout, "Opened\n");
      else assert.notEqual((JSON.parse(results[0]!.stdout.startsWith("{") ? results[0]!.stdout : "{}") as { outcome?: string }).outcome, "halted", "valid source sign-in must recover without owner input");
      const endpoint = await readDevToolsActivePort(path.join(profile, "DevToolsActivePort"));
      observer = await connectCdp(endpoint.port, endpoint.browserPath);
      const { targetInfos } = await observer.send<{ targetInfos: { type: string; url: string; targetId: string }[] }>("Target.getTargets");
      const target = targetInfos.find((target) => target.type === "page" && target.url.startsWith(site))!;
      const { sessionId } = await observer.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      const evaluate = async (expression: string) => (await observer!.send<{ result: { value: string } }>("Runtime.evaluate", { expression, returnByValue: true }, sessionId, 2000)).result.value;
      const cookies = async () => (await observer!.send<{ cookies: { name: string; value: string }[] }>("Storage.getCookies")).cookies;
      assert.equal(await evaluate("document.querySelector('h1').textContent"), "Signed in");
      assert.equal((await cookies()).find((cookie) => cookie.name === "bao-only")?.value, "keep");
      if (!sso) assert.equal(await evaluate("localStorage.getItem('identity')"), "bao-account");
      if (scenario === "unavailable source") {
        assert.equal((await proxy.execute("open", [opened]))[0]!.stdout, "Opened\n", "a source launch failure cannot block a later open");
        assert.equal(launchCount, 3);
        await writeFile(path.join(sourceRoot, "Local State"), "not valid JSON");
        assert.equal((await proxy.execute("open", [opened]))[0]!.stdout, "Opened\n", "an unreadable source state cannot block a working Bao login");
        assert.equal((await cookies()).find((cookie) => cookie.name === "session")?.value, "fresh");
        assert.equal(await evaluate("localStorage.getItem('identity')"), "bao-account");
        const wall = await proxy.execute("open", [`${site}/login`]);
        assert.equal((JSON.parse(wall[0]!.stdout) as { outcome: string }).outcome, "halted", "a failed wall snapshot falls through to owner wait");
        assert.equal(launchCount, 3, "wall handling reuses the failed open snapshot without another source launch");
      }
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
      observer?.close();
      await launches.closeRetainedChrome(profile);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("browser choice is explicit on open and rejects unknown values", async () => {
  const proxy = new AgentBrowserProxy({ home: "/unused" });
  await assert.rejects(proxy.execute("open", [], "other"), /must be copy, bao, or current/);
  await assert.rejects(proxy.execute("snapshot", [], "bao"), /only accepted on open/);
  const tool = TOOLS.find((item) => item.name === "agent_browser")!;
  assert.ok("browser" in tool.inputSchema.properties);
  assert.deepEqual(tool.inputSchema.properties.browser.enum, ["copy", "bao", "current"]);
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
