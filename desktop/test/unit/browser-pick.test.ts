import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { connect as netConnect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { startApp } from "../../src/app/server";
import { ChromeFolderDenied } from "../../src/chrome-access";
import { holdDir } from "../../src/cdp-live/chrome-hold";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { connectCdp, type CdpSocket } from "../../src/cdp-live/socket";
import { baoAgentProfileDir } from "../../src/engines/bao-profile";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import { chooseChromeProfile, ChromeProfileQuestion, openOrFallBack, pickLine, RoutesFailed, signInLine, type BrowserPlan } from "../../src/engines/browser-pick";
import { BOUND_REASON } from "../../src/engines/bound-sign-in";
import { McpClient } from "../../src/eval/mcp-client";
import { launchOwnedChrome, launchOwnedChromeEndpoint, pidsForDataDir, pinTestBrowser, resolveNormalChrome } from "../../src/launch";
import { runWorkflow } from "../../src/mcp/catalog";
import { openWorkflowBrowser, settingsProfileQuestion } from "../../src/engines/workflow-browser";
import { Library } from "../../src/v1/store";
import { chromeProfiles, type ProfileNames } from "../support/chrome-profiles";
import { testWorkflow } from "../support/workflow";
import { scaledMs } from "../runtime";

async function chromeRoot(t: TestContext, profiles: ProfileNames): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bao-pick-"));
  t.after(async () => { await chmod(root, 0o700).catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  return chromeProfiles(root, profiles);
}

test("one Chrome profile is used and named as the only profile", async (t) => {
  const root = await chromeRoot(t, { "Profile 3": { name: "Alex", user_name: "alex@example.test" } });
  assert.deepEqual(await chooseChromeProfile(root, undefined, "Default"),
    { directory: "Profile 3", name: "Alex", email: "alex@example.test", root, why: "the only profile" });
});

test("several Chrome profiles and none named is a question that lists each folder, name, and email and marks the Settings pick", async (t) => {
  const root = await chromeRoot(t, {
    Default: { name: "Alex", user_name: "alex@example.test" },
    "Profile 2": { name: "Work", user_name: "alex@work.test" },
    "Profile 5": { name: "Shopping" },
  });
  const question = await chooseChromeProfile(root, undefined, "Profile 2").then(() => undefined, (error: unknown) => error);
  assert.ok(question instanceof ChromeProfileQuestion);
  assert.equal(question.message, `Chrome has 3 profiles in ${root}, so Bao opened nothing. Choose one: "Default" (Alex, alex@example.test); "Profile 5" (Shopping); "Profile 2" (Work, alex@work.test), picked in Bao Settings.`);
  assert.equal(question.retry({ command: "open", args: ["https://example.test/"], browser: "bao" }),
    'To continue, call agent_browser again with the folder of the profile you choose: {"command":"open","args":["https://example.test/"],"browser":"bao","profile":"Profile 2"}');
  const unpicked = await chooseChromeProfile(root, undefined).then(() => undefined, (error: unknown) => error);
  assert.ok(unpicked instanceof ChromeProfileQuestion);
  assert.doesNotMatch(unpicked.message, /picked in Bao Settings/);
  assert.match(unpicked.retry({ command: "open" }), /"profile":"Default"/);
});

test("a named Chrome profile is used even when Settings picked another, and an unknown name lists the valid ones", async (t) => {
  const root = await chromeRoot(t, { Default: { name: "Alex", user_name: "alex@example.test" }, "Profile 2": { name: "Work" } });
  assert.deepEqual(await chooseChromeProfile(root, { directory: "Default", by: "agent" }, "Profile 2"),
    { directory: "Default", name: "Alex", email: "alex@example.test", root, why: "named by the agent" });
  assert.equal((await chooseChromeProfile(root, { directory: "Profile 2", by: "settings" })).why, "picked in Bao Settings");
  await assert.rejects(chooseChromeProfile(root, { directory: "Profile 9", by: "agent" }),
    { message: `Chrome has no profile "Profile 9" in ${root}. Choose one of: "Default" (Alex, alex@example.test); "Profile 2" (Work).` });
  await assert.rejects(chooseChromeProfile(root, { directory: "Profile 9", by: "settings" }), /Pick it again in Bao Settings\.$/);
});

test("an unreadable Chrome root is an error, never a silent Default", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-pick-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(chooseChromeProfile(root, undefined), new RegExp(`^Error: Bao could not read Chrome's profiles in ${root}`));
});

test("the route line names the route, Chrome app, user-data-dir, profile, and why", () => {
  const profile = { directory: "Default", name: "Alex", email: "alex@example.test", root: "/Chrome", why: "named by the agent" as const };
  assert.equal(pickLine({ route: "bao", why: "the default", chrome: "/Chrome.app/Chrome", userDataDir: "/Bao/agent-browser-profile", profile }),
    'Browser: Bao profile, the default. Chrome app: /Chrome.app/Chrome. User data: /Bao/agent-browser-profile. Sign-ins come from Chrome profile "Default" (Alex, alex@example.test) in /Chrome, named by the agent.');
  assert.equal(pickLine({ route: "copy", why: "named by the agent", chrome: "/Chrome.app/Chrome", userDataDir: "/tmp/run-1", profile: { ...profile, why: "the only profile" } }),
    'Browser: Chrome copy, named by the agent. Chrome app: /Chrome.app/Chrome. User data: /tmp/run-1, a copy of Chrome profile "Default" (Alex, alex@example.test) in /Chrome, the only profile.');
  assert.equal(pickLine({ route: "current", why: "fallback after a sign-in wall", chrome: "/Chrome.app/Chrome", userDataDir: "/Chrome", profile, background: false }),
    'Browser: Running Chrome over remote debugging, fallback after a sign-in wall. Chrome app: /Chrome.app/Chrome. User data: /Chrome. Profile: "Default" (Alex, alex@example.test) in /Chrome, named by the agent. Chrome opened Bao\'s task tab in front, in a window of that profile.');
  assert.equal(pickLine({ route: "extension", why: "named by the agent" }),
    "Browser: Running Chrome through the Bao extension, named by the agent. It runs in the Chrome profile where the Bao extension is linked.");
});

test("a saved workflow on a Chrome copy or Running Chrome uses the named or Settings profile, and with several and neither asks", async (t) => {
  const root = await chromeRoot(t, { Default: { name: "Alex" }, "Profile 2": { name: "Work" } });
  for (const browser of ["copy", "current"] as const) {
    const question = await openWorkflowBrowser({ browser, home: root, site: "about:blank", sourceRoot: root }).then(() => undefined, (error: unknown) => error);
    assert.ok(question instanceof ChromeProfileQuestion);
    assert.deepEqual(question.profiles.map((profile) => profile.directory), ["Default", "Profile 2"]);
    assert.match(String(settingsProfileQuestion(question)),
      new RegExp(`^Error: Chrome has 2 profiles in ${root}, so Bao opened nothing\\. .* Pick one in Bao Settings under Technical details, Page engine, Chrome profile, then run the workflow again\\.$`));
    await assert.rejects(openWorkflowBrowser({ browser, home: root, site: "about:blank", sourceRoot: root, directory: "Profile 9" }), /Pick it again in Bao Settings\.$/);
    await assert.rejects(openWorkflowBrowser({ browser, home: root, site: "about:blank", sourceRoot: root, directory: "Profile 2", profile: "Profile 9" }),
      /^Error: Chrome has no profile "Profile 9" in .+\. Choose one of: "Default" \(Alex\); "Profile 2" \(Work\)\.$/);
  }
});

test("a run_workflow that fails while choosing a profile names the route and folder Bao tried", async (t) => {
  const root = await chromeRoot(t, { Default: { name: "Alex", user_name: "alex@example.test" }, "Profile 2": { name: "Work" } });
  const home = await mkdtemp(path.join(tmpdir(), "bao-run-miss-"));
  const previous = process.env.BAO_AGENT_BROWSER_PROFILE_ROOT;
  process.env.BAO_AGENT_BROWSER_PROFILE_ROOT = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.BAO_AGENT_BROWSER_PROFILE_ROOT;
    else process.env.BAO_AGENT_BROWSER_PROFILE_ROOT = previous;
    await rm(home, { recursive: true, force: true });
  });
  const library = new Library(home);
  library.save(testWorkflow({ id: "hello", startUrl: "about:blank", steps: [] }));
  const chrome = resolveNormalChrome();
  const tried = (route: string, folder: string) =>
    `Browser: ${route}, named by the agent, did not open. Chrome app: ${chrome}. Profile: "${folder}" in ${root}.`;

  const missing = await runWorkflow(library, { id: "hello", browser: "copy", profile: "Profile 9", why: "named by the agent" });
  assert.equal(missing.outcome, "failed");
  assert.match(missing.reason ?? "", /Chrome has no profile "Profile 9"/);
  assert.equal(missing.browser?.[0], tried("Chrome copy", "Profile 9"));

  library.updateSettings({ chromeProfile: "Profile 9" });
  const stale = await runWorkflow(library, { id: "hello", browser: "current", why: "named by the agent" });
  assert.match(stale.reason ?? "", /Pick it again in Bao Settings/);
  assert.equal(stale.browser?.[0], tried("Running Chrome over remote debugging", "Profile 9"));

  library.updateSettings({ chromeProfile: undefined });
  const asked = await runWorkflow(library, { id: "hello", browser: "copy", why: "named by the agent" });
  assert.match(asked.reason ?? "", /so Bao opened nothing/);
  assert.equal(asked.browser, undefined, "a profile question is not a failed open");

  try {
    await chmod(root, 0o000);
    const denied = await runWorkflow(library, { id: "hello", browser: "copy", profile: "Default", why: "named by the agent" });
    assert.match(denied.reason ?? "", /macOS blocked the app that started Bao from reading Chrome's data/);
    assert.equal(denied.browser?.[0], tried("Chrome copy", "Default"));
  } finally {
    await chmod(root, 0o700);
  }
});

