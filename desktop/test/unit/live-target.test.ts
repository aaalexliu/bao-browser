// A live session with no port file from the agent. The browser is the pinned
// test Chromium on a temp profile, serving the Instacart fixture. BaoOSHelper and
// Chrome's profile-window handoff are fakes, so nothing touches the daily Chrome.

import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before, describe, it } from "node:test";
import { startApp } from "../../src/app/server";
import { ALLOW_BUTTON } from "../../src/cdp-live/consent";
import { DEVTOOLS_ACTIVE_PORT, readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { createLiveHost } from "../../src/cdp-live/live-host";
import { LIVE_TOOLS } from "../../src/cdp-live/live-ops";
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

  assert.deepEqual(targetForPortFile(DEVTOOLS_ACTIVE_PORT), daily);
  assert.deepEqual(targetForPortFile("/tmp/t/chrome/DevToolsActivePort"), { kind: "throwaway", portFile: "/tmp/t/chrome/DevToolsActivePort" });
  assert.throws(() => targetForPortFile("DevToolsActivePort"), /absolute DevToolsActivePort/);

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
      const late = await host.call({ op: "live_snapshot" }) as LiveBody;
      assert.equal(late.outcome?.kind, "rejected");
    } finally {
      await host.close();
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
