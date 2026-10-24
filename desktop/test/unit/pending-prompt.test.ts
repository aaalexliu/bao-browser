// A "you need to act" prompt is a file in the app home. Closing the server
// and starting it again puts the bar back. A deadline that has passed, with
// no replay still waiting, marks the run stopped, timed out.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { actBar, rail, runKind, statusLabel, type RunSummary } from "../../src/app/views";
import { makeAsk, type HumanAsk } from "../../src/v1/human-ask";
import { Library } from "../../src/v1/store";
import {
  promptDue,
  readPendingPrompt,
  writePendingPrompt,
  type PendingPrompt,
} from "../../src/v1/pending-prompt";

process.env.BAO_HEAL_CURSOR_ACCOUNT = "0";

function home(): string {
  return mkdtempSync(path.join(tmpdir(), "bao-prompt-"));
}

function loginAsk(runId: string, now: number, timeoutMs: number): HumanAsk {
  return makeAsk({
    kind: "login",
    workflowId: "wf-persist",
    workflowName: "Persist login",
    stepId: "login",
    stepIndex: 1,
    stepCount: 2,
    label: "sign in",
    timeoutMs,
    now,
    runId,
  });
}

function prompt(ask: HumanAsk): PendingPrompt {
  return { ask, runId: ask.runId || "" };
}

function pausedStub(dir: string, ask: HumanAsk): void {
  new Library(dir).saveRun({
    id: ask.runId || "",
    workflowId: ask.workflowId,
    status: "paused",
    at: ask.startedAt,
    heals: [],
    steps: [{ id: ask.stepId, status: "paused", label: ask.label }],
  });
}

async function state(port: number): Promise<{ activeAsk: HumanAsk | null; runs: RunSummary[] }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/state`);
  assert.equal(res.ok, true);
  return await res.json() as { activeAsk: HumanAsk | null; runs: RunSummary[] };
}

test("a deadline of null or zero does not expire", () => {
  const ask = loginAsk("run-open", 1_000, 0);
  assert.equal(ask.deadline, null);
  assert.equal(promptDue(prompt(ask), 1_000_000), false);
  const zero = { ...ask, deadline: 0 };
  assert.equal(promptDue(prompt(zero), 1), false);
});

test("a pending prompt is restored after the app is closed and opened", async () => {
  const dir = home();
  const ask = loginAsk("run-restore", Date.now(), 60 * 60 * 1000);
  writePendingPrompt(dir, prompt(ask));
  pausedStub(dir, ask);
  const first = await startApp({ home: dir, port: 0 });
  const opened = await state(first.port);
  assert.equal(opened.activeAsk?.kind, "login");
  assert.equal(opened.activeAsk?.runId, "run-restore");
  await first.close();

  const second = await startApp({ home: dir, port: 0 });
  try {
    const restored = await state(second.port);
    assert.equal(restored.activeAsk?.instruction, "Sign in to the site in the Bao window");
    assert.equal(restored.activeAsk?.runId, "run-restore");
    assert.ok(readPendingPrompt(dir));
    const bar = actBar({ activeAsk: restored.activeAsk });
    assert.match(bar, /id="act-bar"/);
    assert.match(bar, /You need to act/);
    assert.match(bar, /Sign in to the site in the Bao window/);
    const side = rail({ activeAsk: restored.activeAsk, runs: [] });
    assert.match(side, /id="attention" data-count="1"/);
    assert.match(side, /1 waiting/);
    const run = second.library.readRun("run-restore");
    assert.equal(run.status, "paused");
    assert.equal(statusLabel(runKind({ id: run.id, workflowId: run.workflowId, status: run.status })), "needs you");
  } finally {
    await second.close();
  }
});

test("a prompt past its deadline marks the run stopped, timed out", async () => {
  const dir = home();
  const ask = loginAsk("run-late", Date.now() - 10_000, 1000);
  assert.ok(ask.deadline && ask.deadline < Date.now());
  writePendingPrompt(dir, prompt(ask));
  const app = await startApp({ home: dir, port: 0 });
  try {
    const body = await state(app.port);
    assert.equal(body.activeAsk, null);
    const run = app.library.readRun("run-late");
    assert.equal(run.status, "timed-out");
    assert.equal(statusLabel(runKind({ id: run.id, workflowId: run.workflowId, status: run.status })), "stopped, timed out");
    const failure = run.failure as { reason?: string };
    assert.equal(failure.reason, "stopped, timed out");
    assert.equal(readPendingPrompt(dir), null);
    const listed = body.runs.find((item) => item.id === "run-late");
    assert.equal(listed && statusLabel(runKind(listed)), "stopped, timed out");
  } finally {
    await app.close();
  }
});

test("an open app expires a restored prompt on the next state read", async () => {
  const dir = home();
  const ask = loginAsk("run-open", Date.now(), 60 * 60 * 1000);
  writePendingPrompt(dir, prompt(ask));
  const app = await startApp({ home: dir, port: 0 });
  try {
    const live = await state(app.port);
    assert.equal(live.activeAsk?.kind, "login");
    writePendingPrompt(dir, prompt({ ...ask, deadline: Date.now() - 5 }));
    const next = await state(app.port);
    assert.equal(next.activeAsk, null);
    const run = app.library.readRun("run-open");
    assert.equal(run.status, "timed-out");
    assert.equal(statusLabel(runKind({ id: run.id, workflowId: run.workflowId, status: run.status })), "stopped, timed out");
    assert.equal(readPendingPrompt(dir), null);
  } finally {
    await app.close();
  }
});

test("cancel on a restored prompt clears the bar and leaves the run paused", async () => {
  const dir = home();
  const ask = loginAsk("run-cancel", Date.now(), 60 * 60 * 1000);
  writePendingPrompt(dir, prompt(ask));
  pausedStub(dir, ask);
  const app = await startApp({ home: dir, port: 0 });
  try {
    const live = await state(app.port);
    assert.equal(live.activeAsk?.kind, "login");
    const res = await fetch(`http://127.0.0.1:${app.port}/api/replay/cancel`, { method: "POST" });
    assert.equal(res.ok, true);
    const next = await state(app.port);
    assert.equal(next.activeAsk, null);
    assert.equal(readPendingPrompt(dir), null);
    assert.equal(app.library.readRun("run-cancel").status, "paused");
  } finally {
    await app.close();
  }
});
