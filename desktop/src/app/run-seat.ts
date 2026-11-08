// One local run seat. A guide keeps one hold. It cannot clear an owned run.
import type { ActiveRun } from "./views";
import type { AskKind, HumanAsk } from "../v1/human-ask";

export interface ReturnedHold {
  id: string;
  workflowId: string;
  startedAt: number;
  ask: HumanAsk;
}

type Flags = { stop: boolean; continued: boolean };

export type RunSeat =
  | ({ phase: "idle" } & Flags)
  | ({ phase: "executing"; id: string; workflowId: string; startedAt: number; ask: HumanAsk | null } & Flags)
  | ({ phase: "holding"; id: string; workflowId: string; startedAt: number; ask: HumanAsk } & Flags)
  | ({ phase: "returned"; hold: ReturnedHold } & Flags)
  | ({ phase: "guiding"; hold: ReturnedHold | null } & Flags);

export type SeatView =
  | { replaying: false; ownedRunId: null; activeRun: null; runExecuting: false; stop: boolean; continued: boolean }
  | { replaying: true; ownedRunId: string; activeRun: Extract<ActiveRun, { phase: "running" }>; runExecuting: true; stop: boolean; continued: boolean }
  | { replaying: true; ownedRunId: string; activeRun: Extract<ActiveRun, { phase: "waiting" }>; runExecuting: true; stop: boolean; continued: boolean }
  | { replaying: false; ownedRunId: null; activeRun: Extract<ActiveRun, { phase: "waiting" }>; runExecuting: false; stop: boolean; continued: boolean }
  | { replaying: true; ownedRunId: null; activeRun: Extract<ActiveRun, { phase: "waiting" }> | null; runExecuting: false; stop: boolean; continued: boolean };

export type SeatEvent =
  | { type: "start-run"; id: string; workflowId: string; startedAt: number }
  | { type: "end-run"; id: string }
  | { type: "start-guide" }
  | { type: "end-guide" }
  | { type: "show-ask"; ask: HumanAsk }
  | { type: "clear-ask"; kind: AskKind; runId: string }
  | { type: "continue" }
  | { type: "clear-continued" }
  | { type: "stop" }
  | { type: "clear-stop" }
  | { type: "restore"; hold: ReturnedHold }
  | { type: "drop-returned" };

export type OccupyResult =
  | { ok: true; seat: RunSeat }
  | { ok: false; reason: "busy"; seat: RunSeat };

const cleared: Flags = { stop: false, continued: false };

function flagsOf(seat: RunSeat): Flags {
  return { stop: seat.stop, continued: seat.continued };
}

function waiting(hold: ReturnedHold): Extract<ActiveRun, { phase: "waiting" }> {
  return { id: hold.id, workflowId: hold.workflowId, startedAt: hold.startedAt, phase: "waiting", ask: hold.ask };
}

function returned(hold: ReturnedHold, flags: Flags): RunSeat {
  return { phase: "returned", hold, ...flags };
}

export function snapshot(seat: RunSeat): SeatView {
  switch (seat.phase) {
    case "idle":
      return { replaying: false, ownedRunId: null, activeRun: null, runExecuting: false, ...flagsOf(seat) };
    case "executing":
      return {
        replaying: true,
        ownedRunId: seat.id,
        activeRun: { id: seat.id, workflowId: seat.workflowId, startedAt: seat.startedAt, phase: "running", ask: seat.ask },
        runExecuting: true,
        ...flagsOf(seat),
      };
    case "holding":
      return {
        replaying: true,
        ownedRunId: seat.id,
        activeRun: waiting({ id: seat.id, workflowId: seat.workflowId, startedAt: seat.startedAt, ask: seat.ask }),
        runExecuting: true,
        ...flagsOf(seat),
      };
    case "returned":
      return { replaying: false, ownedRunId: null, activeRun: waiting(seat.hold), runExecuting: false, ...flagsOf(seat) };
    case "guiding":
      return {
        replaying: true,
        ownedRunId: null,
        activeRun: seat.hold ? waiting(seat.hold) : null,
        runExecuting: false,
        ...flagsOf(seat),
      };
    default: {
      const unexpected: never = seat;
      return unexpected;
    }
  }
}

function setFlags(seat: RunSeat, flags: Flags): RunSeat {
  return { ...seat, ...flags };
}

