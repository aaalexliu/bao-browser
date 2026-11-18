import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { connect as netConnect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ChromeFolderDenied } from "../../src/chrome-access";
import { holdDir } from "../../src/cdp-live/chrome-hold";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { clientFrame, connectCdp, serverFrame, ServerFrameDecoder, type CdpSocket } from "../../src/cdp-live/socket";
import { AgentBrowserProxy } from "../../src/engines/agent-browser-proxy";
import { chooseChromeProfile, ChromeProfileQuestion, openOrFallBack, pickLine, RoutesFailed, signInLine, type BrowserPlan } from "../../src/engines/browser-pick";
import { BOUND_REASON } from "../../src/engines/bound-sign-in";
import { launchOwnedChromeEndpoint, pidsForDataDir, pinTestBrowser } from "../../src/launch";
import { openWorkflowBrowser } from "../../src/engines/workflow-browser";
import { chromeProfiles, type ProfileNames } from "../support/chrome-profiles";
import { scaledMs } from "../runtime";

async function chromeRoot(t: TestContext, profiles: ProfileNames, beforeDelete?: { run?: () => Promise<void> }): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "bao-pick-"));
  t.after(async () => {
    try { await beforeDelete?.run?.(); }
    finally {
      await chmod(root, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
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

async function stopHold(dir: string): Promise<void> {
  try {
    const record = JSON.parse(await readFile(path.join(dir, "hold.json"), "utf8")) as { holderPid?: number };
    if (record.holderPid && record.holderPid !== process.pid) process.kill(record.holderPid, "SIGTERM");
  } catch { /* the hold already ended */ }
}

function failedVersionReply(text: string): string | undefined {
  let message: { id?: unknown; method?: unknown; params?: { url?: unknown } };
  try { message = JSON.parse(text) as typeof message; }
  catch { return undefined; }
  if (message.method !== "Target.createTarget" || typeof message.params?.url !== "string" || !message.params.url.startsWith("chrome://version")) return undefined;
  if (typeof message.id !== "number") return undefined;
  return JSON.stringify({ id: message.id, error: { code: -32000, message: "chrome://version failed" } });
}

function approvalGate(upstreamPort: number, browserPath: string, failVersion = false): Promise<{ port: number; accepted: () => number; close: () => void }> {
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
      if (!failVersion) {
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
        return;
      }
      const decoder = new ServerFrameDecoder();
      const take = (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          const reply = frame.opcode === 1 && frame.text ? failedVersionReply(frame.text) : undefined;
          if (reply) {
            socket.write(serverFrame(1, Buffer.from(reply)));
            continue;
          }
          upstream.write(clientFrame(frame.opcode, frame.payload ?? Buffer.alloc(0)));
        }
      };
      if (head.length) take(head);
      socket.on("data", take);
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

async function listeningFixture(t: TestContext, args: string[], failVersion = false): Promise<{ root: string; keeper: CdpSocket; homes: string[]; reported: string; accepted: () => number }> {
  pinTestBrowser();
  const beforeDelete: { run?: () => Promise<void> } = {};
  const root = await chromeRoot(t, { Default: { name: "Alex" }, "Profile 1": { name: "Work" } }, beforeDelete);
  const held = holdDir(root);
  const previousFixture = process.env.BAO_CHROME_HOLD_FIXTURE;
  const homes = [await mkdtemp(path.join(tmpdir(), "bao-denied-workflow-")), await mkdtemp(path.join(tmpdir(), "bao-denied-agent-"))];
  let chrome: Awaited<ReturnType<typeof launchOwnedChromeEndpoint>> | undefined;
  let keeper: CdpSocket | undefined;
  let gate: Awaited<ReturnType<typeof approvalGate>> | undefined;
  let pid: number | undefined;
  beforeDelete.run = async () => {
    if (previousFixture === undefined) delete process.env.BAO_CHROME_HOLD_FIXTURE;
    else process.env.BAO_CHROME_HOLD_FIXTURE = previousFixture;
    await chmod(root, 0o700).catch(() => undefined);
    await stopHold(held);
    keeper?.close();
    const closed = chrome?.close();
    if (closed) await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    await closed?.catch(() => undefined);
    gate?.close();
    await rm(held, { recursive: true, force: true });
    for (const home of homes) await rm(home, { recursive: true, force: true });
  };
  chrome = await launchOwnedChromeEndpoint({ userDataDir: root, headless: true, args: [...args, "--no-startup-window"] });
  const endpoint = await readDevToolsActivePort(chrome.portFile);
  keeper = await connectCdp(endpoint.port, endpoint.browserPath);
  const keeperTab = await keeper.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: true });
  const reported = await pageProfile(keeper, keeperTab.targetId);
  pid = chrome.pid ?? pidsForDataDir(root)[0];
  if (!pid) throw new Error("fixture Chrome has no pid");
  gate = await approvalGate(endpoint.port, endpoint.browserPath, failVersion);
  process.env.BAO_CHROME_HOLD_FIXTURE = JSON.stringify({
    port: gate.port, browserPath: endpoint.browserPath, chromePid: pid, executable: pinTestBrowser(),
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

test("a listening Chrome opens through each planner when the whole folder cannot be listed", { timeout: scaledMs(120_000) }, async (t) => {
  const { root, keeper, homes, reported, accepted } = await listeningFixture(t, []);
  const directory = path.basename(reported);
  const other = directory === "Default" ? "Profile 1" : "Default";
  await chmod(root, 0o111);
  assert.equal((await chooseChromeProfile(root, undefined, undefined, true)).directory, directory, "an unnamed open uses the profile the listening Chrome reports");
  await assert.rejects(chooseChromeProfile(root, { directory: other, by: "agent" }, undefined, true), ChromeFolderDenied);

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

  const fallback = await openWorkflowBrowser({ browser: "current", why: "the default", home: homes[0]!, site: "about:blank", sourceRoot: root });
  try {
    assert.equal(fallback.kind, "current");
    if (fallback.kind !== "current" || fallback.pick?.route !== "current") throw new Error("the default workflow fell back before asking the listening Chrome");
    assert.equal(fallback.pick.profile.directory, directory);
  } finally { await fallback.close(); }

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

test("a failed profile report stops Running Chrome and does not guess Default", { timeout: scaledMs(120_000) }, async (t) => {
  const { root, keeper, homes } = await listeningFixture(t, [], true);
  const before = new Set((await keeper.send<{ targetInfos: { targetId: string; url: string }[] }>("Target.getTargets")).targetInfos.map((target) => target.targetId));
  await chmod(root, 0o111);
  await assert.rejects(chooseChromeProfile(root, undefined, undefined, true), ChromeFolderDenied);
  await assert.rejects(openWorkflowBrowser({ browser: "current", home: homes[0]!, site: "about:blank", sourceRoot: root }), ChromeFolderDenied);
  const proxy = new AgentBrowserProxy({ home: homes[1]!, sourceRoot: root, executable: "/usr/bin/true" });
  await assert.rejects(proxy.execute("open", ["about:blank"], "current"), ChromeFolderDenied);
  await proxy.end();
  const after = (await keeper.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets")).targetInfos;
  assert.equal(after.some((target) => target.url.includes("chrome://inspect")), false);
  assert.equal(after.some((target) => target.type === "page" && !before.has(target.targetId)), false);
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
