import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import * as chromeAx from "../../src/cdp-live/ax";
import { holdDir } from "../../src/cdp-live/chrome-hold";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { connectCdp, ServerFrameDecoder } from "../../src/cdp-live/socket";
import { AgentBrowserRun } from "../../src/engines/agent-browser-record";
import { ChromeProfileQuestion } from "../../src/engines/browser-pick";
import {
  agentProfileText, capTabs, confirmOpenTabs, listProfileTabs, readListeningProfileTabs, readLivePages, tabHost, trimField,
  type LivePage, type ProfileTab, type TabSocket,
} from "../../src/engines/profile-tabs";
import { openTabsFromSnss, readSavedProfileTabs } from "../../src/engines/snss-tabs";
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

function page(targetId: string, url: string, title: string, browserContextId: string) {
  return { type: "page", targetId, url, title, browserContextId };
}

test("live tabs are listed under the profile whose session URLs overlap, and a query is not", async () => {
  const root = "/Chrome";
  const work = [
    page("rh", `https://robinhood.com/stocks?code=${secret}`, "Robinhood", "work"),
    page("cs", "https://complysci.com/home", "ComplySci", "work"),
    page("budget", "https://docs.google.com/document/budget", "Personal budget", "work"),
    page("compliance", "https://docs.google.com/document/compliance", "Work compliance", "work"),
    ...Array.from({ length: 8 }, (_, i) => page(`extra-${i}`, `https://extra.example.test/${i}`, `Extra ${i}`, "work")),
  ];
  const more = [
    page("more-a", "https://more.example.test/a", "More A", "work-b"),
    page("more-b", "https://more.example.test/b", "More B", "work-b"),
  ];
  const home = page("mail", `https://mail.example.test/inbox?id=${secret}`, `https://mail.example.test/inbox?id=${secret}`, "home");
  const other = page("other", `https://other.example.test/secret?code=${secret}`, "Other", "other");
  let created = false;
  const cdp: TabSocket = {
    async send<T>(method: string): Promise<T> {
      if (method === "Target.createTarget") {
        created = true;
        return { targetId: "version" } as T;
      }
      if (method === "Target.getTargets") return { targetInfos: [...work, ...more, home, other, page("ntp", "chrome://newtab", "New Tab", "work")] } as T;
      return {} as T;
    },
  };
  const contexts = await readLivePages(cdp);
  assert.equal(created, false);
  const listing = confirmOpenTabs({
    urls: {
      "Profile 2": [...work, ...more].map((tab) => tab.url).concat("https://closed.example/history"),
      Default: [home.url, "https://old.example/closed-tab"],
    },
    failed: {},
  }, { contexts });
  assert.deepEqual(listing.unmatched, { tabs: [{ title: "Other", host: "other.example.test" }], omitted: 0 });
  assert.equal(listing.byDirectory["Profile 2"]?.tabs.length, 10);
  assert.equal(listing.byDirectory["Profile 2"]?.omitted, 4);
  assert.equal(listing.byDirectory["Profile 2"]?.tabs[0]?.host, "robinhood.com");
  assert.equal(listing.byDirectory["Profile 2"]?.tabs[1]?.host, "complysci.com");
  assert.deepEqual(
    listing.byDirectory["Profile 2"]?.tabs.filter((tab) => tab.host === "docs.google.com").map((tab) => tab.title),
    ["Personal budget", "Work compliance"],
  );
  assert.equal(listing.byDirectory.Default?.tabs[0]?.title, "");
  assert.equal(listing.byDirectory.Default?.tabs[0]?.host, "mail.example.test");
  const packed = JSON.stringify(listing);
  assert.equal(packed.includes(secret), false);
  assert.equal(packed.includes("?"), false);
  assert.equal(packed.includes("closed.example"), false);
  assert.equal(packed.includes("old.example"), false);
  assert.equal(packed.includes("Closed history"), false);
  const text = agentProfileText(root, [
    { directory: "Default", name: "Alex", email: "alex@example.test" },
    { directory: "Profile 2", name: "Work", email: "" },
  ], "Profile 2", listing);
  assert.equal(JSON.stringify(text).includes(secret), false);
  assert.match(text, /"Robinhood" robinhood.com/);
  assert.match(text, /"Personal budget" docs.google.com/);
  assert.match(text, /"Work compliance" docs.google.com/);
  assert.match(text, /and 4 more/);
  assert.match(text, /picked in Bao Settings/);
  assert.match(text, /open in a profile Bao could not match: "Other" other.example.test/);
  assert.doesNotMatch(text, /no open tabs/);
  const asked = profileQuestionResult(new ChromeProfileQuestion(root, [
    { directory: "Default", name: "Alex", email: "alex@example.test" },
    { directory: "Profile 2", name: "Work", email: "" },
  ], "Profile 2").withListing(listing), { command: "open" }, false);
  const profiles = asked.structuredContent.profiles as { directory: string; tabs?: ProfileTab[]; tabsOmitted?: number }[];
  assert.equal(JSON.stringify(asked).includes(secret), false);
  assert.equal(profiles.find((profile) => profile.directory === "Profile 2")?.tabs?.[0]?.host, "robinhood.com");
  assert.equal(profiles.find((profile) => profile.directory === "Profile 2")?.tabsOmitted, 4);
  assert.deepEqual(asked.structuredContent.tabsUnmatched, listing.unmatched);
  assert.equal((asked.structuredContent.profiles as { directory: string; tabs?: ProfileTab[] }[]).some((profile) => profile.tabs?.some((tab) => tab.host === "other.example.test")), false);
});

