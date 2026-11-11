import assert from "node:assert/strict";
import fsp, { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { chromium } from "playwright";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import * as profiles from "../../src/engines/chrome-profile-copy";
import * as bao from "../../src/engines/bao-profile";
import * as launches from "../../src/launch";
import * as currentChrome from "../../src/cdp-live/current-chrome";
import { launchOwnedChromeEndpoint, pinTestBrowser, pidsForDataDir } from "../../src/launch";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { CdpSocket } from "../../src/cdp-live/socket";
import { OWNER_WAIT_LIMIT_MS, ownerWall, ownerCanResume, ownerWaitInstruction, ownerWaitTimeout } from "../../src/cdp-live/owner-wait";
import { Library } from "../../src/v1/store";
import { socketRoot } from "../../src/unix-socket";
import { startExperianFixture } from "../experian/fixture";
import type { RecordedAgentBrowserCommand } from "../../src/engines/agent-browser-record";
import { LIST_TARGETS } from "../support/fake-agent-browser";
import { scaledMs } from "../runtime";

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

/** A proxy on a throwaway source profile, headless Chrome, a fake native agent-browser, and the local Experian fixture. */
async function ownerProxy(t: TestContext) {
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
    const targetId = await profiles.agentTab(browser.portFile);
    return {
      target: { kind: "bao" as const, portFile: browser.portFile }, targetId, closed: browser.closed,
      bytes: copy.bytes, copyMs: copy.copyMs, isClosed: browser.isClosed,
      keepOpen: async () => { await copy.keepOpen(); browser.keepOpen(); },
      close: async () => { await browser.close(); await copy.close(); },
    };
  });
  let attaches = 0;
  t.mock.method(currentChrome, "openCurrentChrome", async () => { attaches++; throw new Error("Chrome is not open. Open Google Chrome, then try again."); });
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
    return { ...chrome, importLogin: async (site: string, preferSource = false) => {
      importCalls.push(site);
      return chrome.importLogin(site, preferSource);
    } };
  });
  const log = path.join(root, "native.jsonl");
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}
${LIST_TARGETS}
const fs=require('node:fs');
const {connectCdp}=require(${JSON.stringify(path.resolve(__dirname, "../../src/cdp-live/socket.js"))});
const args=process.argv.slice(2), command=args[args.indexOf('--idle-timeout')+2];
const endpoint=new URL(args[args.indexOf('--cdp')+1]);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({command,args})+'\\n');
(async()=>{
 if(command==='close'){console.log('close native output');return;}
 const tabs=await listTargets(endpoint.href);
 const bound=fs.existsSync(process.env.AGENT_BROWSER_SOCKET_DIR+'/bao.target') ? JSON.parse(fs.readFileSync(process.env.AGENT_BROWSER_SOCKET_DIR+'/bao.target','utf8')).targetId : undefined;
 const tab=tabs.find(t=>t.id===bound)??tabs.find(t=>t.type==='page');
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
  return {
    root, fixture, home, proxy, log, importCalls,
    get startSite() { return startSite; }, get attaches() { return attaches; }, get copyDir() { return copyDir; }, get closeBrowser() { return closeBrowser; },
    async cleanup(browser: string, observer?: { close(): Promise<void> }) {
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
    },
  };
}

const outcome = (result: Awaited<ReturnType<AgentBrowserProxy["execute"]>>) => (JSON.parse(result[0]!.stdout) as { outcome: string }).outcome;
const instruction = (result: Awaited<ReturnType<AgentBrowserProxy["execute"]>>) => (JSON.parse(result[0]!.stdout) as { instruction: string }).instruction;

for (const { browser, check, bare } of [
  { browser: "copy", check: "signin", bare: false }, { browser: "copy", check: "captcha", bare: false },
  { browser: "bao", check: "signin", bare: false }, { browser: "bao", check: "captcha", bare: false },
  { browser: "bao", check: "signin", bare: true },
] as const) test(`pass-through ${browser} ${check} ${bare ? "bare open" : "URL"} waits privately then continues in the same window and Library run`, { timeout: scaledMs(30_000) }, async (t) => {
  const h = await ownerProxy(t);
  const { fixture, home, proxy, log, importCalls } = h;
  let observer: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    assert.equal(outcome(await proxy.execute("open", [bare ? "fixture.test" : fixture.url(`/owner/start?check=${check}`)], browser)), "halted");
    if (browser === "bao") {
      assert.equal(h.attaches, 1, "a Bao profile at a wall tries the owner's running Chrome first");
      assert.match(proxy.pickLines.at(-1)!, /^Bao's own browser hit a (sign-in page|human check) on (?:127\.0\.0\.1|fixture\.test)\. Bao could not continue in your running Chrome over remote debugging: Chrome is not open\. Open Google Chrome, then try again\. The session stays in Bao's window; Bao tries again on the next wait_for_owner\.$/);
    } else assert.equal(h.attaches, 0, "a copy never switches on its own");
    if (bare) {
      assert.equal(h.startSite, "https://fixture.test/");
      assert.equal(importCalls[0], new URL(fixture.url("/")).origin);
      const commands = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { command: string; args: string[] });
      assert.equal(commands.find((entry) => entry.command === "open")!.args.at(-1), "fixture.test");
    }
    const library = new Library(home);
    const initial = library.listRuns()[0]!;
    assert.equal(initial.status, "needs_human");
    assert.equal((initial.steps as RecordedAgentBrowserCommand[])[0]!.afterShot, undefined);
    const endpoint = await readDevToolsActivePort(path.join(h.copyDir, "DevToolsActivePort"));
    observer = await chromium.connectOverCDP(`http://127.0.0.1:${endpoint.port}`);
    const page = observer.contexts()[0]!.pages().find((page) => page.url().includes("/owner/"))!;
    assert.ok(page);
    const pages = observer.contexts()[0]!.pages().length;
    page.setDefaultTimeout(5000);
    assert.match(await page.locator("#bao-owner-wait").innerText(), /waiting for you/);
    assert.equal(importCalls.length, browser === "bao" && check === "signin" ? 1 : 0, "only an explicit open's login wall can apply its source snapshot");
    const importsBefore = importCalls.length;
    const before = await readFile(log, "utf8");
    for (const command of ["snapshot", "screenshot", "fill", "press", "tab"]) {
      assert.equal(outcome(await proxy.execute(command, ["fixture-private-credential"], undefined, false, undefined, {}, proxy.activeRunId)), "halted");
    }
    assert.equal(await readFile(log, "utf8"), before, "no native commands while the owner types");
    assert.equal(importCalls.length, importsBefore, "owner input never triggers a login import");
    const begin = Date.now();
    assert.equal(outcome(await proxy.execute("wait_for_owner", ["40"], undefined, false, undefined, {}, proxy.activeRunId)), "waiting");
    assert.ok(Date.now() - begin < 3000);
    await assert.rejects(proxy.execute("wait_for_owner", ["120001"], undefined, false, undefined, {}, proxy.activeRunId), /timeoutMs/);
    assert.equal(await readFile(log, "utf8"), before, "polls use only browser target metadata");
    const waiting = proxy.execute("wait_for_owner", ["5000"], undefined, false, undefined, {}, proxy.activeRunId);
    if (check === "signin") {
      await page.getByLabel("Email").fill("owner@example.test");
      await page.getByLabel("Password").fill("fixture-private-password");
      await page.getByRole("button", { name: "Sign in" }).click();
    } else {
      await page.getByRole("checkbox").check();
      await page.getByRole("button", { name: "Continue" }).click();
    }
    assert.equal(outcome(await waiting), "ready");
    assert.equal(h.attaches, browser === "bao" ? 3 : 0, "every explicit wait_for_owner on a Bao profile tries the owner's running Chrome again");
    assert.equal(observer.contexts()[0]!.pages().filter((p) => !p.isClosed()).length, pages);
    assert.equal((await proxy.execute("snapshot", [], undefined, false, undefined, {}, proxy.activeRunId))[0]!.stdout, "snapshot native output\n");
    assert.equal(library.listRuns()[0]!.id, initial.id);
    assert.equal(library.listRuns()[0]!.status, "recording");
    const saved = await readFile(path.join(home, "runs", `${initial.id}.json`), "utf8");
    assert.doesNotMatch(saved, /fixture-private|owner@example/);
    for (const step of (JSON.parse(saved) as { steps: RecordedAgentBrowserCommand[] }).steps.filter((step) => ["open", "wait_for_owner"].includes(step.native.command))) {
      assert.equal(step.afterShot, undefined);
      assert.equal(step.native.screenshots.length, 0);
    }
    await page.goto(fixture.url("/owner/check"));
    await proxy.execute("snapshot", [], undefined, false, undefined, {}, proxy.activeRunId);
    assert.equal(importCalls.length, importsBefore, "later walls never retry the original open");
    await page.evaluate(() => { document.body.innerHTML = "<h1>Dashboard</h1>"; });
    assert.equal(outcome(await proxy.execute("wait_for_owner", ["30"], undefined, false, undefined, {}, proxy.activeRunId)), "waiting", "unchanged metadata stays private");
    await page.evaluate(() => { document.title = "Dashboard"; });
    assert.equal(outcome(await proxy.execute("wait_for_owner", ["2000"], undefined, false, undefined, {}, proxy.activeRunId)), "ready", "same URL can leave a check when title changes");
    await page.goto(fixture.url("/owner/check"));
    await proxy.execute("snapshot", [], undefined, false, undefined, {}, proxy.activeRunId);
    const closed = proxy.execute("wait_for_owner", ["5000"], undefined, false, undefined, {}, proxy.activeRunId);
    if (check === "captcha") await h.closeBrowser!();
    else await page.close();
    assert.equal(outcome(await closed), "closed");
    const ended = library.readRun(initial.id);
    assert.equal(ended.status, "failed");
    assert.equal(ended.envelope?.reason, "session_closed");
    assert.equal(ended.envelope?.status, "failed");
    const cutOff = ended.steps.at(-1) as { status?: string; native?: { command?: string } } | undefined;
    assert.equal(cutOff?.native?.command, "wait_for_owner");
    assert.equal(cutOff?.status, "failed");
  } finally { await h.cleanup(browser, observer); }
});

