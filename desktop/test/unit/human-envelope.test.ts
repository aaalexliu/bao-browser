// A human step returns an envelope and does not block. Resume continues the same
// page. Confirm is never pressed by resume. The fixture is 127.0.0.1 only.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Capture } from "../../src/app/capture";
import { startApp } from "../../src/app/server";
import { runViewer } from "../../src/app/views";
import { runWorkflow, withHeldPage } from "../../src/mcp/catalog";
import { formatClock } from "../../src/v1/time";
import { replay, type Driver } from "../../src/v1/replay";
import type { WorkflowV2 } from "../../src/v1/schema";

const PASSWORD = "BaoSecretFixture9kQ7m";
const ZONE = /(?:AM|PM)\s+(?:[A-Z]{2,5}|GMT[+-]?\d{0,2}|UTC)/;
const ISO_Z = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

test("a yielded confirm does not shoot or press, and resume applies nothing", async () => {
  const clicks: string[] = [];
  let shots = 0;
  const capture = new Capture();
  capture.start();
  const driver = fakeDriver(clicks, ["Waiting to apply"], () => { shots += 1; }, capture);
  const shotDir = mkdtempSync(path.join(tmpdir(), "bao-shots-"));
  const paused = await replay(confirmWorkflow("http://127.0.0.1/fixture"), {}, driver, {
    yieldHuman: true,
    shotDir,
  });
  assert.equal(paused.status, "paused");
  assert.equal(paused.pausedKind, "confirm");
  assert.equal(clicks.length, 0);
  assert.equal(shots, 0);
  assert.equal(capture.push({ kind: "act", op: "click" }), false);
  assert.match(paused.ask?.instruction || "", /Press Apply/);
  assert.match(paused.trail.find((event) => event.phase === "start")?.text || "", /Handoff started/);
  assert.match(paused.trail.find((event) => event.phase === "start")?.text || "", ZONE);
  const resumed = await replay(confirmWorkflow("http://127.0.0.1/fixture"), {}, driver, {
    yieldHuman: true,
    humanReady: true,
    fromStepId: "apply",
    trail: paused.trail,
    shotDir,
  });
  assert.equal(resumed.status, "failed");
  assert.equal(resumed.failure?.reason, "nothing applied");
  assert.equal(clicks.length, 0);
  assert.match(resumed.trail.find((event) => event.phase === "end")?.text || "", /Handoff ended/);
  assert.match(resumed.trail.find((event) => event.phase === "end")?.text || "", ZONE);
});

test("handoff lines stay on the trail while UI events are paused", () => {
  const capture = new Capture();
  capture.start();
  capture.pause();
  assert.equal(capture.push({ kind: "act", op: "click" }), false);
  const started = `Handoff started ${formatClock(Date.now())}`;
  const ended = `Handoff ended ${formatClock(Date.now())}`;
  capture.handoff(started);
  capture.handoff(ended);
  assert.equal(capture.events.length, 2);
  assert.match(capture.events[0]?.afterText || "", ZONE);
  assert.match(capture.events[1]?.afterText || "", /Handoff ended/);
  assert.equal(ISO_Z.test(started), false);
});

test("the run viewer shows the sign-in envelope and the handoff clock", () => {
  const deadline = formatClock(Date.now() + 60_000);
  const html = runViewer({
    id: "run-sign",
    workflowId: "fixture-signin",
    status: "paused",
    modelCalls: 0,
    steps: [{ id: "signin", status: "paused", reason: "sign in" }],
    envelope: {
      status: "needs_signin",
      run_id: "run-sign",
      step: "signin",
      reason: "Sign in to 127.0.0.1 in the Bao window",
      ask: "Sign in to 127.0.0.1 in the Bao window",
      deadline,
      resume_token: "r_abc",
    },
    trail: [{ kind: "handoff", phase: "start", text: `Handoff started ${deadline}` }],
  }, { name: "Fixture sign-in", steps: [{ id: "signin", label: "Sign in" }] });
  assert.match(html, /id="run-envelope"/);
  assert.match(html, /data-status="needs_signin"/);
  assert.match(html, /id="envelope-ask"/);
  assert.match(html, /Sign in to 127\.0\.0\.1 in the Bao window/);
  assert.match(html, /id="envelope-token"/);
  assert.match(html, /id="handoff-trail"/);
  assert.match(html, ZONE);
  assert.equal(ISO_Z.test(html), false);
});