test("a readable profile keeps its live tabs when another profile's session cannot be read", () => {
  const live: LivePage = { targetId: "rh", url: "https://robinhood.com/stocks", title: "Robinhood" };
  const savedOnly: LivePage = { targetId: "old", url: "https://closed.example/history", title: "Closed history" };
  const listing = confirmOpenTabs({
    urls: { Default: [live.url, savedOnly.url] },
    failed: { "Profile 2": "unreadable" },
  }, { contexts: [{ tabs: [live, savedOnly] }, { tabs: [{ targetId: "work", url: "https://complysci.com/home", title: "ComplySci" }] }] });
  assert.deepEqual(listing.byDirectory.Default?.tabs, [
    { title: "Robinhood", host: "robinhood.com" },
    { title: "Closed history", host: "closed.example" },
  ]);
  assert.equal(listing.byDirectory["Profile 2"], undefined);
  assert.equal(listing.unavailable?.["Profile 2"], "the session file could not be read");
  assert.deepEqual(listing.unmatched, { tabs: [{ title: "ComplySci", host: "complysci.com" }], omitted: 0 });
  const text = agentProfileText("/Chrome", [
    { directory: "Default", name: "Alex", email: "" },
    { directory: "Profile 2", name: "Work", email: "" },
  ], undefined, listing);
  assert.match(text, /"Robinhood" robinhood.com/);
  assert.match(text, /"Profile 2".*open tabs were not read \(the session file could not be read\)/);
  assert.match(text, /open in a profile Bao could not match: "ComplySci" complysci.com/);
  assert.doesNotMatch(text, /"Profile 2".*ComplySci/);
  const unread = confirmOpenTabs({
    urls: { Default: ["https://robinhood.com/stocks"] },
    failed: { "Profile 2": "denied" },
  }, { contexts: [], unread: "remote debugging is off" });
  assert.deepEqual(unread.byDirectory, {});
  assert.equal(JSON.stringify(unread).includes("robinhood.com"), false);
  const quiet = agentProfileText("/Chrome", [
    { directory: "Default", name: "Alex", email: "" },
    { directory: "Profile 2", name: "Work", email: "" },
  ], undefined, unread);
  assert.match(quiet, /"Default".*open tabs were not read \(remote debugging is off\)/);
  assert.match(quiet, /"Profile 2".*open tabs were not read \(Chrome's folder is not readable\)/);
  assert.doesNotMatch(quiet, /robinhood/);
});

test("a side panel is not an open tab and does not spoil a match", async () => {
  const stocks = page("rh", "https://robinhood.com/stocks", "Robinhood", "work");
  const comply = page("cs", "https://complysci.com/home", "ComplySci", "work");
  const panel = page("panel", "https://www.google.com/search?q=pizza", "Search side panel", "work");
  const lone = page("only", "https://robinhood.com/stocks", "Robinhood", "home");
  const cdp: TabSocket = {
    async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      if (method === "Target.getTargets") return { targetInfos: [stocks, comply, panel, lone] } as T;
      if (method === "Browser.getWindowForTarget") {
        if (params?.targetId === "panel") throw new Error("not a window tab");
        return { windowId: 1 } as T;
      }
      return {} as T;
    },
  };
  const contexts = await readLivePages(cdp);
  assert.equal(contexts.flatMap((context) => context.tabs).some((tab) => tab.targetId === "panel"), false);
  const both = confirmOpenTabs({
    urls: { Default: [stocks.url, comply.url] },
    failed: {},
  }, { contexts: [contexts[0]!] });
  assert.deepEqual(both.byDirectory.Default?.tabs.map((tab) => tab.host), ["robinhood.com", "complysci.com"]);
  assert.equal(JSON.stringify(both).includes("google.com"), false);
  const one = confirmOpenTabs({
    urls: { Default: [lone.url] },
    failed: {},
  }, { contexts: [contexts[1]!] });
  assert.deepEqual(one.byDirectory.Default?.tabs, [{ title: "Robinhood", host: "robinhood.com" }]);
  assert.equal(one.unmatched, undefined);
});

test("an equal overlap matches no profile", () => {
  const listing = confirmOpenTabs({
    urls: {
      Default: ["https://docs.google.com/document/budget"],
      "Profile 2": ["https://docs.google.com/document/budget"],
    },
    failed: {},
  }, { contexts: [{ tabs: [{ targetId: "doc", url: "https://docs.google.com/document/budget", title: "Budget" }] }] });
  assert.deepEqual(listing.byDirectory, {});
  assert.deepEqual(listing.unmatched, { tabs: [{ title: "Budget", host: "docs.google.com" }], omitted: 0 });
  const text = agentProfileText("/Chrome", [
    { directory: "Default", name: "Alex", email: "" },
    { directory: "Profile 2", name: "Work", email: "" },
  ], undefined, listing);
  assert.match(text, /open in a profile Bao could not match: "Budget" docs.google.com/);
  assert.doesNotMatch(text, /no open tabs/);
});

test("a partial or inexact overlap is not listed under a folder", () => {
  const mail = { targetId: "mail", url: "https://mail.google.com/mail/u/0/", title: "Inbox" };
  const stocks = { targetId: "rh", url: "https://robinhood.com/stocks", title: "Robinhood" };
  const wrong = confirmOpenTabs({
    urls: { "Profile 2": [mail.url] },
    failed: { Default: "unreadable" },
  }, { contexts: [{ tabs: [mail, stocks] }] });
  assert.equal(wrong.byDirectory["Profile 2"], undefined);
  assert.deepEqual(wrong.unmatched?.tabs.map((tab) => tab.host), ["mail.google.com", "robinhood.com"]);
  const text = agentProfileText("/Chrome", [
    { directory: "Default", name: "Alex", email: "" },
    { directory: "Profile 2", name: "Work", email: "" },
  ], undefined, wrong);
  assert.match(text, /open in a profile Bao could not match: "Inbox" mail.google.com; "Robinhood" robinhood.com/);
  assert.doesNotMatch(text, /no open tabs/);
  assert.doesNotMatch(text, /"Profile 2".*Robinhood/);
  const asked = profileQuestionResult(new ChromeProfileQuestion("/Chrome", [
    { directory: "Default", name: "Alex", email: "" },
    { directory: "Profile 2", name: "Work", email: "" },
  ], undefined).withListing(wrong), { command: "open" }, false);
  const profiles = asked.structuredContent.profiles as { tabs?: ProfileTab[] }[];
  assert.equal(profiles.every((profile) => profile.tabs === undefined), true);
  const slash = confirmOpenTabs({
    urls: { Default: ["https://robinhood.com/stocks/"] },
    failed: {},
  }, { contexts: [{ tabs: [stocks] }] });
  assert.equal(slash.byDirectory.Default, undefined);
  assert.equal(slash.unmatched?.tabs[0]?.host, "robinhood.com");
  const close = confirmOpenTabs({
    urls: {
      Default: ["https://a.example/1", "https://a.example/2", "https://a.example/3"],
      "Profile 2": ["https://a.example/1", "https://a.example/2"],
    },
    failed: {},
  }, { contexts: [{ tabs: [1, 2, 3, 4].map((n) => ({ targetId: String(n), url: `https://a.example/${n}`, title: `T${n}` })) }] });
  assert.deepEqual(close.byDirectory, {});
  assert.equal(close.unmatched?.tabs.length, 4);
  const clear = confirmOpenTabs({
    urls: { Default: ["https://a.example/1", "https://a.example/2", "https://a.example/3"], "Profile 2": [] },
    failed: {},
  }, { contexts: [{ tabs: [1, 2, 3].map((n) => ({ targetId: String(n), url: `https://a.example/${n}`, title: `T${n}` })) }] });
  assert.equal(clear.byDirectory.Default?.tabs.length, 3);
  assert.equal(clear.unmatched, undefined);
  const many = confirmOpenTabs({ urls: {}, failed: {} }, {
    contexts: [{ tabs: Array.from({ length: 12 }, (_, i) => ({ targetId: `u${i}`, url: `https://loose.example/${i}`, title: `Loose ${i}` })) }],
  });
  assert.equal(many.unmatched?.tabs.length, 10);
  assert.equal(many.unmatched?.omitted, 2);
  assert.deepEqual(many.byDirectory, {});
});

test("a hermetic run does not connect even when a port file names a listener", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-profile-tabs-"));
  const prior = process.env.BAO_LANE;
  process.env.BAO_LANE = "hermetic";
  try {
    await writeFile(path.join(root, "DevToolsActivePort"), "9333\n/devtools/browser/fixture\n");
    const started = Date.now();
    const listing = await readListeningProfileTabs(root);
    assert.equal(listing.unread, "remote debugging is off");
    assert.ok(Date.now() - started < 500, "a connect to the port file would take seconds");
  } finally {
    if (prior === undefined) delete process.env.BAO_LANE;
    else process.env.BAO_LANE = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test("a vanished listener is unread and does not start a debugging hold", async (t) => {
  quietAllow(t);
  const root = await mkdtemp(path.join(tmpdir(), "bao-profile-tabs-gone-"));
  const prior = process.env.BAO_LANE;
  const previousFixture = process.env.BAO_CHROME_HOLD_FIXTURE;
  const previousBrowser = process.env.BAO_TEST_BROWSER;
  try {
    delete process.env.BAO_LANE;
    process.env.BAO_TEST_BROWSER = process.execPath;
    process.env.BAO_CHROME_HOLD_FIXTURE = JSON.stringify({
      port: 1, browserPath: "/devtools/browser/gone", chromePid: process.pid, executable: process.execPath,
    });
    const started = Date.now();
    const listing = await listProfileTabs(root, ["Default"]);
    assert.equal(listing.unread, "remote debugging is off");
    assert.equal(listing.byDirectory.Default, undefined);
    assert.ok(Date.now() - started < 8_000, "a vanished listener must not wait for Chrome to be opened");
    await assert.rejects(readFile(path.join(holdDir(root), "hold.json"), "utf8"));
    await assert.rejects(readFile(path.join(holdDir(root), "starting.json"), "utf8"));
  } finally {
    if (prior === undefined) delete process.env.BAO_LANE;
    else process.env.BAO_LANE = prior;
    if (previousFixture === undefined) delete process.env.BAO_CHROME_HOLD_FIXTURE;
    else process.env.BAO_CHROME_HOLD_FIXTURE = previousFixture;
    if (previousBrowser === undefined) delete process.env.BAO_TEST_BROWSER;
    else process.env.BAO_TEST_BROWSER = previousBrowser;
    await rm(root, { recursive: true, force: true });
  }
});

test("an endpoint that demands Allow is read through that press and starts no hold", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-profile-tabs-allow-"));
  const gate = await allowGate();
  const presses: string[][] = [];
  t.mock.method(chromeAx, "chromeHelper", () => ({
    exec: async (args: string[]) => {
      presses.push(args);
      if (args[0] === "debug-allow" && args.includes("--press")) {
        gate.release();
        return { ok: true, found: true, pressed: true };
      }
      return { ok: true, found: false, pressed: false };
    },
  }) as unknown as ReturnType<typeof chromeAx.chromeHelper>);
  const prior = process.env.BAO_LANE;
  const previousFixture = process.env.BAO_CHROME_HOLD_FIXTURE;
  const previousBrowser = process.env.BAO_TEST_BROWSER;
  try {
    delete process.env.BAO_LANE;
    process.env.BAO_TEST_BROWSER = process.execPath;
    process.env.BAO_CHROME_HOLD_FIXTURE = JSON.stringify({
      port: gate.port, browserPath: gate.browserPath, chromePid: process.pid, executable: process.execPath,
    });
    const listing = await listProfileTabs(root, ["Default"]);
    assert.equal(listing.unread, undefined);
    assert.deepEqual(listing.unmatched?.tabs, [{ title: "Robinhood", host: "robinhood.com" }]);
    assert.equal(presses.some((args) => args[0] === "debug-allow" && args.includes("--press") && args.includes(String(process.pid))), true);
    await assert.rejects(readFile(path.join(holdDir(root), "hold.json"), "utf8"));
    await assert.rejects(readFile(path.join(holdDir(root), "starting.json"), "utf8"));
  } finally {
    if (prior === undefined) delete process.env.BAO_LANE;
    else process.env.BAO_LANE = prior;
    if (previousFixture === undefined) delete process.env.BAO_CHROME_HOLD_FIXTURE;
    else process.env.BAO_CHROME_HOLD_FIXTURE = previousFixture;
    if (previousBrowser === undefined) delete process.env.BAO_TEST_BROWSER;
    else process.env.BAO_TEST_BROWSER = previousBrowser;
    await gate.close();
    await rm(holdDir(root), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("a fixture browser is read from the listener that is already up", { timeout: 60_000 }, async (t) => {
  quietAllow(t);
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
  const previousFixture = process.env.BAO_CHROME_HOLD_FIXTURE;
  const previousBrowser = process.env.BAO_TEST_BROWSER;
  try {
    const endpoint = await waitForEndpoint(path.join(root, "DevToolsActivePort"));
    const opened = await connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 5000 });
    await opened.send("Target.createTarget", { url: `http://127.0.0.1:${pagePort}/stocks?code=${secret}` });
    await waitForHost(opened, "127.0.0.1");
    opened.close();
    assert.equal(opened.isOpen, false);
    await waitForSavedUrl(path.join(root, "Default", "Sessions"), `http://127.0.0.1:${pagePort}/stocks?code=${secret}`);
    delete process.env.BAO_LANE;
    if (!child.pid) throw new Error("fixture Chrome has no pid");
    process.env.BAO_TEST_BROWSER = exe;
    process.env.BAO_CHROME_HOLD_FIXTURE = JSON.stringify({
      port: endpoint.port, browserPath: endpoint.browserPath, chromePid: child.pid, executable: exe,
    });
    await chmod(path.join(root, "DevToolsActivePort"), 0);
    const listing = await listProfileTabs(root, ["Default", "Profile 2"]);
    const packed = JSON.stringify(listing);
    assert.equal(listing.unread, undefined, packed);
    assert.equal(packed.includes(secret), false, packed);
    assert.equal(packed.includes("?"), false, packed);
    assert.deepEqual(listing.byDirectory.Default?.tabs.map((tab) => tab.host), ["127.0.0.1"]);
    assert.equal(listing.unavailable?.["Profile 2"], "no session file");
    assert.equal(listing.byDirectory["Profile 2"], undefined);
    await assert.rejects(readFile(path.join(holdDir(root), "hold.json"), "utf8"));
    await assert.rejects(readFile(path.join(holdDir(root), "starting.json"), "utf8"));
    const again = await connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 5000 });
    const { targetInfos } = await again.send<{ targetInfos: { url?: string }[] }>("Target.getTargets", {}, undefined, 2000);
    assert.equal(targetInfos.some((target) => target.url?.startsWith("chrome://version")), false);
    again.close();
    assert.equal(again.isOpen, false);
  } finally {
    if (prior === undefined) delete process.env.BAO_LANE;
    else process.env.BAO_LANE = prior;
    if (previousFixture === undefined) delete process.env.BAO_CHROME_HOLD_FIXTURE;
    else process.env.BAO_CHROME_HOLD_FIXTURE = previousFixture;
    if (previousBrowser === undefined) delete process.env.BAO_TEST_BROWSER;
    else process.env.BAO_TEST_BROWSER = previousBrowser;
    await chmod(path.join(root, "DevToolsActivePort"), 0o600).catch(() => undefined);
    await stopHold(holdDir(root));
    await rm(holdDir(root), { recursive: true, force: true });
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve(undefined);
      else child.once("exit", () => resolve(undefined));
    });
    child.kill("SIGKILL");
    await exited;
    page.close();
    await rm(root, { recursive: true, force: true });
  }
});

