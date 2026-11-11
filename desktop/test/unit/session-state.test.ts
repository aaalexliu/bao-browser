import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
  assert.equal(teaching.session.phase, "teachStarting");
  const teachRefused = moveSession(teaching.session, { type: "take-browser" });
  assert.equal(teachRefused.ok, false);
  assert.equal(teachRefused.session, teaching.session);
  const live = moveSession(teaching.session, { type: "teach-ready" });
  assert.equal(live.ok, true);
  assert.equal(moveSession(live.session, { type: "take-browser" }).ok, false);

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

test("a new capture cannot start over teach", () => {
  const starting = moveSession({ phase: "idle" }, { type: "start-teach", since: 4 });
  assert.equal(starting.session.phase, "teachStarting");
  assert.equal(moveSession(starting.session, { type: "finish-teach" }).ok, false);
  const review = moveSession(moveSession(starting.session, { type: "teach-ready" }).session, { type: "finish-teach" });
  assert.equal(review.session.phase, "teachReview");
  assert.equal(moveSession(review.session, { type: "start-recording", since: 5 }).ok, false);
  assert.equal(moveSession({ phase: "teachStarting", since: 3 }, { type: "start-recording", since: 8 }).ok, false);
  assert.equal(moveSession({ phase: "teachLive", since: 7 }, { type: "start-recording", since: 8 }).ok, false);
  assert.equal(moveSession({ phase: "saveSheet", pending }, { type: "start-teach", since: 9 }).ok, false);
  assert.equal(moveSession({ phase: "teachStarting", since: 3 }, { type: "open-save", pending }).ok, false);
  assert.equal(moveSession({ phase: "teachLive", since: 7 }, { type: "open-save", pending }).ok, false);
  assert.equal(moveSession(review.session, { type: "open-save", pending }).ok, false);
  assert.equal(moveSession(recording(), { type: "open-save", pending }).session.phase, "saveSheet");
});

test("a capture can start over an open save sheet", () => {
  const started = moveSession({ phase: "saveSheet", pending }, { type: "start-recording", since: 6 });
  assert.equal(started.ok, true);
  assert.equal(started.session.phase, "recording");
  if (started.session.phase !== "recording") return;
  assert.equal(started.session.pending, pending);
  assert.equal(moveSession(started.session, { type: "take-browser" }).ok, false);
  assert.deepEqual(moveSession(started.session, { type: "discard" }).session, { phase: "saveSheet", pending });
  assert.deepEqual(moveSession(started.session, { type: "abort-start" }).session, { phase: "saveSheet", pending });
  const kept = moveSession(started.session, { type: "commit-save" });
  assert.equal(kept.ok, true);
  assert.equal(kept.session.phase, "recording");
  if (kept.session.phase === "recording") assert.equal(kept.session.pending, undefined);
});

