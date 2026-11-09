import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import * as currentChrome from "../../src/cdp-live/current-chrome";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { pageWall } from "../../src/cdp-live/page-wall";
import { connectCdp, type CdpSocket } from "../../src/cdp-live/socket";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import type { RecordedAgentBrowserCommand } from "../../src/engines/agent-browser-record";
import * as bao from "../../src/engines/bao-profile";
import * as launches from "../../src/launch";
import { closeRetainedChrome, pidsForDataDir, pinTestBrowser } from "../../src/launch";
import { Library } from "../../src/v1/store";
import { chromeProfiles } from "../support/chrome-profiles";

pinTestBrowser();

/** The snapshot of run-ff8d955a, where Bao's own browser met the Times account check (the email is a placeholder). */
const TIMES_CHECK = `- generic
  - generic
    - generic
      - banner
        - generic
          - generic
            - link "SKIP TO CONTENT" [ref=e5]
            - button "Section Navigation" [expanded=false, ref=e6]
              - StaticText "Section Navigation"
            - button "Search" [expanded=false, ref=e9]
              - StaticText "Search"
          - link "The New York Times homepage" [ref=e4]
          - generic
            - link "GIVE THE TIMES" [ref=e7]
            - button "Account Information" [expanded=false, ref=e8]
              - StaticText "Account"
- dialog "Continue reading"
  - paragraph
    - StaticText "To leave, use your browser's Back button."
  - paragraph
    - StaticText "Confirm your account"
  - paragraph
    - StaticText "We noticed multiple devices using this subscription. To continue, please request a verification code for owner@example.test."
  - link "Email me a one-time code" [ref=e1]
    - paragraph
      - StaticText "Email me a one-time code"
  - link "Create a new account" [ref=e2]
    - paragraph
      - StaticText "Create a new account"
  - link "Help Center" [ref=e3]
    - StaticText "Help Center"
`;
const TIMES_ARTICLE = `- banner
  - link "The New York Times homepage" [ref=e1]
  - button "Log in" [ref=e2]
- main
  - heading "The Best Pizza in New York City" [level=1, ref=e3]
  - link "Joe's Pizza" [ref=e4]
`;
const SIGN_IN_FORM = `- main
  - heading "Sign in to Example" [level=1, ref=e1]
  - textbox "Email" [ref=e2]
  - textbox "Password" [ref=e3]
  - button "Sign in" [ref=e4]
`;
const ACCOUNT = `- main
  - heading "Your account" [level=1, ref=e1]
  - link "Sign out" [ref=e2]
`;
const NO_WALL = `- banner
  - link "Sign in" [ref=e1]
  - searchbox "Search" [ref=e2]
- dialog "We use cookies"
  - StaticText "We and our partners use cookies."
  - button "Accept" [ref=e3]
- main
  - heading "How to sign in with a passkey" [level=1, ref=e4]
  - link "Get Claude Code" [ref=e5]
  - textbox "ZIP code" [ref=e6]
`;

test("an in-page wall is a sign-in dialog or main heading beside a password field, a code field, or a send-a-code control", () => {
  assert.equal(pageWall(TIMES_CHECK), true, "the Times account check");
  assert.equal(pageWall(SIGN_IN_FORM), true, "a plain sign-in form");
  assert.equal(pageWall(`- dialog "Verify it's you"\n  - StaticText "Enter the verification code we sent"\n  - textbox "Enter code" [ref=e1]\n`), true, "a code field in a dialog");
  for (const snapshot of [TIMES_ARTICLE, ACCOUNT, NO_WALL, "",
    `- dialog "Newsletter"\n  - StaticText "Sign up for our newsletter"\n  - textbox "Email" [ref=e1]\n`,
    `- dialog "Sign in"\n  - button "Continue with Google" [ref=e1]\n- textbox "Password" [ref=e2]\n`,
  ]) assert.equal(pageWall(snapshot), false, snapshot);
});

/**
 * A site that knows the owner's running Chrome by a device cookie and checks every other browser, a fake native agent-browser
 * that reads each page's snapshot from the page, Bao's own headless profile, and a fake owner's running Chrome.
 */