test("an owner wait follows a later wall in its card, instruction, banner, and ready baseline", { timeout: scaledMs(30_000) }, async (t) => {
  const h = await ownerProxy(t);
  const { proxy, fixture } = h;
  let observer: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    await proxy.execute("open", [fixture.url("/owner/sign-in?two-factor")], "copy");
    const runId = proxy.activeRunId!;
    const since = proxy.ownerPage!.since;
    const endpoint = await readDevToolsActivePort(path.join(h.copyDir, "DevToolsActivePort"));
    observer = await chromium.connectOverCDP(`http://127.0.0.1:${endpoint.port}`);
    const page = observer.contexts()[0]!.pages().find((page) => page.url().includes("/owner/sign-in"))!;
    const waiting = proxy.execute("wait_for_owner", ["1500"], undefined, false, undefined, {}, runId);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const result = await waiting;
    assert.equal(outcome(result), "waiting");
    assert.deepEqual(proxy.ownerPage, { url: fixture.url("/owner/verify"), title: "Two-factor authentication", since });
    assert.match(instruction(result), /Ask the owner to finish the check on 127\.0\.0\.1/);
    assert.equal(proxy.lastCommand!.step.summary!.owner!.title, "Two-factor authentication");
    assert.equal(proxy.lastCommand!.step.summary!.owner!.url, fixture.url("/owner/verify"));
    assert.match(await page.locator("#bao-owner-wait").innerText(), /waiting for you to finish the check/);
    await page.evaluate(() => { document.title = "Confirm your account"; });
    assert.equal(outcome(await proxy.execute("wait_for_owner", ["300"], undefined, false, undefined, {}, runId)), "waiting");
    assert.equal(proxy.ownerPage!.title, "Confirm your account", "a title-only change on a wall updates the same wait");
    assert.equal(await page.locator("#bao-owner-wait").count(), 1, "replacing a banner does not stack it");
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    assert.equal(outcome(await proxy.execute("wait_for_owner", ["2000"], undefined, false, undefined, {}, runId)), "ready");
    assert.equal(await page.locator("#bao-owner-wait").count(), 0);
    assert.equal(proxy.activeRunId, runId);
    assert.equal(outcome(await proxy.execute("wait_for_owner", ["50"], undefined, false, undefined, {}, runId)), "ready", "a page that is not a wall does not start a wait");
    await page.goto(fixture.url("/owner/verify"));
    assert.equal(outcome(await proxy.execute("wait_for_owner", ["300"], undefined, false, undefined, {}, runId)), "waiting");
    await page.goto(fixture.url("/member"));
    assert.equal(outcome(await proxy.execute("wait_for_owner", ["2000"], undefined, false, undefined, {}, runId)), "ready");
  } finally { await h.cleanup("copy", observer); }
});