test("an app replay that fails while choosing a profile names the route the owner picked", async (t) => {
  pinTestBrowser();
  const root = await chromeRoot(t, { Default: { name: "Alex" }, "Profile 2": { name: "Work" } });
  const home = await mkdtemp(path.join(tmpdir(), "bao-app-miss-"));
  const app = await startApp({ home, chromeProfilesRoot: root, baoProfile: path.join(home, "chrome-profile"), extensionHost: false });
  t.after(async () => {
    await app.close();
    await rm(home, { recursive: true, force: true });
  });
  app.library.updateSettings({ chromeProfile: "Profile 9" });
  app.library.save(testWorkflow({ id: "hello", startUrl: "about:blank", steps: [] }));
  const response = await fetch(`http://127.0.0.1:${app.port}/api/replay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "hello", browser: "copy", args: {} }),
  });
  const body = await response.json() as { error?: string };
  assert.equal(response.status, 500);
  assert.match(body.error ?? "", /^Browser: Chrome copy, picked in the Bao app, did not open\. Chrome app: .+ Profile: "Profile 9" in .+\./);
  assert.match(body.error ?? "", /Pick it again in Bao Settings/);
  assert.doesNotMatch(body.error ?? "", /named by the agent/);
});

test("the sign-in import line says what Bao read and wrote, a wall retry, or why it could not read the profile", () => {
  const origin = "https://www.nytimes.com";
  assert.equal(signInLine({ origin, found: 12, cookies: 3, storage: 0 }, "Default"),
    'Sign-in import for https://www.nytimes.com from Chrome profile "Default": read 12 site cookies, wrote 3 new or changed cookies and 0 storage items into Bao\'s profile.');
  assert.equal(signInLine({ origin, found: 1, cookies: 1, storage: 1, retry: true }, "Default"),
    'Sign-in import for https://www.nytimes.com from Chrome profile "Default", again at the sign-in wall: read 1 site cookie, wrote 1 new or changed cookie and 1 storage item into Bao\'s profile.');
  assert.equal(signInLine({ origin, found: 0, cookies: 0, storage: 0 }, "Profile 2"),
    'Sign-in import for https://www.nytimes.com from Chrome profile "Profile 2": the profile has no cookies for this site.');
  assert.equal(signInLine({ origin, found: 0, cookies: 0, storage: 0, error: "EPERM: operation not permitted, scandir '/Chrome/Default/Local Storage/leveldb'" }, "Default"),
    'Sign-in import for https://www.nytimes.com from Chrome profile "Default" failed: EPERM: operation not permitted, scandir \'/Chrome/Default/Local Storage/leveldb\'. Bao\'s profile kept its saved sign-ins.');
});

test("a saved workflow runs in Bao's profile with Chrome's folder refused, and a Chrome copy or Running Chrome stops", { timeout: scaledMs(60_000) }, async (t) => {
  const root = await chromeRoot(t, { Default: { name: "Alex" }, "Profile 2": { name: "Work" } });
  const home = await mkdtemp(path.join(tmpdir(), "bao-pick-home-"));
  pinTestBrowser();
  await chmod(root, 0o000);
  try {
    for (const browser of ["copy", "current"] as const) {
      await assert.rejects(openWorkflowBrowser({ browser, home, site: "about:blank", sourceRoot: root }), ChromeFolderDenied);
    }
    const session = await openWorkflowBrowser({ browser: "bao", home, site: "about:blank", sourceRoot: root });
    try {
      assert.equal(session.kind, "owned");
      const report = session.kind === "owned" ? await session.importLogin?.("https://example.test/", true) : undefined;
      assert.match(report?.error ?? "", new RegExp(`^macOS blocked the app that started Bao from reading Chrome's data \\(EACCES on ${root}\\)\\.`));
    } finally { await session.close(); }
  } finally {
    await chmod(root, 0o700);
    await rm(home, { recursive: true, force: true });
  }
});