async function harness(t: TestContext, initial: "works" | "refused") {
  let attach = initial;
  let delay = 0;
  const root = await mkdtemp(path.join(tmpdir(), "bao-move-"));
  const server = createServer((request, response) => {
    const known = request.headers.cookie?.includes("device=known") ?? false;
    if (request.url === "/gate" && !known || request.url === "/trap" && known) { response.writeHead(302, { location: "/login" }).end(); return; }
    const [title, snapshot] = request.url === "/times" ? ["The Best Pizza in New York City - The New York Times", known ? TIMES_ARTICLE : TIMES_CHECK]
      : request.url === "/account" ? ["Example", known ? ACCOUNT : SIGN_IN_FORM]
        : request.url === "/login" ? ["Sign in", SIGN_IN_FORM]
        : ["Article", NO_WALL];
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><title>${title}</title><script type="text/plain" id="snapshot">${snapshot}</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sourceRoot = await chromeProfiles(path.join(root, "source"));
  await writeFile(path.join(sourceRoot, "Default", "Preferences"), "{}");
  const home = path.join(root, "home");
  const baoDir = bao.baoAgentProfileDir(home);
  const launch = launches.launchOwnedChromeEndpoint;
  t.mock.method(launches, "launchOwnedChromeEndpoint", (options: Parameters<typeof launch>[0]) => launch({ ...options, headless: true }));

  const owner = await launch({ userDataDir: path.join(root, "owner"), headless: true });
  const endpoint = await readDevToolsActivePort(owner.portFile);
  const probe = await connectCdp(endpoint.port, endpoint.browserPath);
  await probe.send("Storage.setCookies", { cookies: [{ name: "device", value: "known", url: site }] });
  await probe.send("Target.createTarget", { url: `${site}/article` });
  // Bao's task tab opens the way fakeTaskTab opens it, once its renderer answers, so a loaded test machine does not time out the attach.
  t.mock.method(currentChrome, "openTaskTab", async (chrome: Pick<currentChrome.CurrentChrome, "cdp">) => {
    const { targetId } = await chrome.cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: true }, undefined, 5000);
    const { sessionId } = await chrome.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, undefined, 30_000);
    await chrome.cdp.send("Runtime.evaluate", { expression: "1" }, sessionId, 30_000);
    await chrome.cdp.send("Target.detachFromTarget", { sessionId }, undefined, 30_000);
    return { targetId, background: true };
  });
  let attaches = 0;
  t.mock.method(currentChrome, "openCurrentChrome", async () => {
    attaches++;
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (attach === "refused") throw new Error("Chrome is not open. Open Google Chrome, then try again.");
    const cdp: CdpSocket = await connectCdp(endpoint.port, endpoint.browserPath);
    return { pid: 7, executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", root: sourceRoot, endpoint, cdp, closed: cdp.disconnected,
      isClosed: () => !cdp.isOpen, detach: () => cdp.close(),
      withConsent: <T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => operation(signal ?? new AbortController().signal) };
  });

  const log = path.join(root, "native.jsonl");
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs'), path=require('node:path');
const {connectCdp}=require(${JSON.stringify(path.resolve(__dirname, "../../src/cdp-live/socket.js"))});
const args=process.argv.slice(2), at=args.indexOf('--idle-timeout')+2, command=args[at], rest=args.slice(at+1);
const endpoint=new URL(args[args.indexOf('--cdp')+1]);
(async()=>{
 if(command==='close'){console.log('closed');return;}
 let bound; try{bound=JSON.parse(fs.readFileSync(path.join(process.env.AGENT_BROWSER_SOCKET_DIR,'bao.target'),'utf8')).targetId;}catch{}
 const tabs=(await (await fetch('http://'+endpoint.host+'/json/list')).json()).filter(t=>t.type==='page');
 const tab=tabs.find(t=>t.id===bound)??tabs.find(t=>!t.url.startsWith('chrome'))??tabs[0];
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({command,port:endpoint.port,url:tab.url})+'\\n');
 if(command==='tab'){console.log(rest.includes('--json')?JSON.stringify({data:{tabs:[{targetId:tab.id,url:tab.url,title:tab.title,active:true}]}}):'→ [t1] '+tab.title);return;}
 const cdp=await connectCdp(Number(endpoint.port),endpoint.pathname);
 try{
  const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:tab.id,flatten:true});
  const read=async(expression)=>(await cdp.send('Runtime.evaluate',{expression,returnByValue:true},sessionId)).result.value;
  if(command==='open'){
   await cdp.send('Page.enable',{},sessionId);
   const loaded=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('fixture navigation timed out')),20000);cdp.on('Page.loadEventFired',sessionId,()=>{clearTimeout(timer);resolve();});});
   await cdp.send('Page.navigate',{url:rest.at(-1)},sessionId); await loaded;
   console.log('✓ '+await read('document.title')+'\\n  '+await read('location.href'));
  } else if(command==='snapshot') process.stdout.write(await read("document.getElementById('snapshot')?.textContent ?? ''"));
  else console.log(command+' native output');
 } finally{cdp.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
`, { mode: 0o700 });

  const proxy = new AgentBrowserProxy({ home, sourceRoot, executable });
  t.after(async () => {
    try { await proxy.close(); }
    finally {
      probe.close();
      await owner.close();
      await closeRetainedChrome(baoDir);
      assert.deepEqual(pidsForDataDir(baoDir), [], "no process owns Bao's test profile");
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  const calls = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { command: string; port: string; url: string });
  const pages = async () => (await probe.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets")).targetInfos.filter((target) => target.type === "page");
  const ownerTabs = (await pages()).map((target) => target.targetId).sort();
  return { proxy, site, home, sourceRoot, baoDir, endpoint, ownerTabs, calls, pages, attaches: () => attaches,
    allow: () => { attach = "works"; }, slow: (ms: number) => { delay = ms; } };
}

const MOVED = `Bao's own browser hit a sign-in or verification prompt on 127.0.0.1; continued in your running Chrome (Chrome profile "Default", Owner) over remote debugging. Take a fresh snapshot before acting.`;
const REFUSED = "Bao's own browser hit a sign-in or verification prompt on 127.0.0.1. Bao could not continue in your running Chrome over remote debugging: Chrome is not open. Open Google Chrome, then try again. The session stays in Bao's window; Bao tries again on the next wait_for_owner.";
const savedSteps = (home: string) => new Library(home).listRuns()[0]!.steps as RecordedAgentBrowserCommand[];

/** Moves Bao's own tab from one page to another, the way a delayed redirect or the owner would. */
async function navigateBao(baoDir: string, from: string, to: string): Promise<void> {
  const endpoint = await readDevToolsActivePort(path.join(baoDir, "DevToolsActivePort"));
  const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
  try {
    const tab = (await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets")).targetInfos
      .find((target) => target.type === "page" && target.url.endsWith(from))!;
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: tab.targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    const loaded = new Promise<void>((resolve) => cdp.on("Page.loadEventFired", sessionId, () => resolve()));
    await cdp.send("Page.navigate", { url: to }, sessionId);
    await loaded;
  } finally { cdp.close(); }
}

const baoClosed = async (dir: string) => {
  for (const deadline = Date.now() + 5000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 50))) {
    if (!pidsForDataDir(dir).length) return true;
  }
  return false;
};

