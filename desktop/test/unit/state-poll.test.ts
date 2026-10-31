import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { activePolling, createStatePoller } from "../../src/app/state-poll";
import type { ShellState } from "../../src/app/views";

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

test("window requests start fast polling before server state changes and stay fast until all settle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const poller = createStatePoller({
    poll: async () => { calls += 1; },
    active: () => false,
    visible: () => true,
  });
  await poller.refresh();
  await advance(t, 900);
  let finishReplay: (result: string) => void = () => {};
  const replay = poller.track(new Promise<string>((resolve) => { finishReplay = resolve; }));
  await setImmediate();
  assert.equal(calls, 2, "starting a request refreshes immediately, without waiting for the idle tick");
  await advance(t, 99);
  assert.equal(calls, 2);
  await advance(t, 1);
  assert.equal(calls, 3, "pending requests poll fast even if the server still reports idle");

  let failGuide: (error: Error) => void = () => {};
  const guide = poller.track(new Promise<void>((_resolve, reject) => { failGuide = reject; }));
  const failed = assert.rejects(guide, /guide refused/);
  await setImmediate();
  assert.equal(calls, 4);
  finishReplay("passed");
  assert.equal(await replay, "passed");
  await setImmediate();
  assert.equal(calls, 5, "completed requests refresh the result");
  await advance(t, 99);
  assert.equal(calls, 5);
  await advance(t, 1);
  assert.equal(calls, 6, "one finished request must not slow another pending request");

  failGuide(new Error("guide refused"));
  await failed;
  await setImmediate();
  assert.equal(calls, 7);
  await advance(t, 999);
  assert.equal(calls, 7, "failed requests release their fast-poll count");
  await advance(t, 1);
  assert.equal(calls, 8);
});

for (const kind of ["login", "confirm", "wall"] as const) {
  test(`orphan ${kind} asks poll at the idle rate while genuine waits stay fast`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const startedAt = Date.now();
    const timeoutMs = kind === "wall" ? 0 : 7200000;
    const state: ShellState = {
      replaying: false,
      activeAsk: {
        kind, workflowId: "wf", workflowName: "Fixture", stepId: "step", stepIndex: 1, stepCount: 1,
        label: "Waiting", site: "localhost", windowName: "Bao", instruction: "Waiting for you", startedAt,
        deadline: timeoutMs ? startedAt + timeoutMs : null, timeoutMs,
      },
    };
    let calls = 0;
    const poller = createStatePoller({
      poll: async () => { calls += 1; },
      active: () => activePolling(state),
      visible: () => true,
    });
    await poller.refresh();
    await advance(t, 999);
    assert.equal(calls, 1, "an ask without a waiting run must not keep fast polling alive");
    await advance(t, 1);
    assert.equal(calls, 2);

    state.replaying = true;
    await poller.refresh();
    await advance(t, 99);
    assert.equal(calls, 3);
    await advance(t, 1);
    assert.equal(calls, 4, "a replay waiting for the person still polls at 100 ms");

    state.replaying = false;
    state.remote = { phase: "running" };
    await poller.refresh();
    await advance(t, 99);
    assert.equal(calls, 5);
    await advance(t, 1);
    assert.equal(calls, 6, "a remote run waiting for the person still polls at 100 ms");

    state.remote = { phase: "idle" };
    await poller.refresh();
    assert.ok(state.activeAsk);
    await advance(t, 999);
    assert.equal(calls, 7);
    await advance(t, 1);
    assert.equal(calls, 8, "an ask left after the run ends returns to the idle rate");
  });
}

test("a failed guide returns to idle polling even if its last progress still says highlight", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = {
    replaying: true,
    guide: { workflowId: "wf", runId: "guide", status: "highlight" as const, actions: 0, index: 0, total: 1, stepId: "step", intent: "Type" },
  };
  let calls = 0;
  const poller = createStatePoller({
    poll: async () => { calls += 1; },
    active: () => activePolling(state),
    visible: () => true,
  });
  let failGuide: (error: Error) => void = () => {};
  const guide = poller.track(new Promise<void>((_resolve, reject) => { failGuide = reject; }));
  const failed = assert.rejects(guide, /page closed/);
  await setImmediate();
  assert.equal(calls, 1);
  await advance(t, 100);
  assert.equal(calls, 2);

  state.replaying = false;
  failGuide(new Error("page closed"));
  await failed;
  await setImmediate();
  assert.equal(calls, 3);
  assert.equal(state.guide.status, "highlight");
  for (let second = 0; second < 3; second++) {
    await advance(t, 999);
    assert.equal(calls, 3 + second);
    await advance(t, 1);
    assert.equal(calls, 4 + second);
  }
});

