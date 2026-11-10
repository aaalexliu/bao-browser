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
import { boundSessions, chromeProfiles } from "../support/chrome-profiles";
import { LIST_TARGETS } from "../support/fake-agent-browser";

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
        : request.url === "/moment" ? ["Just a moment...", NO_WALL]
        : request.url === "/story" ? ["Sign in - Example", NO_WALL]
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
  const launched: string[] = [];
  t.mock.method(launches, "launchOwnedChromeEndpoint", (options: Parameters<typeof launch>[0]) => {
    launched.push(path.basename(options.userDataDir).startsWith("bao-login-source-") ? "import" : options.userDataDir === baoDir ? "bao" : options.userDataDir);
    return launch({ ...options, headless: true });
  });

  // The fake owner's Chrome cannot reach Google or the Times; their pages open as Chrome's error page.
  const owner = await launch({ userDataDir: path.join(root, "owner"), headless: true,
    appendArgs: ["--host-resolver-rules=MAP *google.com ~NOTFOUND, MAP *nytimes.com ~NOTFOUND"] });
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
      isClosed: () => !cdp.isOpen, detach: () => cdp.close() };
  });

  const log = path.join(root, "native.jsonl");
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs'), path=require('node:path');
const {connectCdp}=require(${JSON.stringify(path.resolve(__dirname, "../../src/cdp-live/socket.js"))});
const args=process.argv.slice(2), at=args.indexOf('--idle-timeout')+2, command=args[at], rest=args.slice(at+1);
const endpoint=new URL(args[args.indexOf('--cdp')+1]);
${LIST_TARGETS}
(async()=>{
 if(command==='close'){console.log('closed');return;}
 let bound; try{bound=JSON.parse(fs.readFileSync(path.join(process.env.AGENT_BROWSER_SOCKET_DIR,'bao.target'),'utf8')).targetId;}catch{}
 const tabs=(await listTargets(endpoint.href)).filter(t=>t.type==='page');
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
  return { proxy, site, home, sourceRoot, baoDir, endpoint, ownerTabs, calls, pages, attaches: () => attaches, launched: () => [...launched],
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
  const [opened] = await h.proxy.execute("open", [`${h.site}${page}`], "bao");
  assert.equal(opened!.exitCode, 0, opened!.stderr);
  assert.match(h.proxy.pickLines[0]!, /^Browser: Bao profile, named by the agent\./);
  assert.equal(h.attaches(), 0, "an open whose URL and title look normal stays in Bao's profile");
  const baoPort = (await h.calls()).find((call) => call.command === "open")!.port;

  const [snapshot] = await h.proxy.execute("snapshot", [], undefined, false, undefined, {}, h.proxy.activeRunId);
  assert.equal(snapshot!.stdout, after, `the snapshot is the owner's Chrome tab, past the wall: ${h.proxy.pickLines.join(" | ")}`);
  assert.doesNotMatch(snapshot!.stdout, before);
  assert.ok(h.proxy.lastCommand!.step.summary!.text.startsWith(`${MOVED} Read the page`), h.proxy.lastCommand!.step.summary!.text);
  assert.ok(savedSteps(h.home).at(-1)!.summary!.text.startsWith(MOVED), "the run keeps the move on the step where it happened");
  assert.ok(!savedSteps(h.home)[0]!.summary!.text.includes("running Chrome"), "the open before it ran in Bao's own browser");
  assert.deepEqual(h.proxy.pickLines, [
    `Browser: Running Chrome over remote debugging, fallback after a sign-in wall. Chrome app: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome. User data: ${h.sourceRoot}. `
      + `Profile: "Default" (Owner) in ${h.sourceRoot}, the only profile. Bao's task tab opened in the background.`,
  ]);
  await assert.rejects(h.proxy.execute("open", [`${h.site}${page}`], "bao", false, undefined, {}, h.proxy.activeRunId), /close the current session before choosing a different browser/);
  assert.equal((await h.proxy.execute("open", [`${h.site}${page}`], "current", false, undefined, {}, h.proxy.activeRunId))[0]!.exitCode, 0);
  assert.equal(h.attaches(), 1);
  assert.ok(await baoClosed(h.baoDir), "Bao closes its own window");

  const [clicked] = await h.proxy.execute("click", ["@e2"], undefined, false, undefined, {}, h.proxy.activeRunId);
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

  assert.ok(await h.proxy.finishTask({ outcome: "passed", reason: "fixture" }, h.proxy.activeRunId));
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
  const [opened, tabs] = await h.proxy.execute("open", [`${h.site}/gate`], "bao");
  assert.equal(opened!.stdout, `✓ Article\n  ${h.site}/gate\n`, "the requested page, opened in the owner's Chrome");
  assert.equal(tabs!.stdout, "→ [t1] Article\n");
  assert.ok(savedSteps(h.home)[0]!.summary!.text.startsWith(`Bao's own browser hit a sign-in page on 127.0.0.1; continued in your running Chrome (Chrome profile "Default", Owner) over remote debugging. Take a fresh snapshot before acting. Went to `));
  assert.match(h.proxy.pickLines[0]!, /^Browser: Running Chrome over remote debugging, fallback after a sign-in wall\./);
  assert.equal(new Library(h.home).listRuns()[0]!.status, "recording", "the owner wait in Bao's window ended with the move");
  assert.ok(await baoClosed(h.baoDir));
});

test("a page with no wall stays in Bao's profile", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "works");
  assert.equal((await h.proxy.execute("open", [`${h.site}/article`], "bao"))[0]!.exitCode, 0);
  assert.equal((await h.proxy.execute("snapshot", [], undefined, false, undefined, {}, h.proxy.activeRunId))[0]!.stdout, NO_WALL);
  assert.deepEqual(h.proxy.pickLines, ['Browser: Bao profile, Chrome profile "Default".']);
  assert.equal(h.attaches(), 0);
  assert.deepEqual((await h.pages()).map((target) => target.targetId).sort(), h.ownerTabs, "Bao opened nothing in the owner's Chrome");
});

