import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { workflowDriver } from "../../src/extension/protocol";
import { fixtureDoc } from "../support/fixture-step";
import { validateWorkflow, type WorkflowV2 } from "../../src/v1/schema";
import { liveShotUrl, publicLiveSession, liveLabel, shotNameOk } from "../../src/cdp-live/live-record";
import { acquireCdpLock, lockIsStale, lockText, parseLock, releaseCdpLock } from "../../src/cdp-live/lock";
import { liveSessionView, screenFromQuery } from "../../src/app/live-view";
import {
  checkboxReach,
  dialogFromNodes,
  mayClickAllow,
  summarizeAx,
  type AxLike,
} from "../../src/cdp-live/consent";
import { assertActivePortFile, listenPid, parseDevToolsActivePort, parseListenPid } from "../../src/cdp-live/endpoint";
import { CDP_LIVE_SERVER_REFUSAL, EXTENSION_NOT_CONNECTED, refusesOwnedBrowser, replayRefusal } from "../../src/cdp-live/launch-guard";
import { ServerFrameDecoder, handshakeRequest, scrubCdp } from "../../src/cdp-live/socket";

function migrate(_raw: unknown): WorkflowV2 {
  return fixtureDoc(_raw && typeof _raw === "object" ? _raw as Record<string, unknown> : {});
}

const ready = {
  openedByBao: true,
  connectionStartedAt: 1_000,
  now: 2_000,
  dialogPresentBeforeConnect: false,
  dialog: { present: true, buttonCount: 1 },
};

test("Allow is clicked only for the dialog bao just opened", () => {
  assert.equal(mayClickAllow(ready), true);
  assert.equal(mayClickAllow({ ...ready, openedByBao: false }), false);
  assert.equal(mayClickAllow({ ...ready, connectionStartedAt: null }), false);
  assert.equal(mayClickAllow({ ...ready, dialogPresentBeforeConnect: true }), false);
  assert.equal(mayClickAllow({ ...ready, dialog: { present: false, buttonCount: 1 } }), false);
  assert.equal(mayClickAllow({ ...ready, dialog: { present: true, buttonCount: 0 } }), false);
  assert.equal(mayClickAllow({ ...ready, dialog: { present: true, buttonCount: 2 } }), false);
  assert.equal(mayClickAllow({ ...ready, now: ready.connectionStartedAt + 180_001 }), false);
  assert.equal(mayClickAllow({ ...ready, now: ready.connectionStartedAt - 1 }), false);
});

test("a Chrome tree with no window is not typed into", () => {
  assert.equal(checkboxReach({ checkbox: { found: false }, roles: { AXApplication: 1, AXMenuBar: 1 } }), "stop");
  assert.equal(checkboxReach({ checkbox: { found: false }, roles: { AXWindow: 2 } }), "open-inspect");
  assert.equal(checkboxReach({ checkbox: { found: true }, roles: {} }), "ready");
});

test("Allow sites is not the remote-debugging Allow button", () => {
  const nodes: AxLike[] = [
    { role: "AXButton", name: "Allow sites", title: "Allow sites" },
    { role: "AXCheckBox", name: "Allow remote debugging for this browser instance", value: "1" },
    { role: "AXWindow", name: "Inbox - Google Chrome", title: "Inbox - Google Chrome" },
  ];
  const dialog = dialogFromNodes(nodes);
  assert.equal(dialog.present, false);
  assert.equal(dialog.buttonCount, 0);
  assert.equal(mayClickAllow({ ...ready, dialog }), false);

  const shown: AxLike[] = [
    { role: "AXStaticText", name: "Allow remote debugging?", title: "" },
    { role: "AXButton", name: "Allow", title: "Allow" },
    { role: "AXButton", name: "Cancel", title: "Cancel" },
    { role: "AXButton", name: "Allow sites", title: "Allow sites" },
  ];
  const live = dialogFromNodes(shown);
  assert.equal(live.present, true);
  assert.equal(live.buttonCount, 1);
  assert.equal(mayClickAllow({ ...ready, dialog: live }), true);
});