async function pageProfile(cdp: CdpSocket, targetId: string): Promise<string> {
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  try {
    await cdp.send("Page.navigate", { url: "chrome://version" }, sessionId);
    for (let tries = 0; tries < 100; tries++) {
      const { result } = await cdp.send<{ result: { value?: string } }>("Runtime.evaluate",
        { expression: "document.getElementById('profile_path')?.textContent || ''", returnByValue: true }, sessionId);
      if (result.value) return result.value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("chrome://version never named the profile");
  } finally { await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined); }
}

async function stopHold(root: string): Promise<void> {
  try {
    const record = JSON.parse(await readFile(path.join(holdDir(root), "hold.json"), "utf8")) as { holderPid?: number };
    if (record.holderPid && record.holderPid !== process.pid) process.kill(record.holderPid, "SIGTERM");
  } catch { /* the hold already ended */ }
}

function approvalGate(upstreamPort: number, browserPath: string): Promise<{ port: number; accepted: () => number; close: () => void }> {
  let accepted = 0;
  const hanging = new Set<Socket>();
  const upstreams = new Set<Socket>();
  const server = createServer((_request, response) => { response.writeHead(404).end(); });
  server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (accepted !== 0 || pathname !== browserPath) {
      hanging.add(socket);
      socket.on("close", () => hanging.delete(socket));
      return;
    }
    accepted += 1;
    const upstream = netConnect(upstreamPort, "127.0.0.1");
    upstreams.add(upstream);
    const stop = () => { socket.destroy(); upstream.destroy(); upstreams.delete(upstream); };
    socket.on("error", stop);
    upstream.on("error", stop);
    upstream.on("connect", () => {
      const lines = [`GET ${request.url ?? browserPath} HTTP/1.1`];
      for (const [key, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${item}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        accepted: () => accepted,
        close: () => {
          server.close();
          for (const socket of hanging) socket.destroy();
          for (const socket of upstreams) socket.destroy();
        },
      });
    });
  });
}