test("teach claims its seat, then becomes live with the same clock", () => {
  const starting = moveSession({ phase: "idle" }, { type: "start-teach", since: 20 });
  assert.equal(starting.ok, true);
  assert.deepEqual(starting.session, { phase: "teachStarting", since: 20 });
  const live = moveSession(starting.session, { type: "teach-ready" });
  assert.equal(live.ok, true);
  assert.deepEqual(live.session, { phase: "teachLive", since: 20 });
  if (live.session.phase !== "teachLive") return;
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

async function claimedTeach(label: string): Promise<{
  base: string;
  hits: () => number;
  release: () => void;
  teach: Promise<Response>;
  close: () => Promise<void>;
}> {
  const gate = holdPage();
  let hits = 0;
  const hung = createServer((_req, res) => {
    hits += 1;
    void gate.promise.then(() => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Held</title><p>Held page</p>");
    });
  });
  await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", () => resolve()));
  const address = hung.address();
  const hungPort = typeof address === "object" && address ? address.port : 0;
  const dirs = applyHermeticApp(label);
  const app = await startApp({ home: dirs.home, port: 0, chromeUserData: dirs.chromeUserData });
  const base = `http://127.0.0.1:${app.port}`;
  const teach = fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `http://127.0.0.1:${hungPort}/held`, teach: true }),
  });
  const start = Date.now();
  let launching = false;
  while (Date.now() - start < 15_000) {
    const state = await (await fetch(`${base}/api/state`)).json() as { recording: boolean; teach: { phase: string } };
    if (!state.recording && state.teach.phase !== "live" && hits > 0) {
      launching = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(launching, true, "teach launch was not observed");
  return {
    base,
    hits: () => hits,
    release: () => gate.release(),
    teach,
    close: async () => {
      gate.release();
      await teach.catch(() => undefined);
      await app.close();
      await new Promise<void>((resolve, reject) => hung.close((err) => err ? reject(err) : resolve()));
      rmSync(path.dirname(dirs.home), { recursive: true, force: true });
    },
  };
}

function holdPage(): { promise: Promise<void>; release: () => void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("a replay during a teach launch is refused and the teach comes up as teach", { timeout: 120_000 }, async () => {
  assert.ok(process.env.BAO_TEST_BROWSER, "Run with laneChildEnv so Chromium is pinned");
  const gate = holdPage();
  let hits = 0;
  const hung = createServer((_req, res) => {
    hits += 1;
    void gate.promise.then(() => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Held</title><p>Held page</p>");
    });
  });
  await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", () => resolve()));
  const address = hung.address();
  const hungPort = typeof address === "object" && address ? address.port : 0;
  const dirs = applyHermeticApp("teach-launch-gap");
  const app = await startApp({ home: dirs.home, port: 0, chromeUserData: dirs.chromeUserData });
  const base = `http://127.0.0.1:${app.port}`;
  let teach = Promise.resolve(new Response());
  try {
    const workflow = testWorkflow({
      id: "wf-during-teach-launch",
      name: "During teach launch",
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
    teach = fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `http://127.0.0.1:${hungPort}/held`, teach: true }),
    });
    const start = Date.now();
    let launching = false;
    while (Date.now() - start < 15_000) {
      const state = await (await fetch(`${base}/api/state`)).json() as {
        recording: boolean;
        teach: { phase: string };
      };
      if (!state.recording && state.teach.phase !== "live" && hits > 0) {
        launching = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(launching, true, "teach launch was not observed");
    const during = await (await fetch(`${base}/api/state`)).json() as {
      recording: boolean;
      teach: { phase: string };
    };
    assert.equal(during.recording, false);
    assert.notEqual(during.teach.phase, "live");
    const replay = await fetch(`${base}/api/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: workflow.id, args: {} }),
    });
    const refused = await replay.json() as { error?: string };
    assert.equal(replay.status, 409);
    assert.match(refused.error || "", /recording is open/);
    const captureStart = fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${base}/fixture` }),
    });
    gate.release();
    const captureStarted = await captureStart;
    assert.equal(captureStarted.status, 409, await captureStarted.text());
    const started = await teach;
    assert.equal(started.status, 200, await started.text());
    const after = await (await fetch(`${base}/api/state`)).json() as {
      recording: boolean;
      replaying: boolean;
      teach: { phase: string };
      runs: unknown[];
    };
    assert.equal(after.teach.phase, "live");
    assert.equal(after.recording, true);
    assert.equal(after.replaying, false);
    assert.equal(after.runs.length, 0);
  } finally {
    gate.release();
    await teach.catch(() => undefined);
    await app.close();
    await new Promise<void>((resolve, reject) => hung.close((err) => err ? reject(err) : resolve()));
    rmSync(path.dirname(dirs.home), { recursive: true, force: true });
  }
});