test("a stale running live record cannot keep a restarted or closed session polling fast", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = { liveSessionOpen: false, liveSession: { status: "running" } };
  let calls = 0;
  const poller = createStatePoller({
    poll: async () => { calls += 1; },
    active: () => activePolling(state),
    visible: () => true,
  });
  await poller.refresh();
  await advance(t, 999);
  assert.equal(calls, 1, "a record left by an earlier process is not active work");
  await advance(t, 1);
  assert.equal(calls, 2);

  state.liveSessionOpen = true;
  await poller.refresh();
  await advance(t, 99);
  assert.equal(calls, 3);
  await advance(t, 1);
  assert.equal(calls, 4, "a session owned by the current host still polls fast");

  state.liveSessionOpen = false;
  await poller.refresh();
  assert.equal(state.liveSession.status, "running");
  await advance(t, 999);
  assert.equal(calls, 5);
  await advance(t, 1);
  assert.equal(calls, 6, "ending the current session restores idle polling regardless of the record");
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

test("hidden windows keep a five-second poll for idle and active work, then refresh on return", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let visible = true;
  let active = true;
  let calls = 0;
  const poller = createStatePoller({
    poll: async () => { calls += 1; },
    active: () => active,
    visible: () => visible,
  });
  await poller.refresh();
  visible = false;
  poller.visibilityChanged();
  for (let tick = 0; tick < 12; tick++) {
    active = tick < 6;
    await advance(t, 4999);
    assert.equal(calls, tick + 1);
    await advance(t, 1);
    assert.equal(calls, tick + 2, "hidden windows still drive server housekeeping");
  }
  active = true;
  visible = true;
  poller.visibilityChanged();
  await setImmediate();
  assert.equal(calls, 14);
  await advance(t, 99);
  assert.equal(calls, 14);
  await advance(t, 1);
  assert.equal(calls, 15);
});

test("hidden connection failures retain the retry cap and reset to the hidden cadence", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let refused = true;
  const poller = createStatePoller({
    poll: async () => {
      calls += 1;
      if (refused) throw new Error("connection refused");
    },
    active: () => true,
    visible: () => false,
  });
  await assert.rejects(poller.refresh(), /connection refused/);
  for (const delay of [5000, 5000, 5000, 5000, 8000, 10000, 10000]) {
    const before = calls;
    await advance(t, delay - 1);
    assert.equal(calls, before);
    await advance(t, 1);
    assert.equal(calls, before + 1);
  }
  refused = false;
  await advance(t, 10000);
  const afterSuccess = calls;
  await advance(t, 4999);
  assert.equal(calls, afterSuccess);
  await advance(t, 1);
  assert.equal(calls, afterSuccess + 1);
});

test("hiding during a request schedules a slow poll when that request settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let visible = true;
  let calls = 0;
  let release: () => void = () => {};
  const poller = createStatePoller({
    poll: () => {
      calls += 1;
      return new Promise<void>((resolve) => { release = resolve; });
    },
    active: () => true,
    visible: () => visible,
  });
  const first = poller.refresh();
  await setImmediate();
  visible = false;
  poller.visibilityChanged();
  await advance(t, 60000);
  assert.equal(calls, 1);
  release();
  await first;
  await advance(t, 4999);
  assert.equal(calls, 1);
  await advance(t, 1);
  assert.equal(calls, 2);
  release();
  await setImmediate();
});

test("slow requests never overlap and polling resumes only after they settle", async (t) => {
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
  const first = poller.refresh();
  await advance(t, 60000);
  assert.equal(calls, 1);
  release();
  await first;
  await advance(t, 99);
  assert.equal(calls, 1);
  await advance(t, 1);
  assert.equal(calls, 2);
  await advance(t, 60000);
  assert.equal(calls, 2);
  release();
  await setImmediate();
  await advance(t, 99);
  assert.equal(calls, 2);
  await advance(t, 1);
  assert.equal(calls, 3);
  release();
  await setImmediate();
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
  assert.equal(activePolling({ guide }), false);
  assert.equal(activePolling({ guide, replaying: true }), true);
  assert.equal(activePolling({ guide: { ...guide, status: "passed" } }), false);
  assert.equal(activePolling({ activeAsk: {
    kind: "login", workflowId: "wf", workflowName: "Fixture", stepId: "step", stepIndex: 1, stepCount: 1,
    label: "Sign in", site: "localhost", windowName: "Bao", instruction: "Sign in", startedAt: 0, deadline: null, timeoutMs: 1000,
  } }), false);
  assert.equal(activePolling({ liveSessionOpen: true }), true);
  assert.equal(activePolling({ liveSessionOpen: false }), false);
  assert.equal(activePolling({ pendingImport: { phase: "running" } }), true);
  assert.equal(activePolling({ remote: { phase: "running" } }), true);
  assert.equal(activePolling({ remote: { phase: "confirm" } }), true);
  for (const status of ["passed", "failed", "paused", "needs_human", "timed-out", "refused"]) {
    assert.equal(activePolling({ runs: [{ id: "run", workflowId: "workflow", status }] }), false);
  }
  assert.equal(activePolling({ teach: { phase: "review" } }), false);
});
