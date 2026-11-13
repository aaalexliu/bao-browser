import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { connectCdp } from "../../src/cdp-live/socket";
import { AgentBrowserRun } from "../../src/engines/agent-browser-record";
import { ChromeProfileQuestion } from "../../src/engines/browser-pick";
import {
  agentProfileText, capTabs, listProfileTabs, readListeningProfileTabs, readProfileTabs, tabHost, trimField,
  type ProfileTab, type TabSocket,
} from "../../src/engines/profile-tabs";
import { openTabsFromSnss } from "../../src/engines/snss-tabs";
import { profileQuestionResult } from "../../src/mcp/tool-card";
import { getRun } from "../../src/mcp/catalog";
import { testChromium } from "../../src/test-browser.js";
import { Library } from "../../src/v1/store";

const secret = "secret-oauth-code";

test("a tab host drops the path, userinfo, and query", () => {
  assert.equal(tabHost(`https://user:pass@robinhood.com/stocks?code=${secret}#frag`), "robinhood.com");
  assert.equal(tabHost("https://complysci.com/"), "complysci.com");
  assert.equal(tabHost("chrome://version"), undefined);
  assert.equal(tabHost("about:blank"), undefined);
  assert.equal(tabHost("devtools://devtools/bundled/inspector.html"), undefined);
  assert.equal(trimField("a".repeat(90), 80).length, 80);
  assert.equal(capTabs(Array.from({ length: 12 }, (_, i) => ({ title: String(i), host: "example.test" }))).omitted, 2);
});

test("open tabs are grouped by profile, capped, and never include a query", async () => {
  const root = "/Chrome";
  const targets = [
    { type: "page", url: `https://robinhood.com/stocks?code=${secret}`, title: "Robinhood", browserContextId: "work" },
    { type: "page", url: "https://complysci.com/home", title: "ComplySci", browserContextId: "work" },
    { type: "page", url: "chrome://newtab", title: "New Tab", browserContextId: "work" },
    { type: "page", url: `https://mail.example.test/inbox?id=${secret}`, title: `https://mail.example.test/inbox?id=${secret}`, browserContextId: "home" },
    { type: "page", url: `https://other.example.test/secret?code=${secret}`, title: "Other", browserContextId: "other" },
    ...Array.from({ length: 11 }, (_, i) => ({ type: "page", url: `https://extra.example.test/${i}`, title: `Extra ${i}`, browserContextId: "work" })),
  ];
  const closed: string[] = [];
  let opened = "";
  const cdp: TabSocket = {
    async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      if (method === "Target.getTargets") return { targetInfos: targets } as T;
      if (method === "Target.createTarget") {
        opened = String(params?.browserContextId ?? "focused");
        if (opened === "other") throw new Error("Failed to find browser context for id other");
        return { targetId: `version-${opened}` } as T;
      }
      if (method === "Target.getTargetInfo") return { targetInfo: { browserContextId: "work" } } as T;
      if (method === "Target.attachToTarget") return { sessionId: "session" } as T;
      if (method === "Runtime.evaluate") {
        const folder = opened === "home" ? "Default" : "Profile 2";
        return { result: { value: path.join(root, folder) } } as T;
      }
      if (method === "Target.closeTarget") {
        closed.push(String(params?.targetId));
        return {} as T;
      }
      return {} as T;
    },
  };
  const listing = await readProfileTabs(cdp, root, ["Default", "Profile 2"]);
  assert.deepEqual(closed.sort(), ["version-focused", "version-home"]);
  assert.equal(listing.unmatched, 1);
  assert.equal(listing.byDirectory["Profile 2"]?.tabs[0]?.host, "robinhood.com");
  assert.equal(listing.byDirectory["Profile 2"]?.tabs[1]?.host, "complysci.com");
  assert.equal(listing.byDirectory["Profile 2"]?.tabs.length, 10);
  assert.equal(listing.byDirectory["Profile 2"]?.omitted, 3);
  assert.equal(listing.byDirectory.Default?.tabs[0]?.title, "");
  assert.equal(listing.byDirectory.Default?.tabs[0]?.host, "mail.example.test");
  const text = agentProfileText(root, [
    { directory: "Default", name: "Alex", email: "alex@example.test" },
    { directory: "Profile 2", name: "Work", email: "" },
  ], "Profile 2", listing);
  const packed = JSON.stringify({ text, listing });
  assert.equal(packed.includes(secret), false);
  assert.equal(packed.includes("?"), false);
  assert.match(text, /"Robinhood" robinhood.com/);
  assert.match(text, /picked in Bao Settings/);
  const asked = profileQuestionResult(new ChromeProfileQuestion(root, [
    { directory: "Default", name: "Alex", email: "alex@example.test" },
    { directory: "Profile 2", name: "Work", email: "" },
  ], "Profile 2").withListing(listing), { command: "open" }, false);
  const profiles = asked.structuredContent.profiles as { directory: string; tabs?: ProfileTab[] }[];
  assert.equal(JSON.stringify(asked).includes(secret), false);
  assert.equal(profiles.find((profile) => profile.directory === "Profile 2")?.tabs?.[0]?.host, "robinhood.com");
});

