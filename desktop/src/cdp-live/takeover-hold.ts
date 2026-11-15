// The hold process owns the overlay on Running Chrome. A session speaks on the socket the hold already counted.
// It does not open another debugging connection.

import type { Socket } from "node:net";
import type { FinishOutcome } from "../../../shared/takeover-overlay";
import type { CdpSocket } from "./socket";
import { HELD_SKIP, Takeover, type TakeoverOptions } from "./takeover";

const LINE_MAX = 1024 * 1024;
const CALL_MS = 10_000;

interface HoldState {
  held: boolean;
  heldSince?: number;
  stopped: boolean;
  confirming?: boolean;
}

type HoldReply = HoldState & {
  ok: boolean;
  error?: string;
  outcome?: "done" | "timeout" | "disconnect";
  skipped?: boolean;
};

type HoldEvent =
  | { event: "handoff"; startedAt: number; endedAt: number }
  | { event: "open" }
  | { event: "disconnect" }
  | { event: "askDone" }
  | { event: "held"; held: boolean; heldSince?: number }
  | { event: "confirm"; open: boolean };

interface HoldRequest {
  id: number;
  op: string;
  targetId?: string;
  count?: number;
  text?: string;
  x?: number;
  y?: number;
  hidden?: boolean;
  outcome?: FinishOutcome;
  limitMs?: number;
}

export interface TakeoverHold {
  attach(socket: Socket): void;
  close(): Promise<void>;
}

/** Serves overlay commands on sockets the hold has already counted. */
export function serveTakeoverHold(cdp: CdpSocket): TakeoverHold {
  const sessions = new Set<HoldOverlay>();
  return {
    attach(socket) {
      if (socket.destroyed) return;
      const session = new HoldOverlay(cdp, socket);
      sessions.add(session);
      socket.once("close", () => {
        sessions.delete(session);
        void session.dispose();
      });
      session.listen();
    },
    async close() {
      const open = [...sessions];
      sessions.clear();
      await Promise.all(open.map((session) => session.dispose()));
    },
  };
}

class HoldOverlay {
  private readonly takeover: Takeover;
  private buffer = "";
  private disposed = false;

  constructor(private readonly cdp: CdpSocket, private readonly socket: Socket) {
    const write = (event: HoldEvent) => {
      if (!this.disposed && !socket.destroyed) socket.write(`${JSON.stringify(event)}\n`);
    };
    this.takeover = new Takeover({
      finishHoldMs: process.env.BAO_LANE ? 0 : 4000,
      onHandoff: (startedAt, endedAt) => write({ event: "handoff", startedAt, endedAt }),
      onOpen: () => write({ event: "open" }),
      onDisconnect: () => write({ event: "disconnect" }),
      onAskDone: () => write({ event: "askDone" }),
      onHeld: () => write({ event: "held", held: this.takeover.held, heldSince: this.takeover.heldSince }),
      onConfirm: (open) => write({ event: "confirm", open }),
    });
  }

