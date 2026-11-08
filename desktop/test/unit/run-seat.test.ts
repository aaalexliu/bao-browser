import assert from "node:assert/strict";
import test from "node:test";
import type { HumanAsk } from "../../src/v1/human-ask";
import { occupy, snapshot, type RunSeat, type SeatEvent } from "../../src/app/run-seat";

function ask(runId: string, kind: HumanAsk["kind"] = "login"): HumanAsk {
  return {
    kind,
    workflowId: "wf",
    workflowName: "Workflow",
    stepId: "step",
    stepIndex: 1,
    stepCount: 1,
    label: "Sign in",
    site: "example.test",
    windowName: "Example",
    instruction: "Sign in",
    startedAt: 20,
    deadline: null,
    timeoutMs: 1000,
    runId,
  };
}

function ownedWait(): RunSeat {
  const started = occupy({ phase: "idle", stop: false, continued: false }, {
    type: "start-run",
    id: "run-1",
    workflowId: "wf",
    startedAt: 10,
  });
  assert.equal(started.ok, true);
  const waiting = occupy(started.seat, { type: "show-ask", ask: ask("run-1") });
  assert.equal(waiting.ok, true);
  return waiting.seat;
}

test("a guide cannot clear an owned wait", () => {
  const seat = ownedWait();
  const guide = occupy(seat, { type: "start-guide" });
  assert.equal(guide.ok, false);
  if (guide.ok) return;
  assert.equal(guide.reason, "busy");
  assert.equal(guide.seat, seat);
  assertPublished(guide.seat);
  const view = snapshot(guide.seat);
  assert.equal(view.replaying, true);
  assert.equal(view.ownedRunId, "run-1");
  assert.equal(view.runExecuting, true);
  assert.equal(view.activeRun?.phase, "waiting");
});

test("ending an owned wait drops ownership and keeps the ask", () => {
  const ended = occupy(ownedWait(), { type: "end-run", id: "run-1" });
  assert.equal(ended.ok, true);
  assertPublished(ended.seat);
  const view = snapshot(ended.seat);
  assert.equal(view.replaying, false);
  assert.equal(view.ownedRunId, null);
  assert.equal(view.runExecuting, false);
  assert.equal(view.activeRun?.id, "run-1");
  assert.equal(view.activeRun?.phase, "waiting");
});

test("a second run cannot replace an executing seat", () => {
  const started = occupy({ phase: "idle", stop: false, continued: false }, {
    type: "start-run",
    id: "run-1",
    workflowId: "wf",
    startedAt: 10,
  });
  const again = occupy(started.seat, { type: "start-run", id: "run-2", workflowId: "wf", startedAt: 11 });
  assert.equal(again.ok, false);
  assertPublished(started.seat);
  assertPublished(again.seat);
  assert.equal(snapshot(again.seat).ownedRunId, "run-1");
});

test("an ask for another run cannot take an owned seat", () => {
  const taken = occupy(ownedWait(), { type: "show-ask", ask: ask("run-2") });
  assert.equal(taken.ok, false);
  assertPublished(taken.seat);
  assert.equal(snapshot(taken.seat).activeRun?.id, "run-1");
});

test("guide parks a returned hold and restores it", () => {
  const returned = occupy(ownedWait(), { type: "end-run", id: "run-1" }).seat;
  const guide = occupy(returned, { type: "start-guide" });
  assert.equal(guide.ok, true);
  assertPublished(returned);
  assertPublished(guide.seat);
  const during = snapshot(guide.seat);
  assert.equal(during.replaying, true);
  assert.equal(during.ownedRunId, null);
  assert.equal(during.activeRun?.id, "run-1");
  const restored = occupy(guide.seat, { type: "end-guide" });
  assertPublished(restored.seat);
  const after = snapshot(restored.seat);
  assert.equal(after.replaying, false);
  assert.equal(after.ownedRunId, null);
  assert.equal(after.activeRun?.id, "run-1");
  assert.equal(after.activeRun?.phase, "waiting");
});

test("clearing a held ask keeps it on the running view", () => {
  const cleared = occupy(ownedWait(), { type: "clear-ask", kind: "login", runId: "run-1" });
  assertPublished(cleared.seat);
  const view = snapshot(cleared.seat);
  assert.equal(view.replaying, true);
  assert.equal(view.ownedRunId, "run-1");
  assert.equal(view.activeRun?.phase, "running");
  assert.equal(view.activeRun && "ask" in view.activeRun ? view.activeRun.ask?.stepId : "", "step");
});

test("a returned hold can start again", () => {
  const returned = occupy(ownedWait(), { type: "end-run", id: "run-1" }).seat;
  const again = occupy(returned, { type: "start-run", id: "run-2", workflowId: "wf", startedAt: 30 });
  assert.equal(again.ok, true);
  assertPublished(returned);
  assertPublished(again.seat);
  const view = snapshot(again.seat);
  assert.equal(view.replaying, true);
  assert.equal(view.ownedRunId, "run-2");
  assert.equal(view.activeRun?.phase, "running");
});

function assertPublished(seat: RunSeat): void {
  const view = snapshot(seat);
  if (view.activeRun?.phase === "running") {
    assert.equal(view.replaying, true);
    assert.equal(view.ownedRunId, view.activeRun.id);
    assert.equal(view.runExecuting, true);
  }
  if (view.ownedRunId) {
    assert.equal(view.replaying, true);
    assert.equal(view.runExecuting, true);
    assert.equal(view.activeRun?.id, view.ownedRunId);
  }
  if (!view.replaying) assert.equal(view.ownedRunId, null);
}