for (const { wall, page, before, after } of [
  { wall: "the Times account check", page: "/times", before: /Email me a one-time code/, after: TIMES_ARTICLE },
  { wall: "a plain sign-in form", page: "/account", before: /textbox "Password"/, after: ACCOUNT },
]) test(`a Bao profile whose snapshot shows ${wall} continues in the owner's running Chrome on the same profile`, { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "works");
  const [opened] = await h.proxy.execute("open", [`${h.site}${page}`]);
  assert.equal(opened!.exitCode, 0, opened!.stderr);
  assert.match(h.proxy.pickLines[0]!, /^Browser: Bao profile, the default\./);
  assert.equal(h.attaches(), 0, "an open whose URL and title look normal stays in Bao's profile");
  const baoPort = (await h.calls()).find((call) => call.command === "open")!.port;

  const [snapshot] = await h.proxy.execute("snapshot");
  assert.equal(snapshot!.stdout, after, `the snapshot is the owner's Chrome tab, past the wall: ${h.proxy.pickLines.join(" | ")}`);
  assert.doesNotMatch(snapshot!.stdout, before);
  assert.ok(h.proxy.lastCommand!.step.summary!.text.startsWith(`${MOVED} Read the page`), h.proxy.lastCommand!.step.summary!.text);
  assert.ok(savedSteps(h.home).at(-1)!.summary!.text.startsWith(MOVED), "the run keeps the move on the step where it happened");
  assert.ok(!savedSteps(h.home)[0]!.summary!.text.includes("running Chrome"), "the open before it ran in Bao's own browser");
  assert.deepEqual(h.proxy.pickLines, [
    `Browser: Running Chrome over remote debugging, fallback after a sign-in wall. Chrome app: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome. User data: ${h.sourceRoot}. `
      + `Profile: "Default" (Owner) in ${h.sourceRoot}, the only profile. Bao's task tab opened in the background.`,
  ]);
  assert.equal(h.attaches(), 1);
  assert.ok(await baoClosed(h.baoDir), "Bao closes its own window");

  const [clicked] = await h.proxy.execute("click", ["@e2"]);
  assert.equal(clicked!.stdout, "click native output\n");
  assert.deepEqual(h.proxy.pickLines, ['Browser: Running Chrome over remote debugging, Chrome profile "Default".']);
  const calls = await h.calls();
  const moved = calls.findIndex((call) => call.port !== baoPort);
  assert.ok(moved > 0);
  assert.deepEqual(calls.slice(moved).map((call) => call.port), calls.slice(moved).map(() => String(h.endpoint.port)), "every later command acts in the owner's Chrome");
  assert.equal(calls[moved]!.command, "open", "Bao opens the page in its task tab first");
  assert.ok(calls.slice(moved + 1).every((call) => call.url === `${h.site}${page}`), "on the same page, in Bao's task tab");

  const runs = new Library(h.home).listRuns();
  assert.equal(runs.length, 1, "the session and its run continue");
  assert.equal(runs[0]!.status, "recording");
  assert.deepEqual(runs[0]!.browser && { route: runs[0]!.browser.route, why: runs[0]!.browser.why }, { route: "current", why: "fallback after a sign-in wall" });

  assert.ok(await h.proxy.finishTask({ outcome: "passed", reason: "fixture" }));
  // Target.closeTarget answers before Chrome destroys the tab.
  let left: string[] = [];
  for (const deadline = Date.now() + 3000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 50))) {
    left = (await h.pages()).map((target) => target.targetId).sort();
    if (left.length === h.ownerTabs.length) break;
  }
  assert.deepEqual(left, h.ownerTabs, "only Bao's task tab closes; the owner's tabs stay");
});