async function listeningFixture(t: TestContext, args: string[]): Promise<{ root: string; keeper: CdpSocket; homes: string[]; reported: string; accepted: () => number }> {
  pinTestBrowser();
  const root = await chromeRoot(t, { Default: { name: "Alex" }, "Profile 1": { name: "Work" } });
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: root, headless: true, args: [...args, "--no-startup-window"] });
  const endpoint = await readDevToolsActivePort(chrome.portFile);
  const keeper = await connectCdp(endpoint.port, endpoint.browserPath);
  const keeperTab = await keeper.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: true });
  const reported = await pageProfile(keeper, keeperTab.targetId);
  const previousFixture = process.env.BAO_CHROME_HOLD_FIXTURE;
  const pid = chrome.pid ?? pidsForDataDir(root)[0];
  if (!pid) throw new Error("fixture Chrome has no pid");
  const gate = await approvalGate(endpoint.port, endpoint.browserPath);
  process.env.BAO_CHROME_HOLD_FIXTURE = JSON.stringify({
    port: gate.port, browserPath: endpoint.browserPath, chromePid: pid, executable: pinTestBrowser(),
  });
  const homes = [await mkdtemp(path.join(tmpdir(), "bao-denied-workflow-")), await mkdtemp(path.join(tmpdir(), "bao-denied-agent-"))];
  t.after(async () => {
    if (previousFixture === undefined) delete process.env.BAO_CHROME_HOLD_FIXTURE;
    else process.env.BAO_CHROME_HOLD_FIXTURE = previousFixture;
    await chmod(root, 0o700).catch(() => undefined);
    await stopHold(root);
    keeper.close();
    const closed = chrome.close();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    await closed.catch(() => undefined);
    gate.close();
    await rm(holdDir(root), { recursive: true, force: true });
    for (const home of homes) await rm(home, { recursive: true, force: true });
  });
  return { root, keeper, homes, reported, accepted: gate.accepted };
}

