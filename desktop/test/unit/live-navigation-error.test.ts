import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import type { LiveSessionRecord } from "../../src/cdp-live/live-record";
import { launchOwnedChrome } from "../../src/launch";
import type { RunResult } from "../../src/v1/replay";
import { CdpLiveDriver, LiveNavigationFailure, LiveNavigationHalt } from "../../src/cdp-live/driver";
import type { CdpSocket } from "../../src/cdp-live/socket";
import { applyHermeticApp } from "../runtime";

test("main-frame failure tracking ignores background errors and retains deliberate guards", async () => {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const url = "https://books.toscrape.com/";
  const cdp = {
    on: (method: string, _session: string, handler: (event: Record<string, unknown>) => void) => listeners.set(method, handler),
    send: async (method: string) => method === "Page.getFrameTree" ? { frameTree: { frame: { url } } } : { result: { value: undefined } },
  } as unknown as CdpSocket;
  const emit = (method: string, event: Record<string, unknown>) => listeners.get(method)!(event);
  const driver = new CdpLiveDriver(cdp, "session", "owned");
  await driver.start();
  emit("Network.requestWillBeSent", { type: "Document", frameId: "owned", requestId: "main", request: { url } });
  emit("Network.requestWillBeSent", { type: "Document", frameId: "child", requestId: "child", request: { url: url + "iframe" } });
  emit("Network.loadingFailed", { type: "Document", requestId: "child", errorText: "net::ERR_BLOCKED_BY_CLIENT" });
  emit("Network.requestWillBeSent", { type: "Image", frameId: "owned", requestId: "image", request: { url: url + "image.png" } });
  emit("Network.loadingFailed", { type: "Image", requestId: "image", errorText: "net::ERR_CONNECTION_RESET" });
  emit("Network.loadingFailed", { type: "Document", requestId: "main", canceled: true, errorText: "net::ERR_ABORTED" });
  await driver.checkNavigation();
  emit("Network.loadingFailed", { type: "Document", requestId: "main", errorText: "net::ERR_EMPTY_RESPONSE" });
  await assert.rejects(driver.checkNavigation(), error => error instanceof LiveNavigationFailure && error.url === url && error.errorCode === "net::ERR_EMPTY_RESPONSE");
  driver.setStopPath("/login(?:/|$)");
  emit("Network.requestWillBeSent", { type: "Document", frameId: "owned", requestId: "login", request: { url: url + "login" } });
  emit("Fetch.requestPaused", { requestId: "fetch-login", frameId: "owned", request: { url: url + "login" } });
  emit("Network.loadingFailed", { type: "Document", requestId: "login", errorText: "net::ERR_BLOCKED_BY_CLIENT" });
  assert.equal(driver.takeBlockedNav(), "login_wall");
  await assert.rejects(driver.checkNavigation(), error => error instanceof LiveNavigationHalt && error.reason === "login_wall" && error.url === url + "login");
});