test("a check during a slow opening navigation is refused", { timeout: 120_000 }, async () => {
  assert.ok(process.env.BAO_TEST_BROWSER, "Run with laneChildEnv so Chromium is pinned");
  process.env.BAO_DRIVE = "1";
  const launch = await claimedTeach("teach-check-launch");
  try {
    const check = await fetch(`${launch.base}/api/teach/check`, { method: "POST" });
    assert.equal(check.status, 409);
    const drive = await fetch(`${launch.base}/api/sessions/drive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goto: "about:blank" }),
    });
    assert.equal(drive.status, 409);
    const during = await (await fetch(`${launch.base}/api/state`)).json() as {
      recording: boolean;
      teach: { phase: string };
      liveTrail: { op: string }[];
    };
    assert.equal(during.recording, false);
    assert.notEqual(during.teach.phase, "live");
    assert.equal(during.liveTrail.some((event) => event.op === "verify"), false);
    launch.release();
    const started = await launch.teach;
    assert.equal(started.status, 200, await started.text());
    const after = await (await fetch(`${launch.base}/api/state`)).json() as {
      teach: { phase: string };
      liveTrail: { op: string }[];
    };
    assert.equal(after.teach.phase, "live");
    assert.equal(after.liveTrail.some((event) => event.op === "verify"), false);
  } finally {
    delete process.env.BAO_DRIVE;
    await launch.close();
  }
});

test("a stop during a teach launch waits for the page", { timeout: 120_000 }, async () => {
  assert.ok(process.env.BAO_TEST_BROWSER, "Run with laneChildEnv so Chromium is pinned");
  const launch = await claimedTeach("teach-stop-launch");
  try {
    let done = false;
    const stopping = fetch(`${launch.base}/api/teach/stop`, { method: "POST" }).then((res) => {
      done = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(done, false, "stop finished before the capture page existed");
    launch.release();
    const stopped = await stopping;
    assert.equal(stopped.status, 200, await stopped.text());
    const started = await launch.teach;
    assert.equal(started.status, 200, await started.text());
    const after = await (await fetch(`${launch.base}/api/state`)).json() as {
      recording: boolean;
      teach: { phase: string };
      saveSheet: unknown;
    };
    assert.equal(after.teach.phase, "review");
    assert.equal(after.recording, false);
    assert.equal(after.saveSheet, null);
  } finally {
    await launch.close();
  }
});

test("a capture stop during a teach launch waits for the page", { timeout: 120_000 }, async () => {
  assert.ok(process.env.BAO_TEST_BROWSER, "Run with laneChildEnv so Chromium is pinned");
  const launch = await claimedTeach("teach-capture-stop-launch");
  try {
    let done = false;
    const stopping = fetch(`${launch.base}/api/sessions/stop`, { method: "POST" }).then((res) => {
      done = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(done, false, "stop finished before the capture page existed");
    launch.release();
    const stopped = await stopping;
    assert.equal(stopped.status, 200, await stopped.text());
    await launch.teach;
    const after = await (await fetch(`${launch.base}/api/state`)).json() as {
      recording: boolean;
      teach: { phase: string };
      saveSheet: unknown;
    };
    assert.equal(after.teach.phase, "review");
    assert.equal(after.recording, false);
    assert.equal(after.saveSheet, null);
  } finally {
    await launch.close();
  }
});

test("a discard during a teach launch waits for the page", { timeout: 120_000 }, async () => {
  assert.ok(process.env.BAO_TEST_BROWSER, "Run with laneChildEnv so Chromium is pinned");
  const launch = await claimedTeach("teach-discard-launch");
  try {
    let done = false;
    const discarding = fetch(`${launch.base}/api/teach/discard`, { method: "POST" }).then((res) => {
      done = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(done, false, "discard finished before the capture page existed");
    launch.release();
    const discarded = await discarding;
    assert.equal(discarded.status, 200, await discarded.text());
    await launch.teach;
    const after = await (await fetch(`${launch.base}/api/state`)).json() as {
      recording: boolean;
      replaying: boolean;
      teach: { phase: string };
    };
    assert.equal(after.teach.phase, "idle");
    assert.equal(after.recording, false);
    assert.equal(after.replaying, false);
  } finally {
    await launch.close();
  }
});

test("a stop during live teach keeps the demonstration", { timeout: 120_000 }, async () => {
  assert.ok(process.env.BAO_TEST_BROWSER, "Run with laneChildEnv so Chromium is pinned");
  const dirs = applyHermeticApp("teach-stop-keeps");
  const bar = path.join(dirs.home, "fake-bar.js");
  writeFileSync(bar, [
    "#!/usr/bin/env node",
    "let buf = \"\";",
    "let sent = false;",
    "process.stdin.setEncoding(\"utf8\");",
    "process.stdin.on(\"data\", (chunk) => {",
    "  buf += chunk;",
    "  let nl = buf.indexOf(\"\\n\");",
    "  while (nl >= 0) {",
    "    const line = buf.slice(0, nl).trim();",
    "    buf = buf.slice(nl + 1);",
    "    nl = buf.indexOf(\"\\n\");",
    "    if (!line || sent) continue;",
    "    try {",
    "      const msg = JSON.parse(line);",
    "      if (msg.cmd === \"show\" && Array.isArray(msg.steps) && msg.steps.length > 0) {",
    "        sent = true;",
    "        process.stdout.write(JSON.stringify({ event: \"hotkey\", name: \"stop\" }) + \"\\n\");",
    "        process.stdout.write(JSON.stringify({ event: \"check\", text: \"after the stop\" }) + \"\\n\");",
    "      }",
    "    } catch { /* ignore a partial line */ }",
    "  }",
    "});",
    "",
  ].join("\n"));
  chmodSync(bar, 0o755);
  process.env.BAO_CAPTURE_BAR = "1";
  process.env.BAO_CAPTURE_BAR_BIN = bar;
  const app = await startApp({ home: dirs.home, port: 0, chromeUserData: dirs.chromeUserData });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const started = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${base}/fixture`, teach: true }),
    });
    assert.equal(started.status, 200, await started.text());
    const noted = await fetch(`${base}/api/sessions/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "keep this demonstration" }),
    });
    assert.equal(noted.status, 200, await noted.text());
    const start = Date.now();
    let steps: string[] = [];
    let phase = "";
    while (Date.now() - start < 8_000) {
      const state = await (await fetch(`${base}/api/state`)).json() as {
        recording: boolean;
        capture: { steps: string[] };
        teach: { phase: string };
      };
      steps = state.capture.steps;
      phase = state.teach.phase;
      if (steps.some((step) => step.includes("after the stop"))) break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(phase, "live");
    assert.equal(steps.some((step) => step.includes("keep this demonstration")), true);
    assert.equal(steps.some((step) => step.includes("after the stop")), true);
    assert.equal(existsSync(path.join(dirs.home, "shots", "pending")), false);
  } finally {
    delete process.env.BAO_CAPTURE_BAR;
    delete process.env.BAO_CAPTURE_BAR_BIN;
    await app.close();
    rmSync(path.dirname(dirs.home), { recursive: true, force: true });
  }
});

test("a failed save leaves the capture so it can be saved again", { timeout: 120_000 }, async () => {
  assert.ok(process.env.BAO_TEST_BROWSER, "Run with laneChildEnv so Chromium is pinned");
  const dirs = applyHermeticApp("save-retry");
  const app = await startApp({ home: dirs.home, port: 0, chromeUserData: dirs.chromeUserData });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const started = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${base}/fixture` }),
    });
    assert.equal(started.status, 200, await started.text());
    const noted = await fetch(`${base}/api/sessions/note`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "keep the transfer" }),
    });
    assert.equal(noted.status, 200, await noted.text());
    const blocked = path.join(dirs.home, "shots", "pending");
    mkdirSync(path.dirname(blocked), { recursive: true });
    writeFileSync(blocked, "not a directory");
    const failed = await fetch(`${base}/api/sessions/stop`, { method: "POST" });
    const failure = await failed.text();
    assert.equal(failed.status, 500, failure);
    const mid = await (await fetch(`${base}/api/state`)).json() as {
      recording: boolean;
      replaying: boolean;
      liveTrail: { op: string }[];
      teach: { phase: string };
    };
    assert.equal(mid.recording, false);
    assert.equal(mid.replaying, false);
    assert.equal(mid.teach.phase, "idle");
    assert.equal(mid.liveTrail.some((event) => event.op === "note"), true);
    rmSync(blocked);
    const again = await fetch(`${base}/api/sessions/stop`, { method: "POST" });
    const savedText = await again.text();
    assert.equal(again.status, 200, savedText);
    assert.match(savedText, /keep the transfer/);
    const after = await (await fetch(`${base}/api/state`)).json() as { saveSheet: { id: string } | null };
    assert.ok(after.saveSheet);
  } finally {
    await app.close();
    rmSync(path.dirname(dirs.home), { recursive: true, force: true });
  }
});