test("an open that lands on a sign-in URL in a Bao profile continues in the owner's running Chrome", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "works");
  const [opened, tabs] = await h.proxy.execute("open", [`${h.site}/gate`]);
  assert.equal(opened!.stdout, `✓ Article\n  ${h.site}/gate\n`, "the requested page, opened in the owner's Chrome");
  assert.equal(tabs!.stdout, "→ [t1] Article\n");
  assert.ok(savedSteps(h.home)[0]!.summary!.text.startsWith(`Bao's own browser hit a sign-in page on 127.0.0.1; continued in your running Chrome (Chrome profile "Default", Owner) over remote debugging. Take a fresh snapshot before acting. Went to `));
  assert.match(h.proxy.pickLines[0]!, /^Browser: Running Chrome over remote debugging, fallback after a sign-in wall\./);
  assert.equal(new Library(h.home).listRuns()[0]!.status, "recording", "the owner wait in Bao's window ended with the move");
  assert.ok(await baoClosed(h.baoDir));
});

test("a page with no wall stays in Bao's profile", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "works");
  assert.equal((await h.proxy.execute("open", [`${h.site}/article`]))[0]!.exitCode, 0);
  assert.equal((await h.proxy.execute("snapshot"))[0]!.stdout, NO_WALL);
  assert.deepEqual(h.proxy.pickLines, ['Browser: Bao profile, Chrome profile "Default".']);
  assert.equal(h.attaches(), 0);
  assert.deepEqual((await h.pages()).map((target) => target.targetId).sort(), h.ownerTabs, "Bao opened nothing in the owner's Chrome");
});

