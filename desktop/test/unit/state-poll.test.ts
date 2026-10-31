import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { activePolling, createStatePoller } from "../../src/app/state-poll";

async function advance(t: TestContext, ms: number): Promise<void> {
  t.mock.timers.tick(ms);
  await setImmediate();
}

test("idle state polls once a second and live work keeps the 100 ms cadence", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let active = false;
  const poller = createStatePoller({
    poll: async () => { calls += 1; },
    active: () => active,
    visible: () => true,
  });
  t.after(poller.stop);
  await poller.refresh();
  for (let second = 0; second < 60; second++) await advance(t, 1000);
  assert.equal(calls, 61);

  active = true;
  await poller.refresh();
  const liveStart = calls;
  for (let tick = 0; tick < 10; tick++) await advance(t, 100);
  assert.equal(calls - liveStart, 10);

  active = false;
  await poller.refresh();
  const idleStart = calls;
  await advance(t, 999);
  assert.equal(calls, idleStart);
  await advance(t, 1);
  assert.equal(calls, idleStart + 1);
});

test("connection failures back off from 500 ms to 10 seconds and success resets the delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let refused = true;
  const poller = createStatePoller({
    poll: async () => {
      calls += 1;
      if (refused) throw new Error("connection refused");
    },
    active: () => false,
    visible: () => true,
  });
  t.after(poller.stop);
  await assert.rejects(poller.refresh(), /connection refused/);
  for (const delay of [500, 1000, 2000, 4000, 8000, 10000, 10000]) {
    const before = calls;
    await advance(t, delay - 1);
    assert.equal(calls, before, `retried before ${delay} ms`);
    await advance(t, 1);
    assert.equal(calls, before + 1);
  }

  refused = false;
  const beforeSuccess = calls;
  await advance(t, 9999);
  assert.equal(calls, beforeSuccess);
  await advance(t, 1);
  assert.equal(calls, beforeSuccess + 1);
  await advance(t, 999);
  assert.equal(calls, beforeSuccess + 1);
  await advance(t, 1);
  assert.equal(calls, beforeSuccess + 2);

  refused = true;
  await advance(t, 1000);
  const afterFailure = calls;
  await advance(t, 499);
  assert.equal(calls, afterFailure);
  await advance(t, 1);
  assert.equal(calls, afterFailure + 1, "the next failure starts at 500 ms again");
});

test("hidden windows stop polling, then refresh immediately when visible", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let visible = true;
  let calls = 0;
  const poller = createStatePoller({
    poll: async () => { calls += 1; },
    active: () => true,
    visible: () => visible,
  });
  t.after(poller.stop);
  await poller.refresh();
  visible = false;
  poller.visibilityChanged();
  await advance(t, 60000);
  assert.equal(calls, 1);
  visible = true;
  poller.visibilityChanged();
  await setImmediate();
  assert.equal(calls, 2);
  await advance(t, 99);
  assert.equal(calls, 2);
  await advance(t, 1);
  assert.equal(calls, 3);
});

test("slow requests never overlap and stopped requests cannot restart polling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let release: () => void = () => {};
  const poller = createStatePoller({
    poll: () => {
      calls += 1;
      return new Promise<void>((resolve) => { release = resolve; });
    },
    active: () => true,
    visible: () => true,
  });
  t.after(poller.stop);
  const first = poller.refresh();
  await advance(t, 60000);
  assert.equal(calls, 1);
  release();
  await first;
  await advance(t, 99);
  assert.equal(calls, 1);
  await advance(t, 1);
  assert.equal(calls, 2);
  poller.stop();
  release();
  await setImmediate();
  await advance(t, 60000);
  assert.equal(calls, 2, "a settled request cannot restart a stopped poller");
});

test("manual refreshes and visibility changes coalesce into a fresh read after an in-flight request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let release: () => void = () => {};
  const poller = createStatePoller({
    poll: () => {
      calls += 1;
      return new Promise<void>((resolve) => { release = resolve; });
    },
    active: () => false,
    visible: () => true,
  });
  t.after(poller.stop);
  const first = poller.refresh();
  const fresh = poller.refresh();
  assert.equal(poller.refresh(), fresh);
  poller.visibilityChanged();
  await advance(t, 60000);
  assert.equal(calls, 1);
  release();
  await first;
  await setImmediate();
  assert.equal(calls, 2);
  release();
  await fresh;
  await advance(t, 999);
  assert.equal(calls, 2);
  await advance(t, 1);
  assert.equal(calls, 3);
  release();
  await setImmediate();
});

test("live work stays fast without treating historical results as active", () => {
  assert.equal(activePolling({}), false);
  assert.equal(activePolling({ recording: true }), true);
  assert.equal(activePolling({ replaying: true }), true);
  assert.equal(activePolling({ teach: { phase: "live" } }), true);
  const guide = { workflowId: "wf", runId: "run", status: "highlight" as const, actions: 0, index: 0, total: 1, stepId: "step", intent: "Click" };
  assert.equal(activePolling({ guide }), true);
  assert.equal(activePolling({ guide: { ...guide, status: "passed" } }), false);
  assert.equal(activePolling({ activeAsk: {
    kind: "login", workflowId: "wf", workflowName: "Fixture", stepId: "step", stepIndex: 1, stepCount: 1,
    label: "Sign in", site: "localhost", windowName: "Bao", instruction: "Sign in", startedAt: 0, deadline: null, timeoutMs: 1000,
  } }), true);
  assert.equal(activePolling({ liveSession: { status: "running" } }), true);
  assert.equal(activePolling({ pendingImport: { phase: "running" } }), true);
  assert.equal(activePolling({ remote: { phase: "running" } }), true);
  assert.equal(activePolling({ remote: { phase: "confirm" } }), true);
  const run = { id: "run", workflowId: "workflow", status: "running" };
  assert.equal(activePolling({ runs: [run] }), true);
  for (const status of ["passed", "failed", "needs_human", "idle"] as const) {
    assert.equal(activePolling({ runs: [{ ...run, status }], liveSession: { status } }), false);
  }
  assert.equal(activePolling({ teach: { phase: "review" } }), false);
});
