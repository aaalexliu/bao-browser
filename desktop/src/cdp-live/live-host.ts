import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { condenseWithGroups } from "../v1/condense";
import { workflowShotName } from "../v1/shots";
import { type PageEngineName } from "../engines/agent-browser";
import { navigationGuard } from "./allowlist";
import { liveSessionDir, SessionLog } from "./audit";
import { chromeHelper, type ChromeAx } from "./ax";
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
import { liveScope, replayLiveWorkflow, type LiveReplayOptions } from "./live-replay";
import { LIVE_READ_LIMIT, liveReadSpec, readLiveRegion, type RegionRead } from "./live-read";
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
import { remoteDebuggingDeps, setRemoteDebugging } from "./remote-debugging";
import {
  admit,
  buildView,
  isLiveOp,
  LIVE_DISCONNECT,
  LIVE_IDLE_MS,
  LIVE_IDLE_WARN_MS,
  LIVE_REPLAY,
  markedState,
  pageHalt,
  publicLiveResult,
  readLivePage,
  searchField,
  viewPage,
  workflowIdsFromIntent,
  type LabelGuard,
  type LiveIdleWarning,
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
  LiveTrail,
  trailIdentity,
  workflowFromTrail,
  type LiveSide,
} from "./live-trail";
import type { CdpSocket } from "./socket";
import { leafTexts } from "../v1/recorder";
import { sameRecordedControl } from "../v1/identity";
import type { RunResult } from "../v1/replay";
import { popupDismissName, validateWorkflow, type Identity, type ReplayArgs, type WorkflowV2 } from "../v1/schema";
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
  covered: Map<Identity, string[]>;
  optionalDismissals: Set<string>;
  /** Every act that went through. The saved workflow is built from it. */
  trail: LiveTrail;
  startedAt: number;
  steps: { name: string; status: string; ms: number }[];
  /** Debugging was off before this session, so stop turns it off again. */
  turnedOn: boolean;
  portFile: string;
  closeTarget?: () => Promise<void>;
  artifactRoot?: string;
  engineName: PageEngineName;
  runId: string;
  eventShots: Map<string, string>;
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
  read: "live_read",
  click: "live_click",
  type: "live_type",
  key: "live_key",
  scroll: "live_scroll",
  screenshot: "live_screenshot",
};

function shown(read: LiveRead | null | undefined): LiveViewPage | null {
  return read ? viewPage(read.view) : null;
}

interface LiveRunSelection {
  target: LiveTarget;
  engineName: PageEngineName;
  artifactRoot?: string;
  close?: () => Promise<void>;
}

export interface LiveHostOptions {
  home: string;
  lockFile?: string;
  connectTimeoutMs?: number;
  /** The Chrome a start drives when the caller names no port file. Default: the daily Chrome. */
  target?: LiveTarget;
  /** Runs once per session or replay. The chosen engine and private profile stay fixed until it ends. */
  selectRun?: () => Promise<LiveRunSelection>;
  /** BaoOSHelper, for the daily Chrome's Allow dialog. Tests pass a fake. */
  helper?: () => ChromeAx;
  /** Asks the daily Chrome to open a window in the target's profile. Tests pass a fake. */
  openProfile?: OpenProfileWindow;
  /** An open session with no call for this long saves and ends. */
  idleMs?: number;
  /** The warning comes this long before the idle save. Zero turns it off. */
  idleWarnMs?: number;
  /** Gets the warning when it comes, and null when a call, Keep open, or the end clears it. */
  onIdleWarn?: (warning: LiveIdleWarning | null) => void;
  onNotice?: (message: string) => void;
  /** Records each session window as live-<session>-<time>.mp4 and each replay window as <runId>.mp4 here. */
  videoDir?: string;
  evalVideoNoBlur?: true;
}

type EndReason = "stop" | "disconnect" | "idle";

