// A live session with no port file from the agent. The browser is the pinned
// test Chromium on a temp profile, serving the Instacart fixture. BaoOSHelper and
// Chrome's profile-window handoff are fakes, so nothing touches the daily Chrome.

import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before, describe, it } from "node:test";
import { startApp } from "../../src/app/server";
import { ALLOW_BUTTON } from "../../src/cdp-live/consent";
import { DEVTOOLS_ACTIVE_PORT, readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { createLiveHost } from "../../src/cdp-live/live-host";
import { LIVE_TOOLS, type LiveIdleWarning } from "../../src/cdp-live/live-ops";
import {
  asksToAllow,
  chromeExecutable,
  DAILY_PROFILE,
  parseLiveTarget,
  profileWindowArgs,
  profileWindowUrl,
  targetForPortFile,
  type ProfileWindowAsk,
} from "../../src/cdp-live/live-target";
import { presetForUrl } from "../../src/cdp-live/presets";
import { connectCdp } from "../../src/cdp-live/socket";
import { frameRpc } from "../../src/mcp/frame";
import { liveCliBody } from "../../src/mcp/live-proxy";
import { Library } from "../../src/v1/store";
import { launchFixtureBrowser, type FixtureBrowser } from "../instacart/browser";
import { startInstacartFixture, type InstacartFixture } from "../instacart/fixture";
import { fakeChromeHelper } from "../fake-helper";
import { applyHermeticApp } from "../runtime";

interface LiveBody {
  outcome?: { kind?: string; reason?: string };
  session?: string;
  view?: {
    controls: { ref: string; label: string; kind: string }[];
    stopBeforeConfirm: { label: string }[];
  } | null;
}

const BAO_PROFILE = "/tmp/bao-home/chrome-profile";

test("the live target defaults to the daily Chrome's Default profile, and bao and throwaway name their own port file", () => {
  const daily = { kind: "daily", portFile: DEVTOOLS_ACTIVE_PORT, profile: DAILY_PROFILE };
  assert.equal(DAILY_PROFILE, "Default");
  assert.deepEqual(parseLiveTarget(undefined, BAO_PROFILE), daily);
  assert.deepEqual(parseLiveTarget("", BAO_PROFILE), daily);
  assert.deepEqual(parseLiveTarget("daily", BAO_PROFILE), daily);
  assert.deepEqual(parseLiveTarget("daily:Profile 2", BAO_PROFILE), { ...daily, profile: "Profile 2" });
  assert.deepEqual(parseLiveTarget("bao", BAO_PROFILE), { kind: "bao", portFile: path.join(BAO_PROFILE, "DevToolsActivePort") });
  assert.deepEqual(
    parseLiveTarget("throwaway:/tmp/t/chrome/DevToolsActivePort", BAO_PROFILE),
    { kind: "throwaway", portFile: "/tmp/t/chrome/DevToolsActivePort" },
  );
  assert.throws(() => parseLiveTarget("throwaway:chrome/DevToolsActivePort", BAO_PROFILE), /absolute DevToolsActivePort/);
  assert.throws(() => parseLiveTarget("throwaway:/tmp/t/chrome/Default/Cookies", BAO_PROFILE), /absolute DevToolsActivePort/);
  assert.throws(() => parseLiveTarget("daily:../Other", BAO_PROFILE), /profile directory/);
  assert.throws(() => parseLiveTarget("daily:", BAO_PROFILE), /profile directory/);
  assert.throws(() => parseLiveTarget("chrome", BAO_PROFILE), /unknown live target chrome/);

  const bao = parseLiveTarget("bao", BAO_PROFILE);
  const profile2 = parseLiveTarget("daily:Profile 2", BAO_PROFILE);
  assert.deepEqual(targetForPortFile(DEVTOOLS_ACTIVE_PORT, bao), daily);
  assert.deepEqual(targetForPortFile(DEVTOOLS_ACTIVE_PORT, profile2), profile2);
  assert.deepEqual(targetForPortFile(bao.portFile, profile2), { kind: "throwaway", portFile: bao.portFile });
  assert.deepEqual(targetForPortFile("/tmp/t/chrome/DevToolsActivePort", bao), { kind: "throwaway", portFile: "/tmp/t/chrome/DevToolsActivePort" });
  assert.throws(() => targetForPortFile("DevToolsActivePort", bao), /absolute DevToolsActivePort/);

  assert.equal(asksToAllow(parseLiveTarget("daily", BAO_PROFILE)), true);
  assert.equal(asksToAllow(parseLiveTarget("bao", BAO_PROFILE)), false);
  assert.equal(asksToAllow(parseLiveTarget("throwaway:/tmp/t/DevToolsActivePort", BAO_PROFILE)), false);
});

test("a known host keeps its own preset, so www.instacart.com cannot fall back to generic", () => {
  assert.equal(presetForUrl("https://www.instacart.com/store/costco/storefront"), "instacart");
  assert.equal(presetForUrl("https://www.instacart.com/store/costco/storefront", "generic"), "instacart");
  assert.equal(presetForUrl("https://instacart.com/", "books"), "instacart");
  assert.equal(presetForUrl("https://books.toscrape.com/", "generic"), "books");
  assert.equal(presetForUrl("https://shop.example/"), "generic");
  assert.equal(presetForUrl("https://shop.example/", "instacart"), "instacart");
  assert.equal(presetForUrl("https://www.instacart.com/", "nope"), null);
});

test("an agent starts a session with only an intent and a url", () => {
  const start = LIVE_TOOLS.find((tool) => tool.name === "live_session_start");
  assert.deepEqual(start?.inputSchema.required, ["intent", "url"]);
  const body = liveCliBody("live_session_start", ["--intent", "Shop", "--url", "https://www.instacart.com/"]);
  assert.equal(body.portFile, "");
  assert.equal(body.preset, "");
});

test("the daily Chrome's window comes from Chrome's own binary, in the named profile", () => {
  const url = profileWindowUrl("abc123");
  assert.match(url, /^data:text\/html,.*bao-live-abc123/);
  const userDataDir = "/Users/someone/Library/Application Support/Google/Chrome";
  assert.deepEqual(profileWindowArgs({ userDataDir, profile: "Default", url }), [
    `--user-data-dir=${userDataDir}`,
    "--profile-directory=Default",
    "--new-window",
    url,
  ]);
});

async function until<T>(read: () => T | undefined, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function savedWorkflow(home: string, id: string) {
  try {
    return new Library(home).read(id);
  } catch {
    return undefined;
  }
}

function sessionRecord(home: string): { status?: string; note?: string } {
  return JSON.parse(readFileSync(path.join(home, "live-session", "session.json"), "utf8")) as { status?: string; note?: string };
}

function labels(body: LiveBody): string[] {
  return (body.view?.controls || []).map((item) => item.label);
}

function stops(body: LiveBody): string[] {
  return (body.view?.stopBeforeConfirm || []).map((item) => item.label);
}

describe("a live session with no port file from the agent", { timeout: 180_000 }, () => {
  let fixture: InstacartFixture;
  let browser: FixtureBrowser;

  before(async () => {
    fixture = await startInstacartFixture();
    browser = await launchFixtureBrowser(fixture);
  });

  after(async () => {
    await browser?.close();
    await fixture?.close();
  });

  it("drives a throwaway Chrome with no helper call, on the instacart preset, and saves after the agent goes quiet", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "bao-live-target-"));
    const lockFile = path.join(home, "lock");
    const ax = fakeChromeHelper();
    const host = createLiveHost({
      home,
      lockFile,
      target: { kind: "throwaway", portFile: browser.portFile },
      helper: () => ax.helper,
      openProfile: async () => {
        throw new Error("a throwaway Chrome has no profile window");
      },
      idleMs: 600,
    });
    try {
      const started = await host.call({
        op: "live_session_start",
        intent: "Put costco blueberries in the cart",
        url: fixture.url("/store/costco/storefront"),
      }) as LiveBody;
      assert.equal(started.outcome?.kind, "applied", JSON.stringify(started.outcome));
      assert.deepEqual(ax.calls, []);
      assert.equal(host.isOpen(), true);
      assert.equal(labels(started).includes("Checkout"), false);
      assert.ok(stops(started).includes("Checkout"), stops(started).join(", "));
      assert.ok(stops(started).includes("Try Instacart+ free"), stops(started).join(", "));
      const search = started.view?.controls.find((item) => item.label === "Search Costco");
      assert.ok(search, labels(started).join(", "));
      const typed = await host.call({ op: "live_type", ref: search.ref, text: "blueberries" }) as LiveBody;
      assert.equal(typed.outcome?.kind, "applied", JSON.stringify(typed.outcome));

      const id = started.session || "";
      const workflow = await until(() => savedWorkflow(home, id), "the idle save");
      assert.equal(workflow.driver, "cdp-live");
      assert.equal(workflow.steps.some((step) => step.action === "type"), true);
      // The workflow is written before the session record, so wait for the record too.
      const record = await until(() => {
        const read = sessionRecord(home);
        return read.status === "running" ? undefined : read;
      }, "the session record");
      assert.equal(record.status, "passed");
      assert.equal(record.note, "Saved after the agent went quiet.");
      await until(() => (existsSync(lockFile) ? undefined : true), "the lock release");
      assert.equal(host.isOpen(), false);
      const late = await host.call({ op: "live_snapshot" }) as LiveBody;
      assert.equal(late.outcome?.kind, "rejected");
    } finally {
      await host.close();
    }
  });

  it("warns before the idle save, and a person who is away still gets the save", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "bao-live-warn-"));
    const lockFile = path.join(home, "lock");
    const seen: { at: number; warning: LiveIdleWarning | null }[] = [];
    const host = createLiveHost({
      home,
      lockFile,
      target: { kind: "throwaway", portFile: browser.portFile },
      openProfile: async () => undefined,
      idleMs: 3_000,
      idleWarnMs: 2_000,
      onIdleWarn: (warning) => seen.push({ at: Date.now(), warning }),
    });
    try {
      const started = await host.call({ op: "live_session_start", intent: "Put costco blueberries in the cart", url: fixture.url("/store/costco/storefront") }) as LiveBody;
      assert.equal(started.outcome?.kind, "applied", JSON.stringify(started.outcome));
      const search = started.view?.controls.find((item) => item.label === "Search Costco");
      assert.ok(search, labels(started).join(", "));
      assert.equal((await host.call({ op: "live_type", ref: search.ref, text: "blueberries" }) as LiveBody).outcome?.kind, "applied");
      const quietFrom = Date.now();

      const record = await until(() => {
        const read = sessionRecord(home);
        return read.status === "running" ? undefined : read;
      }, "the idle save");
      assert.equal(record.status, "passed");
      assert.equal(record.note, "Saved after the agent went quiet.");
      assert.deepEqual(seen.map((item) => item.warning === null), [false, true], "one warning, then the save clears it");
      const [warned, cleared] = seen;
      assert.equal(warned?.warning?.session, started.session);
      assert.equal(warned?.warning?.host, "www.instacart.com");
      assert.ok((warned?.at || 0) - quietFrom >= 1_000 - 50, "the warning waits until two seconds before the save");
      assert.ok((warned?.warning?.saveAt || 0) - (warned?.at || 0) <= 2_000 + 50, "saveAt is the lead time away");
      assert.ok((cleared?.at || 0) >= (warned?.warning?.saveAt || 0) - 50, "the save comes at saveAt, not sooner");
      assert.ok(savedWorkflow(home, started.session || ""), "the away person still gets the saved workflow");
      assert.equal(await host.keepOpen(), false, "Keep open after the save says the session is gone");
    } finally {
      await host.close();
    }
  });

  it("keeps a busy session quiet, and Keep open restarts the idle wait", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "bao-live-keep-"));
    const seen: { at: number; warning: LiveIdleWarning | null }[] = [];
    const host = createLiveHost({
      home,
      lockFile: path.join(home, "lock"),
      target: { kind: "throwaway", portFile: browser.portFile },
      openProfile: async () => undefined,
      idleMs: 4_000,
      idleWarnMs: 2_000,
      onIdleWarn: (warning) => seen.push({ at: Date.now(), warning }),
    });
    try {
      const started = await host.call({ op: "live_session_start", intent: "Shop", url: fixture.url("/store/costco/storefront") }) as LiveBody;
      assert.equal(started.outcome?.kind, "applied", JSON.stringify(started.outcome));
      // An agent that keeps calling for longer than the warning delay never sees a warning.
      const busyUntil = Date.now() + 3_000;
      while (Date.now() < busyUntil) {
        assert.equal((await host.call({ op: "live_snapshot", page: 1 }) as LiveBody).outcome?.kind, "applied");
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.equal(seen.length, 0, "no warning while the agent calls");

      const first = await until(() => seen[0]?.warning || undefined, "the warning");
      assert.equal(await host.keepOpen(), true);
      const keptAt = Date.now();
      assert.equal(seen[1]?.warning, null, "Keep open clears the warning");
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, first.saveAt + 1_000 - Date.now())));
      assert.equal(sessionRecord(home).status, "running", "the session is open past the first saveAt");
      const second = await until(() => seen[2]?.warning || undefined, "the next warning");
      assert.ok(second.saveAt >= keptAt + 4_000 - 50, "the next save is a full idle wait after Keep open");
      assert.equal((await host.call({ op: "live_stop" }) as LiveBody).outcome?.kind, "stopped");
      assert.equal(seen.at(-1)?.warning, null, "a call clears the warning");
    } finally {
      await host.close();
    }
  });

  it("the app posts the idle warning, shows it in the window state, and Keep open clears it", async () => {
    const dirs = applyHermeticApp("live-idle");
    // Stands in for Bao.app's notifier socket. Darwin posts through it; other systems use notify-send.
    const posts: { cmd?: string; title?: string }[] = [];
    const notifier = createServer((conn) => {
      let buf = "";
      conn.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        posts.push(JSON.parse(buf.slice(0, nl)) as { cmd?: string; title?: string });
        conn.end(`${JSON.stringify({ ok: true, authorization: "authorized", delivered: true })}\n`);
      });
    });
    const sock = path.join(mkdtempSync(path.join(tmpdir(), "bao-ns-")), "n.sock");
    await new Promise<void>((resolve) => notifier.listen(sock, resolve));
    process.env.BAO_NOTIFY_SOCK = sock;
    const app = await startApp({
      home: dirs.home,
      port: 0,
      liveTarget: `throwaway:${browser.portFile}`,
      liveLockFile: path.join(dirs.home, "live.lock"),
      liveIdleMs: 6_000,
      liveIdleWarnMs: 4_000,
    });
    const base = `http://127.0.0.1:${app.port}`;
    type State = { liveIdle?: LiveIdleWarning | null; liveSessionOpen?: boolean; notifications?: { title: string }[] };
    const state = async () => await (await fetch(`${base}/api/state`)).json() as State;
    const live = async (body: Record<string, unknown>) => await (await fetch(`${base}/api/live`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })).json() as LiveBody;
    const keep = async () => await (await fetch(`${base}/api/live/keep`, { method: "POST" })).json() as { open?: boolean };
    try {
      assert.equal((await state()).liveSessionOpen, false);
      const started = await live({ op: "live_session_start", intent: "Shop", url: fixture.url("/store/costco/storefront") });
      assert.equal(started.outcome?.kind, "applied", JSON.stringify(started.outcome));
      assert.equal((await state()).liveSessionOpen, true);
      assert.equal((await state()).liveIdle, null);
      let warned: State = {};
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        warned = await state();
        if (warned.liveIdle) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(warned.liveIdle?.host, "www.instacart.com");
      assert.equal(warned.liveIdle?.session, started.session);
      const posted = /^Press Keep open in the Bao window to keep the live session on www\.instacart\.com\. Waiting \d+:\d\d · times out at /;
      assert.match(warned.notifications?.at(-1)?.title || "", posted);

      const refused = await fetch(`${base}/api/live/keep`, { method: "POST", headers: { origin: "https://evil.example" } });
      assert.equal(refused.status, 403);
      assert.ok((await state()).liveIdle, "a page on another origin cannot keep the session open");

      assert.deepEqual(await keep(), { open: true });
      assert.equal((await state()).liveIdle, null);
      if (process.platform === "darwin") {
        await until(() => (posts.length >= 2 ? true : undefined), "the notifier clear");
        assert.deepEqual(posts.map((post) => post.cmd), ["act", "clear"]);
        assert.match(posts[0]?.title || "", posted);
      }
      assert.equal((await live({ op: "live_stop" })).outcome?.kind, "stopped");
      assert.deepEqual(await keep(), { open: false });
      assert.equal((await state()).liveSessionOpen, false);
    } finally {
      await app.close();
      delete process.env.BAO_NOTIFY_SOCK;
      notifier.close();
    }
  });

  it("presses Allow through the helper on the daily Chrome and drives only the window it asked the Default profile for", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "bao-live-daily-"));
    const ax = fakeChromeHelper();
    const endpoint = await readDevToolsActivePort(browser.portFile);
    const side = await connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 10_000 });
    const asks: ProfileWindowAsk[] = [];
    const made: string[] = [];
    const host = createLiveHost({
      home,
      lockFile: path.join(home, "lock"),
      target: { kind: "daily", portFile: browser.portFile, profile: DAILY_PROFILE },
      helper: () => ax.helper,
      // Stands in for the running Chrome taking the profile-window command line.
      openProfile: async (ask) => {
        asks.push(ask);
        const created = await side.send<{ targetId?: string }>("Target.createTarget", { url: ask.url, newWindow: true });
        made.push(created.targetId || "");
      },
    });
    try {
      const started = await host.call({
        op: "live_session_start",
        intent: "Shop",
        url: fixture.url("/store/costco/storefront"),
        preset: "generic",
      }) as LiveBody;
      assert.equal(started.outcome?.kind, "applied", JSON.stringify(started.outcome));
      assert.deepEqual(ax.calls, ["permissions false", "nodes", "nodes", `press AXButton ${ALLOW_BUTTON}`]);
      assert.match(readFileSync(path.join(home, "live-session", "ax.jsonl"), "utf8"), /"what":"AXPress","role":"AXButton","name":"Allow"/);
      assert.ok(stops(started).includes("Checkout"), "an explicit generic preset still gets the instacart guards");

      assert.equal(asks.length, 1);
      assert.equal(asks[0]?.profile, "Default");
      assert.equal(asks[0]?.userDataDir, browser.userDataDir);
      assert.equal(asks[0]?.pid, browser.pid);
      assert.match(asks[0]?.url || "", /bao-live-[0-9a-f]{16}/);
      assert.equal(await chromeExecutable(browser.pid), browser.executable);
      const listed = await side.send<{ targetInfos?: { targetId?: string; type?: string; url?: string }[] }>("Target.getTargets");
      const driven = (listed.targetInfos || []).filter((info) => info.type === "page" && (info.url || "").startsWith(fixture.url("/store/")));
      assert.deepEqual(driven.map((info) => info.targetId), [made[0]]);
      const stopped = await host.call({ op: "live_stop" }) as LiveBody;
      assert.equal(stopped.outcome?.kind, "stopped");
    } finally {
      await host.close();
      side.close();
    }
  });

  it("refuses the daily Chrome before connecting when BaoOSHelper has no Accessibility grant", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "bao-live-grant-"));
    const ax = fakeChromeHelper({ accessibility: false });
    const asks: ProfileWindowAsk[] = [];
    const host = createLiveHost({
      home,
      lockFile: path.join(home, "lock"),
      target: { kind: "daily", portFile: browser.portFile, profile: DAILY_PROFILE },
      helper: () => ax.helper,
      openProfile: async (ask) => {
        asks.push(ask);
      },
    });
    try {
      const started = await host.call({ op: "live_session_start", intent: "Shop", url: fixture.url("/store/costco/storefront") }) as LiveBody;
      assert.equal(started.outcome?.kind, "rejected");
      assert.equal(started.outcome?.reason, "BaoOSHelper accessibility is not granted");
      assert.deepEqual(ax.calls, ["permissions false"]);
      assert.deepEqual(asks, []);
      assert.equal(existsSync(path.join(home, "lock")), false);
    } finally {
      await host.close();
    }
  });

  it("refuses a daily profile that does not exist before reading the grant or opening a window", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "bao-live-noprofile-"));
    const ax = fakeChromeHelper();
    const asks: ProfileWindowAsk[] = [];
    const host = createLiveHost({
      home,
      lockFile: path.join(home, "lock"),
      target: { kind: "daily", portFile: browser.portFile, profile: "Profile 3" },
      helper: () => ax.helper,
      openProfile: async (ask) => {
        asks.push(ask);
      },
    });
    try {
      const started = await host.call({ op: "live_session_start", intent: "Shop", url: fixture.url("/store/costco/storefront") }) as LiveBody;
      assert.equal(started.outcome?.kind, "rejected");
      assert.equal(
        started.outcome?.reason,
        `Chrome profile Profile 3 does not exist in ${browser.userDataDir}. Profiles there: Default`,
      );
      assert.deepEqual(ax.calls, []);
      assert.deepEqual(asks, []);
      assert.equal(existsSync(path.join(browser.userDataDir, "Profile 3")), false);
      assert.equal(existsSync(path.join(home, "lock")), false);
    } finally {
      await host.close();
    }
  });

  it("accepts a daily profile folder with a name Chrome's own UI does not make", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "bao-live-custom-profile-"));
    const work = path.join(browser.userDataDir, "Work");
    mkdirSync(work);
    const ax = fakeChromeHelper({ accessibility: false });
    const host = createLiveHost({
      home,
      lockFile: path.join(home, "lock"),
      target: { kind: "daily", portFile: browser.portFile, profile: "Work" },
      helper: () => ax.helper,
      openProfile: async () => undefined,
    });
    try {
      const started = await host.call({ op: "live_session_start", intent: "Shop", url: fixture.url("/store/costco/storefront") }) as LiveBody;
      assert.equal(started.outcome?.reason, "BaoOSHelper accessibility is not granted");
      assert.deepEqual(ax.calls, ["permissions false"]);
    } finally {
      await host.close();
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("an MCP client that disconnects without live_stop still saves its workflow", async () => {
    const dirs = applyHermeticApp("live-target");
    const app = await startApp({
      home: dirs.home,
      port: 0,
      liveTarget: `throwaway:${browser.portFile}`,
      liveLockFile: path.join(dirs.home, "live.lock"),
    });
    const user = path.join(dirs.home, "..", "user");
    mkdirSync(user, { recursive: true });
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      child = spawn(process.execPath, [path.join(process.cwd(), "desktop/dist/desktop/src/app/cli.js"), "mcp-live", "--home", dirs.home], {
        env: { ...process.env, HOME: user, BAO_HOME: dirs.home },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const proc = child;
      type Reply = { id?: number; result?: { content?: { text?: string }[]; isError?: boolean; tools?: { name: string; inputSchema: { required?: string[] } }[] } };
      const replies = new Map<number, Reply>();
      let buf = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) {
            const msg = JSON.parse(line) as Reply;
            if (typeof msg.id === "number") replies.set(msg.id, msg);
          }
          nl = buf.indexOf("\n");
        }
      });
      let id = 0;
      const rpc = async (method: string, params?: unknown) => {
        id += 1;
        const mine = id;
        proc.stdin.write(frameRpc({ jsonrpc: "2.0", id: mine, method, params }, "json"));
        return until(() => replies.get(mine), method, 60_000);
      };
      const tool = async (name: string, args: Record<string, unknown>): Promise<LiveBody> => {
        const reply = await rpc("tools/call", { name, arguments: args });
        assert.equal(reply.result?.isError, false, reply.result?.content?.[0]?.text);
        return JSON.parse(reply.result?.content?.[0]?.text || "{}") as LiveBody;
      };
      await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mock-user", version: "0" } });
      proc.stdin.write(frameRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, "json"));
      const listed = await rpc("tools/list");
      assert.deepEqual(listed.result?.tools?.find((item) => item.name === "live_session_start")?.inputSchema.required, ["intent", "url"]);

      const started = await tool("live_session_start", {
        intent: "put costco blueberries into the cart at instacart",
        url: fixture.url("/store/costco/storefront"),
      });
      assert.equal(started.outcome?.kind, "applied");
      assert.ok(stops(started).includes("Checkout"));
      const search = started.view?.controls.find((item) => item.label === "Search Costco");
      assert.ok(search);
      assert.equal((await tool("live_type", { ref: search.ref, text: "blueberries" })).outcome?.kind, "applied");

      const exited = new Promise<number | null>((resolve) => proc.once("exit", (code) => resolve(code)));
      proc.stdin.end();
      assert.equal(await exited, 0);
      const workflow = await until(() => savedWorkflow(dirs.home, started.session || ""), "the save on disconnect");
      assert.equal(workflow.driver, "cdp-live");
      assert.equal(workflow.intent, "put costco blueberries into the cart at instacart");
      const record = await until(() => {
        const read = sessionRecord(dirs.home);
        return read.status === "running" ? undefined : read;
      }, "the session record");
      assert.equal(record.status, "passed");
      assert.equal(record.note, "Saved when the agent disconnected.");
      assert.equal(existsSync(path.join(dirs.home, "live.lock")), false);
    } finally {
      child?.kill();
      await app.close();
    }
  });
});