test("wait_for_owner on a Bao profile moves to the owner's running Chrome before it waits", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "works");
  assert.equal((await h.proxy.execute("open", [`${h.site}/times`]))[0]!.exitCode, 0);
  const [moved] = await h.proxy.execute("wait_for_owner", ["1000"]);
  assert.equal(moved!.stdout, `✓ The Best Pizza in New York City - The New York Times\n  ${h.site}/times\n`);
  assert.ok(h.proxy.lastCommand!.step.summary!.text.startsWith(`Bao's own browser hit a step that needs the owner on 127.0.0.1; continued in your running Chrome (Chrome profile "Default", Owner) over remote debugging. Take a fresh snapshot before acting.`));
  assert.match(h.proxy.pickLines[0]!, /^Browser: Running Chrome over remote debugging, fallback after a sign-in wall\./);
  assert.equal((await h.proxy.execute("snapshot"))[0]!.stdout, TIMES_ARTICLE);
  assert.ok(await baoClosed(h.baoDir));
  const begin = Date.now();
  const [waiting] = await h.proxy.execute("wait_for_owner", ["300"]);
  assert.ok(Date.now() - begin >= 250, "a wait in Running Chrome is a real wait");
  const reply = JSON.parse(waiting!.stdout) as { outcome: string; instruction: string };
  assert.equal(reply.outcome, "waiting");
  assert.match(reply.instruction, /Bao's task tab in their own Chrome/);
  assert.equal(h.attaches(), 1);
});

test("when the owner's running Chrome does not attach, the wait stays in Bao's window with the fallback calls, and every wait_for_owner tries again", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "refused");
  assert.equal((await h.proxy.execute("open", [`${h.site}/times`]))[0]!.exitCode, 0);
  assert.equal((await h.proxy.execute("snapshot"))[0]!.stdout, TIMES_CHECK, "the snapshot of Bao's window stands");
  assert.deepEqual(h.proxy.pickLines, ['Browser: Bao profile, Chrome profile "Default".', REFUSED]);
  const fallback = `To take it, call agent_browser with {"command":"close"}, then with {"command":"open","args":["${h.site}/times"],"browser":"current","profile":"Default"}.`;
  const [waiting] = await h.proxy.execute("wait_for_owner", ["300"]);
  const reply = JSON.parse(waiting!.stdout) as { outcome: string; instruction: string };
  assert.equal(reply.outcome, "waiting");
  assert.match(reply.instruction, /in this Bao window/);
  assert.ok(reply.instruction.includes(fallback), reply.instruction);
  assert.deepEqual(h.proxy.pickLines, ['Browser: Bao profile, Chrome profile "Default".', REFUSED.replace("a sign-in or verification prompt", "a step that needs the owner")]);
  assert.equal(h.attaches(), 2, "the explicit wait tried the owner's running Chrome again");
  assert.equal(pidsForDataDir(h.baoDir).length > 0, true, "Bao's window stays open for the owner");

  const [halted] = await h.proxy.execute("click", ["@e1"]);
  assert.equal(JSON.parse(halted!.stdout).outcome, "halted");
  assert.ok((JSON.parse(halted!.stdout) as { instruction: string }).instruction.includes(fallback));
  assert.equal(h.attaches(), 2, "only an explicit wait_for_owner tries again");

  h.allow();
  const [moved] = await h.proxy.execute("wait_for_owner", ["300"]);
  assert.equal(moved!.stdout, `✓ The Best Pizza in New York City - The New York Times\n  ${h.site}/times\n`);
  assert.equal(h.attaches(), 3);
  assert.match(h.proxy.pickLines[0]!, /^Browser: Running Chrome over remote debugging, fallback after a sign-in wall\./);
  assert.equal((await h.proxy.execute("snapshot"))[0]!.stdout, TIMES_ARTICLE);
  assert.ok(await baoClosed(h.baoDir));
});