export function createLiveHost(opts: LiveHostOptions): {
  call(raw: unknown): Promise<unknown>;
  isOpen(): boolean;
  /** Replays a cdp-live workflow in a new window of this host's target. */
  replay(workflow: WorkflowV2, inputs?: ReplayArgs, options?: LiveReplayOptions): Promise<RunResult>;
  /** The person's Keep open. False when no session is open. */
  keepOpen(): Promise<boolean>;
  close(): Promise<void>;
} {
  const lockFile = opts.lockFile || CDP_LOCK_PATH;
  const defaultTarget = opts.target || parseLiveTarget("daily", "");
  const openProfile = opts.openProfile || openChromeProfileWindow;
  const axLog = path.join(opts.home, "live-session", "ax.jsonl");
  async function restoreOff(portFile: string): Promise<void> {
    const ax = opts.helper ? opts.helper() : chromeHelper();
    await setRemoteDebugging(false, remoteDebuggingDeps(ax, portFile, axLog, opts.onNotice));
  }
  const idleMs = opts.idleMs ?? LIVE_IDLE_MS;
  const warnMs = Math.min(opts.idleWarnMs ?? LIVE_IDLE_WARN_MS, idleMs);
  let slot: SlotState = { phase: "idle" };
  let open: OpenState | null = null;
  let chain = Promise.resolve();
  let pending = 0;
  let runningStep: OpenState["steps"][number] | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let warnTimer: ReturnType<typeof setTimeout> | undefined;
  let warning: LiveIdleWarning | null = null;
  const heldProfiles: (() => Promise<void>)[] = [];

  function reply(body: Record<string, unknown>): unknown {
    return publicLiveResult(body);
  }

  function setWarning(next: LiveIdleWarning | null): void {
    if (!warning && !next) return;
    warning = next;
    opts.onIdleWarn?.(next);
  }

  function disarmIdle(): void {
    clearTimeout(idleTimer);
    clearTimeout(warnTimer);
    idleTimer = undefined;
    warnTimer = undefined;
    setWarning(null);
  }

  async function call(raw: unknown): Promise<unknown> {
    disarmIdle();
    pending += 1;
    const run = chain.then(() => dispatch(raw));
    chain = run.then(() => undefined, () => undefined).then(() => {
      pending -= 1;
      armIdle();
    });
    return run;
  }

  /** The session saves once no call has come for idleMs, and warns warnMs before that. Each call restarts the wait. */
  function armIdle(): void {
    disarmIdle();
    if (!open || pending > 0 || idleMs <= 0) return;
    const state = open;
    const saveAt = Date.now() + idleMs;
    if (warnMs > 0) {
      warnTimer = setTimeout(() => {
        if (open === state) setWarning({ session: state.id, host: state.host, saveAt });
      }, idleMs - warnMs);
      warnTimer.unref?.();
    }
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
    runningStep = undefined;
    open?.driver.touch();
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
      if (op === "live_read") return await readRegion(String(body.name || ""), body.selector === undefined ? "body" : String(body.selector));
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

  function updateStep(action: string, status: string, ms: number): void {
    if (!open) return;
    const name = Object.keys(LOOK_OPS).find((key) => LOOK_OPS[key] === action) || action;
    if (status !== "running" && runningStep?.name === name) {
      Object.assign(runningStep, { status, ms });
      runningStep = undefined;
    } else {
      const step = { name, status, ms };
      open.steps.push(step);
      runningStep = status === "running" ? step : undefined;
    }
    open.log.setSteps(open.steps);
  }

  async function note(action: string, label: string, status: string, isTrusted: boolean | null): Promise<void> {
    if (!open) return;
    updateStep(action, status, 0);
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
    const { guard, stopPath, hosts, origins } = liveScope(url, asked);
    const host = new URL(url).hostname;
    const blocked = navigationGuard(url, hosts, origins, stopPath);
    if (blocked) throw new Error(blocked);
    const selected = await opts.selectRun?.();
    if (portFile && selected?.close) {
      await selected.close();
      throw new Error("a copied-profile run cannot override its target with portFile");
    }
    const configured = selected?.target ?? defaultTarget;
    const target = portFile ? targetForPortFile(portFile, configured) : configured;
    const engineName = selected?.engineName ?? "old";
    if (lockFile !== CDP_LOCK_PATH && target !== configured) throw new Error("this app has its own live lock, so it drives only its configured Chrome");
    await acquireCdpLock(AGENT, { file: lockFile, timeoutMs: 5_000 }).catch(async (error) => { await selected?.close?.(); throw error; });
    let prepared;
    try {
      prepared = await prepareTarget(target, opts.helper, { axLog, onNotice: opts.onNotice }, engineName);
    } catch (err) {
      try { await selected?.close?.(); } finally { releaseCdpLock(AGENT, lockFile); }
      throw err;
    }
    let cdp: CdpSocket | undefined;
    let driver: CdpLiveDriver | undefined;
    try {
      const opened = await connectTarget(prepared, hosts, {
        openProfile,
        axLog: path.join(opts.home, "live-session", "ax.jsonl"),
        connectTimeoutMs: opts.connectTimeoutMs,
        engineName,
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
        covered: new Map(),
        optionalDismissals: new Set(),
        trail,
        startedAt: Date.now(),
        steps: [],
        turnedOn: prepared.turnedOn,
        portFile: prepared.target.portFile,
        closeTarget: selected?.close,
        artifactRoot: selected?.artifactRoot,
        engineName,
        runId: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        eventShots: new Map(),
      };
      const videoDir = open.artifactRoot ? path.join(open.artifactRoot, "videos") : opts.videoDir;
      if (videoDir) await driver.startVideo(path.join(videoDir, open.artifactRoot ? `${open.runId}.mp4` : `live-${open.id}-${Date.now().toString(36)}.mp4`), { noBlur: opts.evalVideoNoBlur });
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
      const clip = open?.artifactRoot ? path.join(open.artifactRoot, "videos", `${open.runId}.mp4`) : "";
      if (open?.log) {
        const reason = err instanceof Error ? err.message : "live call failed";
        await open.log.flush("failed", reason.slice(0, 160), host).catch(() => undefined);
      }
      await driver?.end().catch(() => undefined);
      cdp?.close();
      if (prepared.turnedOn) await restoreOff(prepared.target.portFile).catch(() => undefined);
      try { await selected?.close?.(); } finally {
        releaseCdpLock(AGENT, lockFile);
        open = null;
        slot = { phase: "idle" };
        await driver?.finishVideo().catch(() => undefined);
        if (clip) await rm(clip, { force: true });
      }
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
      open.driver.pauseCapture();
      open.halted = halt;
      open.refused = true;
    }
    const shot = await record(action, open.read.view.title || action, Date.now() - started, halt ? "needs_human" : "passed", null);
    if (["click", "type", "key", "scroll"].includes(action)) {
      const event = open.trail.list().at(-1);
      if (event && shot) open.eventShots.set(event.id, shot);
    }
    return reply({
      op: LOOK_OPS[action] || "live_screenshot",
      session: open.id,
      outcome: halt ? { kind: "halted", reason: halt } : { kind: "applied" },
      view: shown(open.read),
      shot,
      ...extra,
    });
  }

  async function readRegion(name: string, selector: string): Promise<unknown> {
    if (!open) throw new Error("no live session");
    const state = open;
    const spec = liveReadSpec(name, selector);
    if (state.trail.list().some((event) => event.extract?.as === name)) throw new Error("read output name already used");
    const looked = await look("read") as Record<string, unknown>;
    if (state.halted) return looked;
    const read = await state.driver.evaluateFunction<RegionRead>(readLiveRegion, { selector, limit: LIVE_READ_LIMIT });
    const url = await state.driver.locationHref();
    const event = await state.trail.add({ op: "extract", extract: spec, beforeUrl: url, afterUrl: url });
    if (typeof looked.shot === "string" && looked.shot) state.eventShots.set(event.id, looked.shot);
    return reply({ ...looked, read: { name, ...read } });
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
    const control = before?.identity;
    const covered = control && [...state.covered.keys()].find((identity) => sameRecordedControl(identity, control));
    if (outcome.kind !== "applied") {
      if (outcome.kind === "refused" && outcome.reason === "element is covered" && control) {
        if (!covered) state.covered.set(control, []);
      }
      else state.refused = true;
      // A refusal before the click gets its own audit row. After the click, the click's row stands.
      if (!before) await note("click", outcome.reason, "failed", null);
      return reply({ op: "live_click", session: state.id, outcome, view: shown(state.read), shot: "" });
    }
    if (covered) {
      state.covered.get(covered)!.forEach((id) => state.optionalDismissals.add(id));
      state.covered.delete(covered);
    }
    const after = await readAfter(state, index, true);
    // The accessible name, not the redacted view label, so the item in "Add 1 ct {item}" keeps its digits.
    const name = before?.identity?.name || before?.identity?.text || outcome.label;
    const effect = before ? clickEffect(before.side, after) : {};
    const skip = await cartAddSkip(
      name,
      before?.nodes || [],
      effect.subtreeAfter,
      async () => (await state.driver.tree().catch(() => null))?.nodes || [],
    );
    const event = await state.trail.add({
      op: "click",
      identity: before?.identity,
      beforeUrl: before?.side.url,
      afterUrl: after.url || undefined,
      ...effect,
      ...(skip ? { skipWhen: skip.text, ...(skip.anyCount ? { skipAnyCount: true } : {}) } : {}),
    });
    if (popupDismissName(before?.identity)) {
      for (const dismissals of state.covered.values()) dismissals.push(event.id);
    }
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
    updateStep(action, status, ms);
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
  function saveWorkflow(status: string, video: boolean, videoTruncated: boolean, traceUnavailable?: string): boolean {
    if (!open) return false;
    const events = open.trail.list().map((event) => open!.optionalDismissals.has(event.id) ? { ...event, optional: "dismiss" as const } : event);
    if (!events.length) return false;
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
    if (!workflow.steps.length) return false;
    const library = new Library(opts.home);
    library.save(workflow);
    if (open.artifactRoot) {
      const { groups } = condenseWithGroups(events, { id: workflow.id, name: workflow.name, startUrl: workflow.startUrl });
      const workflowShots = path.join(library.root, "shots", "workflows", workflow.id);
      const runShots = path.join(library.root, "shots", "runs", open.runId);
      mkdirSync(workflowShots, { recursive: true });
      mkdirSync(runShots, { recursive: true });
      const starts = groups.map((group) => events.findIndex((event) => event.id === group[0]?.id));
      const steps = workflow.steps.map((step, index) => {
        const start = starts[index] ?? -1;
        const end = starts[index + 1] ?? events.length;
        const event = start < 0 ? undefined : events.slice(start, end).reverse().find((entry) => open!.eventShots.has(entry.id));
        const shot = event ? open!.eventShots.get(event.id) : undefined;
        const src = shot ? path.join(liveSessionDir(opts.home), "shots", shot) : undefined;
        const afterShot = `${step.index}-after.png`;
        if (src && existsSync(src)) {
          copyFileSync(src, path.join(workflowShots, workflowShotName(step.id)));
          copyFileSync(src, path.join(runShots, afterShot));
          return { id: step.id, status: "passed", afterShot };
        }
        return { id: step.id, status: "passed" };
      });
      library.saveRun({ id: open.runId, kind: "capture", pageEngine: open.engineName, workflowId: workflow.id, at: open.startedAt, status, heals: [], steps, modelCalls: 0, videoTruncated, traceUnavailable,
        ...(video ? { video: `${open.runId}.mp4`, videoStartedAt: open.startedAt } : {}) });
    }
    return true;
  }

  async function stop(reason: EndReason = "stop"): Promise<unknown> {
    disarmIdle();
    if (!open) {
      return reply({ op: "live_stop", session: "", outcome: { kind: "rejected", reason: "not_open" }, view: null, shot: "" });
    }
    const id = open.id;
    const view = shown(open.read);
    const ended = reason === "disconnect" ? "Saved when the agent disconnected."
      : reason === "idle" ? "Saved after the agent went quiet."
        : "Stopped.";
    const refused = open.refused || open.covered.size > 0;
    const noteText = open.halted ? open.halted : refused ? "Refused." : ended;
    const status = open.halted ? "needs_human" : refused ? "failed" : "passed";
    const ending = open;
    let saveError = "";
    await ending.driver.end().catch(() => undefined);
    ending.cdp.close();
    if (ending.turnedOn) await restoreOff(ending.portFile).catch(() => undefined);
    try { await ending.closeTarget?.(); }
    catch (error) { saveError = error instanceof Error ? error.message : "profile cleanup failed"; }
    finally { releaseCdpLock(AGENT, lockFile); }
    let videoError = "";
    let saved = false;
    let videoWrote = false;
    let videoTruncated = false;
    try {
      const recorded = await open.driver.finishVideo();
      videoWrote = recorded.wrote;
      videoTruncated = recorded.truncated;
    }
    catch (error) { videoError = `video unavailable: ${error instanceof Error ? error.message : "video save failed"}`; }
    try { saved = saveWorkflow(status, videoWrote, videoTruncated, videoError || undefined); }
    catch (error) { saveError = error instanceof Error ? error.message : "workflow save failed"; }
    const videoNote = videoError ? `${saved ? "Workflow saved; " : ""}${videoError}` : videoTruncated ? "Video truncated." : "";
    await ending.log.flush(saveError ? "failed" : status, [saveError || noteText, videoNote].filter(Boolean).join(" "), ending.host);
    slot = { phase: "closed", id, status: saveError ? "failed" : status };
    open = null;
    if (!saved && ending.artifactRoot) await rm(path.join(ending.artifactRoot, "videos", `${ending.runId}.mp4`), { force: true });
    if (saveError) {
      return reply({ op: "live_stop", session: id, outcome: { kind: "rejected", reason: saveError.slice(0, 180) }, view, shot: "" });
    }
    return reply({ op: "live_stop", session: id, outcome: { kind: "stopped", already: false, ...(videoNote ? { reason: videoNote } : {}) }, view, shot: "" });
  }

  /** Runs inside the call chain. The session must be closed, and the replay takes the CDP lock itself. */
  async function runReplay(workflow: WorkflowV2, inputs: ReplayArgs, options: LiveReplayOptions = {}, evalVideoNoBlur?: true): Promise<RunResult> {
    if (slot.phase === "open") throw new Error("stop the live session before replay");
    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    let selected: LiveRunSelection | undefined;
    let run: RunResult = {
      runId, status: "failed", steps: workflow.steps.map((step) => ({ id: step.id, status: "pending" })),
      heals: [], repairs: [], locatorHits: [], receipts: [], trajectory: [], trail: [], pageClasses: [], modelCalls: 0,
    };
    try {
      selected = await opts.selectRun?.();
      run.pageEngine = selected?.engineName ?? "old";
      try {
        run = await replayLiveWorkflow(workflow, inputs, {
          target: selected?.target ?? defaultTarget,
          leaveOpen: options.leaveOpen,
          engineName: run.pageEngine,
          artifactRoot: selected?.artifactRoot,
          shotDir: path.join(opts.home, "shots", "runs", runId),
          videoDir: opts.videoDir,
          evalVideoNoBlur,
          lockFile,
          helper: opts.helper,
          openProfile,
          axLog,
          connectTimeoutMs: opts.connectTimeoutMs,
          onNotice: opts.onNotice,
        }, runId);
      } finally {
        if (run.pageLeftOpen && selected?.close) heldProfiles.push(selected.close);
        else await selected?.close?.();
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "live replay failed";
      run.status = "failed";
      run.failure = run.failure ? { ...run.failure, reason: `${run.failure.reason}; ${reason}` } : {
        stepId: workflow.steps[0]?.id || workflow.id, index: 0, intent: workflow.intent || workflow.name,
        phase: "action", reason, snapshot: {},
      };
      const clip = selected?.artifactRoot ? path.join(selected.artifactRoot, "videos", `${runId}.mp4`) : "";
      if (clip && existsSync(clip) && statSync(clip).size > 1000) run.video = `${runId}.mp4`;
    }
    return run;
  }

  /** bao mcp's run_workflow sends the workflow it found and the inputs. The reply carries the run, or why it did not start. */
  async function replayBody(body: Record<string, unknown>): Promise<unknown> {
    const workflow = body.workflow && typeof body.workflow === "object" ? body.workflow as WorkflowV2 : undefined;
    const inputs = body.inputs && typeof body.inputs === "object" && !Array.isArray(body.inputs) ? body.inputs as ReplayArgs : {};
    try {
      if (!workflow) throw new Error("workflow is required");
      const errors = validateWorkflow(workflow);
      if (errors.length) throw new Error(`invalid workflow: ${errors.join(", ")}`);
      return reply({ op: LIVE_REPLAY, run: await runReplay(workflow, inputs, { leaveOpen: body.leaveOpen === true }, opts.evalVideoNoBlur) });
    } catch (err) {
      const reason = err instanceof Error ? err.message : "live replay failed";
      return reply({ op: LIVE_REPLAY, outcome: { kind: "rejected", reason: reason.slice(0, 180) } });
    }
  }

  async function replay(workflow: WorkflowV2, inputs: ReplayArgs = {}, options: LiveReplayOptions = {}): Promise<RunResult> {
    const run = chain.then(() => runReplay(workflow, inputs, options));
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Runs in the call chain, so an idle save that already started wins and the reply says the session is gone. */
  async function keepOpen(): Promise<boolean> {
    const run = chain.then(() => {
      if (!open) return false;
      open.driver.touch();
      armIdle();
      return true;
    });
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async function close(): Promise<void> {
    disarmIdle();
    if (slot.phase === "open") {
      await stop().catch(() => undefined);
      releaseCdpLock(AGENT, lockFile);
    }
    await Promise.all(heldProfiles.splice(0).map((closeProfile) => closeProfile()));
  }

  return { call, replay, keepOpen, close, isOpen: () => open !== null };
}