test("a later wall re-injects its banner without activating or raising the window", { timeout: scaledMs(45_000) }, async (t) => {
  const front: string[] = [];
  const send = CdpSocket.prototype.send;
  t.mock.method(CdpSocket.prototype, "send", function (this: CdpSocket, ...args: Parameters<typeof send>) {
    if (args[0] === "Target.activateTarget" || args[0] === "Browser.getWindowForTarget" || args[0] === "Browser.setWindowBounds") front.push(args[0]);
    return send.apply(this, args);
  });
  const h = await ownerProxy(t);
  const { proxy, fixture } = h;
  let observer: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    const opened = await proxy.execute("open", [fixture.url("/owner/sign-in?two-factor")], "copy");
    assert.ok(front.includes("Target.activateTarget"), "the first wall still brings the window forward");
    const since = proxy.ownerPage!.since;
    const broughtFront = /Bao brought this window to the front for the owner/;
    const firstFront = broughtFront.test(instruction(opened));
    const runId = proxy.activeRunId!;
    const endpoint = await readDevToolsActivePort(path.join(h.copyDir, "DevToolsActivePort"));
    observer = await chromium.connectOverCDP(`http://127.0.0.1:${endpoint.port}`);
    const page = observer.contexts()[0]!.pages().find((item) => item.url().includes("/owner/sign-in"))!;
    page.setDefaultTimeout(5000);
    const quiet = async (result: Awaited<ReturnType<AgentBrowserProxy["execute"]>>, what: string) => {
      assert.deepEqual(front, [], what);
      assert.equal(broughtFront.test(instruction(result)), firstFront, what);
      assert.equal(proxy.ownerPage!.since, since, what);
      assert.equal(proxy.activeRunId, runId, what);
      assert.equal(await page.locator("#bao-owner-wait").count(), 1, what);
    };

    front.length = 0;
    const moving = proxy.execute("wait_for_owner", ["2500"], undefined, false, undefined, {}, runId);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const moved = await moving;
    assert.equal(outcome(moved), "waiting");
    assert.equal(proxy.ownerPage!.url, fixture.url("/owner/verify"));
    assert.equal(proxy.ownerPage!.title, "Two-factor authentication");
    assert.match(await page.locator("#bao-owner-wait").innerText(), /finish the check/);
    await quiet(moved, "a later wall URL does not activate or raise");

    await page.evaluate(() => document.getElementById("bao-owner-wait")?.remove());
    await page.evaluate(() => { document.title = "Confirm your account"; });
    front.length = 0;
    const retitled = await proxy.execute("wait_for_owner", ["1500"], undefined, false, undefined, {}, runId);
    assert.equal(outcome(retitled), "waiting");
    assert.equal(proxy.ownerPage!.title, "Confirm your account");
    assert.equal(proxy.ownerPage!.url, fixture.url("/owner/verify"));
    await quiet(retitled, "a title-only change re-injects the banner without activating or raising");
  } finally { await h.cleanup("copy", observer); }
});

