import { readDevToolsActivePort } from "./endpoint";
import { connectCdp, type CdpSocket } from "./socket";
import {
  controlState, overlayView, stepControl, takeoverOverlaySource, WATCHDOG_MS,
  type Control, type FinishOutcome, type OverlayView,
} from "../../../shared/takeover-overlay";

/** A CDP send that is already attached to one page, or a browser socket that also takes a session id. */
export interface CdpSend {
  send<T>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
}

export interface TakeoverOptions {
  watchdogMs?: number;
  heartbeatMs?: number;
  finishHoldMs?: number;
  /** Skip the poll and heartbeat. The fail-open test uses this so the page watchdog can fire. */
  quiet?: boolean;
  onDisconnect?: () => void;
  onOpen?: () => void;
  onHandoff?: (startedAt: number, endedAt: number) => void;
  onAskDone?: () => void;
  onHeld?: (held: boolean) => void;
  onConfirm?: (open: boolean) => void;
}

/** Bracket returns this when the owner holds the tab, so the command must not run. */
export const HELD_SKIP = Symbol("bao.held");

interface BoundPage {
  sessionId?: string;
  contextId?: number;
  objectId?: string;
  identifier?: string;
  frameId?: string;
}

const WORLD = "bao-takeover";

/**
 * One control chart for a run.
 * Input.setIgnoreInputEvents on this connection also drops agent-browser's own dispatch, so the shield is the only block.
 * It is down for the one command the agent is running.
 */
export class Takeover {
  private control: Control = controlState();
  private activity = "Working…";
  private lastTab = true;
  private view: OverlayView = overlayView(this.control, this.activity, this.lastTab);
  private cdp?: CdpSocket;
  private ownedSocket = false;
  private sendApi?: CdpSend;
  private page: BoundPage = {};
  private targetId?: string;
  private disposed = false;
  private polling = false;
  private calling = true;
  private askReturned = false;
  private owned?: number;
  private disconnected = false;
  private confirmOpen = false;
  private confirmWait?: () => void;
  private handback?: (outcome: "done" | "timeout" | "disconnect") => void;
  private hiddenShots = 0;
  private readonly source: string;
  private readonly quiet: boolean;
  private readonly heartbeatMs: number;
  private readonly finishHoldMs: number;
  private heart?: ReturnType<typeof setInterval>;
  private unlisten: Array<() => void> = [];

  constructor(private readonly options: TakeoverOptions = {}) {
    this.source = takeoverOverlaySource(options.watchdogMs ?? WATCHDOG_MS);
    this.quiet = options.quiet === true;
    this.heartbeatMs = options.heartbeatMs === undefined ? 5000 : options.heartbeatMs;
    this.finishHoldMs = options.finishHoldMs === undefined ? 4000 : options.finishHoldMs;
  }

  get held(): boolean {
    return (this.control.phase === "owner" || this.control.phase === "taking") && this.control.reason === "takeover";
  }

  get heldSince(): number | undefined {
    return this.held ? this.control.startedAt : undefined;
  }

  get waiting(): boolean {
    return this.handback !== undefined;
  }

  get confirming(): boolean {
    return this.confirmOpen;
  }

  get stoppedByOwner(): boolean {
    return this.disconnected;
  }

  noteAskReturned(): void {
    this.askReturned = true;
  }

  async noteOwned(count: number): Promise<void> {
    this.owned = count;
    await this.refreshLastTab();
  }