test("scripted driver on the sign-in fixture resumes the same run", { timeout: 60_000 }, async () => {
  process.env.BAO_CHROME_NO_SANDBOX = "1";
  const home = mkdtempSync(path.join(tmpdir(), "bao-envelope-"));
  const app = await startApp({ home, port: 0 });
  let token = "";
  try {
    const base = `http://127.0.0.1:${app.port}`;
    app.library.save(signInWorkflow(base));
    const first = await runWorkflow(app.library, { id: "fixture-signin" });
    token = first.resume_token || "";
    assert.equal(first.status, "needs_signin");
    assert.equal(first.outcome, "needs_signin");
    assert.equal(first.step, "signin");
    assert.match(first.ask || "", /Sign in to 127\.0\.0\.1 in the Bao window/);
    assert.match(first.reason || "", /Sign in to 127\.0\.0\.1/);
    assert.match(first.deadline || "", ZONE);
    assert.match(first.resume_token || "", /^r_[a-f0-9]+$/);
    assert.equal(first.run_id, first.runId);
    assert.equal(JSON.stringify(first).includes(PASSWORD), false);
    const paused = app.library.readRun(first.run_id || "");
    const sign = (paused.steps as { id: string; beforeShot?: string; afterShot?: string }[]).find((step) => step.id === "signin");
    assert.equal(sign?.beforeShot, undefined);
    assert.equal(sign?.afterShot, undefined);
    assert.equal(paused.envelope?.status, "needs_signin");
    await withHeldPage(token, async (page) => {
      await page.locator("#username").fill("ada");
      await page.locator("#continue").click();
      await page.locator("#password").fill(PASSWORD);
      await page.locator("#signin").click();
      await page.waitForURL((url) => url.pathname === "/freeze", { timeout: 15_000 });
    });
    const done = await runWorkflow(app.library, { resume: token });
    token = "";
    assert.equal(done.outcome, "ok");
    assert.equal(done.status, "completed");
    assert.equal(JSON.stringify(done).includes(PASSWORD), false);
    const stored = app.library.readRun(done.run_id || "");
    assert.equal(stored.modelCalls, 0);
    assert.equal(stored.status, "passed");
    const trail = stored.trail as { phase?: string; text?: string }[];
    assert.match(trail.find((event) => event.phase === "start")?.text || "", /Handoff started/);
    assert.match(trail.find((event) => event.phase === "end")?.text || "", /Handoff ended/);
    assert.match(trail.map((event) => event.text || "").join("\n"), ZONE);
  } finally {
    if (token) await runWorkflow(app.library, { resume: token, cancel: true }).catch(() => undefined);
    await app.close();
  }
});

test("a human step past its deadline ends stopped, timed out", { timeout: 60_000 }, async () => {
  process.env.BAO_CHROME_NO_SANDBOX = "1";
  const home = mkdtempSync(path.join(tmpdir(), "bao-envelope-timeout-"));
  const app = await startApp({ home, port: 0 });
  let token = "";
  try {
    const base = `http://127.0.0.1:${app.port}`;
    app.library.updateSettings({ actTimeoutMs: 200 });
    app.library.save(signInWorkflow(base));
    const first = await runWorkflow(app.library, { id: "fixture-signin" });
    token = first.resume_token || "";
    assert.equal(first.status, "needs_signin");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const expired = await runWorkflow(app.library, { resume: token });
    token = "";
    assert.equal(expired.reason, "stopped, timed out");
    assert.equal(expired.status, "timed-out");
    const stored = app.library.readRun(expired.run_id || "");
    assert.equal(stored.status, "timed-out");
  } finally {
    if (token) await runWorkflow(app.library, { resume: token, cancel: true }).catch(() => undefined);
    await app.close();
  }
});