test("a hermetic run does not connect even when a port file names a listener", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-profile-tabs-"));
  const prior = process.env.BAO_LANE;
  process.env.BAO_LANE = "hermetic";
  try {
    await writeFile(path.join(root, "DevToolsActivePort"), "9333\n/devtools/browser/fixture\n");
    const started = Date.now();
    const listing = await readListeningProfileTabs(root, ["Default"]);
    assert.equal(listing.unread, "remote debugging is off");
    assert.ok(Date.now() - started < 500, "a connect to the port file would take seconds");
  } finally {
    if (prior === undefined) delete process.env.BAO_LANE;
    else process.env.BAO_LANE = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test("a fixture browser is read and the socket is closed without leaving debugging to us", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-profile-tabs-chrome-"));
  await mkdir(path.join(root, "Profile 2"), { recursive: true });
  const exe = process.env.BAO_TEST_BROWSER || testChromium.executablePath();
  const child: ChildProcess = spawn(exe, [
    `--user-data-dir=${root}`, "--remote-debugging-port=0", "--headless=new",
    "--use-mock-keychain", "--password-store=basic", "--no-first-run", "--no-default-browser-check",
  ], { stdio: "ignore" });
  t.after(() => { child.kill("SIGKILL"); });
  const page = createServer((_req, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<title>Robinhood</title><p>ok</p>");
  });
  await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
  const pagePort = (page.address() as AddressInfo).port;
  const prior = process.env.BAO_LANE;
  try {
    const endpoint = await waitForEndpoint(path.join(root, "DevToolsActivePort"));
    const opened = await connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 5000 });
    await opened.send("Target.createTarget", { url: `http://127.0.0.1:${pagePort}/stocks?code=${secret}` });
    await waitForHost(opened, "127.0.0.1");
    opened.close();
    assert.equal(opened.isOpen, false);
    delete process.env.BAO_LANE;
    const listing = await readListeningProfileTabs(root, ["Default", "Profile 2"]);
    const packed = JSON.stringify(listing);
    assert.equal(listing.unread, undefined, packed);
    assert.equal(packed.includes(secret), false, packed);
    assert.equal(packed.includes("?"), false, packed);
    const hosts = Object.values(listing.byDirectory).flatMap((group) => group.tabs.map((tab) => tab.host));
    assert.ok(hosts.includes("127.0.0.1"), packed);
    const again = await connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 5000 });
    const { targetInfos } = await again.send<{ targetInfos: { url?: string }[] }>("Target.getTargets", {}, undefined, 2000);
    assert.equal(targetInfos.some((target) => target.url?.startsWith("chrome://version")), false);
    again.close();
    assert.equal(again.isOpen, false);
  } finally {
    if (prior === undefined) delete process.env.BAO_LANE;
    else process.env.BAO_LANE = prior;
    child.kill("SIGKILL");
    page.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForHost(cdp: Awaited<ReturnType<typeof connectCdp>>, host: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.send<{ targetInfos: { url?: string }[] }>("Target.getTargets", {}, undefined, 2000);
    if (targetInfos.some((target) => target.url?.includes(`${host}:`))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`fixture page ${host} did not appear`);
}

async function waitForEndpoint(file: string) {
  const deadline = Date.now() + 15_000;
  let last: unknown;
  while (Date.now() < deadline) {
    try { return await readDevToolsActivePort(file); }
    catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw last instanceof Error ? last : new Error("fixture Chrome did not write DevToolsActivePort");
}

test("the opening call's profile and reason are on the run and in get_run", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-profile-choice-"));
  try {
    const run = new AgentBrowserRun(home);
    run.noteProfileChoice("Default", `  robinhood.com is open there ${"x".repeat(220)}  `);
    const library = new Library(home);
    const stored = library.readRun(run.id);
    assert.equal(stored.profileChoice?.directory, "Default");
    assert.equal(stored.profileChoice?.reason?.length, 200);
    assert.equal(stored.profileChoice?.reason?.startsWith("robinhood.com is open there"), true);
    assert.deepEqual(getRun(library, run.id).profileChoice, stored.profileChoice);
    const blank = new AgentBrowserRun(home);
    blank.noteProfileChoice("Profile 2", "   ");
    assert.deepEqual(new Library(home).readRun(blank.id).profileChoice, { directory: "Profile 2" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

function snssCommand(id: number, payload: Buffer): Buffer {
  const frame = Buffer.alloc(3 + payload.length);
  frame.writeUInt16LE(1 + payload.length, 0);
  frame[2] = id;
  payload.copy(frame, 3);
  return frame;
}

function navigationCommand(tab: number, url: string, title: string, index = 0): Buffer {
  const urlBytes = Buffer.from(url, "utf8");
  const titleUnits = Buffer.from(title, "utf16le");
  const urlPad = (4 - (urlBytes.length % 4)) % 4;
  const body = Buffer.alloc(8 + 4 + urlBytes.length + urlPad + 4 + titleUnits.length);
  body.writeUInt32LE(tab, 0);
  body.writeInt32LE(index, 4);
  body.writeInt32LE(urlBytes.length, 8);
  urlBytes.copy(body, 12);
  const titleAt = 12 + urlBytes.length + urlPad;
  body.writeInt32LE(title.length, titleAt);
  titleUnits.copy(body, titleAt + 4);
  const payload = Buffer.alloc(4 + body.length);
  payload.writeUInt32LE(body.length, 0);
  body.copy(payload, 4);
  return snssCommand(6, payload);
}

function snssFile(...commands: Buffer[]): Buffer {
  const header = Buffer.alloc(8);
  header.write("SNSS", 0, "latin1");
  header.writeUInt32LE(3, 4);
  return Buffer.concat([header, ...commands]);
}

test("a closed tab in a session file is not listed, and a query is not either", async () => {
  const gone = navigationCommand(1, `https://robinhood.com/stocks?code=${secret}`, "Robinhood");
  const kept = navigationCommand(2, `https://complysci.com/home?id=${secret}`, "ComplySci");
  const closed = Buffer.alloc(4);
  closed.writeUInt32LE(1, 0);
  const open = openTabsFromSnss(snssFile(gone, kept, snssCommand(16, closed)));
  assert.deepEqual(open, [{ url: `https://complysci.com/home?id=${secret}`, title: "ComplySci" }]);
  const current = Buffer.alloc(8);
  current.writeUInt32LE(3, 0);
  const back = openTabsFromSnss(snssFile(
    navigationCommand(3, "https://robinhood.com/stocks", "Robinhood", 0),
    navigationCommand(3, `https://mail.example.test/inbox?id=${secret}`, "Inbox", 1),
    snssCommand(7, current),
  ));
  assert.deepEqual(back, [{ url: "https://robinhood.com/stocks", title: "Robinhood" }]);
  const root = await mkdtemp(path.join(tmpdir(), "bao-snss-synthetic-"));
  try {
    const sessions = path.join(root, "Default", "Sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(path.join(sessions, "Session_1"), snssFile(gone, kept, snssCommand(16, closed)));
    const listing = await listProfileTabs(root, ["Default"]);
    const packed = JSON.stringify(listing);
    assert.equal(packed.includes(secret), false, packed);
    assert.equal(packed.includes("?"), false, packed);
    assert.deepEqual(listing.byDirectory.Default?.tabs, [{ title: "ComplySci", host: "complysci.com" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a session file Chrome wrote names the profile, and the query stays out", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-snss-chrome-"));
  const page = createServer((req, response) => {
    const title = req.url?.startsWith("/work") ? "ComplySci" : "Robinhood";
    response.setHeader("content-type", "text/html");
    response.end(`<title>${title}</title><p>ok</p>`);
  });
  await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
  const pagePort = (page.address() as AddressInfo).port;
  const children: ChildProcess[] = [];
  const prior = process.env.BAO_LANE;
  try {
    await writeProfileSession(root, "Default", children, `http://127.0.0.1:${pagePort}/stocks?code=${secret}`);
    await writeProfileSession(root, "Profile 2", children, `http://127.0.0.1:${pagePort}/work?id=${secret}`);
    process.env.BAO_LANE = "hermetic";
    const listing = await listProfileTabs(root, ["Default", "Profile 2"]);
    const packed = JSON.stringify(listing);
    assert.equal(packed.includes(secret), false, packed);
    assert.equal(packed.includes("?"), false, packed);
    assert.equal(listing.note, undefined, packed);
    assert.deepEqual(listing.byDirectory.Default?.tabs, [{ title: "Robinhood", host: "127.0.0.1" }]);
    assert.deepEqual(listing.byDirectory["Profile 2"]?.tabs, [{ title: "ComplySci", host: "127.0.0.1" }]);
  } finally {
    if (prior === undefined) delete process.env.BAO_LANE;
    else process.env.BAO_LANE = prior;
    for (const child of children) child.kill("SIGKILL");
    page.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an unreadable Chrome folder keeps the listener counts and says so", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-snss-denied-"));
  const prior = process.env.BAO_LANE;
  try {
    await mkdir(path.join(root, "Default"));
    await chmod(path.join(root, "Default"), 0);
    process.env.BAO_LANE = "hermetic";
    const listing = await listProfileTabs(root, ["Default"]);
    assert.equal(listing.unread, "remote debugging is off");
    assert.equal(listing.note, "Chrome's folder is not readable, so tabs were not read from disk.");
    assert.equal(listing.byDirectory.Default, undefined);
    const text = agentProfileText(root, [{ directory: "Default", name: "Home", email: "" }], undefined, listing);
    assert.match(text, /open tabs were not read \(remote debugging is off\)/);
    assert.match(text, /Chrome's folder is not readable/);
  } finally {
    if (prior === undefined) delete process.env.BAO_LANE;
    else process.env.BAO_LANE = prior;
    await chmod(path.join(root, "Default"), 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function writeProfileSession(root: string, profile: string, children: ChildProcess[], url: string): Promise<void> {
  const exe = process.env.BAO_TEST_BROWSER || testChromium.executablePath();
  const child = spawn(exe, [
    `--user-data-dir=${root}`, "--remote-debugging-port=0", "--headless=new", `--profile-directory=${profile}`,
    "--use-mock-keychain", "--password-store=basic", "--no-first-run", "--no-default-browser-check", url,
  ], { stdio: "ignore" });
  children.push(child);
  const endpoint = await waitForEndpoint(path.join(root, "DevToolsActivePort"));
  const cdp = await connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 5000 });
  try {
    await waitForHost(cdp, "127.0.0.1");
    await waitForSavedUrl(path.join(root, profile, "Sessions"), url);
    await cdp.send("Browser.close", {}, undefined, 3000);
  } finally {
    cdp.close();
  }
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await rm(path.join(root, "DevToolsActivePort"), { force: true });
}

async function waitForSavedUrl(dir: string, url: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  let last = "no session file";
  while (Date.now() < deadline) {
    const names = await readdir(dir).catch(() => []);
    const session = names.filter((name) => name.startsWith("Session_")).sort().at(-1);
    if (session) {
      const open = openTabsFromSnss(await readFile(path.join(dir, session)));
      last = open ? open.map((tab) => tab.url).join(" ") : "unreadable session file";
      if (open?.some((tab) => tab.url === url)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Chrome did not write ${url} to ${dir}: ${last}`);
}