test("a failed save leaves recording and lets a new capture start", { timeout: 120_000 }, async () => {
  assert.ok(process.env.BAO_TEST_BROWSER, "Run with laneChildEnv so Chromium is pinned");
  const dirs = applyHermeticApp("save-start-again");
  const app = await startApp({ home: dirs.home, port: 0, chromeUserData: dirs.chromeUserData });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const started = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${base}/fixture` }),
    });
    assert.equal(started.status, 200, await started.text());
    const noted = await fetch(`${base}/api/sessions/note`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "keep the transfer" }),
    });
    assert.equal(noted.status, 200, await noted.text());
    const blocked = path.join(dirs.home, "shots", "pending");
    mkdirSync(path.dirname(blocked), { recursive: true });
    writeFileSync(blocked, "not a directory");
    const failed = await fetch(`${base}/api/sessions/stop`, { method: "POST" });
    assert.equal(failed.status, 500, await failed.text());
    const mid = await (await fetch(`${base}/api/state`)).json() as {
      recording: boolean;
      replaying: boolean;
      liveTrail: { op: string }[];
    };
    assert.equal(mid.recording, false);
    assert.equal(mid.replaying, false);
    assert.equal(mid.liveTrail.some((event) => event.op === "note"), true);
    const again = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${base}/fixture` }),
    });
    assert.equal(again.status, 200, await again.text());
    const after = await (await fetch(`${base}/api/state`)).json() as { recording: boolean; replaying: boolean };
    assert.equal(after.recording, true);
    assert.equal(after.replaying, false);
  } finally {
    await app.close();
    rmSync(path.dirname(dirs.home), { recursive: true, force: true });
  }
});