function quietAllow(t: { mock: { method: typeof test.mock.method } }): void {
  t.mock.method(chromeAx, "chromeHelper", () => ({
    exec: async () => ({ ok: true, found: false, pressed: false }),
  }) as unknown as ReturnType<typeof chromeAx.chromeHelper>);
}

function allowGate(): Promise<{ port: number; browserPath: string; release: () => void; close: () => Promise<void> }> {
  const browserPath = "/devtools/browser/allow-gate";
  let release = (): void => undefined;
  const opened = new Promise<void>((resolve) => { release = resolve; });
  const server = createNetServer((socket) => armAllowSocket(socket, opened));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        browserPath,
        release,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function armAllowSocket(socket: Socket, opened: Promise<void>): void {
  let buf = Buffer.alloc(0);
  let http = true;
  const decoder = new ServerFrameDecoder();
  socket.on("data", (chunk) => {
    if (http) {
      buf = Buffer.concat([buf, chunk]);
      if (!buf.includes("\r\n\r\n")) return;
      http = false;
      void opened.then(() => {
        if (!socket.destroyed) socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      });
      return;
    }
    for (const frame of decoder.push(chunk)) {
      if (frame.opcode !== 1 || !frame.text) continue;
      let message: { id?: unknown; method?: unknown };
      try { message = JSON.parse(frame.text) as typeof message; }
      catch { continue; }
      if (typeof message.id !== "number") continue;
      const result = message.method === "Target.getTargets"
        ? { targetInfos: [{ targetId: "tab", type: "page", url: "https://robinhood.com/stocks", title: "Robinhood" }] }
        : { windowId: 1 };
      const payload = Buffer.from(JSON.stringify({ id: message.id, result }));
      const header = Buffer.alloc(2);
      header[0] = 0x81;
      header[1] = payload.length;
      socket.write(Buffer.concat([header, payload]));
    }
  });
}

async function stopHold(dir: string): Promise<void> {
  try {
    const record = JSON.parse(await readFile(path.join(dir, "hold.json"), "utf8")) as { holderPid?: number };
    if (record.holderPid && record.holderPid !== process.pid) process.kill(record.holderPid, "SIGTERM");
  } catch { /* the hold already ended */ }
}

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

function pruneCommand(tab: number, index: number, count: number): Buffer {
  const payload = Buffer.alloc(12);
  payload.writeUInt32LE(tab, 0);
  payload.writeInt32LE(index, 4);
  payload.writeInt32LE(count, 8);
  return snssCommand(24, payload);
}

function navigationCommand(tab: number, url: string, title: string, index = 0, id = 6): Buffer {
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
  return snssCommand(id, payload);
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
  const header = Buffer.alloc(8);
  header.write("SNSS", 0, "latin1");
  header.writeUInt32LE(1, 4);
  assert.equal(openTabsFromSnss(header), undefined);
  assert.deepEqual(openTabsFromSnss(snssFile(navigationCommand(4, "https://tabs.example/closed", "Tabs archive", 0, 1))), []);
  const pruned = Buffer.alloc(8);
  pruned.writeUInt32LE(5, 0);
  pruned.writeInt32LE(0, 4);
  const afterPrune = openTabsFromSnss(snssFile(
    navigationCommand(5, "https://a.example/old", "Old", 0),
    navigationCommand(5, "https://b.example/now", "Now", 1),
    navigationCommand(5, "https://c.example/later", "Later", 2),
    pruneCommand(5, 0, 1),
    snssCommand(7, pruned),
  ));
  assert.deepEqual(afterPrune, [{ url: "https://b.example/now", title: "Now" }]);
  const stillOnNow = Buffer.alloc(8);
  stillOnNow.writeUInt32LE(6, 0);
  stillOnNow.writeInt32LE(1, 4);
  assert.deepEqual(openTabsFromSnss(snssFile(
    navigationCommand(6, "https://a.example/old", "Old", 0),
    navigationCommand(6, "https://b.example/now", "Now", 1),
    navigationCommand(6, "https://c.example/later", "Later", 2),
    snssCommand(7, stillOnNow),
    pruneCommand(6, 0, 1),
  )), [{ url: "https://b.example/now", title: "Now" }]);
  const missing = Buffer.alloc(8);
  missing.writeUInt32LE(7, 0);
  missing.writeInt32LE(1, 4);
  assert.deepEqual(openTabsFromSnss(snssFile(
    navigationCommand(7, "https://a.example/old", "Old", 0),
    snssCommand(7, missing),
  )), []);
  const selected = Buffer.alloc(8);
  selected.writeUInt32LE(8, 0);
  selected.writeInt32LE(0, 4);
  assert.deepEqual(openTabsFromSnss(snssFile(
    navigationCommand(8, "https://a.example/", "Old", 0),
    navigationCommand(8, "about:blank", "Blank", 0),
    snssCommand(7, selected),
  )), []);
  const root = await mkdtemp(path.join(tmpdir(), "bao-snss-synthetic-"));
  try {
    const sessions = path.join(root, "Default", "Sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(path.join(sessions, "Session_1"), snssFile(gone, kept, snssCommand(16, closed)));
    await writeFile(path.join(sessions, "Tabs_9"), snssFile(navigationCommand(9, "https://tabs.example/closed", "Tabs archive")));
    await writeFile(path.join(root, "Default", "Current Session"), snssFile(navigationCommand(8, "https://legacy.example/old", "Legacy")));
    await mkdir(path.join(root, "Profile 2"), { recursive: true });
    await writeFile(path.join(root, "Profile 2", "Current Tabs"), snssFile(navigationCommand(7, "https://legacy.example/tabs", "Legacy tabs")));
    const saved = await readSavedProfileTabs(root, ["Default", "Profile 2"]);
    assert.deepEqual(saved.urls.Default, [`https://complysci.com/home?id=${secret}`]);
    assert.equal(saved.failed["Profile 2"], "absent");
    assert.equal(JSON.stringify(saved).includes("tabs.example"), false);
    assert.equal(JSON.stringify(saved).includes("legacy.example"), false);
    const listing = await listProfileTabs(root, ["Default", "Profile 2"]);
    const packed = JSON.stringify(listing);
    assert.equal(packed.includes(secret), false, packed);
    assert.equal(packed.includes("ComplySci"), false, packed);
    assert.equal(packed.includes("tabs.example"), false, packed);
    assert.equal(listing.unread, "remote debugging is off");
    assert.deepEqual(listing.byDirectory, {});
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
    const saved = await readSavedProfileTabs(root, ["Default", "Profile 2"]);
    const url = saved.urls.Default?.find((item) => item.includes(`127.0.0.1:${pagePort}/`));
    assert.equal(typeof url, "string");
    const listing = confirmOpenTabs(saved, {
      contexts: [{ tabs: [{ targetId: "live", url: url!, title: "Robinhood" }] }],
    });
    const packed = JSON.stringify(listing);
    assert.equal(packed.includes(secret), false, packed);
    assert.equal(packed.includes("?"), false, packed);
    assert.deepEqual(listing.byDirectory.Default?.tabs, [{ title: "Robinhood", host: "127.0.0.1" }]);
    assert.equal(listing.byDirectory["Profile 2"], undefined);
    process.env.BAO_LANE = "hermetic";
    const closed = await listProfileTabs(root, ["Default", "Profile 2"]);
    const closedPacked = JSON.stringify(closed);
    assert.equal(closed.unread, "remote debugging is off");
    assert.equal(closedPacked.includes(secret), false, closedPacked);
    assert.equal(closedPacked.includes("Robinhood"), false, closedPacked);
    assert.equal(closedPacked.includes("ComplySci"), false, closedPacked);
    assert.deepEqual(closed.byDirectory, {});
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
    const sessions = path.join(root, "Profile 2", "Sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(path.join(sessions, "Session_1"), snssFile(navigationCommand(1, "https://robinhood.com/stocks", "Robinhood")));
    const saved = await readSavedProfileTabs(root, ["Default", "Profile 2"]);
    assert.equal(saved.failed.Default, "denied");
    assert.deepEqual(saved.urls["Profile 2"], ["https://robinhood.com/stocks"]);
    const matched = confirmOpenTabs(saved, {
      contexts: [{ tabs: [{ targetId: "live", url: "https://robinhood.com/stocks", title: "Robinhood" }] }],
    });
    assert.deepEqual(matched.byDirectory["Profile 2"]?.tabs, [{ title: "Robinhood", host: "robinhood.com" }]);
    assert.equal(matched.unavailable?.Default, "Chrome's folder is not readable");
    process.env.BAO_LANE = "hermetic";
    const listing = await listProfileTabs(root, ["Default", "Profile 2"]);
    assert.equal(listing.unread, "remote debugging is off");
    assert.equal(listing.unavailable?.Default, "Chrome's folder is not readable");
    assert.equal(listing.byDirectory.Default, undefined);
    assert.equal(listing.byDirectory["Profile 2"], undefined);
    assert.equal(JSON.stringify(listing).includes("robinhood"), false);
    const text = agentProfileText(root, [
      { directory: "Default", name: "Home", email: "" },
      { directory: "Profile 2", name: "Work", email: "" },
    ], undefined, listing);
    assert.match(text, /"Profile 2".*open tabs were not read \(remote debugging is off\)/);
    assert.match(text, /"Default".*open tabs were not read \(Chrome's folder is not readable\)/);
    assert.doesNotMatch(text, /robinhood/);
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
