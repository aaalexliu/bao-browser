import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { startApp } from "../../src/app/server";
import { CdpLiveDriver } from "../../src/cdp-live/driver";
import { createLiveHost } from "../../src/cdp-live/live-host";
import { CdpSocket } from "../../src/cdp-live/socket";
import { ffmpegBin } from "../../src/v1/replay-video";
import { Library } from "../../src/v1/store";
import type { WorkflowV2 } from "../../src/v1/schema";
import { launchFixtureBrowser, type FixtureBrowser } from "../instacart/browser";
import { startInstacartFixture, type InstacartFixture } from "../instacart/fixture";
import { startServe } from "../instacart/lane";
import { laneChildEnv } from "../runtime";

type Body = { outcome?: { kind?: string; reason?: string }; session?: string; view?: { controls: { ref: string; label: string }[] }; run?: { status: string; video?: string } };

describe("live windows use the shared CDP recorder", { timeout: 180_000, skip: !ffmpegBin() }, () => {
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

  for (const evalVideoNoBlur of [undefined, true] as const) {
    it(`${evalVideoNoBlur ? "eval" : "ordinary"} sessions release CDP before encoding and Library replay stays blurred`, async (t) => {
      const home = mkdtempSync(path.join(tmpdir(), "bao-shared-video-"));
      const videoDir = path.join(home, "videos");
      const lockFile = path.join(home, "lock");
      let closed = 0;
      let finished = 0;
      const modes: (true | undefined)[] = [];
      const close = CdpSocket.prototype.close;
      const finishVideo = CdpLiveDriver.prototype.finishVideo;
      const startVideo = CdpLiveDriver.prototype.startVideo;
      t.mock.method(CdpSocket.prototype, "close", function (this: CdpSocket) {
        close.call(this);
        assert.equal(this.isOpen, false);
        closed += 1;
      });
      t.mock.method(CdpLiveDriver.prototype, "startVideo", async function (this: CdpLiveDriver, dest: string, opts: { noBlur?: true } = {}) {
        modes.push(opts.noBlur);
        await startVideo.call(this, dest, opts);
      });
      t.mock.method(CdpLiveDriver.prototype, "finishVideo", async function (this: CdpLiveDriver) {
        assert.equal(closed, finished + 1);
        assert.equal(existsSync(lockFile), false);
        const targets = await (await fetch(`${browser.cdpUrl}/json/list`)).json() as { id: string }[];
        assert.ok(!targets.some((target) => target.id === this.targetId));
        try { return await finishVideo.call(this); } finally { finished += 1; }
      });
      const host = createLiveHost({ home, lockFile, target: { kind: "throwaway", portFile: browser.portFile }, idleMs: 0, videoDir, evalVideoNoBlur });
      const call = (body: Record<string, unknown>) => host.call(body) as Promise<Body>;
      try {
        const started = await call({ op: "live_session_start", intent: "search costco for blueberries", url: fixture.url("/store/costco/storefront"), noBlur: true, evalVideoNoBlur: true });
        assert.equal(started.outcome?.kind, "applied");
        const search = started.view?.controls.find((item) => item.label === "Search Costco")?.ref;
        const typed = await call({ op: "live_type", ref: search, text: "blueberries" });
        assert.equal(typed.outcome?.kind, "applied");
        assert.equal((await call({ op: "live_stop" })).outcome?.kind, "stopped");
        const session = readdirSync(videoDir).find((name) => name.startsWith(`live-${started.session}-`) && name.endsWith(".mp4"));
        assert.ok(session && statSync(path.join(videoDir, session)).size > 1000);
        const workflow = new Library(home).read(started.session!);
        const run = await host.replay(workflow);
        assert.equal(run.status, "passed", JSON.stringify(run.failure));
        assert.equal(run.modelCalls, 0);
        assert.equal(run.video, `${run.runId}.mp4`);
        assert.ok(statSync(path.join(videoDir, run.video!)).size > 1000);
        const replayed = await call({ op: "live_replay", workflow, noBlur: true });
        assert.equal(replayed.run?.status, "passed");
        assert.ok(replayed.run?.video?.endsWith(".mp4"));
        assert.ok(readdirSync(videoDir).every((name) => name.endsWith(".mp4")), "new recordings do not leave a WebM copy");
        assert.deepEqual(modes, [evalVideoNoBlur, undefined, evalVideoNoBlur]);
        t.mock.method(CdpLiveDriver.prototype, "goto", async () => { throw new Error("failed start"); });
        assert.equal((await call({ op: "live_session_start", intent: "failed start", url: fixture.url("/store/costco/storefront") })).outcome?.kind, "rejected");
        assert.equal(finished, 4);
      } finally { await host.close(); }
    });
  }

  for (const ending of ["stop", "disconnect", "idle", "save-failure"] as const) {
    it(`reports session video truncation on ${ending}`, async (t) => {
      const home = mkdtempSync(path.join(tmpdir(), "bao-truncated-video-"));
      const finishVideo = CdpLiveDriver.prototype.finishVideo;
      if (ending === "save-failure") t.mock.method(Library.prototype, "save", () => { throw new Error("workflow save failed"); });
      t.mock.method(CdpLiveDriver.prototype, "finishVideo", async function (this: CdpLiveDriver) {
        const result = await finishVideo.call(this);
        assert.equal(result.wrote, true);
        return { ...result, truncated: true };
      });
      const host = createLiveHost({ home, lockFile: path.join(home, "lock"), target: { kind: "throwaway", portFile: browser.portFile }, videoDir: path.join(home, "videos"), idleMs: ending === "idle" ? 500 : 0, idleWarnMs: 0 });
      const call = (body: Record<string, unknown>) => host.call(body) as Promise<Body>;
      try {
        const started = await call({ op: "live_session_start", intent: "record a search", url: fixture.url("/store/costco/storefront"), client: "test" });
        assert.equal(started.outcome?.kind, "applied");
        const typed = await call({ op: "live_type", ref: started.view?.controls.find((control) => control.label === "Search Costco")?.ref, text: "blueberries" });
        assert.equal(typed.outcome?.kind, "applied");
        if (ending === "idle") {
          const deadline = Date.now() + 15_000;
          while (host.isOpen() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
          assert.equal(host.isOpen(), false);
        } else {
          const stopped = await call(ending === "disconnect" ? { op: "live_disconnect", client: "test" } : { op: "live_stop" });
          assert.equal(stopped.outcome?.kind, ending === "save-failure" ? "rejected" : "stopped");
          assert.equal(stopped.outcome?.reason, ending === "save-failure" ? "workflow save failed" : "Video truncated.");
        }
        const session = JSON.parse(readFileSync(path.join(home, "live-session", "session.json"), "utf8")) as { status: string; note: string };
        assert.equal(session.status, ending === "save-failure" ? "failed" : "passed");
        assert.ok(session.note.endsWith("Video truncated."), session.note);
      } finally { await host.close(); }
    });
  }

  it("the eval lane launches a private recording app without a public no-blur flag", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bev-"));
    const home = path.join(root, "home");
    const user = path.join(root, "user");
    mkdirSync(user);
    const env = { ...laneChildEnv("hermetic", process.env), HOME: user, BAO_HOME: home };
    const app = await startServe(env, home, browser.portFile, path.join(root, "lock"), true);
    try {
      const { port } = JSON.parse(readFileSync(path.join(home, "server.json"), "utf8")) as { port: number };
      const call = async (body: Record<string, unknown>) => (await (await fetch(`http://127.0.0.1:${port}/api/live`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as Body;
      const started = await call({ op: "live_session_start", intent: "search through eval", url: fixture.url("/store/costco/storefront") });
      assert.equal(started.outcome?.kind, "applied");
      assert.equal((await call({ op: "live_type", ref: started.view?.controls.find((control) => control.label === "Search Costco")?.ref, text: "blueberries" })).outcome?.kind, "applied");
      assert.equal((await call({ op: "live_stop" })).outcome?.kind, "stopped");
      const clips = readdirSync(path.join(home, "videos"));
      assert.ok(clips.some((name) => name.startsWith(`live-${started.session}-`) && statSync(path.join(home, "videos", name)).size > 1000));
    } finally { await app.close(); }
  });

  it("persists the live replay video on the run and serves the clip", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "bao-live-run-video-"));
    const library = new Library(home);
    const workflow: WorkflowV2 = {
      schema: "bao.workflow/v2", version: 2, id: "video-search", name: "Search Costco", startUrl: fixture.url("/store/costco/storefront"), createdAt: 0, driver: "cdp-live", inputs: [],
      steps: [{ id: "search", index: 0, action: "type", label: "Search Costco", surface: "dom", identity: { surface: "dom", role: "textbox", name: "Search Costco", path: [] }, value: "blueberries", timeoutMs: 2000 }],
    };
    library.save(workflow);
    const before = process.env.BAO_RUN_VIDEO;
    process.env.BAO_RUN_VIDEO = "1";
    const app = await startApp({ home, port: 0, liveTarget: `throwaway:${browser.portFile}`, liveLockFile: path.join(home, "lock"), extensionHost: false });
    try {
      const response = await fetch(`http://127.0.0.1:${app.port}/api/replay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: workflow.id, inputs: {} }) });
      assert.equal(response.status, 200);
      const result = await response.json() as { runId: string; status: string };
      assert.equal(result.status, "passed", JSON.stringify(result));
      const saved = library.readRun(result.runId);
      assert.equal(saved.video, `${result.runId}.mp4`);
      const video = await fetch(`http://127.0.0.1:${app.port}/api/runs/${result.runId}/video`);
      assert.equal(video.status, 200);
      assert.equal(video.headers.get("content-type"), "video/mp4");
      assert.ok((await video.arrayBuffer()).byteLength > 1000);
    } finally {
      await app.close();
      if (before === undefined) delete process.env.BAO_RUN_VIDEO; else process.env.BAO_RUN_VIDEO = before;
    }
  });
});