test("finish_task reports a wait the timer ended once, not on the next browser call", { timeout: scaledMs(30_000) }, async (t) => {
  const h = await ownerProxy(t);
  const { proxy, fixture } = h;
  let offset = 0;
  const now = Date.now;
  t.mock.method(Date, "now", () => now() + offset);
  try {
    await proxy.execute("open", [fixture.url("/owner/start?check=captcha")], "copy");
    const runId = proxy.activeRunId!;
    offset = proxy.ownerPage!.since! + OWNER_WAIT_LIMIT_MS - 5000 - now();
    await proxy.execute("snapshot", [], undefined, false, undefined, {}, runId);
    const deadline = now() + 10_000;
    while (proxy.hasSession() && now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(proxy.hasSession(), false, "the timer ended the session before finish_task");
    assert.equal(await proxy.finishTask({ outcome: "failed", reason: "The wait ended" }, runId), undefined);
    assert.match(proxy.endedWait ?? "", /Bao ended an earlier owner wait .*nobody continued it for 30 minutes\./);
    await proxy.finishTask({ outcome: "failed", reason: "No session" }, runId);
    assert.equal(proxy.endedWait, undefined, "finish_task consumes the notice only once");
    await proxy.execute("open", [fixture.url("/")], "copy");
    assert.equal(proxy.endedWait, undefined, "a later browser call does not inherit the old notice");
  } finally { await h.cleanup("copy"); }
});

test("an owner wait nobody continues ends by itself at its limit, and a later open starts a new task that names the wait Bao ended", { timeout: scaledMs(60_000) }, async (t) => {
  const h = await ownerProxy(t);
  const { fixture, home, proxy } = h;
  const library = new Library(home);
  const ended = (why = "nobody continued it for 30 minutes") => new RegExp(`^Bao ended an earlier owner wait from (?:[A-Z][a-z]{2} \\d+, )?\\d{1,2}:\\d\\d [AP]M; ${why}\\.$`);
  let offset = 0;
  const now = Date.now;
  t.mock.method(Date, "now", () => now() + offset);
  try {
    assert.equal(outcome(await proxy.execute("open", [fixture.url("/owner/start?check=captcha")], "copy")), "halted");
    const first = proxy.activeRunId!;
    // An agent that keeps calling wait_for_owner keeps the wait past 30 minutes from its start, as while the owner types an emailed code.
    offset = proxy.ownerPage!.since! + OWNER_WAIT_LIMIT_MS - 5000 - now();
    assert.equal(outcome(await proxy.execute("wait_for_owner", ["40"], undefined, false, undefined, {}, proxy.activeRunId)), "waiting");
    offset += 10_000;
    assert.equal(outcome(await proxy.execute("wait_for_owner", ["40"], undefined, false, undefined, {}, proxy.activeRunId)), "waiting", "a continued wait outlives the limit counted from its start");
    assert.equal(proxy.activeRunId, first);
    // Shortly before the limit after the latest wait call, any other call re-arms the session's timer, which then ends the wait with no further call.
    offset += OWNER_WAIT_LIMIT_MS - 5000;
    assert.equal(outcome(await proxy.execute("snapshot", [], undefined, false, undefined, {}, proxy.activeRunId)), "halted");
    assert.equal(proxy.activeRunId, first);
    const deadline = now() + 30_000;
    while (proxy.hasSession() && now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(proxy.hasSession(), false, "the timer ended the wait and closed its window");
    assert.equal(library.readRun(first).status, "failed");
    assert.equal(library.readRun(first).envelope?.reason, "session_closed");

    assert.equal(outcome(await proxy.execute("open", [fixture.url("/owner/start?check=captcha")], "copy")), "halted", "a fresh open starts a new task");
    assert.match(proxy.endedWait ?? "", ended());
    const second = proxy.activeRunId!;
    assert.notEqual(second, first);
    await proxy.execute("snapshot", [], undefined, false, undefined, {}, proxy.activeRunId);
    assert.equal(proxy.endedWait, undefined, "only the next result names the ended wait");
    const timedOut = await proxy.execute("wait_for_owner", ["40"], undefined, false, undefined, {}, first);
    assert.equal(outcome(timedOut), "closed", "a chat that comes back to a wait the timer ended learns it ended");
    assert.equal(instruction(timedOut), `This run's browser session ended and cannot continue. Report that to the owner. Run ${first} is not Bao's open browser session. The browser now belongs to another task, so stop here.`);
    assert.equal(proxy.activeRunId, second);

    // A new chat's open during a fresh wait ends that wait and opens fresh; only wait_for_owner continues a wait.
    assert.equal(outcome(await proxy.execute("open", [fixture.url("/owner/start?check=captcha")], "copy")), "halted");
    assert.match(proxy.endedWait ?? "", ended("a new open starts a new task"));
    assert.equal(library.readRun(second).envelope?.reason, "A newer task opened, so Bao ended this session.", "a newer open records the ended run as ended by a newer task");
    const third = proxy.activeRunId!;
    assert.notEqual(third, second);

    // A Mac that slept past the limit never ran the timer. The next open checks the limit itself.
    offset += OWNER_WAIT_LIMIT_MS;
    const opened = await proxy.execute("open", [fixture.url("/")], "copy");
    assert.equal(opened[0]!.stdout, "Opened\n", "the open ran natively instead of returning the old wait");
    assert.match(proxy.endedWait ?? "", ended());
    assert.notEqual(proxy.activeRunId, third);
    assert.equal(library.readRun(third).status, "failed");
    assert.equal(library.listRuns().length, 4);
  } finally { await h.cleanup("copy"); }
});

test("a wait_for_owner, close, or finish_task that names a run a newer open ended leaves the newer chat's session alone, in either order", { timeout: scaledMs(90_000) }, async (t) => {
  for (const order of ["chat A first", "chat B waits first"] as const) await t.test(order, async (t) => {
    const h = await ownerProxy(t);
    const { fixture, proxy } = h;
    let observer: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
    try {
      const halted = await proxy.execute("open", [fixture.url("/owner/start?check=captcha")], "copy");
      assert.equal(outcome(halted), "halted");
      const chatA = proxy.activeRunId!;
      assert.match(instruction(halted), new RegExp(`call agent_browser with command=wait_for_owner, args=\\["60000"\\], and run_id="${chatA}"\\.`));
      await proxy.execute("open", [fixture.url("/")], "copy");
      const chatB = proxy.activeRunId!;
      assert.notEqual(chatB, chatA);
      const endpoint = await readDevToolsActivePort(path.join(h.copyDir, "DevToolsActivePort"));
      observer = await chromium.connectOverCDP(`http://127.0.0.1:${endpoint.port}`);
      const page = observer.contexts()[0]!.pages().find((page) => page.url() === fixture.url("/"))!;
      if (order === "chat B waits first") {
        await page.goto(fixture.url("/owner/sign-in"));
        assert.equal(outcome(await proxy.execute("wait_for_owner", ["40"], undefined, false, undefined, {}, proxy.activeRunId)), "waiting", "chat B starts a wait on a sign-in page");
        assert.equal(await page.locator("#bao-owner-wait").count(), 1);
      }
      const owner = proxy.ownerPage;
      const steps = new Library(h.home).readRun(chatB).steps.length;
      const untouched = async (what: string) => {
        assert.equal(proxy.lastCommand, undefined, `${what}: chat B's run records no step for chat A`);
        assert.deepEqual(proxy.pickLines, [], `${what}: chat A's result does not name chat B's browser`);
        assert.equal(proxy.activeRunId, chatB, `${what}: chat B's session stays open`);
        assert.deepEqual(proxy.ownerPage, owner, `${what}: chat B's wait, or no wait, stays as it was`);
        assert.equal(new Library(h.home).readRun(chatB).status, order === "chat B waits first" ? "needs_human" : "recording");
        assert.equal(new Library(h.home).readRun(chatB).steps.length, steps);
        assert.equal(await page.locator("#bao-owner-wait").count(), order === "chat B waits first" ? 1 : 0, `${what}: no banner on a page chat B is not waiting on`);
        assert.equal(page.isClosed(), false, `${what}: chat B's tab stays open`);
      };
      const ended = `This run's browser session ended and cannot continue. Report that to the owner. Run ${chatA} is not Bao's open browser session. The browser now belongs to another task, so stop here.`;
      const late = await proxy.execute("wait_for_owner", ["40"], undefined, false, undefined, {}, chatA);
      assert.equal(outcome(late), "closed");
      assert.equal(instruction(late), ended);
      assert.deepEqual(proxy.refused, { runId: chatA });
      await untouched("wait_for_owner");
      const closed = await proxy.execute("close", [], undefined, false, undefined, {}, chatA);
      assert.equal(outcome(closed), "closed");
      assert.equal(instruction(closed), ended);
      await untouched("close");
      const snapped = await proxy.execute("snapshot", [], undefined, false, undefined, {}, chatA);
      assert.equal(outcome(snapped), "closed");
      assert.equal(instruction(snapped), ended);
      await untouched("snapshot");
      const clicked = await proxy.execute("click", ["@e1"], undefined, false, undefined, {}, chatA);
      assert.equal(outcome(clicked), "closed");
      assert.equal(instruction(clicked), ended);
      await untouched("click");
      assert.equal(await proxy.finishTask({ outcome: "failed", reason: "chat A gave up" }, chatA), undefined);
      assert.deepEqual(proxy.refused, { runId: chatA });
      await untouched("finish_task");
      for (const [what, call] of [
        ["wait_for_owner", () => proxy.execute("wait_for_owner", ["40"])],
        ["close", () => proxy.execute("close")],
        ["snapshot", () => proxy.execute("snapshot")],
        ["click", () => proxy.execute("click", ["@e1"])],
        ["finish_task", () => proxy.finishTask({ outcome: "failed", reason: "no run named" })],
      ] as const) {
        await assert.rejects(call(), new RegExp(`^Error: run_id is required on ${what} while a browser session is open\\. Send back the run id from this chat's latest agent_browser result; a chat whose results named no run has no session here\\.$`));
        assert.deepEqual(proxy.refused, {});
        await untouched(`${what} without run_id`);
      }
      if (order === "chat B waits first") assert.equal(outcome(await proxy.execute("wait_for_owner", ["40"], undefined, false, undefined, {}, chatB)), "waiting");
      else assert.equal((await proxy.execute("snapshot", [], undefined, false, undefined, {}, proxy.activeRunId))[0]!.stdout, "snapshot native output\n", "chat B continues");
      assert.equal(proxy.refused, undefined);
      assert.equal(await proxy.finishTask({ outcome: "passed", reason: "chat B finished" }, ` ${chatB}`.trim()), chatB, "chat B's own run id ends chat B's session");
      assert.equal(new Library(h.home).readRun(chatB).envelope?.reason, order === "chat B waits first" ? "session_closed" : "chat B finished");
    } finally { await h.cleanup("copy", observer); }
  });
});

test("a wait_for_owner on a page that is not a wall returns ready and does not stick, and a later command still needs the open's run id", { timeout: scaledMs(60_000) }, async (t) => {
  const h = await ownerProxy(t);
  const { fixture, proxy } = h;
  try {
    await proxy.execute("open", [fixture.url("/")], "copy");
    const run = proxy.activeRunId!;
    assert.equal((await proxy.execute("snapshot", [], undefined, false, undefined, {}, run))[0]!.stdout, "snapshot native output\n", "a snapshot that names the open run acts on it");
    await assert.rejects(proxy.execute("click", ["@e1"]), /run_id is required on click while a browser session is open/);
    assert.equal(outcome(await proxy.execute("wait_for_owner", ["40"], undefined, false, undefined, {}, run)), "ready");
    assert.equal(proxy.activeRunId, run);
    assert.equal(proxy.ownerPage, undefined);
    assert.equal(new Library(h.home).readRun(run).status, "recording");
    assert.equal(await proxy.finishTask({ outcome: "passed", reason: "The page was already open." }, run), run);
    assert.equal(new Library(h.home).readRun(run).envelope?.reason, "The page was already open.");
  } finally { await h.cleanup("copy"); }
});

function traceStderr(t: TestContext): string[] {
  const traced: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, "write", ((chunk: string | Uint8Array, ...args: unknown[]) => {
    traced.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return write(chunk, ...(args as [BufferEncoding?]));
  }) as typeof process.stderr.write);
  return traced;
}

test("a cleanup failure while a newer open ends a wait names no ended run and still starts", { timeout: scaledMs(60_000) }, async (t) => {
  let fail = true;
  const failed: string[] = [];
  const remove = fsp.rm;
  const traced = traceStderr(t);
  t.mock.method(fsp, "rm", async (file: Parameters<typeof rm>[0], options: Parameters<typeof rm>[1]) => {
    if (fail && isProxyStateDir(file)) { failed.push(String(file)); throw new Error("fixture rm failed"); }
    return remove(file, options);
  });
  const h = await ownerProxy(t);
  const { fixture, home, proxy } = h;
  const library = new Library(home);
  try {
    assert.equal(outcome(await proxy.execute("open", [fixture.url("/owner/start?check=captcha")], "copy")), "halted");
    const chatA = proxy.activeRunId!;
    const opened = await proxy.execute("open", [fixture.url("/")], "copy");
    assert.equal(opened[0]!.stdout, "Opened\n");
    assert.equal(JSON.stringify(opened).includes(chatA), false, "chat B's open does not name the ended run");
    assert.equal(JSON.stringify(opened).includes("fixture rm failed"), false, "chat B's open does not carry the cleanup error");
    assert.equal(traced.includes(`Bao could not clean up the browser session of run ${chatA}: fixture rm failed\n`), true);
    assert.notEqual(proxy.activeRunId, chatA);
    assert.equal(proxy.hasSession(), true);
    assert.equal(proxy.ownerPage, undefined);
    assert.match(proxy.endedWait ?? "", /; a new open starts a new task\.$/);
    assert.equal((proxy.endedWait ?? "").includes(chatA), false);
    assert.equal(library.readRun(chatA).cleanupError, "fixture rm failed");
    assert.equal(library.readRun(chatA).envelope?.reason, "A newer task opened, so Bao ended this session.");
    fail = false;
    assert.equal((await proxy.execute("snapshot", [], undefined, false, undefined, {}, proxy.activeRunId))[0]!.stdout, "snapshot native output\n");
  } finally {
    fail = false;
    for (const dir of failed) await remove(dir, { recursive: true, force: true });
    await h.cleanup("copy");
    await rm(socketRoot(home), { recursive: true, force: true });
  }
});

test("a cleanup failure while a newer open ends a wait past its limit still starts and names no ended run", { timeout: scaledMs(60_000) }, async (t) => {
  let fail = true;
  const failed: string[] = [];
  const remove = fsp.rm;
  const traced = traceStderr(t);
  t.mock.method(fsp, "rm", async (file: Parameters<typeof rm>[0], options: Parameters<typeof rm>[1]) => {
    if (fail && isProxyStateDir(file)) { failed.push(String(file)); throw new Error("fixture rm failed"); }
    return remove(file, options);
  });
  let offset = 0;
  const now = Date.now;
  t.mock.method(Date, "now", () => now() + offset);
  const h = await ownerProxy(t);
  const { fixture, home, proxy } = h;
  const library = new Library(home);
  try {
    assert.equal(outcome(await proxy.execute("open", [fixture.url("/owner/start?check=captcha")], "copy")), "halted");
    const chatA = proxy.activeRunId!;
    offset = OWNER_WAIT_LIMIT_MS + 1000;
    const opened = await proxy.execute("open", [fixture.url("/")], "copy");
    assert.equal(opened[0]!.stdout, "Opened\n");
    assert.equal(JSON.stringify(opened).includes(chatA), false);
    assert.equal(JSON.stringify(opened).includes("fixture rm failed"), false);
    assert.equal(traced.includes(`Bao could not clean up the browser session of run ${chatA}: fixture rm failed\n`), true);
    assert.notEqual(proxy.activeRunId, chatA);
    assert.match(proxy.endedWait ?? "", /; nobody continued it for 30 minutes\.$/);
    assert.equal((proxy.endedWait ?? "").includes(chatA), false);
    assert.equal(library.readRun(chatA).cleanupError, "fixture rm failed");
    assert.equal(library.readRun(chatA).envelope?.reason, "session_closed");
    fail = false;
  } finally {
    fail = false;
    for (const dir of failed) await remove(dir, { recursive: true, force: true });
    await h.cleanup("copy");
    await rm(socketRoot(home), { recursive: true, force: true });
  }
});

function isProxyStateDir(file: unknown): boolean {
  const name = String(file);
  return path.basename(name).startsWith("proxy-") && path.basename(path.dirname(name)).startsWith("bao-");
}

test("a same-chat open during an owner wait continues that task and keeps the wait", { timeout: scaledMs(60_000) }, async (t) => {
  const h = await ownerProxy(t);
  const { fixture, home, proxy } = h;
  const library = new Library(home);
  try {
    assert.equal(outcome(await proxy.execute("open", [fixture.url("/owner/start?check=captcha")], "copy")), "halted");
    const run = proxy.activeRunId!;
    const owner = proxy.ownerPage;
    const steps = library.readRun(run).steps.length;
    const runs = library.listRuns().length;
    const continued = await proxy.execute("open", [fixture.url("/owner/start?check=captcha")], "copy", false, undefined, {}, run);
    assert.equal(outcome(continued), "halted");
    assert.equal(proxy.activeRunId, run);
    assert.deepEqual(proxy.ownerPage, owner);
    assert.equal(library.readRun(run).status, "needs_human");
    assert.equal(library.readRun(run).steps.length, steps);
    assert.equal(proxy.endedWait, undefined);
    assert.equal(library.listRuns().length, runs);
    assert.equal(outcome(await proxy.execute("wait_for_owner", ["40"], undefined, false, undefined, {}, run)), "waiting");
  } finally { await h.cleanup("copy"); }
});

test("the owner-wait instruction names the page's ask and sends the owner to the browser the session drives", () => {
  const current = ownerWaitInstruction(true, false, "run-fixture", { url: "https://www.amazon.com/ap/signin", title: "Amazon Sign-In" });
  assert.match(current, /Ask the owner to sign in to amazon\.com in Bao's task tab in their own Chrome,/);
  assert.match(current, /Bao ends the wait if no wait_for_owner call continues it for 30 minutes\./);
  assert.match(current, /On closed, report that the owner's Chrome session ended\.$/);
  assert.doesNotMatch(current, /Bao window|brought/);
  const bao = ownerWaitInstruction(false, true, "run-fixture", { url: "https://myaccount.nytimes.com/auth/login", title: "Confirm your account" });
  assert.match(bao, /^Keep this session open\. Bao brought this window to the front for the owner\. /);
  assert.match(ownerWaitInstruction(false, false, "run-fixture"), /^Keep this session open\. Ask the owner /, "Bao claims the raise only when it ran");
  assert.match(bao, /Ask the owner to finish the check on myaccount\.nytimes\.com in this Bao window,/);
  assert.doesNotMatch(bao, /sign in/);
  assert.match(bao, /On closed, report that the owner closed the window\.$/);
  assert.match(ownerWaitInstruction(false, false, "run-fixture"), /Ask the owner to finish the check on the page in this Bao window, then call agent_browser with command=wait_for_owner, args=\["60000"\], and run_id="run-fixture"\./);
});