test("stop and continue stay on every phase", () => {
  const idle: RunSeat = { phase: "idle", stop: false, continued: false };
  const executing = occupy(idle, { type: "start-run", id: "run-1", workflowId: "wf", startedAt: 10 }).seat;
  const holding = occupy(executing, { type: "show-ask", ask: ask("run-1") }).seat;
  const returned = occupy(holding, { type: "end-run", id: "run-1" }).seat;
  const guiding = occupy(idle, { type: "start-guide" }).seat;
  for (const seat of [idle, executing, holding, returned, guiding]) {
    assertPublished(seat);
    const before = snapshot(seat);
    const stoppedSeat = occupy(seat, { type: "stop" }).seat;
    assertPublished(stoppedSeat);
    const stopped = snapshot(stoppedSeat);
    assert.equal(stopped.stop, true);
    assert.equal(stopped.continued, false);
    assert.equal(stopped.replaying, before.replaying);
    assert.equal(stopped.ownedRunId, before.ownedRunId);
    assert.equal(stopped.activeRun?.id ?? null, before.activeRun?.id ?? null);
    assert.equal(stopped.activeRun?.phase, before.activeRun?.phase);
    const continuedSeat = occupy(seat, { type: "continue" }).seat;
    assertPublished(continuedSeat);
    const continued = snapshot(continuedSeat);
    assert.equal(continued.continued, true);
    assert.equal(continued.stop, false);
    assert.equal(continued.replaying, before.replaying);
    assert.equal(continued.ownedRunId, before.ownedRunId);
    assert.equal(continued.activeRun?.id ?? null, before.activeRun?.id ?? null);
    assert.equal(continued.activeRun?.phase, before.activeRun?.phase);
  }
});

test("a second start cannot take an executing or holding seat", () => {
  const idle: RunSeat = { phase: "idle", stop: false, continued: false };
  const executing = occupy(idle, { type: "start-run", id: "run-1", workflowId: "wf", startedAt: 10 }).seat;
  const holding = occupy(executing, { type: "show-ask", ask: ask("run-1") }).seat;
  const refused: SeatEvent[] = [
    { type: "start-run", id: "run-2", workflowId: "wf", startedAt: 11 },
    { type: "start-guide" },
  ];
  for (const seat of [executing, holding]) {
    for (const event of refused) {
      const again = occupy(seat, event);
      assert.equal(again.ok, false);
      assert.equal(again.seat, seat);
      assert.equal(snapshot(again.seat).ownedRunId, "run-1");
      assert.equal(snapshot(again.seat).replaying, true);
      assertPublished(again.seat);
    }
  }
});

test("a relay clear does not remove a local hold", () => {
  const seat = ownedWait();
  const refused = occupy(seat, { type: "show-ask", ask: ask("run-2") });
  assert.equal(refused.ok, false);
  const cleared = occupy(refused.seat, { type: "clear-ask", kind: "login", runId: "run-2" });
  assert.equal(cleared.seat, seat);
  const view = snapshot(cleared.seat);
  assert.equal(view.ownedRunId, "run-1");
  assert.equal(view.replaying, true);
  assert.equal(view.activeRun?.phase, "waiting");
  assert.equal(view.activeRun?.id, "run-1");
  const matched = occupy(seat, { type: "clear-ask", kind: "login", runId: "run-1" });
  assert.equal(snapshot(matched.seat).activeRun?.phase, "running");
  assert.equal(snapshot(matched.seat).ownedRunId, "run-1");
});

test("a guide keeps one hold, so a later ask cannot leave the parked hold in Needs you", () => {
  const returned = occupy(ownedWait(), { type: "end-run", id: "run-1" }).seat;
  const guide = occupy(returned, { type: "start-guide" });
  assert.equal(guide.ok, true);
  assertPublished(returned);
  assertPublished(guide.seat);
  assert.equal(snapshot(guide.seat).activeRun?.id, "run-1");
  assert.equal(snapshot(guide.seat).activeRun?.startedAt, 10);
  const other = occupy(guide.seat, { type: "show-ask", ask: ask("run-2") });
  assert.equal(other.ok, true);
  assert.equal(snapshot(other.seat).activeRun?.id, "run-2");
  assert.equal(snapshot(other.seat).ownedRunId, null);
  const cleared = occupy(other.seat, { type: "clear-ask", kind: "login", runId: "run-2" });
  assert.equal(snapshot(cleared.seat).activeRun, null);
  assertPublished(other.seat);
  assertPublished(cleared.seat);
  const ended = occupy(cleared.seat, { type: "end-guide" });
  assertPublished(ended.seat);
  const after = snapshot(ended.seat);
  assert.equal(after.replaying, false);
  assert.equal(after.ownedRunId, null);
  assert.equal(after.activeRun, null);
  const kept = occupy(guide.seat, { type: "clear-ask", kind: "login", runId: "run-2" });
  assert.equal(snapshot(kept.seat).activeRun?.id, "run-1");
  const same = occupy(guide.seat, { type: "show-ask", ask: { ...ask("run-1"), startedAt: 99 } });
  assert.equal(snapshot(same.seat).activeRun?.startedAt, 10);
});
