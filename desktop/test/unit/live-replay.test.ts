// Plan W5: a recorded live workflow replays through the one live runner. The
// app records a session on the Instacart fixture through /api/live, with the
// calls an agent's MCP client makes. The saved workflow then replays through
// the app's /api/replay and through bao mcp's run_workflow, which hands the run
// to the app. The browser is the pinned test Chromium on a temp profile, so
// nothing touches the daily Chrome or the real site, and no model is called.

import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { startApp, type App } from "../../src/app/server";
import { replayLiveWorkflow } from "../../src/cdp-live/live-replay";
import { frameRpc } from "../../src/mcp/frame";
import type { WorkflowOutcome } from "../../src/mcp/catalog";
import type { RunResult } from "../../src/v1/replay";
import type { WorkflowStep, WorkflowV2 } from "../../src/v1/schema";
import { shotFormat } from "../../src/v1/shots";
import { launchFixtureBrowser, type FixtureBrowser } from "../instacart/browser";
import { TARGET, startInstacartFixture, type InstacartFixture } from "../instacart/fixture";
import { applyHermeticApp } from "../runtime";

const INTENT = "put costco blueberries into the cart at instacart";
const ADD = `Add 1 ct ${TARGET.name}`;
const MARKER = `Increment quantity of ${TARGET.name}`;

interface LiveBody {
  outcome?: { kind?: string; reason?: string };
  session?: string;
  view?: { path?: string; controls: { ref: string; label: string; kind: string }[] } | null;
}

type ReplayBody = RunResult & { id?: string; error?: string };

function refOf(body: LiveBody, label: string): string {
  const ref = body.view?.controls.find((item) => item.label === label)?.ref || "";
  assert.ok(ref, `${label} in ${(body.view?.controls || []).map((item) => item.label).join(", ")}`);
  return ref;
}

async function until<T>(read: () => T | undefined, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A stdio client for `bao mcp`, as an agent runs it. */
function mcpClient(home: string): { tool(name: string, args: Record<string, unknown>): Promise<WorkflowOutcome>; close(): Promise<void> } {
  const user = path.join(home, "..", "user");
  mkdirSync(user, { recursive: true });
  const proc: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [path.join(process.cwd(), "desktop/dist/desktop/src/app/cli.js"), "mcp", "--home", home],
    { env: { ...process.env, HOME: user, BAO_HOME: home }, stdio: ["pipe", "pipe", "pipe"] },
  );
  type Reply = { id?: number; result?: { content?: { text?: string }[]; isError?: boolean } };
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
  let ready: Promise<unknown> | undefined;
  const rpc = async (method: string, params?: unknown): Promise<Reply> => {
    id += 1;
    const mine = id;
    proc.stdin.write(frameRpc({ jsonrpc: "2.0", id: mine, method, params }, "json"));
    return until(() => replies.get(mine), method, 120_000);
  };
  return {
    async tool(name, args) {
      ready ??= rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mock-user", version: "0" } });
      await ready;
      const reply = await rpc("tools/call", { name, arguments: args });
      assert.equal(reply.result?.isError, false, reply.result?.content?.[0]?.text);
      return JSON.parse(reply.result?.content?.[0]?.text || "{}") as WorkflowOutcome;
    },
    async close() {
      const exited = new Promise((resolve) => proc.once("exit", resolve));
      proc.stdin.end();
      proc.kill();
      await exited;
    },
  };
}

