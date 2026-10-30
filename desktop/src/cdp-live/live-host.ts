import path from "node:path";
import { navigationGuard } from "./allowlist";
import { liveSessionDir, SessionLog } from "./audit";
import type { ChromeAx } from "./ax";
import { type CdpLiveDriver } from "./driver";
import {
  clickLive,
  pressLiveKey,
  scrollLive,
  typeLive,
  watchNewTargets,
  type LiveActOutcome,
  type LiveActTarget,
} from "./live-act";
import { liveScope, replayLiveWorkflow } from "./live-replay";
import {
  connectTarget,
  openChromeProfileWindow,
  parseLiveTarget,
  prepareTarget,
  targetForPortFile,
  type LiveTarget,
  type OpenProfileWindow,
} from "./live-target";
import { acquireCdpLock, CDP_LOCK_PATH, rememberLockTarget, releaseCdpLock, takeDeadTarget } from "./lock";
import {
  admit,
  buildView,
  isLiveOp,
  LIVE_DISCONNECT,
  LIVE_IDLE_MS,
  LIVE_REPLAY,
  markedState,
  pageHalt,
  publicLiveResult,
  readLivePage,
  searchField,
  viewPage,
  workflowIdsFromIntent,
  type LabelGuard,
  type LiveOpName,
  type LiveRead,
  type LiveViewPage,
  type MarkedState,
  type PageFacts,
  type SlotState,
} from "./live-ops";
import {
  cartAddSkip,
  clickEffect,
  isCartAdd,
  LiveTrail,
  trailIdentity,
  workflowFromTrail,
  type LiveSide,
} from "./live-trail";
import type { CdpSocket } from "./socket";
import { leafTexts } from "../v1/recorder";
import type { RunResult } from "../v1/replay";
import { validateWorkflow, type Identity, type ReplayArgs, type WorkflowV2 } from "../v1/schema";
import { Library } from "../v1/store";

const AGENT = "bao-live";

interface OpenState {
  id: string;
  intent: string;
  startUrl: string;
  driver: CdpLiveDriver;
  cdp: CdpSocket;
  log: SessionLog;
  guard: LabelGuard;
  stopPath: string;
  hosts: string[];
  origins: string[];
  /** The MCP client that started the session. Its disconnect saves the session. */
  client: string;
  host: string;
  epoch: number;
  read: LiveRead | null;
  /** The page facts behind `read`, before redaction. */
  facts: PageFacts | null;
  halted: string;
  refused: boolean;
  /** Every act that went through. The saved workflow is built from it. */
  trail: LiveTrail;
  startedAt: number;
  steps: { name: string; status: string; ms: number }[];
}

/** The marked control and the page around it, read after every check and before the act. */
interface Before {
  identity?: Identity;
  nodes: Identity[];
  side: LiveSide;
}

const LOOK_OPS: Record<string, LiveOpName> = {
  start: "live_session_start",
  snapshot: "live_snapshot",
  click: "live_click",
  type: "live_type",
  key: "live_key",
  scroll: "live_scroll",
  screenshot: "live_screenshot",
};

function shown(read: LiveRead | null | undefined): LiveViewPage | null {
  return read ? viewPage(read.view) : null;
}

export interface LiveHostOptions {
  home: string;
  lockFile?: string;
  connectTimeoutMs?: number;
  /** The Chrome a start drives when the caller names no port file. Default: the daily Chrome. */
  target?: LiveTarget;
  /** BaoOSHelper, for the daily Chrome's Allow dialog. Tests pass a fake. */
  helper?: () => ChromeAx;
  /** Asks the daily Chrome to open a window in the target's profile. Tests pass a fake. */
  openProfile?: OpenProfileWindow;
  /** An open session with no call for this long saves and ends. */
  idleMs?: number;
}

type EndReason = "stop" | "disconnect" | "idle";