function clearAsk(seat: RunSeat, kind: AskKind, runId: string): RunSeat {
  switch (seat.phase) {
    case "holding":
      if (seat.id !== runId || seat.ask.kind !== kind) return seat;
      return {
        phase: "executing",
        id: seat.id,
        workflowId: seat.workflowId,
        startedAt: seat.startedAt,
        ask: seat.ask,
        ...flagsOf(seat),
      };
    case "returned":
      if (seat.hold.id !== runId || seat.hold.ask.kind !== kind) return seat;
      return { phase: "idle", ...flagsOf(seat) };
    case "guiding":
      if (!seat.hold || seat.hold.id !== runId || seat.hold.ask.kind !== kind) return seat;
      return { ...seat, hold: null };
    case "idle":
    case "executing":
      return seat;
    default: {
      const unexpected: never = seat;
      return unexpected;
    }
  }
}

function showAsk(seat: RunSeat, ask: HumanAsk): OccupyResult {
  if (!ask.runId) return { ok: true, seat };
  switch (seat.phase) {
    case "executing":
    case "holding":
      if (ask.runId !== seat.id) return { ok: false, reason: "busy", seat };
      return {
        ok: true,
        seat: {
          phase: "holding",
          id: seat.id,
          workflowId: seat.workflowId,
          startedAt: seat.startedAt,
          ask,
          ...flagsOf(seat),
        },
      };
    case "idle":
      return {
        ok: true,
        seat: returned({
          id: ask.runId,
          workflowId: ask.workflowId,
          startedAt: ask.startedAt,
          ask,
        }, flagsOf(seat)),
      };
    case "returned":
      return {
        ok: true,
        seat: returned({
          id: ask.runId,
          workflowId: ask.workflowId,
          startedAt: seat.hold.id === ask.runId ? seat.hold.startedAt : ask.startedAt,
          ask,
        }, flagsOf(seat)),
      };
    case "guiding":
      return {
        ok: true,
        seat: {
          ...seat,
          hold: {
            id: ask.runId,
            workflowId: ask.workflowId,
            startedAt: seat.hold?.id === ask.runId ? seat.hold.startedAt : ask.startedAt,
            ask,
          },
        },
      };
    default: {
      const unexpected: never = seat;
      return unexpected;
    }
  }
}

export function occupy(seat: RunSeat, event: SeatEvent): OccupyResult {
  switch (event.type) {
    case "start-run":
      if (seat.phase !== "idle" && seat.phase !== "returned") return { ok: false, reason: "busy", seat };
      return {
        ok: true,
        seat: {
          phase: "executing",
          id: event.id,
          workflowId: event.workflowId,
          startedAt: event.startedAt,
          ask: null,
          ...cleared,
        },
      };
    case "end-run":
      if (seat.phase === "executing" && seat.id === event.id) return { ok: true, seat: { phase: "idle", ...flagsOf(seat) } };
      if (seat.phase === "holding" && seat.id === event.id) {
        return {
          ok: true,
          seat: returned({
            id: seat.id,
            workflowId: seat.workflowId,
            startedAt: seat.startedAt,
            ask: seat.ask,
          }, flagsOf(seat)),
        };
      }
      return { ok: true, seat };
    case "start-guide":
      if (seat.phase === "idle") return { ok: true, seat: { phase: "guiding", hold: null, ...cleared } };
      if (seat.phase === "returned") return { ok: true, seat: { phase: "guiding", hold: seat.hold, ...cleared } };
      return { ok: false, reason: "busy", seat };
    case "end-guide":
      if (seat.phase !== "guiding") return { ok: true, seat };
      if (seat.hold) return { ok: true, seat: returned(seat.hold, flagsOf(seat)) };
      return { ok: true, seat: { phase: "idle", ...flagsOf(seat) } };
    case "show-ask":
      return showAsk(seat, event.ask);
    case "clear-ask":
      return { ok: true, seat: clearAsk(seat, event.kind, event.runId) };
    case "continue":
      return { ok: true, seat: setFlags(seat, { stop: seat.stop, continued: true }) };
    case "clear-continued":
      return { ok: true, seat: setFlags(seat, { stop: seat.stop, continued: false }) };
    case "stop":
      return { ok: true, seat: setFlags(seat, { stop: true, continued: seat.continued }) };
    case "clear-stop":
      return { ok: true, seat: setFlags(seat, { stop: false, continued: seat.continued }) };
    case "restore":
      if (seat.phase === "idle") return { ok: true, seat: returned(event.hold, flagsOf(seat)) };
      if (seat.phase === "guiding" && !seat.hold) return { ok: true, seat: { ...seat, hold: event.hold } };
      return { ok: true, seat };
    case "drop-returned":
      if (seat.phase === "returned") return { ok: true, seat: { phase: "idle", ...flagsOf(seat) } };
      return { ok: true, seat };
    default: {
      const unexpected: never = event;
      return unexpected;
    }
  }
}