test("a flag-free listening Chrome opens through each planner when the profile list cannot be read", { timeout: scaledMs(120_000) }, async (t) => {
  const { root, keeper, homes, reported, accepted } = await listeningFixture(t, []);
  const directory = path.basename(reported);
  const other = directory === "Default" ? "Profile 1" : "Default";
  await chmod(path.join(root, "Local State"), 0o000);
  await chmod(path.join(root, "DevToolsActivePort"), 0o000);
  assert.equal((await chooseChromeProfile(root, undefined, undefined, true)).directory, directory, "an unnamed open uses the profile the listening Chrome reports");
  await assert.rejects(chooseChromeProfile(root, { directory: other, by: "agent" }, undefined, true), ChromeFolderDenied);
  await assert.rejects(chooseChromeProfile(root, undefined), ChromeFolderDenied);

  const before = new Set((await keeper.send<{ targetInfos: { targetId: string }[] }>("Target.getTargets")).targetInfos.map((target) => target.targetId));
  const workflow = await openWorkflowBrowser({ browser: "current", home: homes[0]!, site: "about:blank", sourceRoot: root });
  try {
    assert.equal(workflow.kind, "current");
    if (workflow.kind !== "current" || workflow.pick?.route !== "current") throw new Error("the workflow planner did not choose Running Chrome");
    assert.equal(workflow.pick.profile.directory, directory);
    const opened = (await keeper.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets")).targetInfos
      .filter((target) => target.type === "page" && !before.has(target.targetId));
    assert.equal(opened.some((target) => target.url.includes("chrome://inspect")), false);
    assert.ok(opened.length >= 1, "the workflow planner opened a tab");
    assert.ok((await pageProfile(keeper, opened[0]!.targetId)).endsWith(`${path.sep}${directory}`));
  } finally { await workflow.close(); }

  await assert.rejects(openWorkflowBrowser({ browser: "current", home: homes[0]!, site: "about:blank", sourceRoot: root, profile: other }), ChromeFolderDenied);

  const proxy = new AgentBrowserProxy({ home: homes[1]!, sourceRoot: root, executable: "/usr/bin/true" });
  const agentBefore = new Set((await keeper.send<{ targetInfos: { targetId: string }[] }>("Target.getTargets")).targetInfos.map((target) => target.targetId));
  let agentError: unknown;
  try { await proxy.execute("open", ["about:blank"], "current"); }
  catch (error) { agentError = error; }
  assert.equal(agentError instanceof ChromeFolderDenied, false, agentError instanceof Error ? agentError.message : String(agentError));
  const agentOpened = (await keeper.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets")).targetInfos
    .filter((target) => target.type === "page" && !agentBefore.has(target.targetId));
  assert.equal(agentOpened.some((target) => target.url.includes("chrome://inspect")), false);
  assert.ok(agentOpened.length >= 1, agentError instanceof Error ? agentError.message : "the agent planner opened no tab");
  try { assert.ok((await pageProfile(keeper, agentOpened[0]!.targetId)).endsWith(`${path.sep}${directory}`)); }
  finally { await proxy.end(); }
  assert.equal(accepted(), 1, "a second debugging connection was not allowed");
});

test("a default workflow uses the listening profile before it falls back", { timeout: scaledMs(120_000) }, async (t) => {
  const { root, keeper, homes, reported, accepted } = await listeningFixture(t, []);
  const directory = path.basename(reported);
  await chmod(path.join(root, "Local State"), 0o000);
  await chmod(path.join(root, "DevToolsActivePort"), 0o000);
  const before = new Set((await keeper.send<{ targetInfos: { targetId: string }[] }>("Target.getTargets")).targetInfos.map((target) => target.targetId));
  const workflow = await openWorkflowBrowser({ browser: "current", why: "the default", home: homes[0]!, site: "about:blank", sourceRoot: root });
  try {
    assert.equal(workflow.kind, "current");
    if (workflow.kind !== "current" || workflow.pick?.route !== "current") throw new Error("the default workflow fell back before asking the listening Chrome");
    assert.equal(workflow.pick.why, "the default");
    assert.equal(workflow.pick.profile.directory, directory);
    const opened = (await keeper.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets")).targetInfos
      .filter((target) => target.type === "page" && !before.has(target.targetId));
    assert.equal(opened.some((target) => target.url.includes("chrome://inspect")), false);
    assert.ok(opened.length >= 1, "the default workflow opened a tab");
    assert.ok((await pageProfile(keeper, opened[0]!.targetId)).endsWith(`${path.sep}${directory}`));
  } finally { await workflow.close(); }
  assert.equal(accepted(), 1, "a second debugging connection was not allowed");
});

test("a failed profile report stops Running Chrome and does not guess Default", { timeout: scaledMs(120_000) }, async (t) => {
  const { root, keeper, homes } = await listeningFixture(t, []);
  const before = new Set((await keeper.send<{ targetInfos: { targetId: string; url: string }[] }>("Target.getTargets")).targetInfos.map((target) => target.targetId));
  await chmod(root, 0o000);
  await assert.rejects(chooseChromeProfile(root, undefined, undefined, true), ChromeFolderDenied);
  await assert.rejects(openWorkflowBrowser({ browser: "current", home: homes[0]!, site: "about:blank", sourceRoot: root }), ChromeFolderDenied);
  const proxy = new AgentBrowserProxy({ home: homes[1]!, sourceRoot: root, executable: "/usr/bin/true" });
  await assert.rejects(proxy.execute("open", ["about:blank"], "current"), ChromeFolderDenied);
  await proxy.end();
  const after = (await keeper.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets")).targetInfos;
  assert.equal(after.some((target) => target.url.includes("chrome://inspect")), false);
  assert.equal(after.some((target) => target.type === "page" && !before.has(target.targetId)), false);
});

test("run_workflow names its route, Chrome profile, and sign-in import, and a sign-in stop in Bao's profile gives the call back to Running Chrome", { timeout: scaledMs(120_000) }, async (t) => {
  pinTestBrowser();
  const root = await mkdtemp(path.join(tmpdir(), "bao-run-pick-"));
  const sourceRoot = path.join(root, "chrome");
  const home = path.join(root, "library");
  let signedIn = false;
  let shownIn = () => {};
  const server = createServer((request, response) => {
    if (request.url === "/state") { response.end(signedIn ? "in" : "out"); return; }
    if (request.url === "/shown") { response.end(); shownIn(); return; }
    response.setHeader("Content-Type", "text/html");
    if (request.url === "/account") { response.end(`<title>Account</title><h1>${request.headers.cookie?.includes("login=owner") ? "Signed in" : "Signed out"}</h1>`); return; }
    response.end(`<title>Locked</title><h1 id="state">Locked</h1><script>(async function poll() {
      if (await (await fetch("/state")).text() !== "in") { setTimeout(poll, 100); return; }
      document.getElementById("state").textContent = "Welcome back";
      fetch("/shown");
    })();</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const source = await launchOwnedChrome({ userDataDir: sourceRoot, headless: true });
  try { await source.addCookies([{ name: "login", value: "owner", url: site, expires: Date.now() / 1000 + 3600 }]); }
  finally { await source.close(); }
  const state = JSON.parse(await readFile(path.join(sourceRoot, "Local State"), "utf8")) as Record<string, unknown>;
  await mkdir(path.join(sourceRoot, "Profile 2"), { recursive: true });
  await writeFile(path.join(sourceRoot, "Local State"), JSON.stringify({ ...state, profile: { info_cache: {
    Default: { name: "Owner", user_name: "owner@example.test" }, "Profile 2": { name: "Work", user_name: "owner@work.test" },
  } } }));
  const library = new Library(home);
  library.updateSettings({ chromeProfile: "Default" });
  library.save(testWorkflow({ id: "account", startUrl: `${site}/account`, steps: [
    { id: "check", index: 0, timeoutMs: 1000, caption: { text: "Check account" }, action: "verify", check: { kind: "text", match: "Signed in", timeoutMs: 1000 } },
  ] }));
  library.save(testWorkflow({ id: "locked", startUrl: `${site}/locked`, steps: [
    { id: "signin", index: 0, timeoutMs: 1000, caption: { text: "Sign in" }, action: "handoff", reason: "sign-in", check: { kind: "text", match: "Welcome back", timeoutMs: 1000 } },
  ] }));
  library.save(testWorkflow({ id: "login-check", startUrl: `${site}/locked`, steps: [
    { id: "login", index: 0, timeoutMs: 100, caption: { text: "Check the sign in" }, action: "verify", check: { kind: "text", match: "Welcome back", timeoutMs: 100 } },
  ] }));
  library.save(testWorkflow({ id: "login-download", startUrl: `${site}/locked`, steps: [
    { id: "login", index: 0, timeoutMs: 100, caption: { text: "Check the sign in" }, action: "verify", check: { kind: "text", match: "Welcome back", timeoutMs: 100 } },
    { id: "save", index: 1, timeoutMs: 1000, caption: { text: "Save the report" }, action: "download", download: { output: "report", name: "report.txt" } },
  ] }));
  await mkdir(path.join(root, "user"));
  const mcp = McpClient.start({ ...process.env, HOME: path.join(root, "user"), BAO_HOME: home, BAO_AGENT_BROWSER_PROFILE_ROOT: sourceRoot, BAO_HEAL_CURSOR_ACCOUNT: "0" });
  let held = "";
  t.after(async () => {
    try {
      if (held) await mcp.call("run_workflow", { resume: held, cancel: true }).catch(() => undefined);
      await mcp.close();
    } finally {
      for (const pid of pidsForDataDir(baoAgentProfileDir(home))) {
        try { process.kill(pid, "SIGTERM"); } catch {}
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
  await mcp.handshake();
  const run = async (args: Record<string, unknown>) => {
    const result = await mcp.call("run_workflow", args);
    t.diagnostic(`run_workflow ${JSON.stringify(args)}\n${result.text}`);
    assert.equal(result.isError, false, result.text);
    return JSON.parse(result.text) as { outcome: string; status: string; reason?: string; resume_token?: string; browser?: string[] };
  };
  const chrome = resolveNormalChrome();
  const opened = `Browser: Bao profile, named by the agent. Chrome app: ${chrome}. User data: ${baoAgentProfileDir(home)}. `
    + `Sign-ins come from Chrome profile "Default" (Owner, owner@example.test) in ${sourceRoot}, picked in Bao Settings.`;
  const fallback = (calls: string) => 'If the sign-in or check does not clear in Bao\'s profile, the fallback is the owner\'s running Chrome over remote debugging '
    + `on the same Chrome profile "Default". To take it, call run_workflow with ${calls}. Bao does not switch on its own.`;

  const passed = await run({ id: "account", browser: "bao" });
  assert.equal(passed.outcome, "ok", passed.reason);
  assert.deepEqual(passed.browser, [opened,
    `Sign-in import for ${site} from Chrome profile "Default": read 1 site cookie, wrote 1 new or changed cookie and 0 storage items into Bao's profile.`]);

  const waiting = await run({ id: "locked", browser: "bao" });
  assert.equal(waiting.status, "needs_signin", waiting.reason);
  held = waiting.resume_token!;
  assert.deepEqual(waiting.browser, [opened,
    `Sign-in import for ${site} from Chrome profile "Default": read 1 site cookie, wrote 0 new or changed cookies and 0 storage items into Bao's profile.`,
    fallback(`{"resume":"${held}","cancel":true}, then with {"id":"locked","browser":"current","profile":"Default"} and the same inputs`)]);

  const still = await run({ resume: held });
  assert.equal(still.status, "needs_signin", still.reason);
  assert.deepEqual(still.browser, ['Browser: Bao profile, Chrome profile "Default".',
    fallback(`{"resume":"${held}","cancel":true}, then with {"id":"locked","browser":"current","profile":"Default"} and the same inputs`)]);
  // The held page reports when it shows the sign-in.
  await new Promise<void>((resolve) => { shownIn = resolve; signedIn = true; });
  const resumed = await run({ resume: held });
  held = "";
  assert.equal(resumed.status, "completed", resumed.reason);
  assert.deepEqual(resumed.browser, ['Browser: Bao profile, Chrome profile "Default".']);

  signedIn = false;
  const failed = await run({ id: "login-check", browser: "bao", profile: "Default" });
  assert.equal(failed.status, "needs_signin", failed.reason);
  assert.equal(failed.browser?.[0], opened.replace("picked in Bao Settings", "named by the agent"));
  assert.equal(failed.browser?.at(-1), fallback(`{"resume":"${failed.resume_token}","browser":"current","profile":"Default"}`));

  const moves = await run({ id: "login-download", browser: "bao", profile: "Default" });
  assert.equal(moves.status, "needs_signin", moves.reason);
  assert.equal(moves.browser?.[0], failed.browser?.[0]);
  assert.equal(moves.browser?.some((line) => line.includes("browser\":\"current")), false, moves.browser?.join("\n"));

  const unnamed = await run({ id: "login-download" });
  assert.equal(unnamed.status, "needs_signin", unnamed.reason);
  assert.equal(unnamed.browser?.[0], opened.replace("named by the agent", "the workflow moves files, which running Chrome cannot do yet"),
    "a run that names no browser and moves files uses Bao's profile instead of the default, running Chrome");
});

const onlyProfile = { directory: "Default", name: "Alex", email: "alex@example.test", root: "/chrome", why: "the only profile" as const };

test("a bound reroute falls back to the named route, and both failures name both routes", async () => {
  const opened: BrowserPlan[] = [];
  const open = async (plan: BrowserPlan) => {
    opened.push(plan);
    if (plan.route === "current") throw new Error("screen is locked.");
    return plan.route;
  };
  const missed = (plan: BrowserPlan | undefined) => "missed" in (plan ?? {}) ? (plan as { missed?: string }).missed : undefined;
  assert.equal(await openOrFallBack({ route: "current", why: BOUND_REASON, profile: onlyProfile, from: "bao" }, open), "bao");
  assert.equal(opened.at(-1)?.route, "bao");
  assert.equal("unread" in (opened.at(-1) ?? {}), false, "a named Bao profile keeps its sign-in import");
  assert.equal(missed(opened.at(-1)), "Bao could not use your running Chrome: screen is locked.");
  assert.equal(await openOrFallBack({ route: "current", why: BOUND_REASON, profile: onlyProfile, from: "copy" }, open), "copy");
  assert.equal(missed(opened.at(-1)), "Bao could not use your running Chrome: screen is locked.");
  assert.equal(await openOrFallBack({ route: "current", why: "the default", profile: onlyProfile }, open), "bao");
  const unread = opened.at(-1)!;
  assert.equal(unread.route, "bao");
  assert.equal("unread" in unread ? unread.unread : undefined, "Bao could not use your running Chrome: screen is locked.");
  assert.equal(missed(unread), undefined, "an unread fallback keeps the reason on the pick, not a second line");
  await assert.rejects(openOrFallBack({ route: "current", why: BOUND_REASON, profile: onlyProfile, from: "bao" }, async (plan) => {
    throw new Error(plan.route === "current" ? "screen is locked" : "The Bao profile is already open");
  }), (error: unknown) => {
    assert.ok(error instanceof RoutesFailed);
    assert.notEqual(error.message, error.line);
    assert.equal(error.message, "screen is locked. The Bao profile is already open.");
    assert.match(error.line, /Running Chrome over remote debugging, this site ties its sign-in to your Chrome, did not open\. Chrome app: .+ Profile: "Default" in \/chrome\. screen is locked/);
    assert.match(error.line, /Bao profile, fallback when running Chrome could not be used, did not open\. Chrome app: .+ Profile: "Default" in \/chrome\. The Bao profile is already open/);
    assert.equal(error.line.indexOf("Browser: Running Chrome"), error.line.lastIndexOf("Browser: Running Chrome"));
    return true;
  });
});