test("wait_for_owner on a Bao profile moves to the owner's running Chrome before it waits", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "works");
  assert.equal((await h.proxy.execute("open", [`${h.site}/times`], "bao"))[0]!.exitCode, 0);
  const [moved] = await h.proxy.execute("wait_for_owner", ["1000"], undefined, false, undefined, {}, h.proxy.activeRunId);
  assert.equal(moved!.stdout, `✓ The Best Pizza in New York City - The New York Times\n  ${h.site}/times\n`);
  assert.ok(h.proxy.lastCommand!.step.summary!.text.startsWith(`Bao's own browser hit a step that needs the owner on 127.0.0.1; continued in your running Chrome (Chrome profile "Default", Owner) over remote debugging. Take a fresh snapshot before acting.`));
  assert.match(h.proxy.pickLines[0]!, /^Browser: Running Chrome over remote debugging, fallback after a sign-in wall\./);
  assert.equal((await h.proxy.execute("snapshot", [], undefined, false, undefined, {}, h.proxy.activeRunId))[0]!.stdout, TIMES_ARTICLE);
  assert.ok(await baoClosed(h.baoDir));
  const begin = Date.now();
  const [waiting] = await h.proxy.execute("wait_for_owner", ["300"], undefined, false, undefined, {}, h.proxy.activeRunId);
  assert.ok(Date.now() - begin >= 250, "a wait in Running Chrome is a real wait");
  const reply = JSON.parse(waiting!.stdout) as { outcome: string; instruction: string };
  assert.equal(reply.outcome, "waiting");
  assert.match(reply.instruction, /Bao's task tab in their own Chrome/);
  assert.equal(h.attaches(), 1);
});