export function createLiveHost(opts: LiveHostOptions): {
  call(raw: unknown): Promise<unknown>;
  /** Replays a cdp-live workflow in a new window of this host's target. */
  replay(workflow: WorkflowV2, inputs?: ReplayArgs): Promise<RunResult>;
  close(): Promise<void>;
} {
  const lockFile = opts.lockFile || CDP_LOCK_PATH;
  const defaultTarget = opts.target || parseLiveTarget("daily", "");
  const openProfile = opts.openProfile || openChromeProfileWindow;
  const idleMs = opts.idleMs ?? LIVE_IDLE_MS;
  let slot: SlotState = { phase: "idle" };
  let open: OpenState | null = null;
  let chain = Promise.resolve();
  let pending = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function reply(body: Record<string, unknown>): unknown {
    return publicLiveResult(body);
  }

  async function call(raw: unknown): Promise<unknown> {
    clearTimeout(idleTimer);
    pending += 1;
    const run = chain.then(() => dispatch(raw));
    chain = run.then(() => undefined, () => undefined).then(() => {
      pending -= 1;
      armIdle();
    });
    return run;
  }

  /** The session saves once no call has come for idleMs. Each call restarts the wait. */
  function armIdle(): void {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    if (!open || pending > 0 || idleMs <= 0) return;
    idleTimer = setTimeout(() => {
      const run = chain.then(() => (open ? stop("idle") : undefined));
      chain = run.then(() => undefined, () => undefined);
    }, idleMs);
    idleTimer.unref?.();
  }

  async function disconnect(body: Record<string, unknown>): Promise<unknown> {
    const client = typeof body.client === "string" ? body.client : "";
    if (!open || !client || open.client !== client) {
      return reply({ op: LIVE_DISCONNECT, session: "", outcome: { kind: "rejected", reason: "not_open" }, view: null, shot: "" });
    }
    try {
      return await stop("disconnect");
    } catch (err) {
      const reason = err instanceof Error ? err.message : "live call failed";
      return reply({ op: LIVE_DISCONNECT, session: "", outcome: { kind: "rejected", reason: reason.slice(0, 180) }, view: null, shot: "" });
    }
  }

  async function dispatch(raw: unknown): Promise<unknown> {
    const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const op = typeof body.op === "string" ? body.op : "";
    if (op === LIVE_DISCONNECT) return disconnect(body);
    if (op === LIVE_REPLAY) return replayBody(body);
    if (!isLiveOp(op)) {
      return reply({ op, session: "", outcome: { kind: "rejected", reason: "unknown" }, view: null, shot: "" });
    }
    const decision = admit(slot, op);
    const session = slot.phase === "idle" ? "" : slot.id;
    if (decision.kind === "stop-already") {
      return reply({ op, session, outcome: { kind: "stopped", already: true }, view: null, shot: "" });
    }
    if (decision.kind === "reject") {
      return reply({ op, session, outcome: { kind: "rejected", reason: decision.reason }, view: null, shot: "" });
    }
    try {
      if (op === "live_session_start") return await start(body);
      if (op === "live_stop") return await stop();
      if (!open) return reply({ op, session, outcome: { kind: "rejected", reason: "not_open" }, view: null, shot: "" });
      if (open.halted) {
        return reply({ op, session: open.id, outcome: { kind: "halted", reason: open.halted }, view: shown(open.read), shot: "" });
      }
      if (op === "live_snapshot") {
        if (body.page !== undefined && open.read) {
          return reply({ op, session: open.id, outcome: { kind: "applied" }, view: viewPage(open.read.view, Number(body.page)), shot: "" });
        }
        return await look("snapshot");
      }
      if (op === "live_click") return await click(String(body.ref || ""));
      if (op === "live_type") return await typeInto(String(body.ref || ""), String(body.text || ""));
      if (op === "live_key") {
        const key = String(body.key || "");
        const ref = String(body.ref || "");
        return await act("key", ref, key, (target) => pressLiveKey(target, key, ref));
      }
      if (op === "live_scroll") {
        const direction = String(body.direction || "");
        const ref = String(body.ref || "");
        return await act("scroll", ref, direction, (target) => scrollLive(target, direction, ref));
      }
      return await look("screenshot");
    } catch (err) {
      const reason = err instanceof Error ? err.message : "live call failed";
      if (open) {
        open.refused = true;
        await note(op, reason, "failed", null);
      }
      return reply({ op, session: open?.id || session, outcome: { kind: "rejected", reason: reason.slice(0, 180) }, view: shown(open?.read), shot: "" });
    }
  }

  async function note(action: string, label: string, status: string, isTrusted: boolean | null): Promise<void> {
    if (!open) return;
    open.steps.push({ name: action, status, ms: 0 });
    open.log.setSteps(open.steps);
    await open.log.add({
      action,
      label: label.slice(0, 80),
      path: open.read?.view.path || "",
      isTrusted,
      ms: 0,
    });
  }

  async function start(body: Record<string, unknown>): Promise<unknown> {
    const intent = typeof body.intent === "string" ? body.intent.trim() : "";
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const portFile = typeof body.portFile === "string" ? body.portFile.trim() : "";
    const asked = typeof body.preset === "string" ? body.preset.trim() : "";
    const workflowId = typeof body.workflowId === "string" ? body.workflowId.trim() : "";
    const client = typeof body.client === "string" ? body.client.slice(0, 80) : "";
    if (!intent) throw new Error("intent is required");
    if (!url.startsWith("http://") && !url.startsWith("https://")) throw new Error("url must be http or https");
    const target = portFile ? targetForPortFile(portFile, defaultTarget) : defaultTarget;
    const { guard, stopPath, hosts, origins } = liveScope(url, asked);
    const host = new URL(url).hostname;
    const blocked = navigationGuard(url, hosts, origins, stopPath);
    if (blocked) throw new Error(blocked);
    if (lockFile !== CDP_LOCK_PATH && target !== defaultTarget) throw new Error("this app has its own live lock, so it drives only its configured Chrome");
    const prepared = await prepareTarget(target, opts.helper);
    await acquireCdpLock(AGENT, { file: lockFile, timeoutMs: 5_000 });
    let cdp: CdpSocket | undefined;
    let driver: CdpLiveDriver | undefined;
    try {
      const opened = await connectTarget(prepared, hosts, {
        openProfile,
        axLog: path.join(opts.home, "live-session", "ax.jsonl"),
        connectTimeoutMs: opts.connectTimeoutMs,
      });
      cdp = opened.cdp;
      driver = opened.driver;
      driver.setOrigins(origins);
      driver.setStopPath(stopPath);
      const ids = workflowIdsFromIntent(intent, workflowId);
      const log = new SessionLog(liveSessionDir(opts.home), intent, ids.workflowId.slice(0, 40));
      const trail = await LiveTrail.open(opts.home);
      open = {
        id: ids.workflowId.slice(0, 40),
        intent,
        startUrl: url,
        driver,
        cdp,
        log,
        guard,
        stopPath,
        hosts,
        origins,
        client,
        host,
        epoch: 0,
        read: null,
        facts: null,
        halted: "",
        refused: false,
        trail,
        startedAt: Date.now(),
        steps: [],
      };
      slot = { phase: "open", id: open.id };
      rememberLockTarget(AGENT, driver.targetId, lockFile);
      const leftover = takeDeadTarget(lockFile);
      if (leftover && leftover !== driver.targetId) {
        await cdp.send("Target.closeTarget", { targetId: leftover }).catch(() => undefined);
      }
      await watchNewTargets(cdp, driver.targetId, () => open !== null, () => {
        if (!open) return;
        open.halted = "new_target";
        open.refused = true;
      });
      await note("start", url, "running", null);
      await driver.goto(url);
      return await look("start");
    } catch (err) {
      if (open?.log) {
        const reason = err instanceof Error ? err.message : "live call failed";
        await open.log.flush("failed", reason.slice(0, 160), host).catch(() => undefined);
      }
      await driver?.end().catch(() => undefined);
      cdp?.close();
      releaseCdpLock(AGENT, lockFile);
      open = null;
      slot = { phase: "idle" };
      throw err;
    }
  }

  async function reread(state: OpenState): Promise<{ read: LiveRead; facts: PageFacts }> {
    state.epoch += 1;
    const facts = await state.driver.evaluateFunction<PageFacts>(readLivePage, { markIndex: -1 });
    state.read = buildView(facts, state.epoch, state.guard);
    state.facts = facts;
    return { read: state.read, facts };
  }

  /** The marked control's full identity, from tree(), and the page around it. A failed read refuses the act. */
  async function readBefore(state: OpenState, index: number, leaves = false): Promise<Before> {
    const seen = index >= 0 ? await state.driver.markedTree(index) : undefined;
    return {
      identity: trailIdentity(seen?.marked, seen?.tree.nodes || []),
      nodes: seen?.tree.nodes || [],
      side: {
        url: await state.driver.locationHref(),
        leaves: leaves ? await state.driver.evaluateFunction<Record<string, string>>(leafTexts, null) : {},
        text: seen?.mark.text || "",
        value: seen?.mark.value || "",
        missing: !seen || seen.mark.missing,
      },
    };
  }

  /** The same reads after the act. The act already happened, so a read that fails stays empty. */
  async function readAfter(state: OpenState, index: number, leaves = false): Promise<LiveSide> {
    const url = await state.driver.locationHref().catch(() => "");
    const leafMap = leaves
      ? await state.driver.evaluateFunction<Record<string, string>>(leafTexts, null).catch(() => ({}))
      : {};
    const gone: MarkedState = { handle: "", text: "", value: "", missing: true };
    const mark = index >= 0
      ? await state.driver.evaluateFunction<MarkedState>(markedState, { markIndex: index }).catch(() => gone)
      : gone;
    return { url, leaves: leafMap, text: mark.text, value: mark.value, missing: mark.missing };
  }

  async function look(action: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    if (!open) throw new Error("no live session");
    const started = Date.now();
    const { read, facts } = await reread(open);
    open.read = read;
    const halt = pageHalt({
      blocked: facts.blocked,
      path: facts.path,
      passwordFields: open.read.view.credentialFields,
      text: facts.text,
      stopPath: open.stopPath,
    });
    if (halt) {
      open.halted = halt;
      open.refused = true;
    }
    const shot = await record(action, open.read.view.title || action, Date.now() - started, halt ? "needs_human" : "passed", null);
    return reply({
      op: LOOK_OPS[action] || "live_screenshot",
      session: open.id,
      outcome: halt ? { kind: "halted", reason: halt } : { kind: "applied" },
      view: shown(open.read),
      shot,
      ...extra,
    });
  }

  /** A key press or a scroll. `what` is the key, or the scroll direction. */
  async function act(
    action: "key" | "scroll",
    ref: string,
    what: string,
    run: (target: LiveActTarget) => Promise<LiveActOutcome>,
  ): Promise<unknown> {
    if (!open?.read) throw new Error("no live page");
    const state = open;
    const read = open.read;
    const op = LOOK_OPS[action];
    const index = ref ? read.targets.byRef.get(ref)?.index ?? -1 : -1;
    let before: Before | undefined;
    const outcome = await run({
      driver: state.driver,
      read,
      guard: state.guard,
      stopPath: state.stopPath,
      hosts: state.hosts,
      origins: state.origins,
      before: async (name, label) => {
        before = await readBefore(state, index);
        await note(name, label, "running", null);
      },
      reread: async () => (await reread(state)).read,
    });
    if (outcome.kind !== "applied") {
      state.refused = true;
      if (outcome.kind === "halted") state.halted = outcome.reason;
      await note(action, outcome.reason, "failed", null);
      return reply({ op, session: state.id, outcome, view: shown(state.read), shot: "" });
    }
    const after = await readAfter(state, -1);
    await state.trail.add({
      op: action,
      ...(action === "key" ? { key: what } : { detail: what }),
      identity: before?.identity,
      beforeUrl: before?.side.url,
      afterUrl: after.url || undefined,
    });
    return look(action, outcome.scroll ? { scroll: outcome.scroll } : {});
  }

  /** The open session's page, for one act. `before` runs after every check and right before the act. */
  function actTarget(state: OpenState, read: LiveRead, before: LiveActTarget["before"]): LiveActTarget {
    return {
      driver: state.driver,
      read,
      guard: state.guard,
      stopPath: state.stopPath,
      hosts: state.hosts,
      origins: state.origins,
      before,
      reread: async () => (await reread(state)).read,
    };
  }

  async function click(ref: string): Promise<unknown> {
    if (!open?.read) throw new Error("no live page");
    const state = open;
    const index = open.read.targets.byRef.get(ref)?.index ?? -1;
    let before: Before | undefined;
    const outcome: LiveActOutcome = await clickLive(actTarget(state, open.read, async (_action, label) => {
      before = await readBefore(state, index, true);
      await note("click", label, "running", null);
    }), ref);
    if (before) await state.log.patchLast(state.driver.lastTrusted());
    if (outcome.kind !== "applied") {
      state.refused = true;
      // A refusal before the click gets its own audit row. After the click, the click's row stands.
      if (!before) await note("click", outcome.reason, "failed", null);
      return reply({ op: "live_click", session: state.id, outcome, view: shown(state.read), shot: "" });
    }
    const after = await readAfter(state, index, true);
    // The accessible name, not the redacted view label, so the item in "Add 1 ct {item}" keeps its digits.
    const name = before?.identity?.name || before?.identity?.text || outcome.label;
    const effect = before ? clickEffect(before.side, after) : {};
    const skip = isCartAdd(name)
      ? cartAddSkip(name, before?.nodes || [], (await state.driver.tree().catch(() => null))?.nodes || [], effect.subtreeAfter)
      : undefined;
    await state.trail.add({
      op: "click",
      identity: before?.identity,
      beforeUrl: before?.side.url,
      afterUrl: after.url || undefined,
      ...effect,
      ...(skip ? { skipWhen: skip.text, ...(skip.anyCount ? { skipAnyCount: true } : {}) } : {}),
    });
    return look("click");
  }

  async function typeInto(ref: string, text: string): Promise<unknown> {
    if (!open?.read) throw new Error("no live page");
    const state = open;
    const index = open.read.targets.byRef.get(ref)?.index ?? -1;
    let before: Before | undefined;
    const outcome: LiveActOutcome = await typeLive(actTarget(state, open.read, async (_action, label) => {
      before = await readBefore(state, index);
      await note("type", label, "running", null);
    }), ref, text);
    if (outcome.kind !== "applied") {
      state.refused = true;
      if (outcome.kind === "halted") state.halted = outcome.reason;
      else await note("type", outcome.reason, "failed", null);
      return reply({ op: "live_type", session: state.id, outcome, view: shown(state.read), shot: "" });
    }
    const after = await readAfter(state, index);
    const fact = state.facts?.controls.find((item) => item.index === index);
    await state.trail.add({
      op: "type",
      identity: before?.identity,
      // The whole field, as the recorder keeps it. Text typed after a prefilled value includes that value.
      value: after.value || `${before?.side.value || ""}${text}`,
      // A recorded workflow replays the search it saw. The search text is not an input.
      ...(fact && searchField(fact) ? { literal: true } : {}),
      beforeUrl: before?.side.url,
      afterUrl: after.url || undefined,
    });
    return look("type");
  }

  async function record(action: string, label: string, ms: number, status: string, isTrusted: boolean | null): Promise<string> {
    if (!open) return "";
    open.steps.push({ name: action, status, ms });
    open.log.setSteps(open.steps);
    const png = await open.driver.captureRedacted(`${action} ${open.read?.view.path || ""}`).catch(() => undefined);
    return open.log.add({
      action,
      label,
      path: open.read?.view.path || "",
      isTrusted,
      ms,
      png,
    });
  }

  /** Builds the workflow from the session's trail and saves it. A session with no step saves nothing. */
  function saveWorkflow(): void {
    if (!open) return;
    const events = open.trail.list();
    if (!events.length) return;
    const workflow = workflowFromTrail({
      id: open.id,
      name: open.intent.slice(0, 80),
      intent: open.intent,
      startUrl: open.startUrl,
      createdAt: open.startedAt,
      savedAt: Date.now(),
      events,
      guard: open.guard,
    });
    if (!workflow.steps.length) return;
    new Library(opts.home).save(workflow);
  }

  async function stop(reason: EndReason = "stop"): Promise<unknown> {
    clearTimeout(idleTimer);
    if (!open) {
      return reply({ op: "live_stop", session: "", outcome: { kind: "rejected", reason: "not_open" }, view: null, shot: "" });
    }
    const id = open.id;
    const view = shown(open.read);
    const ended = reason === "disconnect" ? "Saved when the agent disconnected."
      : reason === "idle" ? "Saved after the agent went quiet."
        : "Stopped.";
    const noteText = open.halted ? open.halted : open.refused ? "Refused." : ended;
    const status = open.halted ? "needs_human" : open.refused ? "failed" : "passed";
    let saveError = "";
    try {
      saveWorkflow();
    } catch (err) {
      saveError = err instanceof Error ? err.message : "workflow save failed";
    }
    const ending = open;
    await ending.log.flush(saveError ? "failed" : status, saveError || noteText, ending.host);
    slot = { phase: "closed", id, status: saveError ? "failed" : status };
    open = null;
    // A replay opens its own connection, so the session closes its window and socket before it frees the lock.
    await ending.driver.end().catch(() => undefined);
    ending.cdp.close();
    releaseCdpLock(AGENT, lockFile);
    if (saveError) {
      return reply({ op: "live_stop", session: id, outcome: { kind: "rejected", reason: saveError.slice(0, 180) }, view, shot: "" });
    }
    return reply({ op: "live_stop", session: id, outcome: { kind: "stopped", already: false }, view, shot: "" });
  }

  /** Runs inside the call chain. The session must be closed, and the replay takes the CDP lock itself. */
  async function runReplay(workflow: WorkflowV2, inputs: ReplayArgs): Promise<RunResult> {
    if (slot.phase === "open") throw new Error("stop the live session before replay");
    return replayLiveWorkflow(workflow, inputs, {
      target: defaultTarget,
      lockFile,
      helper: opts.helper,
      openProfile,
      axLog: path.join(opts.home, "live-session", "ax.jsonl"),
      connectTimeoutMs: opts.connectTimeoutMs,
    });
  }

  /** bao mcp's run_workflow sends the workflow it found and the inputs. The reply carries the run, or why it did not start. */
  async function replayBody(body: Record<string, unknown>): Promise<unknown> {
    const workflow = body.workflow && typeof body.workflow === "object" ? body.workflow as WorkflowV2 : undefined;
    const inputs = body.inputs && typeof body.inputs === "object" && !Array.isArray(body.inputs) ? body.inputs as ReplayArgs : {};
    try {
      if (!workflow) throw new Error("workflow is required");
      const errors = validateWorkflow(workflow);
      if (errors.length) throw new Error(`invalid workflow: ${errors.join(", ")}`);
      return reply({ op: LIVE_REPLAY, run: await runReplay(workflow, inputs) });
    } catch (err) {
      const reason = err instanceof Error ? err.message : "live replay failed";
      return reply({ op: LIVE_REPLAY, outcome: { kind: "rejected", reason: reason.slice(0, 180) } });
    }
  }

  async function replay(workflow: WorkflowV2, inputs: ReplayArgs = {}): Promise<RunResult> {
    const run = chain.then(() => runReplay(workflow, inputs));
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async function close(): Promise<void> {
    clearTimeout(idleTimer);
    if (slot.phase === "open") {
      await stop().catch(() => undefined);
      releaseCdpLock(AGENT, lockFile);
    }
  }

  return { call, replay, close };
}