  listen(): void {
    this.socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      if (this.buffer.length > LINE_MAX) {
        this.buffer = "";
        this.socket.destroy();
        return;
      }
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line) void this.onLine(line);
        newline = this.buffer.indexOf("\n");
      }
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.takeover.dispose().catch(() => undefined);
  }

  private state(): HoldState {
    return {
      held: this.takeover.held,
      heldSince: this.takeover.heldSince,
      stopped: this.takeover.stoppedByOwner,
      confirming: this.takeover.confirming,
    };
  }

  private reply(id: number, body: Omit<HoldReply, "held" | "stopped"> & Partial<HoldState>): void {
    if (this.socket.destroyed) return;
    const state = this.state();
    this.socket.write(`${JSON.stringify({ id, ...state, ...body })}\n`);
  }

  private async onLine(line: string): Promise<void> {
    let request: HoldRequest;
    try {
      request = JSON.parse(line) as HoldRequest;
    } catch {
      return;
    }
    if (!Number.isInteger(request.id) || typeof request.op !== "string") return;
    try {
      const extra = await this.run(request);
      this.reply(request.id, { ok: true, ...extra });
    } catch (error) {
      this.reply(request.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async run(request: HoldRequest): Promise<Partial<HoldReply>> {
    const takeover = this.takeover;
    if (request.op === "attach") {
      if (typeof request.count === "number") await takeover.noteOwned(request.count);
      await takeover.attachShared(this.cdp, request.targetId);
      return {};
    }
    if (request.op === "owned") {
      await takeover.noteOwned(request.count ?? 1);
      return {};
    }
    if (request.op === "follow") {
      await takeover.follow(request.targetId);
      return {};
    }
    if (request.op === "activity") {
      await takeover.activityLine(request.text ?? "");
      return {};
    }
    if (request.op === "cursor") {
      await takeover.cursor(request.x ?? 0, request.y ?? 0);
      return {};
    }
    if (request.op === "lower") {
      if (takeover.confirming) {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 12_000);
        try { await takeover.waitConfirm(abort.signal); }
        finally { clearTimeout(timer); }
      }
      if (takeover.held || takeover.confirming) return { skipped: true };
      await takeover.lowerShield();
      if (takeover.held) {
        await takeover.raiseShield();
        return { skipped: true };
      }
      return {};
    }
    if (request.op === "raise") {
      await takeover.raiseShield();
      return {};
    }
    if (request.op === "hide") {
      await takeover.setHidden(request.hidden === true);
      return {};
    }
    if (request.op === "ask") {
      await takeover.showAsk(request.text ?? "");
      return {};
    }
    if (request.op === "clearAsk") {
      await takeover.clearAsk();
      return {};
    }
    if (request.op === "finish") {
      await takeover.finish(request.outcome ?? "finished");
      return {};
    }
    if (request.op === "dispose") {
      await this.dispose();
      return {};
    }
    if (request.op === "state") return {};
    if (request.op === "wait") {
      const limit = Number.isFinite(request.limitMs) ? Math.max(0, request.limitMs ?? 0) : 0;
      const abort = new AbortController();
      const onClose = () => abort.abort();
      this.socket.once("close", onClose);
      const timer = setTimeout(() => abort.abort(), limit + 1000);
      try {
        const outcome = await takeover.waitHandback(abort.signal, limit);
        return { outcome };
      } finally {
        clearTimeout(timer);
        this.socket.off("close", onClose);
      }
    }
    throw new Error(`unknown overlay command ${request.op}`);
  }
}

/** The session side of the hold's overlay. Commands go out on the counted socket. */
export class AdmittedTakeover {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, { resolve: (reply: HoldReply) => void; reject: (error: Error) => void }>();
  private heldFlag = false;
  private heldAt: number | undefined;
  private stopped = false;
  private confirmFlag = false;
  private confirmWait?: () => void;
  private waitingFlag = false;
  private hiddenShots = 0;
  private disposed = false;
  private closing = false;

  constructor(private readonly socket: Socket, private readonly options: TakeoverOptions = {}) {
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", () => undefined);
    socket.once("close", () => this.fail(new Error("session closed")));
  }

  get held(): boolean {
    return this.heldFlag;
  }

  get heldSince(): number | undefined {
    return this.held ? this.heldAt : undefined;
  }

  get waiting(): boolean {
    return this.waitingFlag;
  }

  get stoppedByOwner(): boolean {
    return this.stopped;
  }

  get confirming(): boolean {
    return this.confirmFlag;
  }

  async syncHeld(): Promise<void> {
    this.apply(await this.call("state"));
  }

  async attach(targetId?: string, owned?: number): Promise<void> {
    this.apply(await this.call("attach", { targetId, count: owned }));
  }

  async noteOwned(count: number): Promise<void> {
    this.apply(await this.call("owned", { count }));
  }

  async follow(targetId: string | undefined): Promise<void> {
    this.apply(await this.call("follow", { targetId }));
  }

  async activityLine(text: string): Promise<void> {
    this.apply(await this.call("activity", { text }));
  }

  async cursor(x: number, y: number): Promise<void> {
    this.apply(await this.call("cursor", { x, y }));
  }

  async bracket<T>(fn: () => Promise<T>, signal?: AbortSignal, skip?: () => boolean): Promise<T | typeof HELD_SKIP> {
    return this.lowerAndRun(fn, signal, skip, 0);
  }

  private async lowerAndRun<T>(fn: () => Promise<T>, signal: AbortSignal | undefined, skip: (() => boolean) | undefined, depth: number): Promise<T | typeof HELD_SKIP> {
    if (this.held || skip?.()) return HELD_SKIP;
    const reply = await this.call("lower", {}, 15_000);
    this.apply(reply);
    if (skip?.()) {
      if (!reply.skipped) await this.call("raise").catch(() => undefined);
      return HELD_SKIP;
    }
    if (this.confirming && !this.held && depth < 2) {
      await this.waitConfirm(signal ?? AbortSignal.timeout(12_000));
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return this.lowerAndRun(fn, signal, skip, depth + 1);
    }
    if (reply.skipped || this.held) return HELD_SKIP;
    try {
      return await fn();
    } finally {
      this.apply(await this.call("raise"));
    }
  }

  async waitConfirm(signal: AbortSignal): Promise<void> {
    if (!this.confirmFlag || signal.aborted) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        signal.removeEventListener("abort", finish);
        if (this.confirmWait === finish) this.confirmWait = undefined;
        resolve();
      };
      this.confirmWait = finish;
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  async hideForShot<T>(fn: () => Promise<T>): Promise<T> {
    this.hiddenShots += 1;
    if (this.hiddenShots === 1) this.apply(await this.call("hide", { hidden: true }));
    try {
      return await fn();
    } finally {
      this.hiddenShots -= 1;
      if (this.hiddenShots === 0 && !this.disposed) this.apply(await this.call("hide", { hidden: false }).catch(() => undefined));
    }
  }

  async showAsk(text: string): Promise<void> {
    this.apply(await this.call("ask", { text }));
  }

  async clearAsk(): Promise<void> {
    this.apply(await this.call("clearAsk"));
  }

  async waitHandback(signal: AbortSignal, limitMs: number): Promise<"done" | "timeout" | "disconnect"> {
    if (!this.held) return "done";
    this.waitingFlag = true;
    const aborted = new Promise<HoldReply>((resolve) => {
      const finish = () => resolve({ ok: true, held: false, stopped: this.stopped, outcome: this.stopped ? "disconnect" : "timeout" });
      if (signal.aborted) finish();
      else signal.addEventListener("abort", finish, { once: true });
    });
    try {
      const reply = await Promise.race([this.call("wait", { limitMs }, limitMs + CALL_MS), aborted]);
      this.apply(reply);
      return reply.outcome ?? "timeout";
    } catch (error) {
      if (signal.aborted || this.stopped) return "disconnect";
      throw error;
    } finally {
      this.waitingFlag = false;
    }
  }

  async finish(outcome: FinishOutcome): Promise<void> {
    this.apply(await this.call("finish", { outcome }, CALL_MS + 4000));
  }

  async dispose(): Promise<void> {
    if (this.disposed || this.closing) return;
    this.closing = true;
    await this.call("dispose").catch(() => undefined);
    this.disposed = true;
    this.fail(new Error("overlay disposed"));
  }

  private apply(reply: HoldReply | undefined): void {
    if (!reply) return;
    this.heldFlag = reply.held;
    this.heldAt = reply.heldSince;
    this.stopped = reply.stopped;
    this.confirmFlag = reply.confirming === true;
    if (!this.confirmFlag) this.confirmWait?.();
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let message: (HoldReply & { id?: number; event?: string }) | HoldEvent;
    try {
      message = JSON.parse(line) as HoldReply & { id?: number; event?: string };
    } catch {
      return;
    }
    if ("event" in message && message.event) {
      this.onEvent(message as HoldEvent);
      return;
    }
    const reply = message as HoldReply & { id?: number };
    const waiter = typeof reply.id === "number" ? this.pending.get(reply.id) : undefined;
    if (!waiter) return;
    this.pending.delete(reply.id as number);
    if (reply.ok) waiter.resolve(reply);
    else waiter.reject(new Error(reply.error || "overlay command failed"));
  }

  private onEvent(event: HoldEvent): void {
    if (event.event === "handoff") this.options.onHandoff?.(event.startedAt, event.endedAt);
    else if (event.event === "open") this.options.onOpen?.();
    else if (event.event === "askDone") this.options.onAskDone?.();
    else if (event.event === "held") {
      this.heldFlag = event.held;
      this.heldAt = event.heldSince;
      this.options.onHeld?.(event.held);
    } else if (event.event === "confirm") {
      this.confirmFlag = event.open;
      this.options.onConfirm?.(event.open);
      if (!event.open) this.confirmWait?.();
    } else if (event.event === "disconnect") {
      this.stopped = true;
      this.heldFlag = false;
      this.confirmFlag = false;
      this.confirmWait?.();
      if (!this.waitingFlag) this.options.onDisconnect?.();
    }
  }

  private call(op: string, extra: Record<string, unknown> = {}, timeoutMs = CALL_MS): Promise<HoldReply> {
    if (this.disposed || this.socket.destroyed) return Promise.reject(new Error("overlay is not connected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`overlay timeout ${op}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (reply) => {
          clearTimeout(timer);
          resolve(reply);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.write(`${JSON.stringify({ id, op, ...extra })}\n`);
    });
  }

  private fail(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}