test("when the owner's running Chrome does not attach, the wait stays in Bao's window with the fallback calls, and every wait_for_owner tries again", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "refused");
  assert.equal((await h.proxy.execute("open", [`${h.site}/times`], "bao"))[0]!.exitCode, 0);
  assert.equal((await h.proxy.execute("snapshot", [], undefined, false, undefined, {}, h.proxy.activeRunId))[0]!.stdout, TIMES_CHECK, "the snapshot of Bao's window stands");
  assert.deepEqual(h.proxy.pickLines, ['Browser: Bao profile, Chrome profile "Default".', REFUSED]);
  const fallback = `To take it, call agent_browser with {"command":"close","run_id":"${h.proxy.activeRunId}"}, then with {"command":"open","args":["${h.site}/times"],"browser":"current","profile":"Default"}.`;
  const [waiting] = await h.proxy.execute("wait_for_owner", ["300"], undefined, false, undefined, {}, h.proxy.activeRunId);
  const reply = JSON.parse(waiting!.stdout) as { outcome: string; instruction: string };
  assert.equal(reply.outcome, "waiting");
  assert.match(reply.instruction, /in this Bao window/);
  assert.ok(reply.instruction.includes(fallback), reply.instruction);
  assert.deepEqual(h.proxy.pickLines, ['Browser: Bao profile, Chrome profile "Default".', REFUSED.replace("a sign-in or verification prompt", "a step that needs the owner")]);
  assert.equal(h.attaches(), 2, "the explicit wait tried the owner's running Chrome again");
  assert.equal(pidsForDataDir(h.baoDir).length > 0, true, "Bao's window stays open for the owner");

  const [halted] = await h.proxy.execute("click", ["@e1"], undefined, false, undefined, {}, h.proxy.activeRunId);
  assert.equal((JSON.parse(halted!.stdout) as { outcome: string }).outcome, "halted");
  assert.ok((JSON.parse(halted!.stdout) as { instruction: string }).instruction.includes(fallback));
  assert.equal(h.attaches(), 2, "only an explicit wait_for_owner tries again");

  h.allow();
  const [moved] = await h.proxy.execute("wait_for_owner", ["300"], undefined, false, undefined, {}, h.proxy.activeRunId);
  assert.equal(moved!.stdout, `✓ The Best Pizza in New York City - The New York Times\n  ${h.site}/times\n`);
  assert.equal(h.attaches(), 3);
  assert.match(h.proxy.pickLines[0]!, /^Browser: Running Chrome over remote debugging, fallback after a sign-in wall\./);
  assert.equal((await h.proxy.execute("snapshot", [], undefined, false, undefined, {}, h.proxy.activeRunId))[0]!.stdout, TIMES_ARTICLE);
  assert.ok(await baoClosed(h.baoDir));
});

test("a URL wall reopens the page before the wall, not the latest open, and the line names the wall's host", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "works");
  assert.equal((await h.proxy.execute("open", [`${h.site}/article`], "bao"))[0]!.exitCode, 0);
  await navigateBao(h.baoDir, "/article", `${h.site}/restaurant`);
  assert.equal((await h.proxy.execute("snapshot", [], undefined, false, undefined, {}, h.proxy.activeRunId))[0]!.stdout, NO_WALL);
  const wall = `http://localhost:${new URL(h.site).port}/login`;
  await navigateBao(h.baoDir, "/restaurant", wall);

  const [result] = await h.proxy.execute("click", ["@e5"], undefined, false, undefined, {}, h.proxy.activeRunId);
  assert.equal(result!.stdout, `\u2713 Article\n  ${h.site}/restaurant\n`, "Running Chrome opens the restaurant page, not the latest open and not the sign-in URL");
  const step = savedSteps(h.home).at(-1)!;
  assert.deepEqual(step.native.args, [`${h.site}/restaurant`]);
  assert.ok(step.summary!.text.startsWith("Bao's own browser hit a sign-in page on localhost; continued in your running Chrome"), step.summary!.text);
  const sentence = step.summary!.text.slice(0, step.summary!.text.indexOf("Take a fresh snapshot"));
  assert.ok(!sentence.includes("127.0.0.1"), step.summary!.text);
  assert.ok(await baoClosed(h.baoDir));
});