test("a command that meets a sign-in page between commands does not run; Bao records the open it ran in the owner's Chrome", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "works");
  assert.equal((await h.proxy.execute("open", [`${h.site}/article`]))[0]!.exitCode, 0);
  assert.equal((await h.proxy.execute("snapshot"))[0]!.stdout, NO_WALL);
  await navigateBao(h.baoDir, "/article", `${h.site}/login`);

  const [result] = await h.proxy.execute("click", ["@e5"]);
  assert.equal(result!.stdout, `✓ Article\n  ${h.site}/article\n`, "the open in the owner's Chrome, not a click");
  assert.ok(!(await h.calls()).some((call) => call.command === "click"), "the click never ran");
  const step = savedSteps(h.home).at(-1)!;
  assert.deepEqual({ command: step.native.command, args: step.native.args }, { command: "open", args: [`${h.site}/article`] });
  assert.ok(step.summary!.text.startsWith("Bao's own browser hit a sign-in page on 127.0.0.1; continued in your running Chrome"), step.summary!.text);
  assert.doesNotMatch(step.summary!.text, /Clicked/);
  assert.ok(await baoClosed(h.baoDir));
});

test("a command whose move lands on a sign-in page in the owner's Chrome halts there, and the run keeps the move on its step", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "works");
  assert.equal((await h.proxy.execute("open", [`${h.site}/trap`]))[0]!.exitCode, 0);
  assert.equal(h.attaches(), 0, "the page has no wall in Bao's own browser");
  await navigateBao(h.baoDir, "/trap", `${h.site}/login`);

  const [result] = await h.proxy.execute("click", ["@e5"]);
  assert.equal((JSON.parse(result!.stdout) as { outcome: string }).outcome, "halted");
  assert.equal(h.attaches(), 1);
  assert.ok(!(await h.calls()).some((call) => call.command === "click"), "the click never ran");
  const step = savedSteps(h.home).at(-1)!;
  assert.deepEqual({ command: step.native.command, args: step.native.args }, { command: "open", args: [`${h.site}/trap`] });
  assert.ok(step.summary!.text.startsWith(`Bao's own browser hit a sign-in page on 127.0.0.1; continued in your running Chrome (Chrome profile "Default", Owner) over remote debugging. Take a fresh snapshot before acting. Your turn: sign in`), step.summary!.text);
  assert.ok(!savedSteps(h.home)[0]!.summary!.text.includes("running Chrome"), "the first open ran in Bao's own browser");
  assert.match(h.proxy.pickLines[0]!, /^Browser: Running Chrome over remote debugging, fallback after a sign-in wall\./);
  assert.ok(await baoClosed(h.baoDir));
});

test("a slow failed move on wait_for_owner still leaves time to see the owner clear the wall in Bao's window", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "refused");
  assert.equal((await h.proxy.execute("open", [`${h.site}/times`]))[0]!.exitCode, 0);
  assert.equal((await h.proxy.execute("snapshot"))[0]!.stdout, TIMES_CHECK);
  assert.equal((JSON.parse((await h.proxy.execute("wait_for_owner", ["300"]))[0]!.stdout) as { outcome: string }).outcome, "waiting");
  await navigateBao(h.baoDir, "/times", `${h.site}/article`);
  h.slow(2500);
  const [ready] = await h.proxy.execute("wait_for_owner", ["2000"]);
  assert.equal((JSON.parse(ready!.stdout) as { outcome: string }).outcome, "ready", "the retry took longer than the timeout, yet Bao still read the page");
  assert.equal(h.attaches(), 3);
});