test("AX summary drops other window titles", () => {
  const summary = summarizeAx([
    { role: "AXWindow", name: "Bank - Google Chrome", title: "Bank - Google Chrome" },
    { role: "AXStaticText", name: "Allow remote debugging?" },
    { role: "AXButton", name: "Allow", title: "Allow" },
    { role: "AXButton", name: "Allow sites" },
    { role: "AXCheckBox", name: "Allow remote debugging for this browser instance", value: "0" },
    { role: "AXLink", name: "https://secret.example/account" },
  ]);
  const blob = JSON.stringify(summary);
  assert.equal(blob.includes("secret.example"), false);
  assert.equal(blob.includes("Bank"), false);
  assert.equal(blob.includes("Allow remote debugging?"), true);
  assert.equal(summary.dialog.buttonCount, 1);
  assert.equal(summary.checkbox.value, "0");
});

test("historical cdp-live workflows stay valid but cannot launch replay", () => {
  const doc = migrate({
    id: "wf-cdp-live",
    name: "Live",
    version: 2,
    schema: "bao.workflow/v4",
    startUrl: "https://books.toscrape.com/",
    createdAt: 1,
    inputs: [],
    steps: [],
  });
  assert.deepEqual(validateWorkflow({ ...doc, driver: "cdp-live" as unknown as WorkflowV2["driver"] }), []);
  assert.ok(validateWorkflow({ ...doc, driver: "cdp" as unknown as WorkflowV2["driver"] }).includes("driver"));
  assert.equal(workflowDriver({ driver: "cdp-live" }), "playwright");
  assert.equal(workflowDriver({ driver: "cdp" }), "playwright");
  assert.equal(refusesOwnedBrowser("cdp-live"), true);
  assert.equal(refusesOwnedBrowser("playwright"), false);
  assert.equal(refusesOwnedBrowser("extension"), false);
  assert.equal(refusesOwnedBrowser("cdp"), false);
  assert.equal(CDP_LIVE_SERVER_REFUSAL, "this workflow used the retired live driver");
});

test("a replay refuses cdp-live, and refuses an extension workflow only without a linked extension", () => {
  assert.equal(replayRefusal("cdp-live", { extensionLinked: true }), CDP_LIVE_SERVER_REFUSAL);
  assert.equal(replayRefusal("extension", { extensionLinked: false }), EXTENSION_NOT_CONNECTED);
  assert.equal(replayRefusal("extension", { extensionLinked: true }), null);
  assert.equal(replayRefusal("playwright", { extensionLinked: false }), null);
  assert.equal(replayRefusal(undefined, { extensionLinked: false }), null);
});

test("the browser handshake has no Origin header", () => {
  const raw = handshakeRequest("/devtools/browser/example", "127.0.0.1:9222", "abc");
  assert.equal(/\r\nOrigin:/i.test(raw), false);
  assert.match(raw, /^GET \/devtools\/browser\/example HTTP\/1\.1\r\nHost: 127\.0\.0\.1:9222\r\n/);
  assert.equal(scrubCdp("no /devtools/browser/abc-def"), "no /devtools/browser/<id>");
});

test("start and navigate audit URLs retain captured URL parts", () => {
  const urls = [
    ["http://127.0.0.1:47811/member", "http://127.0.0.1:47811/member"],
    ["http://[::1]:47811/member", "http://[::1]:47811/member"],
    ["https://www3.example123.com:8443/member", "https://www3.example123.com:8443/member"],
    ["https://person:secret@example.com/member?token=123456#private", "https://person:secret@example.com/member?token=123456#private"],
    ["https://example.com/report/123456", "https://example.com/report/123456"],
  ];
  for (const action of ["start", "navigate"]) {
    for (const [label, expected] of urls) {
      const session = publicLiveSession({ status: "running", audit: [{ action, label }] });
      assert.equal(session?.audit[0]?.label, expected);
      assert.equal(publicLiveSession(session)?.audit[0]?.label, expected, "labels survive repeated log writes");
    }
  }
  const session = publicLiveSession({ status: "running", audit: [
    { action: "start", label: "Member dashboard" },
    { action: "navigate", label: "Target page" },
    { action: "click", label: "Credit score 742" },
    { action: "type", label: "user@example.com" },
  ] });
  assert.deepEqual(session?.audit.map((row) => row.label), ["Member dashboard", "Target page", "Credit score 742", "user@example.com"]);
  assert.equal(liveLabel("Credit score 742"), "Credit score 742");
});