test("cancel and resume leave the confirm button unpressed", { timeout: 60_000 }, async () => {
  process.env.BAO_CHROME_NO_SANDBOX = "1";
  const home = mkdtempSync(path.join(tmpdir(), "bao-envelope-confirm-"));
  const app = await startApp({ home, port: 0 });
  let token = "";
  try {
    const base = `http://127.0.0.1:${app.port}`;
    app.library.save(confirmWorkflow(`${base}/fixture`, "confirm-one"));
    const first = await runWorkflow(app.library, { id: "confirm-one" });
    token = first.resume_token || "";
    assert.equal(first.status, "needs_human");
    assert.match(first.ask || "", /Press Apply on 127\.0\.0\.1 in the Bao window/);
    let waiting = "";
    await withHeldPage(token, async (page) => {
      waiting = await page.locator("#apply-status").innerText();
    });
    assert.equal(waiting, "Waiting to apply");
    const resumed = await runWorkflow(app.library, { resume: token });
    token = "";
    assert.equal(resumed.reason, "nothing applied");
    assert.notEqual(resumed.status, "completed");

    app.library.save(confirmWorkflow(`${base}/fixture`, "confirm-cancel"));
    const second = await runWorkflow(app.library, { id: "confirm-cancel" });
    token = second.resume_token || "";
    const cancelled = await runWorkflow(app.library, { resume: token, cancel: true });
    token = "";
    assert.equal(cancelled.reason, "nothing applied");
    assert.equal(cancelled.status, "stopped");
  } finally {
    if (token) await runWorkflow(app.library, { resume: token, cancel: true }).catch(() => undefined);
    await app.close();
  }
});

function signInWorkflow(base: string): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id: "fixture-signin",
    name: "Fixture sign-in",
    startUrl: `${base}/login?next=/freeze`,
    createdAt: 1,
    precondition: { kind: "url", match: "/freeze", phase: "auth" },
    inputs: [],
    steps: [
      {
        id: "signin",
        index: 0,
        action: "login",
        label: "Sign in",
        surface: "dom",
        timeoutMs: 5000,
        postcondition: { kind: "url", match: "/freeze", timeoutMs: 5000 },
      },
      {
        id: "status",
        index: 1,
        action: "verify",
        label: "Status is none",
        surface: "dom",
        timeoutMs: 2000,
        expect: { kind: "text", match: "Status: none", timeoutMs: 2000 },
      },
    ],
  };
}

function confirmWorkflow(startUrl: string, id = "confirm-apply"): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id,
    name: "Confirm apply",
    startUrl,
    createdAt: 1,
    inputs: [],
    steps: [{
      id: "apply",
      index: 0,
      action: "confirm",
      human: true,
      label: "Confirm before Apply",
      surface: "dom",
      timeoutMs: 1000,
      identity: { surface: "dom", role: "button", testId: "apply", text: "Apply", path: [] },
      postcondition: { kind: "text", match: "Applied", timeoutMs: 1000 },
    }],
  };
}

function fakeDriver(clicks: string[], texts: string[], shot: () => void, capture: Capture): Driver {
  return {
    tree: async () => ({
      nodes: [{ surface: "dom", role: "button", testId: "apply", text: "Apply", path: [] }],
      url: "http://127.0.0.1/fixture",
      texts,
      values: [],
    }),
    snapshot: async () => ({ dom: [] }),
    click: async (node) => { clicks.push(node.testId || node.text || ""); },
    fill: async () => {},
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    sleep: async () => {},
    shot: async () => { shot(); return undefined; },
    showAsk() {},
    showConfirm() {},
    pauseCapture() { capture.pause(); },
    resumeCapture() { capture.resume(); },
  };
}