  /** Opens its own socket on a Bao profile or copy. Callers do not share this connection. */
  async attachPort(portFile: string, targetId?: string): Promise<void> {
    const endpoint = await readDevToolsActivePort(portFile);
    const cdp = await connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 5000 });
    this.cdp = cdp;
    this.ownedSocket = true;
    this.sendApi = cdp;
    await this.attachTarget(targetId);
    this.startLoops();
  }

  /** Uses a connection the caller owns. dispose does not close it. */
  async attachShared(cdp: CdpSocket, targetId?: string): Promise<void> {
    this.cdp = cdp;
    this.ownedSocket = false;
    this.sendApi = cdp;
    await this.attachTarget(targetId);
    this.startLoops();
  }

  /** A page session that is already attached, such as Playwright's CDP session. */
  async attachPage(send: CdpSend): Promise<void> {
    this.sendApi = send;
    await this.install();
    this.startLoops();
  }

  async activityLine(text: string): Promise<void> {
    this.activity = text || "Working…";
    if (this.control.phase === "agent") await this.push();
  }

  async cursor(x: number, y: number, active = true): Promise<void> {
    await this.call("agent", { active, x, y }).catch(() => undefined);
  }

  async lowerShield(): Promise<void> {
    await this.call("agent", { active: true }).catch(() => undefined);
  }

  async raiseShield(): Promise<void> {
    await this.call("agent", { active: false }).catch(() => undefined);
    if (this.control.phase === "agent") await this.push().catch(() => undefined);
  }

  /** Lowers the shield for one command, then raises it. A hold taken before the command does not lower the shield and does not run. */
  async bracket<T>(fn: () => Promise<T>, signal?: AbortSignal, skip?: () => boolean): Promise<T | typeof HELD_SKIP> {
    if (this.confirmOpen) await this.waitConfirm(signal ?? AbortSignal.timeout(12_000));
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    if (this.held || skip?.()) return HELD_SKIP;
    await this.lowerShield();
    try {
      if (this.held || skip?.()) return HELD_SKIP;
      return await fn();
    } finally {
      await this.raiseShield();
    }
  }

  async waitConfirm(signal: AbortSignal): Promise<void> {
    if (!this.confirmOpen || signal.aborted) return;
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

  async setHidden(hidden: boolean): Promise<void> {
    await this.call("hide", hidden).catch(() => undefined);
  }

  async hideForShot<T>(fn: () => Promise<T>): Promise<T> {
    this.hiddenShots += 1;
    if (this.hiddenShots === 1) await this.call("hide", true).catch(() => undefined);
    try {
      return await fn();
    } finally {
      this.hiddenShots -= 1;
      if (this.hiddenShots === 0 && !this.disposed) await this.call("hide", false).catch(() => undefined);
    }
  }

  async showAsk(text: string): Promise<void> {
    this.control = stepControl(this.control.phase === "agent" ? this.control : controlState(), { type: "ask", ask: text, at: Date.now() });
    await this.push();
  }

  async clearAsk(): Promise<void> {
    if (this.control.reason !== "ask") return;
    this.control = stepControl(this.control, { type: "done", at: Date.now() });
    this.control = stepControl(this.control, { type: "resume" });
    await this.push();
  }

  async waitHandback(signal: AbortSignal, limitMs: number): Promise<"done" | "timeout" | "disconnect"> {
    if (!this.held) return "done";
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome: "done" | "timeout" | "disconnect") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (this.handback === finish) this.handback = undefined;
        resolve(outcome);
      };
      this.handback = finish;
      const timer = setTimeout(() => finish("timeout"), limitMs);
      const onAbort = () => finish(this.disconnected ? "disconnect" : "timeout");
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async follow(targetId: string | undefined): Promise<void> {
    if (!targetId || targetId === this.targetId || !this.cdp) return;
    this.releaseConfirm();
    await this.detachPage().catch(() => undefined);
    await this.attachTarget(targetId);
  }

  async finish(outcome: FinishOutcome): Promise<void> {
    this.control = stepControl(this.control, { type: "finish", outcome });
    await this.push().catch(() => undefined);
    if (this.finishHoldMs > 0) await new Promise((resolve) => setTimeout(resolve, this.finishHoldMs));
  }

  /** Stops the poll and heartbeat so the page watchdog can fail open. */
  stopCalling(): void {
    this.calling = false;
    if (this.heart) clearInterval(this.heart);
    this.heart = undefined;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.calling = false;
    if (this.heart) clearInterval(this.heart);
    await this.detachPage().catch(() => undefined);
    if (this.ownedSocket) this.cdp?.close();
    this.cdp = undefined;
    this.sendApi = undefined;
  }

  private startLoops(): void {
    if (this.quiet) return;
    if (this.heartbeatMs > 0) {
      this.heart = setInterval(() => { void this.beat(); }, this.heartbeatMs);
      this.heart.unref?.();
    }
    void this.pollLoop();
  }

  private async beat(): Promise<void> {
    if (!this.calling || this.disposed) return;
    await this.refreshLastTab().catch(() => undefined);
    await this.call("heartbeat").catch(() => undefined);
  }

  private async pollLoop(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    while (this.calling && !this.disposed) {
      try {
        const event = await this.call<{ type: string }>("poll");
        if (!this.calling || this.disposed) return;
        await this.onEvent(event);
      } catch {
        if (this.disposed || !this.calling) return;
        await this.rebind().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  }

  private noteHeld(before: boolean): void {
    if (before !== this.held) this.options.onHeld?.(this.held);
  }

  private releaseConfirm(): void {
    const open = this.confirmOpen || this.confirmWait !== undefined;
    this.confirmOpen = false;
    const waiting = this.confirmWait;
    this.confirmWait = undefined;
    waiting?.();
    if (open) this.options.onConfirm?.(false);
  }

  private async onEvent(event: { type: string; open?: boolean }): Promise<void> {
    if (event.type === "confirm") {
      if (event.open === true) {
        this.confirmOpen = true;
        this.options.onConfirm?.(true);
      } else this.releaseConfirm();
      return;
    }
    if (event.type === "takeControl") {
      if (this.control.phase !== "agent") return;
      const before = this.held;
      const at = Date.now();
      this.control = stepControl(this.control, { type: "take", at });
      this.control = stepControl(this.control, { type: "own" });
      this.noteHeld(before);
      await this.paint();
      return;
    }
    if (event.type === "done") {
      if (this.control.phase !== "owner") return;
      const before = this.held;
      const reason = this.control.reason;
      const startedAt = this.control.startedAt;
      const at = Date.now();
      if (reason === "ask" && this.askReturned) {
        this.options.onAskDone?.();
        await this.finish("finished");
        await this.dispose();
        return;
      }
      this.control = stepControl(this.control, { type: "done", at });
      if (reason === "ask") this.options.onAskDone?.();
      else if (startedAt) this.options.onHandoff?.(startedAt, at);
      this.activity = "Working…";
      this.control = stepControl(this.control, { type: "resume" });
      this.handback?.("done");
      this.noteHeld(before);
      await this.paint();
      return;
    }
    if (event.type === "disconnect") {
      this.releaseConfirm();
      this.disconnected = true;
      this.control = stepControl(this.control, { type: "disconnect", at: Date.now() });
      this.handback?.("disconnect");
      this.options.onDisconnect?.();
      return;
    }
    if (event.type === "openBao") this.options.onOpen?.();
  }

  private async push(): Promise<void> {
    this.view = overlayView(this.control, this.activity, this.lastTab);
    await this.call("apply", this.view);
  }

  private async paint(): Promise<void> {
    try {
      await this.push();
    } catch {
      await this.rebind().catch(() => undefined);
    }
  }

  private async attachTarget(targetId?: string): Promise<void> {
    const cdp = this.cdp;
    if (!cdp) return;
    const id = targetId ?? await this.activeTarget();
    if (!id) return;
    this.targetId = id;
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: id, flatten: true });
    this.page = { sessionId };
    this.unlisten.push(cdp.on("Runtime.executionContextCreated", sessionId, (params) => {
      const context = params.context;
      if (!context || typeof context !== "object") return;
      if ("name" in context && context.name === WORLD) return;
      const aux = "auxData" in context ? context.auxData : undefined;
      const frameId = aux && typeof aux === "object" && "frameId" in aux ? aux.frameId : undefined;
      const type = aux && typeof aux === "object" && "type" in aux ? aux.type : undefined;
      if (type !== undefined && type !== "default") return;
      if (typeof frameId !== "string" || (this.page.frameId && frameId !== this.page.frameId)) return;
      void this.rebind(true);
    }));
    await this.install();
  }

  private async activeTarget(): Promise<string | undefined> {
    const cdp = this.cdp;
    if (!cdp) return undefined;
    const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
    const pages = targetInfos.filter((target) => target.type === "page");
    if (this.owned === undefined) this.lastTab = pages.length <= 1;
    return pages[0]?.targetId;
  }

  private async refreshLastTab(): Promise<void> {
    const last = this.owned !== undefined ? this.owned <= 1 : await this.browserLastTab();
    if (last === undefined) return;
    if (last === this.lastTab) return;
    this.lastTab = last;
    if (this.control.phase === "agent" || this.control.phase === "owner") await this.push().catch(() => undefined);
  }

  private async browserLastTab(): Promise<boolean | undefined> {
    if (!this.cdp) return undefined;
    const { targetInfos } = await this.cdp.send<{ targetInfos: { type: string }[] }>("Target.getTargets");
    return targetInfos.filter((target) => target.type === "page").length <= 1;
  }

  private async install(): Promise<void> {
    const sessionId = this.page.sessionId;
    await this.send("Page.enable", {}, sessionId);
    await this.send("Runtime.enable", {}, sessionId);
    const { frameTree } = await this.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree", {}, sessionId);
    this.page.frameId = frameTree.frame.id;
    const { identifier } = await this.send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", { source: this.source, worldName: WORLD }, sessionId);
    this.page.identifier = identifier;
    const world = await this.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: WORLD }, sessionId);
    this.page.contextId = world.executionContextId;
    await this.bind(world.executionContextId);
    await this.push();
  }

  private async bind(contextId: number): Promise<void> {
    const evaluated = await this.send<{ result: { objectId?: string } }>("Runtime.evaluate", {
      expression: this.source,
      contextId,
      returnByValue: false,
    }, this.page.sessionId);
    this.page.objectId = evaluated.result.objectId;
    this.page.contextId = contextId;
  }

  private async rebind(replaced = false): Promise<void> {
    if (this.disposed) return;
    const sessionId = this.page.sessionId;
    const previous = this.page.objectId;
    const { frameTree } = await this.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree", {}, sessionId);
    this.page.frameId = frameTree.frame.id;
    const world = await this.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: WORLD }, sessionId);
    const found = await this.send<{ result: { objectId?: string } }>("Runtime.evaluate", {
      expression: "globalThis.__baoTakeover",
      contextId: world.executionContextId,
      returnByValue: false,
    }, sessionId);
    const foundId = found.result.objectId;
    if (replaced || !foundId || (previous !== undefined && foundId !== previous)) this.releaseConfirm();
    if (!foundId) await this.bind(world.executionContextId);
    else {
      this.page.objectId = foundId;
      this.page.contextId = world.executionContextId;
    }
    await this.push().catch(() => undefined);
  }

  private async detachPage(): Promise<void> {
    await this.call("dispose").catch(() => undefined);
    for (const stop of this.unlisten) stop();
    this.unlisten = [];
    const sessionId = this.page.sessionId;
    const identifier = this.page.identifier;
    if (identifier) await this.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }, sessionId).catch(() => undefined);
    if (sessionId && this.cdp) await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    this.page = {};
    this.targetId = undefined;
  }

  private async call<T>(method: string, arg?: unknown): Promise<T> {
    const objectId = this.page.objectId;
    if (!objectId) throw new Error("overlay is not installed");
    const declared = arg === undefined
      ? `function() { return this.${method}(); }`
      : `function(arg) { return this.${method}(arg); }`;
    const replied = await this.send<{ result: { value?: T } }>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: declared,
      arguments: arg === undefined ? [] : [{ value: arg }],
      returnByValue: true,
      awaitPromise: true,
    }, this.page.sessionId);
    return replied.result.value as T;
  }

  private send<T>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> {
    const api = this.sendApi;
    if (!api) return Promise.reject(new Error("overlay has no connection"));
    return api.send<T>(method, params, sessionId);
  }
}