test("a live session view reads stored page shots", () => {
  assert.equal(screenFromQuery("?screen=live"), "live");
  assert.equal(screenFromQuery("?screen=library"), "");
  assert.equal(screenFromQuery("?screen=settings"), "");
  assert.equal(screenFromQuery("?screen=run&run=run-fixture"), "");
  assert.equal(screenFromQuery("?screen=run"), "");
  assert.equal(shotNameOk("shot-001.png"), true);
  assert.equal(shotNameOk("../session.json"), false);
  assert.equal(liveShotUrl("shot-001.png"), "/api/live-session/shots/shot-001.png");
  assert.equal(liveShotUrl("../x.png"), "");
  assert.equal(liveLabel("bananas $1.29"), "bananas $1.29");
  assert.equal(liveLabel("user@example.com"), "user@example.com");
  const html = liveSessionView({
    id: "live",
    intent: "Add one cheap item, then remove it.",
    status: "passed",
    host: "www.instacart.com",
    updatedAt: 1,
    steps: [{ name: "add", status: "passed", ms: 12 }],
    audit: [{ action: "allow", label: "Allow", path: "", isTrusted: null, ms: 80, at: 1, shot: "", via: "ax" },
      { action: "add", label: "Add", path: "/store/s", isTrusted: true, ms: 40, at: 2, shot: "shot-001.png", via: "cdp" }],
    note: "",
  });
  assert.match(html, /id="live-steps"/);
  assert.match(html, /id="live-audit"/);
  assert.match(html, /AX press/);
  assert.match(html, /\/api\/live-session\/shots\/shot-001\.png/);
  assert.doesNotMatch(html, /https?:/);
});

test("the browser lock is exclusive and a stale lock can be taken", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-lock-"));
  const file = path.join(dir, "lock");
  assert.equal(parseLock(lockText("agent-a", 10))?.agentId, "agent-a");
  assert.equal(lockIsStale(1, 20 * 60 * 1000 + 2), true);
  let now = 1_000;
  let tries = 0;
  await acquireCdpLock("agent-a", { file, now: () => now, timeoutMs: 1_000, sleep: async () => undefined });
  await assert.rejects(acquireCdpLock("agent-b", {
    file,
    now: () => now + tries,
    timeoutMs: 0,
    sleep: async () => { tries += 1; },
  }), /held/);
  releaseCdpLock("agent-b", file);
  assert.equal(parseLock(readFileSync(file, "utf8"))?.agentId, "agent-a");
  now = 1_000 + 20 * 60 * 1000 + 5;
  await acquireCdpLock("agent-b", { file, now: () => now, timeoutMs: 1_000, sleep: async () => undefined });
  releaseCdpLock("agent-b", file);
});

test("listenPid calls /usr/sbin/lsof on macOS and lsof by name on Linux", async (t) => {
  const calls: string[] = [];
  t.mock.method(childProcess, "execFile", ((file: string, _args: readonly string[], _opts: unknown, callback: (err: Error | null, stdout: string) => void) => {
    calls.push(file);
    callback(null, "Google 7 alexliu 1u IPv4 0x1 0t0 TCP 127.0.0.1:9222 (LISTEN)\n");
    return {} as childProcess.ChildProcess;
  }) as typeof childProcess.execFile);
  assert.equal(await listenPid(9222, "darwin"), 7);
  assert.equal(await listenPid(9222, "linux"), 7);
  assert.deepEqual(calls, ["/usr/sbin/lsof", "lsof"]);
});

test("DevToolsActivePort is the only file the endpoint reader accepts", () => {
  assert.throws(() => assertActivePortFile("/tmp/Preferences"), /DevToolsActivePort/);
  const parsed = parseDevToolsActivePort("9222\n/devtools/browser/00000000-0000-4000-8000-000000000000\n");
  assert.equal(parseListenPid("Google 92286 alexliu 198u IPv4 0x1 0t0 TCP 127.0.0.1:9222 (LISTEN)\n", 9222), 92286);
  assert.equal(parseListenPid("Google 8920 alexliu 12u IPv4 0x1 0t0 TCP 127.0.0.1:25319 (LISTEN)\n", 9222), null);
  assert.equal(parsed.port, 9222);
  assert.equal(parsed.browserPath, "/devtools/browser/00000000-0000-4000-8000-000000000000");
  assert.throws(() => parseDevToolsActivePort("9222\n/devtools/page/abc\n"), /browser target/);
  const decoder = new ServerFrameDecoder();
  const payload = Buffer.from("{\"id\":1,\"result\":{\"ok\":true}}");
  const header = Buffer.from([0x81, payload.length]);
  assert.equal(decoder.push(header.subarray(0, 1)).length, 0);
  const frames = decoder.push(Buffer.concat([header.subarray(1), payload]));
  assert.equal(frames[0]?.text, payload.toString("utf8"));
});
