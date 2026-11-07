import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import * as profiles from "../../src/engines/chrome-profile-copy";
import * as bao from "../../src/engines/bao-profile";
import * as launches from "../../src/launch";
import { launchOwnedChromeEndpoint, pinTestBrowser, pidsForDataDir } from "../../src/launch";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { ownerWall, ownerCanResume, ownerWaitTimeout } from "../../src/cdp-live/owner-wait";
import { Library } from "../../src/v1/store";
import { startExperianFixture } from "../experian/fixture";
import type { RecordedAgentBrowserCommand } from "../../src/engines/agent-browser-record";

pinTestBrowser();

test("owner wait classifies only URL/title and bounds every call below the MCP timeout", () => {
  for (const [url, title, reason] of [
    ["https://usa.experian.com/login/index", "Experian", "login_wall"],
    ["https://usa.experian.com/member", "Verify your identity", "login_wall"],
    ["https://usa.experian.com/member", "hCaptcha check", "bot_wall"],
    ["https://usa.experian.com/member", "Request unsuccessful", "bot_wall"],
    ["https://example.com/wiki/CAPTCHA", "Article", null],
    ["https://example.com/challenge-results", "Challenge results", null],
    ["https://example.com/imperva-guide", "Guide", null],
    ["https://example.com/article", "Captchability", null],
    ["https://example.com/_Incapsula_Resource?token=fixture", "Check", "bot_wall"],
    ["https://newassets.hcaptcha.com/captcha/v1/fixture/static/hcaptcha.html", "Check", "bot_wall"],
    ["https://www.google.com/recaptcha/api2/bframe", "Check", "bot_wall"],
    ["https://www.recaptcha.net/recaptcha/enterprise/anchor", "Check", "bot_wall"],
  ]) assert.equal(ownerWall({ url: url!, title: title! }), reason);
  const before = { url: "https://example.test/member", title: "hCaptcha check" };
  assert.equal(ownerCanResume(before, before), false);
  assert.equal(ownerCanResume(before, { ...before, title: "Dashboard" }), true);
  assert.equal(ownerCanResume(before, { ...before, title: "Sign in" }), false);
  assert.equal(ownerCanResume(before, { url: "chrome-error://chromewebdata/", title: "Error" }), false);
  assert.equal(ownerWaitTimeout(undefined), 60000);
  assert.equal(ownerWaitTimeout(120000), 120000);
  for (const value of [0, -1, 120001, Infinity, NaN, "60000", 1.5]) assert.throws(() => ownerWaitTimeout(value));
});

