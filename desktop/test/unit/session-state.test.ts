import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { moveSession, startApp, type CaptureSession, type PendingCapture } from "../../src/app/server";
import { testWorkflow } from "../support/workflow";
import { applyHermeticApp } from "../runtime";

const pending = {
  workflow: testWorkflow({ id: "wf-sheet" }),
  events: [],
  shots: new Map(),
  poster: "",
  floor: "Floor",
} as PendingCapture;

function recording(): CaptureSession {
  const started = moveSession({ phase: "idle" }, { type: "start-recording", since: 10 });
  assert.equal(started.ok, true);
  return started.session;
}

test("replay cannot take the browser while a recording or live teach holds it", () => {
  const open = recording();
  const refused = moveSession(open, { type: "take-browser" });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "busy");
  assert.equal(refused.session, open);

  const teaching = moveSession({ phase: "idle" }, { type: "start-teach", since: 11 });
  assert.equal(teaching.ok, true);
  const teachRefused = moveSession(teaching.session, { type: "take-browser" });
  assert.equal(teachRefused.ok, false);
  assert.equal(teachRefused.session, teaching.session);

  const resting: CaptureSession[] = [
    { phase: "idle" },
    { phase: "saveSheet", pending },
    { phase: "teachReview" },
  ];
  for (const session of resting) {
    const allowed = moveSession(session, { type: "take-browser" });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.session, session);
  }
});

test("a new capture cannot start over teach or a save sheet", () => {
  const review = moveSession(
    moveSession({ phase: "idle" }, { type: "start-teach", since: 4 }).session,
    { type: "finish-teach" },
  );
  assert.equal(review.session.phase, "teachReview");
  assert.equal(moveSession(review.session, { type: "start-recording", since: 5 }).ok, false);
  assert.equal(moveSession({ phase: "saveSheet", pending }, { type: "start-recording", since: 6 }).ok, false);
  assert.equal(moveSession(recording(), { type: "open-save", pending: pending }).session.phase, "saveSheet");
  assert.equal(moveSession({ phase: "teachLive", since: 7 }, { type: "open-save", pending }).ok, false);
});

test("teach becomes live with its clock in one step", () => {
  const live = moveSession({ phase: "idle" }, { type: "start-teach", since: 20 });
  assert.equal(live.ok, true);
  assert.deepEqual(live.session, { phase: "teachLive", since: 20 });
  const review = moveSession({ ...live.session, extract: { mode: "list", count: 1, locators: [], columns: [] } }, { type: "finish-teach" });
  assert.deepEqual(review.session, { phase: "teachReview" });
});

test("a replay started during recording is refused", { timeout: 120_000 }, async () => {
  assert.ok(process.env.BAO_TEST_BROWSER, "Run with laneChildEnv so Chromium is pinned");
  const dirs = applyHermeticApp("session-replay");
  const app = await startApp({ home: dirs.home, port: 0, chromeUserData: dirs.chromeUserData });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const workflow = testWorkflow({
      id: "wf-during-record",
      name: "During recording",
      startUrl: `${base}/fixture`,
      steps: [{
        id: "open",
        index: 0,
        timeoutMs: 1000,
        caption: { text: "Open the schedule", citation: { text: "Apply", source: "name" } },
        action: "click",
        target: {
          locators: [{ kind: "role", role: "button", name: "Apply" }, { kind: "text", value: "Apply" }],
          hint: { role: "button", surface: "dom" },
        },
      }],
    });
    app.library.save(workflow);
    const started = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${base}/fixture` }),
    });
    assert.equal(started.status, 200, await started.text());
    const before = await (await fetch(`${base}/api/state`)).json() as {
      recording: boolean;
      replaying: boolean;
      teach: { phase: string };
      runs: unknown[];
    };
    assert.equal(before.recording, true);
    assert.equal(before.teach.phase, "idle");
    const replay = await fetch(`${base}/api/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: workflow.id, args: {} }),
    });
    const body = await replay.json() as { error?: string };
    assert.equal(replay.status, 409);
    assert.match(body.error || "", /recording is open/);
    const after = await (await fetch(`${base}/api/state`)).json() as typeof before;
    assert.equal(after.recording, true);
    assert.equal(after.replaying, false);
    assert.equal(after.teach.phase, "idle");
    assert.equal(after.runs.length, 0);
  } finally {
    await app.close();
    rmSync(path.dirname(dirs.home), { recursive: true, force: true });
  }
});
