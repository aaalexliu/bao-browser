import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import type { HumanAsk } from "../../src/v1/human-ask";
import { occupy, snapshot, type RunSeat } from "../../src/app/run-seat";

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
  const view = snapshot(guide.seat);
  assert.equal(view.replaying, true);
  assert.equal(view.ownedRunId, "run-1");
  assert.equal(view.runExecuting, true);
  assert.equal(view.activeRun?.phase, "waiting");
});

test("ending an owned wait drops ownership and keeps the ask", () => {
  const ended = occupy(ownedWait(), { type: "end-run", id: "run-1" });
  assert.equal(ended.ok, true);
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
  assert.equal(snapshot(again.seat).ownedRunId, "run-1");
});

test("an ask for another run cannot take an owned seat", () => {
  const taken = occupy(ownedWait(), { type: "show-ask", ask: ask("run-2") });
  assert.equal(taken.ok, false);
  assert.equal(snapshot(taken.seat).activeRun?.id, "run-1");
});

test("guide parks a returned hold and restores it", () => {
  const returned = occupy(ownedWait(), { type: "end-run", id: "run-1" }).seat;
  const guide = occupy(returned, { type: "start-guide" });
  assert.equal(guide.ok, true);
  const during = snapshot(guide.seat);
  assert.equal(during.replaying, true);
  assert.equal(during.ownedRunId, null);
  assert.equal(during.activeRun?.id, "run-1");
  const restored = occupy(guide.seat, { type: "end-guide" });
  const after = snapshot(restored.seat);
  assert.equal(after.replaying, false);
  assert.equal(after.ownedRunId, null);
  assert.equal(after.activeRun?.id, "run-1");
  assert.equal(after.activeRun?.phase, "waiting");
});

test("clearing a held ask keeps it on the running view", () => {
  const cleared = occupy(ownedWait(), { type: "clear-ask", kind: "login" });
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
  const view = snapshot(again.seat);
  assert.equal(view.replaying, true);
  assert.equal(view.ownedRunId, "run-2");
  assert.equal(view.activeRun?.phase, "running");
});

async function appendedSeatDiagnostics(appended: string): Promise<number[]> {
  const sourcePath = path.resolve("desktop/src/app/run-seat.ts");
  const original = await readFile(sourcePath, "utf8");
  const configPath = path.resolve("tsconfig.desktop.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(configFile.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
  const host = ts.createCompilerHost(parsed.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (path.resolve(fileName) === sourcePath) {
      const version = typeof languageVersion === "number" ? languageVersion : ts.ScriptTarget.ES2022;
      return ts.createSourceFile(fileName, `${original}\n${appended}\n`, version, true, ts.ScriptKind.TS);
    }
    return getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  const program = ts.createProgram([sourcePath], parsed.options, host);
  return ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file !== undefined && path.resolve(diagnostic.file.fileName) === sourcePath && (diagnostic.start ?? 0) >= original.length)
    .map((diagnostic) => diagnostic.code);
}

test("the seat type rejects an owned run that is not replaying", async () => {
  assert.deepEqual(await appendedSeatDiagnostics('const value: SeatView = { replaying: false, ownedRunId: null, activeRun: null, runExecuting: false, stop: false, continued: false }; void value;'), []);
  assert.ok((await appendedSeatDiagnostics('const value: RunSeat = { phase: "idle", ownedRunId: "run-1", stop: false, continued: false }; void value;')).includes(2353));
  const illegal = await appendedSeatDiagnostics([
    "type IllegalOwnedIdle = Extract<SeatView, { replaying: false; ownedRunId: string }>;",
    "const illegalOwnedIdle: IllegalOwnedIdle = { replaying: false, ownedRunId: \"run-1\", activeRun: null, runExecuting: false, stop: false, continued: false };",
    "void illegalOwnedIdle;",
  ].join("\n"));
  assert.ok(illegal.includes(2322));
});

test("stop and continue stay on every phase", () => {
  const idle: RunSeat = { phase: "idle", stop: false, continued: false };
  const executing = occupy(idle, { type: "start-run", id: "run-1", workflowId: "wf", startedAt: 10 }).seat;
  const holding = occupy(executing, { type: "show-ask", ask: ask("run-1") }).seat;
  const returned = occupy(holding, { type: "end-run", id: "run-1" }).seat;
  const guiding = occupy(idle, { type: "start-guide" }).seat;
  for (const seat of [idle, executing, holding, returned, guiding]) {
    const before = snapshot(seat);
    const stopped = snapshot(occupy(seat, { type: "stop" }).seat);
    assert.equal(stopped.stop, true);
    assert.equal(stopped.continued, false);
    assert.equal(stopped.replaying, before.replaying);
    assert.equal(stopped.ownedRunId, before.ownedRunId);
    assert.equal(stopped.activeRun?.id ?? null, before.activeRun?.id ?? null);
    assert.equal(stopped.activeRun?.phase, before.activeRun?.phase);
    const continued = snapshot(occupy(seat, { type: "continue" }).seat);
    assert.equal(continued.continued, true);
    assert.equal(continued.stop, false);
    assert.equal(continued.replaying, before.replaying);
    assert.equal(continued.ownedRunId, before.ownedRunId);
    assert.equal(continued.activeRun?.id ?? null, before.activeRun?.id ?? null);
    assert.equal(continued.activeRun?.phase, before.activeRun?.phase);
  }
});

test("the seat type rejects a running replay with no owner and two owning runs", async () => {
  const runningUnowned = await appendedSeatDiagnostics([
    "const runningUnowned: SeatView = {",
    "  replaying: true,",
    "  ownedRunId: null,",
    "  activeRun: { id: \"run-1\", workflowId: \"wf\", startedAt: 1, phase: \"running\", ask: null },",
    "  runExecuting: true,",
    "  stop: false,",
    "  continued: false,",
    "};",
    "void runningUnowned;",
  ].join("\n"));
  assert.ok(runningUnowned.includes(2322));
  assert.ok((await appendedSeatDiagnostics('const twoIds: RunSeat = { phase: "executing", id: "run-1", otherId: "run-2", workflowId: "wf", startedAt: 1, ask: null, stop: false, continued: false }; void twoIds;')).includes(2353));
  const twoOwners = await appendedSeatDiagnostics([
    "type TwoOwners = (Extract<RunSeat, { phase: \"executing\" }> & { id: \"run-1\" }) & (Extract<RunSeat, { phase: \"holding\" }> & { id: \"run-2\" });",
    "const twoOwners: TwoOwners = { phase: \"executing\", id: \"run-1\", workflowId: \"wf\", startedAt: 1, ask: null, stop: false, continued: false };",
    "void twoOwners;",
  ].join("\n"));
  assert.ok(twoOwners.includes(2322));
});