test("a later wait on a dialog an earlier wait_for_owner started does not call it a sign-in page", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "refused");
  assert.equal((await h.proxy.execute("open", [`${h.site}/times`], "bao"))[0]!.exitCode, 0);
  assert.equal((JSON.parse((await h.proxy.execute("wait_for_owner", ["300"], undefined, false, undefined, {}, h.proxy.activeRunId))[0]!.stdout) as { outcome: string }).outcome, "waiting");
  h.allow();
  const [moved] = await h.proxy.execute("wait_for_owner", ["300"], undefined, false, undefined, {}, h.proxy.activeRunId);
  assert.equal(moved!.stdout, `\u2713 The Best Pizza in New York City - The New York Times\n  ${h.site}/times\n`);
  const step = savedSteps(h.home).at(-1)!;
  assert.ok(step.summary!.text.startsWith("Bao's own browser hit a step that needs the owner on 127.0.0.1; continued in your running Chrome"), step.summary!.text);
  assert.ok(!step.summary!.text.includes("a sign-in page"), step.summary!.text);
  assert.ok(!step.summary!.text.includes("a sign-in or verification prompt"), step.summary!.text);
  assert.ok(await baoClosed(h.baoDir));
});

test("a title-only human check reopens its own URL", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "works");
  assert.equal((await h.proxy.execute("open", [`${h.site}/article`], "bao"))[0]!.exitCode, 0);
  await navigateBao(h.baoDir, "/article", `${h.site}/restaurant`);
  assert.equal((await h.proxy.execute("snapshot", [], undefined, false, undefined, {}, h.proxy.activeRunId))[0]!.stdout, NO_WALL);
  const moment = `http://localhost:${new URL(h.site).port}/moment`;
  await navigateBao(h.baoDir, "/restaurant", moment);
  const [check] = await h.proxy.execute("click", ["@e5"], undefined, false, undefined, {}, h.proxy.activeRunId);
  const checkReply = JSON.parse(check!.stdout) as { outcome: string; instruction: string };
  assert.equal(checkReply.outcome, "halted", "the check page is still a wall in Running Chrome, so the owner clears it there");
  assert.match(checkReply.instruction, /clear the check on localhost/);
  const checkStep = savedSteps(h.home).at(-1)!;
  assert.deepEqual(checkStep.native.args, [moment], "Running Chrome opens the check page, not the restaurant page");
  assert.ok(checkStep.summary!.text.startsWith("Bao's own browser hit a human check on localhost"), checkStep.summary!.text);
  assert.ok(await baoClosed(h.baoDir));
});

test("a sign-in title on the same host reopens its own URL", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "works");
  assert.equal((await h.proxy.execute("open", [`${h.site}/article`], "bao"))[0]!.exitCode, 0);
  await navigateBao(h.baoDir, "/article", `${h.site}/restaurant`);
  assert.equal((await h.proxy.execute("snapshot", [], undefined, false, undefined, {}, h.proxy.activeRunId))[0]!.stdout, NO_WALL);
  const story = `${h.site}/story`;
  await navigateBao(h.baoDir, "/restaurant", story);
  const [titleMove] = await h.proxy.execute("click", ["@e5"], undefined, false, undefined, {}, h.proxy.activeRunId);
  const titleReply = JSON.parse(titleMove!.stdout) as { outcome: string; instruction: string };
  assert.equal(titleReply.outcome, "halted", "a Sign in title is still a wall on that URL");
  assert.match(titleReply.instruction, /sign in to 127\.0\.0\.1/);
  const titleStep = savedSteps(h.home).at(-1)!;
  assert.deepEqual(titleStep.native.args, [story], "Running Chrome opens that URL, not the page before it");
  assert.ok(titleStep.summary!.text.startsWith("Bao's own browser hit a sign-in page on 127.0.0.1"), titleStep.summary!.text);
  assert.ok(await baoClosed(h.baoDir));
});

const AUTHORIZE = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=fixture&state=fixture&nonce=fixture";

async function landOnAuthorize(baoDir: string, from: string): Promise<void> {
  const endpoint = await readDevToolsActivePort(path.join(baoDir, "DevToolsActivePort"));
  const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
  try {
    const tab = (await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets")).targetInfos
      .find((target) => target.type === "page" && target.url.endsWith(from));
    if (!tab?.targetId) throw new Error(`no Bao tab ending in ${from}`);
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: tab.targetId, flatten: true });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*login.microsoftonline.com*", requestStage: "Request" }] }, sessionId);
    cdp.on("Fetch.requestPaused", sessionId, (params) => {
      const requestId = params.requestId;
      if (typeof requestId !== "string") return;
      void cdp.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: "content-type", value: "text/html" }],
        body: Buffer.from("<!doctype html><title>Sign in to your account</title>").toString("base64"),
      }, sessionId).catch(() => undefined);
    });
    await cdp.send("Page.enable", {}, sessionId);
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("authorize page did not load")), 15_000);
      cdp.on("Page.loadEventFired", sessionId, () => { clearTimeout(timer); resolve(); });
    });
    await cdp.send("Page.navigate", { url: AUTHORIZE }, sessionId);
    await loaded;
  } finally { cdp.close(); }
}