describe("a recorded live workflow replays through the one live runner", { timeout: 300_000 }, () => {
  let fixture: InstacartFixture;
  let browser: FixtureBrowser;
  let app: App;
  let home: string;
  let lockFile: string;

  before(async () => {
    fixture = await startInstacartFixture();
    browser = await launchFixtureBrowser(fixture);
    home = applyHermeticApp("live-replay").home;
    lockFile = path.join(home, "live.lock");
    app = await startApp({ home, port: 0, liveTarget: `throwaway:${browser.portFile}`, liveLockFile: lockFile });
  });

  after(async () => {
    await app?.close();
    await browser?.close();
    await fixture?.close();
  });

  const post = async <T>(route: string, body: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(`http://127.0.0.1:${app.port}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as T };
  };
  const live = async (body: Record<string, unknown>): Promise<LiveBody> => (await post<LiveBody>("/api/live", body)).body;
  const writes = () => fixture.state().writes.map((write) => [write.op, write.productId, write.after]);
  const searched = () => fixture.state().requests.filter((hit) => hit.path.startsWith("/store/costco/s?")).map((hit) => hit.path);
  const passedNoModel = (run: { status?: string; modelCalls?: number; heals?: unknown[]; failure?: unknown }) => {
    assert.equal(run.status, "passed", JSON.stringify(run.failure));
    assert.equal(run.modelCalls, 0);
    assert.deepEqual(run.heals, []);
  };

  it("records the blueberries task, replays the recorded search, skips an Add already in the cart, and refuses checkout", async () => {
    // Record, the way an agent drives the live tools.
    fixture.reset();
    const started = await live({ op: "live_session_start", intent: INTENT, url: fixture.url("/store/costco/storefront"), client: "mock-user" });
    assert.equal(started.outcome?.kind, "applied", JSON.stringify(started.outcome));
    const typed = await live({ op: "live_type", ref: refOf(started, "Search Costco"), text: "blueberries" });
    assert.equal(typed.outcome?.kind, "applied", JSON.stringify(typed.outcome));
    const results = await live({ op: "live_key", key: "Enter", ref: refOf(typed, "Search Costco") });
    assert.equal(results.view?.path, "/store/costco/s");
    const added = await live({ op: "live_click", ref: refOf(results, ADD) });
    assert.equal(added.outcome?.kind, "applied", JSON.stringify(added.outcome));
    assert.equal((await live({ op: "live_stop" })).outcome?.kind, "stopped");
    assert.equal(existsSync(lockFile), false);

    const id = started.session || "";
    const recorded = app.library.read(id);
    assert.equal(recorded.driver, "cdp-live");
    assert.deepEqual(recorded.steps.map((step) => step.action), ["type", "key", "click"]);
    assert.deepEqual(recorded.inputs, [], "the search text is not an input");
    assert.equal(recorded.steps[0]?.value, "blueberries");
    assert.deepEqual(recorded.steps[2]?.when, { absent: MARKER });
    assert.deepEqual(writes(), [["add", TARGET.id, 1]]);
    // The run form cannot move a live workflow to Bao's own Chrome.
    const state = await (await fetch(`http://127.0.0.1:${app.port}/api/state`)).json() as { workflows?: { id: string; driver?: string }[] };
    assert.equal(state.workflows?.find((item) => item.id === id)?.driver, "cdp-live");
    const moved = await fetch(`http://127.0.0.1:${app.port}/api/workflows/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ driver: "playwright" }),
    });
    assert.equal(moved.status, 409);
    assert.equal(app.library.read(id).driver, "cdp-live");

    // The app's replay on an empty cart. It types the recorded search text.
    fixture.reset();
    const first = await post<ReplayBody>("/api/replay", { id, args: {} });
    assert.equal(first.status, 200, first.body.error);
    passedNoModel(first.body);
    assert.equal(first.body.id, first.body.runId);
    assert.deepEqual(first.body.steps.map((step) => [step.status, step.reason ?? ""]), [["passed", ""], ["passed", ""], ["passed", ""]]);
    assert.deepEqual(searched(), ["/store/costco/s?k=blueberries"]);
    assert.deepEqual(writes(), [["add", TARGET.id, 1]]);
    assert.equal(app.library.readRun(first.body.runId).status, "passed");
    const shots = path.join(home, "shots", "runs", first.body.runId);
    assert.equal(readdirSync(shots).length, recorded.steps.length * 2, "live Library runs save page pictures with video off");
    for (const step of first.body.steps) {
      for (const ref of [step.beforeShot, step.afterShot]) {
        assert.ok(ref, "each live step keeps both picture references");
        assert.equal(shotFormat(readFileSync(path.join(shots, ref))), "png");
      }
    }
    for (const extension of ["mp4", "webm"]) assert.equal(existsSync(path.join(home, "videos", `${first.body.runId}.${extension}`)), false);
    assert.equal(existsSync(lockFile), false, "the replay frees the CDP lock");

    // Again: the item is already in the cart.
    const again = await post<ReplayBody>("/api/replay", { id, args: {} });
    passedNoModel(again.body);
    assert.deepEqual(again.body.steps.map((step) => step.reason ?? ""), ["", "", "already done"]);
    assert.deepEqual(searched(), ["/store/costco/s?k=blueberries", "/store/costco/s?k=blueberries"]);
    assert.deepEqual(writes(), [["add", TARGET.id, 1]], "replay added nothing to a cart that had the item");

    // bao mcp's run_workflow. The mcp process hands the run to the app.
    fixture.reset();
    const mcp = mcpClient(home);
    try {
      const viaMcp = await mcp.tool("run_workflow", { id });
      assert.equal(viaMcp.outcome, "ok", JSON.stringify(viaMcp));
      assert.deepEqual(searched(), ["/store/costco/s?k=blueberries"]);
      assert.deepEqual(writes(), [["add", TARGET.id, 1]]);
      const stored = app.library.readRun(viaMcp.runId || "");
      assert.equal(stored.status, "passed");
      assert.equal(stored.modelCalls, 0);
      assert.equal(readdirSync(path.join(home, "shots", "runs", stored.id)).length, recorded.steps.length * 2);

      // A workflow edited to click Checkout after the Add. Replay refuses the click and never loads /checkout.
      const checkout: WorkflowStep = {
        id: `${id}-checkout`,
        index: recorded.steps.length,
        action: "click",
        label: "Click \"Checkout\"",
        surface: "dom",
        timeoutMs: 4000,
        identity: { surface: "dom", role: "link", name: "Checkout", text: "Checkout", tag: "a", path: [] },
        locators: [{ kind: "role", role: "link", name: "Checkout" }],
      };
      const edited: WorkflowV2 = { ...recorded, id: `${id}-then-checkout`, steps: [...recorded.steps, checkout] };
      app.library.save(edited);
      const refused = await mcp.tool("run_workflow", { id: edited.id });
      assert.equal(refused.outcome, "failed", JSON.stringify(refused));
      assert.equal(refused.reason, "action: denied");
      assert.deepEqual(refused.receipts.map((step) => step.status), ["passed", "passed", "passed", "failed"]);
      assert.equal(app.library.readRun(refused.runId || "").modelCalls, 0);
    } finally {
      await mcp.close();
    }

    // A workflow edited to open the checkout page is refused before the load.
    const navigate: WorkflowStep = {
      id: `${id}-open-checkout`,
      index: recorded.steps.length,
      action: "navigate",
      label: "Open checkout",
      surface: "dom",
      timeoutMs: 4000,
      value: fixture.url("/checkout?store=costco"),
    };
    const opened: WorkflowV2 = { ...recorded, id: `${id}-open-checkout`, steps: [...recorded.steps, navigate] };
    app.library.save(opened);
    const blocked = await post<ReplayBody>("/api/replay", { id: opened.id, args: {} });
    assert.equal(blocked.body.status, "failed");
    assert.equal(blocked.body.failure?.reason, "blocked-path");
    assert.equal(blocked.body.modelCalls, 0);

    assert.deepEqual(fixture.state().traps, [], "no replay reached a checkout, login, or account page");
    assert.deepEqual(writes(), [["add", TARGET.id, 1]]);
    assert.equal(existsSync(lockFile), false);

    // A replay does not run while a live session holds the Chrome.
    const open = await live({ op: "live_session_start", intent: "look around", url: fixture.url("/store/costco/storefront") });
    assert.equal(open.outcome?.kind, "applied", JSON.stringify(open.outcome));
    const busy = await post<{ error?: string; modelCalls?: number }>("/api/replay", { id, args: {} });
    assert.equal(busy.status, 409);
    assert.match(busy.body.error || "", /stop the live session before replay/);
    assert.equal(busy.body.modelCalls, 0);
    assert.equal((await live({ op: "live_stop" })).outcome?.kind, "stopped");
    assert.equal(existsSync(lockFile), false);
  });

  it("keeps startup failures in Library Runs through both the app and product MCP", async () => {
    const failedHome = applyHermeticApp("live-replay-startup-failure").home;
    const failedLock = path.join(failedHome, "live.lock");
    const failed = await startApp({
      home: failedHome, port: 0, liveTarget: `throwaway:${path.join(failedHome, "missing", "DevToolsActivePort")}`, liveLockFile: failedLock,
    });
    const workflow: WorkflowV2 = {
      schema: "bao.workflow/v2", id: "wf-startup-failure", name: "Startup failure", intent: "Read-only startup",
      version: 2, createdAt: Date.now(), driver: "cdp-live", startUrl: fixture.url("/store/costco/storefront"), inputs: [],
      steps: [{ id: "startup-note", index: 0, action: "note", label: "No cart action", surface: "dom", timeoutMs: 4000 }],
    };
    failed.library.save(workflow);
    try {
      const response = await fetch(`http://127.0.0.1:${failed.port}/api/replay`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: workflow.id, args: {} }),
      });
      assert.equal(response.status, 200);
      const run = await response.json() as ReplayBody;
      assert.equal(run.status, "failed");
      assert.equal(run.modelCalls, 0);
      assert.deepEqual(run.steps.map((step) => step.status), ["pending"]);
      assert.match(run.failure?.reason || "", /DevToolsActivePort|missing|ENOENT/);
      assert.deepEqual(failed.library.readRun(run.runId).failure, run.failure);
      const state = await (await fetch(`http://127.0.0.1:${failed.port}/api/state`)).json() as { runs: { id: string; failure?: { reason: string } }[] };
      assert.equal(state.runs.find((item) => item.id === run.runId)?.failure?.reason, run.failure?.reason);
      const mcp = mcpClient(failedHome);
      try {
        const outcome = await mcp.tool("run_workflow", { id: workflow.id });
        assert.equal(outcome.outcome, "failed");
        assert.ok(outcome.reason?.includes(run.failure!.reason));
        assert.notEqual(outcome.runId, run.runId);
        const stored = failed.library.readRun(outcome.runId!);
        assert.equal(stored.status, "failed");
        assert.deepEqual(stored.failure, run.failure);
        assert.equal(stored.modelCalls, 0);
        assert.deepEqual(stored.steps, run.steps);
        assert.equal(failed.library.listRuns().length, 2);
      } finally { await mcp.close(); }
      assert.equal(existsSync(failedLock), false);
    } finally { await failed.close(); }
  });

  it("keeps completed step results when video encoding fails after replay", async () => {
    const previous = process.env.FFMPEG;
    process.env.FFMPEG = process.execPath;
    try {
      const run = await replayLiveWorkflow({
        schema: "bao.workflow/v2", id: "wf-video-failure", name: "Video failure", intent: "Read-only video failure",
        version: 2, createdAt: Date.now(), driver: "cdp-live", startUrl: fixture.url("/store/costco/storefront"), inputs: [],
        steps: [{ id: "video-note", index: 0, action: "note", label: "No cart action", surface: "dom", timeoutMs: 4000 }],
      }, {}, {
        target: { kind: "throwaway", portFile: browser.portFile }, artifactRoot: home, lockFile, engineName: "old",
        axLog: path.join(home, "video-failure-ax.jsonl"),
        openProfile: async () => { throw new Error("a throwaway fixture must not open the daily Chrome"); },
      });
      passedNoModel(run);
      assert.deepEqual(run.steps.map((step) => step.status), ["passed"]);
      assert.equal(run.video, undefined);
      assert.match(run.traceUnavailable || "", /replay video unavailable: CDP video/);
      assert.equal(existsSync(lockFile), false);
    } finally {
      if (previous === undefined) delete process.env.FFMPEG;
      else process.env.FFMPEG = previous;
    }
  });
});