test("Chrome failed documents cannot pass a live session or its Library capture", { timeout: 90_000 }, async () => {
  const dirs = applyHermeticApp("live-navigation-error");
  const fixture = createServer((req, res) => {
    if (req.url === "/empty") return req.socket.destroy();
    res.setHeader("content-type", "text/html");
    res.end('<title>Local navigation</title><h1>Ready</h1><a href="/blocked">Open destination</a>');
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const browser = await launchOwnedChrome({ userDataDir: dirs.chromeUserData, headless: true, childHome: dirs.nativeHostHome });
  const app = await startApp({ home: dirs.home, port: 0, liveTarget: `throwaway:${path.join(dirs.chromeUserData, "DevToolsActivePort")}`, liveLockFile: path.join(dirs.home, "lock") });
  type Reply = { session: string; outcome: { kind: string; reason?: string } };
  const call = async (op: string, args: Record<string, unknown> = {}): Promise<Reply> => fetch(`http://127.0.0.1:${app.port}/api/live`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, ...args }),
  }).then(response => response.json()) as Promise<Reply>;
  const state = (): Promise<{ liveSession: LiveSessionRecord }> => fetch(`http://127.0.0.1:${app.port}/api/state`).then(response => response.json());
  try {
    for (const [careful, readBeforeStop] of [[false, true], [true, true], [false, false], [true, false]] as const) {
      const start = await call("live_session_start", { intent: `${readBeforeStop ? "Read" : "Stop"} local blocked destination ${careful}`, url, careful });
      assert.equal(start.outcome.kind, "applied", JSON.stringify(start));
      const page = browser.pages().find(page => page.url() === url + "/")!;
      assert.ok(page);
      const cdp = await browser.newCDPSession(page);
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `${url}/blocked`, resourceType: "Document" }] });
      cdp.on("Fetch.requestPaused", event => { void cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }); });
      const failed = await cdp.send("Page.navigate", { url: url + "/blocked" });
      assert.equal(failed.errorText, "net::ERR_BLOCKED_BY_CLIENT");
      const read = await call(readBeforeStop ? "live_snapshot" : "live_stop");
      if (readBeforeStop) await call("live_stop");
      const recorded = (await state()).liveSession;
      if (process.env.BAO_ARTIFACTS_DIR && readBeforeStop) {
        await mkdir(process.env.BAO_ARTIFACTS_DIR, { recursive: true });
        await writeFile(path.join(process.env.BAO_ARTIFACTS_DIR, `error-${careful}.json`), JSON.stringify({ failed, read, recorded }, null, 2));
        const ui = await browser.newPage();
        try {
          await ui.goto(`http://127.0.0.1:${app.port}/`);
          await ui.locator("button[data-screen=live]").click();
          await ui.getByRole("heading", { name: "Live session", exact: true }).waitFor();
          await ui.screenshot({ path: path.join(process.env.BAO_ARTIFACTS_DIR, `live-error-${careful}.png`), fullPage: true });
          await ui.locator("button[data-screen=library]").click();
          await ui.getByText(recorded.intent, { exact: true }).first().waitFor();
          await ui.screenshot({ path: path.join(process.env.BAO_ARTIFACTS_DIR, `library-error-${careful}.png`), fullPage: true });
        } finally { await ui.close(); }
      }
      assert.equal(read.outcome.kind, readBeforeStop ? "rejected" : "stopped", JSON.stringify(read));
      if (readBeforeStop) {
        assert.match(read.outcome.reason || "", /ERR_BLOCKED_BY_CLIENT/);
        assert.ok(read.outcome.reason?.includes(url + "/blocked"));
      }
      assert.equal(recorded.status, "failed");
      assert.deepEqual(recorded.navigationFailure, { url: url + "/blocked", errorCode: "net::ERR_BLOCKED_BY_CLIENT" });
      assert.match(recorded.note, /ERR_BLOCKED_BY_CLIENT/);
      assert.ok(recorded.note.includes(url + "/blocked"));
      const capture = app.library.listRuns().find(run => run.workflowId === start.session);
      assert.ok(capture, "a failed navigation remains in Library without a successful action");
      assert.equal(capture.status, "failed");
      assert.ok(JSON.stringify(capture.failure).includes("ERR_BLOCKED_BY_CLIENT"));
      assert.ok(JSON.stringify(capture.failure).includes(url + "/blocked"));
      assert.equal(app.library.read(start.session).startUrl, url);
    }
    const empty = await call("live_session_start", { intent: "Read an unavailable local page", url: url + "/empty" });
    assert.equal(empty.outcome.kind, "rejected", JSON.stringify(empty));
    assert.match(empty.outcome.reason || "", /ERR_EMPTY_RESPONSE/);
    const capture = app.library.listRuns().find(run => run.workflowId === empty.session);
    assert.equal(capture?.status, "failed");
    assert.ok(JSON.stringify(capture?.failure).includes(url + "/empty"));
    const workflow = app.library.read(empty.session);
    app.library.save({ ...workflow, id: "wf-replay-unavailable", startUrl: url + "/empty" });
    const replay = await fetch(`http://127.0.0.1:${app.port}/api/replay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "wf-replay-unavailable", args: {} }) }).then(response => response.json()) as RunResult;
    assert.equal(replay.status, "failed", JSON.stringify(replay));
    assert.match(replay.failure?.reason || "", /ERR_EMPTY_RESPONSE/);
    assert.ok(replay.failure?.reason.includes(url + "/empty"));
    assert.equal(app.library.readRun(replay.runId).status, "failed");
  } finally {
    await app.close();
    await browser.close();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
  }
});