test("a sign-in title on another host reopens the page the agent was on", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "works");
  assert.equal((await h.proxy.execute("open", [`${h.site}/article`], "bao"))[0]!.exitCode, 0);
  await navigateBao(h.baoDir, "/article", `${h.site}/restaurant`);
  assert.equal((await h.proxy.execute("snapshot", [], undefined, false, undefined, {}, h.proxy.activeRunId))[0]!.stdout, NO_WALL);
  await landOnAuthorize(h.baoDir, "/restaurant");
  const [moved] = await h.proxy.execute("click", ["@e5"], undefined, false, undefined, {}, h.proxy.activeRunId);
  assert.equal(moved!.stdout, `\u2713 Article\n  ${h.site}/restaurant\n`, "not the authorize URL");
  const step = savedSteps(h.home).at(-1)!;
  assert.deepEqual(step.native.args, [`${h.site}/restaurant`], "Running Chrome opens the page the agent was on");
  assert.ok(!JSON.stringify(step.native.args).includes("microsoftonline"), JSON.stringify(step.native.args));
  assert.ok(step.summary!.text.startsWith("Bao's own browser hit a sign-in page on login.microsoftonline.com"), step.summary!.text);
  assert.ok(await baoClosed(h.baoDir));
});

test("wait_for_owner that reads a fresh sign-in URL reopens the page before it, not the sign-in URL", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "works");
  assert.equal((await h.proxy.execute("open", [`${h.site}/article`], "bao"))[0]!.exitCode, 0);
  await navigateBao(h.baoDir, "/article", `${h.site}/restaurant`);
  assert.equal((await h.proxy.execute("snapshot", [], undefined, false, undefined, {}, h.proxy.activeRunId))[0]!.stdout, NO_WALL);
  const login = `http://localhost:${new URL(h.site).port}/login`;
  await navigateBao(h.baoDir, "/restaurant", login);
  const [moved] = await h.proxy.execute("wait_for_owner", ["1000"], undefined, false, undefined, {}, h.proxy.activeRunId);
  assert.equal(moved!.stdout, `\u2713 Article\n  ${h.site}/restaurant\n`, "not the sign-in URL");
  const text = savedSteps(h.home).at(-1)!.summary!.text;
  assert.ok(text.startsWith("Bao's own browser hit a sign-in page on localhost"), text);
  assert.ok(!text.includes("a step that needs the owner"), text);
  assert.ok(await baoClosed(h.baoDir));
});

test("a blank page does not become the page Running Chrome opens", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "works");
  assert.equal((await h.proxy.execute("open", [`${h.site}/article`], "bao"))[0]!.exitCode, 0);
  await navigateBao(h.baoDir, "/article", "about:blank");
  assert.equal((await h.proxy.execute("snapshot", [], undefined, false, undefined, {}, h.proxy.activeRunId))[0]!.exitCode, 0);
  await navigateBao(h.baoDir, "about:blank", `${h.site}/login`);
  const [result] = await h.proxy.execute("click", ["@e5"], undefined, false, undefined, {}, h.proxy.activeRunId);
  assert.equal(result!.stdout, `\u2713 Article\n  ${h.site}/article\n`, "the page before the blank popup, not about:blank and not the sign-in URL");
  assert.ok(!result!.stdout.includes("about:blank"));
  assert.ok(await baoClosed(h.baoDir));
});