for (const { browser, check, bare } of [
  { browser: "copy", check: "signin", bare: false }, { browser: "copy", check: "captcha", bare: false },
  { browser: "bao", check: "signin", bare: false }, { browser: "bao", check: "captcha", bare: false },
  { browser: "bao", check: "signin", bare: true },
] as const) test(`pass-through ${browser} ${check} ${bare ? "bare open" : "URL"} waits privately then continues in the same window and Library run`, { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-owner-proxy-"));
  const fixture = await startExperianFixture({ loopbackHttp: true });
  const sourceRoot = path.join(root, "source");
  await mkdir(path.join(sourceRoot, "Default"), { recursive: true });
  await writeFile(path.join(sourceRoot, "Local State"), "{}");
  await writeFile(path.join(sourceRoot, "Default", "Preferences"), "{}");
  let copyDir = "";
  let closeBrowser: (() => Promise<void>) | undefined;
  t.mock.method(profiles, "openCopiedChromeForProxy", async (options: Parameters<typeof profiles.openCopiedChromeForProxy>[0]): ReturnType<typeof profiles.openCopiedChromeForProxy> => {
    const copy = await profiles.copyChromeProfile(options);
    copyDir = copy.userDataDir;
    const browser = await launchOwnedChromeEndpoint({ userDataDir: copy.userDataDir, childHome: path.join(root, "user"), headless: true });
    closeBrowser = browser.close;
    return {
      target: { kind: "bao" as const, portFile: browser.portFile }, closed: browser.closed,
      bytes: copy.bytes, copyMs: copy.copyMs, isClosed: browser.isClosed,
      keepOpen: async () => { await copy.keepOpen(); browser.keepOpen(); },
      close: async () => { await browser.close(); await copy.close(); },
    };
  });
  const importCalls: string[] = [];
  let startSite: string | undefined;
  const openBao = bao.openBaoChromeForProxy;
  const launch = launches.launchOwnedChromeEndpoint;
  t.mock.method(launches, "launchOwnedChromeEndpoint", (options: Parameters<typeof launch>[0]) => launch({ ...options, headless: true }));
  t.mock.method(bao, "openBaoChromeForProxy", async (options: Parameters<typeof openBao>[0]) => {
    startSite = options.site;
    const chrome = await openBao(options);
    copyDir = bao.baoAgentProfileDir(options.home);
    closeBrowser = chrome.close;
    return { ...chrome, importLogin: async (site: string) => {
      importCalls.push(site);
      return chrome.importLogin(site);
    } };
  });
  const log = path.join(root, "native.jsonl");
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs');
const {connectCdp}=require(${JSON.stringify(path.resolve(__dirname, "../../src/cdp-live/socket.js"))});
const args=process.argv.slice(2), command=args[args.indexOf('--idle-timeout')+2];
const endpoint=new URL(args[args.indexOf('--cdp')+1]);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({command,args})+'\\n');
(async()=>{
 if(command==='close'){console.log('close native output');return;}
 const tabs=await (await fetch('http://'+endpoint.host+'/json/list')).json();
 const tab=tabs.find(t=>t.type==='page');
 if(command==='tab') console.log(JSON.stringify({data:{tabs:tabs.filter(t=>t.type==='page').map(t=>({targetId:t.id,url:t.url,title:t.url,active:t.id===tab.id}))}}));
 else if(command==='open'){
  const cdp=await connectCdp(Number(endpoint.port),endpoint.pathname);
  try {const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:tab.id,flatten:true}); await cdp.send('Page.enable',{},sessionId); const loaded=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('fixture navigation timed out')),5000);cdp.on('Page.loadEventFired',sessionId,()=>{clearTimeout(timer);resolve();});}); await cdp.send('Page.navigate',{url:args.at(-1)==='fixture.test' ? ${JSON.stringify(fixture.url('/owner/start?check=signin'))} : args.at(-1)},sessionId); await loaded; console.log('Opened');} finally{cdp.close();}
 }else console.log(command+' native output');
})().catch(e=>{console.error(e);process.exitCode=1;});
`, { mode: 0o700 });
  const home = path.join(root, "home");
  const proxy = new AgentBrowserProxy({ home, sourceRoot, executable });
  const abort = () => { proxy.disconnect(); void closeBrowser?.().catch(() => undefined); };
  t.signal.addEventListener("abort", abort, { once: true });
  let observer: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  const outcome = (result: Awaited<ReturnType<AgentBrowserProxy["execute"]>>) => (JSON.parse(result[0]!.stdout) as { outcome: string }).outcome;
  try {
    assert.equal(outcome(await proxy.execute("open", [bare ? "fixture.test" : fixture.url(`/owner/start?check=${check}`)], browser)), "halted");
    if (bare) {
      assert.equal(startSite, "https://fixture.test/");
      assert.equal(importCalls[0], new URL(fixture.url("/")).origin);
      const commands = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(commands.find((entry) => entry.command === "open").args.at(-1), "fixture.test");
    }
    const library = new Library(home);
    const initial = library.listRuns()[0]!;
    assert.equal(initial.status, "needs_human");
    assert.equal((initial.steps as RecordedAgentBrowserCommand[])[0]!.afterShot, undefined);
    const endpoint = await readDevToolsActivePort(path.join(copyDir, "DevToolsActivePort"));
    observer = await chromium.connectOverCDP(`http://127.0.0.1:${endpoint.port}`);
    const page = observer.contexts()[0]!.pages().find((page) => page.url().includes("/owner/"))!;
    assert.ok(page);
    page.setDefaultTimeout(5000);
    assert.match(await page.locator("#bao-owner-wait").innerText(), /waiting for you/);
    assert.equal(importCalls.length, bare ? 1 : 0, "only a new redirect-wall origin gets a second import");
    const importsBefore = importCalls.length;
    const before = await readFile(log, "utf8");
    for (const command of ["snapshot", "screenshot", "fill", "press", "tab", "open"]) {
      assert.equal(outcome(await proxy.execute(command, ["fixture-private-credential"])), "halted");
    }
    assert.equal(await readFile(log, "utf8"), before, "no native commands while the owner types");
    assert.equal(importCalls.length, importsBefore, "owner input never triggers a login import");
    const begin = Date.now();
    assert.equal(outcome(await proxy.execute("wait_for_owner", ["40"])), "waiting");
    assert.ok(Date.now() - begin < 3000);
    await assert.rejects(proxy.execute("wait_for_owner", ["120001"]), /timeoutMs/);
    assert.equal(await readFile(log, "utf8"), before, "polls use only browser target metadata");
    const waiting = proxy.execute("wait_for_owner", ["5000"]);
    if (check === "signin") {
      await page.getByLabel("Email").fill("owner@example.test");
      await page.getByLabel("Password").fill("fixture-private-password");
      await page.getByRole("button", { name: "Sign in" }).click();
    } else {
      await page.getByRole("checkbox").check();
      await page.getByRole("button", { name: "Continue" }).click();
    }
    assert.equal(outcome(await waiting), "ready");
    assert.equal(observer.contexts()[0]!.pages().filter((p) => !p.isClosed()).length, 1);
    assert.equal((await proxy.execute("snapshot"))[0]!.stdout, "snapshot native output\n");
    assert.equal(library.listRuns()[0]!.id, initial.id);
    assert.equal(library.listRuns()[0]!.status, "recording");
    const saved = await readFile(path.join(home, "runs", `${initial.id}.json`), "utf8");
    assert.doesNotMatch(saved, /fixture-private|owner@example/);
    for (const step of (JSON.parse(saved) as { steps: RecordedAgentBrowserCommand[] }).steps.filter((step) => ["open", "wait_for_owner"].includes(step.native.command))) {
      assert.equal(step.afterShot, undefined);
      assert.equal(step.native.screenshots.length, 0);
    }
    await page.goto(fixture.url("/owner/check"));
    await proxy.execute("snapshot");
    assert.equal(importCalls.length, importsBefore, "later walls never retry the original open");
    await page.evaluate(() => { document.body.innerHTML = "<h1>Dashboard</h1>"; });
    assert.equal(outcome(await proxy.execute("wait_for_owner", ["30"])), "waiting", "unchanged metadata stays private");
    await page.evaluate(() => { document.title = "Dashboard"; });
    assert.equal(outcome(await proxy.execute("wait_for_owner", ["2000"])), "ready", "same URL can leave a check when title changes");
    await page.goto(fixture.url("/owner/check"));
    await proxy.execute("snapshot");
    const closed = proxy.execute("wait_for_owner", ["5000"]);
    if (check === "captcha") await closeBrowser!();
    else await page.close();
    assert.equal(outcome(await closed), "closed");
    const ended = library.readRun(initial.id);
    assert.equal(ended.status, "failed");
    assert.equal(ended.envelope?.reason, "session_closed");
    assert.equal(ended.envelope?.status, "failed");
  } finally {
    t.signal.removeEventListener("abort", abort);
    try { await proxy.close(); }
    finally {
      try { await observer?.close(); }
      finally {
        try { await fixture.close(); }
        finally {
          try {
            if (copyDir) {
              await launches.closeRetainedChrome(copyDir);
              assert.deepEqual(pidsForDataDir(copyDir), [], "no process owns this test profile");
              if (browser === "copy") await assert.rejects(readFile(path.join(copyDir, "Default", "Preferences")), /ENOENT/, "the copy was removed");
            }
          } finally { await rm(root, { recursive: true, force: true }); }
        }
      }
    }
  }
});