test("a command that meets a sign-in page between commands does not run; Bao records the open it ran in the owner's Chrome", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "works");
  assert.equal((await h.proxy.execute("open", [`${h.site}/article`], "bao"))[0]!.exitCode, 0);
  assert.equal((await h.proxy.execute("snapshot", [], undefined, false, undefined, {}, h.proxy.activeRunId))[0]!.stdout, NO_WALL);
  await navigateBao(h.baoDir, "/article", `${h.site}/login`);

  const [result] = await h.proxy.execute("click", ["@e5"], undefined, false, undefined, {}, h.proxy.activeRunId);
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
  assert.equal((await h.proxy.execute("open", [`${h.site}/trap`], "bao"))[0]!.exitCode, 0);
  assert.equal(h.attaches(), 0, "the page has no wall in Bao's own browser");
  await navigateBao(h.baoDir, "/trap", `${h.site}/login`);

  const [result] = await h.proxy.execute("click", ["@e5"], undefined, false, undefined, {}, h.proxy.activeRunId);
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
  assert.equal((await h.proxy.execute("open", [`${h.site}/times`], "bao"))[0]!.exitCode, 0);
  assert.equal((await h.proxy.execute("snapshot", [], undefined, false, undefined, {}, h.proxy.activeRunId))[0]!.stdout, TIMES_CHECK);
  assert.equal((JSON.parse((await h.proxy.execute("wait_for_owner", ["300"], undefined, false, undefined, {}, h.proxy.activeRunId))[0]!.stdout) as { outcome: string }).outcome, "waiting");
  await navigateBao(h.baoDir, "/times", `${h.site}/article`);
  h.slow(2500);
  const [ready] = await h.proxy.execute("wait_for_owner", ["2000"], undefined, false, undefined, {}, h.proxy.activeRunId);
  assert.equal((JSON.parse(ready!.stdout) as { outcome: string }).outcome, "ready", "the retry took longer than the timeout, yet Bao still read the page");
  assert.equal(h.attaches(), 3);
});

test("a sign-in the owner finishes during a slow failed move still ends the wait_for_owner that started before it", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "refused");
  assert.equal((await h.proxy.execute("open", [`${h.site}/article`], "bao"))[0]!.exitCode, 0);
  assert.equal(h.attaches(), 0);
  h.slow(3000);
  const waiting = h.proxy.execute("wait_for_owner", ["2000"], undefined, false, undefined, {}, h.proxy.activeRunId);
  for (const deadline = Date.now() + 30_000; h.attaches() === 0 && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.attaches(), 1, "the move began");
  await navigateBao(h.baoDir, "/article", `${h.site}/account`);
  const [ready] = await waiting;
  assert.equal((JSON.parse(ready!.stdout) as { outcome: string }).outcome, "ready", "the page changed after the wait began, during the move");
});

const OWNER_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("an open that names no browser runs in the owner's running Chrome, and Bao starts no Chrome of its own", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "works");
  const [opened] = await h.proxy.execute("open", [`${h.site}/article`]);
  assert.equal(opened!.stdout, `✓ Article\n  ${h.site}/article\n`);
  assert.deepEqual(h.proxy.pickLines, [`Browser: Running Chrome over remote debugging, the default. Chrome app: ${OWNER_CHROME}. User data: ${h.sourceRoot}. `
    + `Profile: "Default" (Owner) in ${h.sourceRoot}, the only profile. Bao's task tab opened in the background.`]);
  assert.deepEqual(h.launched(), [], "no Bao profile and no sign-in import");
});

test("when running Chrome cannot be used, a named Bao profile on a bound site says why on its own line", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "refused");
  const why = "Bao could not use your running Chrome: Chrome is not open. Open Google Chrome, then try again.";
  assert.equal((await h.proxy.execute("open", ["https://www.nytimes.com/"], "bao"))[0]!.exitCode, 0);
  assert.match(h.proxy.pickLines[0]!, /^Browser: Bao profile, fallback when running Chrome could not be used\./);
  assert.equal(h.proxy.pickLines[1], why);
  const saved = new Library(h.home).listRuns()[0]!.browser;
  assert.equal(saved && "unread" in saved ? saved.unread : undefined, undefined);
  assert.deepEqual(h.launched(), ["bao"]);
});

test("when running Chrome cannot be used, a named copy on a bound site says why on its own line", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "refused");
  assert.equal((await h.proxy.execute("open", ["https://www.nytimes.com/"], "copy"))[0]!.exitCode, 0);
  assert.match(h.proxy.pickLines[0]!, /^Browser: Chrome copy, fallback when running Chrome could not be used\./);
  assert.equal(h.proxy.pickLines[1], "Bao could not use your running Chrome: Chrome is not open. Open Google Chrome, then try again.");
});

test("when running Chrome cannot be used, an open that names no browser runs in Bao's profile without a sign-in import and says why in one line", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "refused");
  assert.equal((await h.proxy.execute("open", [`${h.site}/article`]))[0]!.exitCode, 0);
  assert.equal(h.proxy.pickLines.length, 1, h.proxy.pickLines.join(" | "));
  assert.match(h.proxy.pickLines[0]!, /^Browser: Bao profile, fallback when running Chrome could not be used\. Chrome app: .+\. User data: .+agent-browser-profile\. /);
  assert.ok(h.proxy.pickLines[0]!.endsWith("Bao imports no sign-ins: Bao could not use your running Chrome: Chrome is not open. Open Google Chrome, then try again."), h.proxy.pickLines[0]);
  assert.deepEqual(h.launched(), ["bao"], "Bao's own profile, and no import Chrome");
  assert.equal((await h.proxy.execute("open", [`${h.site}/times`], undefined, false, undefined, {}, h.proxy.activeRunId))[0]!.exitCode, 0);
  assert.deepEqual(h.launched(), ["bao"], "a later open imports nothing either");
});

for (const url of ["https://www.google.com/maps/@40.73,-73.99,14z", "https://www.nytimes.com/2026/11/09/dining/best-pizza.html"]) {
  test(`browser=bao on ${new URL(url).hostname} opens in the owner's running Chrome and imports nothing`, { timeout: 60_000 }, async (t) => {
    const h = await harness(t, "works");
    await h.proxy.execute("open", [url], "bao");
    assert.match(h.proxy.pickLines[0]!, /^Browser: Running Chrome over remote debugging, this site ties its sign-in to your Chrome\. .+ Profile: "Default" \(Owner\)/);
    assert.equal(h.attaches(), 1);
    assert.deepEqual(h.launched(), [], "no Bao profile and no sign-in import");
    assert.equal(new Library(h.home).listRuns()[0]!.browser?.why, "this site ties its sign-in to your Chrome");
  });
}

test("a site in the Chrome profile's device-bound session table opens in running Chrome, even on browser=copy", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "works");
  boundSessions(path.join(h.sourceRoot, "Default"), ["http://127.0.0.1 3f9a"]);
  assert.equal((await h.proxy.execute("open", [`${h.site}/article`], "copy"))[0]!.stdout, `✓ Article\n  ${h.site}/article\n`);
  assert.match(h.proxy.pickLines[0]!, /^Browser: Running Chrome over remote debugging, this site ties its sign-in to your Chrome\./);
  assert.deepEqual(h.launched(), []);
});

test("a later open of a site that ties its sign-in to Chrome moves the Bao-profile session there before any import", { timeout: 60_000 }, async (t) => {
  const h = await harness(t, "works");
  assert.equal((await h.proxy.execute("open", [`${h.site}/article`], "bao"))[0]!.exitCode, 0);
  await h.proxy.execute("open", ["https://www.nytimes.com/"], undefined, false, undefined, {}, h.proxy.activeRunId);
  const line = `Bao did not open www.nytimes.com in its own browser because this site ties its sign-in to your Chrome; continued in your running Chrome (Chrome profile "Default", Owner) over remote debugging. Take a fresh snapshot before acting.`;
  assert.ok(savedSteps(h.home).at(-1)!.summary!.text.startsWith(line), savedSteps(h.home).at(-1)!.summary!.text);
  assert.match(h.proxy.pickLines[0]!, /^Browser: Running Chrome over remote debugging, this site ties its sign-in to your Chrome\./);
  assert.ok(!(new Library(h.home).listRuns()[0]!.signInImports ?? []).some((report) => report.origin.includes("nytimes")), "no import for the Times");
  assert.deepEqual(h.launched(), ["bao"], "no import Chrome");
  assert.ok(await baoClosed(h.baoDir));
});
