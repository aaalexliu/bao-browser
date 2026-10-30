import path from "node:path";
import { navigationGuard, originsFor } from "./allowlist";
import { liveSessionDir, SessionLog } from "./audit";
import type { ChromeAx } from "./ax";
import { type CdpLiveDriver } from "./driver";
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
import { redactLabel } from "./live-record";
import {
  admit,
  buildView,
  focusLiveMark,
  isLiveOp,
  LIVE_DISCONNECT,
  LIVE_IDLE_MS,
  markedFieldValue,
  markedState,
  pageHalt,
  planClick,
  planKey,
  planScroll,
  planType,
  publicLiveResult,
  readLivePage,
  sameTarget,
  scrollLivePage,
  searchField,
  targetVerdict,
  viewPage,
  workflowIdsFromIntent,
  type LabelGuard,
  type LiveOpName,
  type LiveRead,
  type LiveViewPage,
  type MarkedState,
  type PageFacts,
  type ScrollFacts,
  type SlotState,
} from "./live-ops";
import {
  cartAddItem,
  clickEffect,
  inCartMarker,
  LiveTrail,
  QUERY_INPUT,
  trailIdentity,
  workflowFromTrail,
  type LiveSide,
} from "./live-trail";
import { guardPreset, presetForUrl } from "./presets";
import type { CdpSocket } from "./socket";
import { leafTexts } from "../v1/recorder";
import { pageWhen, type PageGuard } from "../v1/replay";
import type { Identity, WorkflowV2 } from "../v1/schema";
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
  portFile: string;
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

export interface ReplayTarget {
  driver: Pick<CdpLiveDriver, "setOrigins" | "goto" | "evaluateFunction" | "clickCss" | "takeBlockedNav">;
  guard: LabelGuard;
  stopPath: string;
  hosts: string[];
  origins: string[];
}

/** The open page a key press or a scroll acts on. */
export interface LiveActTarget {
  driver: Pick<CdpLiveDriver, "evaluateFunction" | "pressMarked" | "takeBlockedNav" | "returnFromBlock" | "sleep">;
  read: LiveRead;
  guard: LabelGuard;
  stopPath: string;
  hosts: readonly string[];
  origins: readonly string[];
  /** Writes the audit row. It runs after every check and before the page is touched. */
  before(action: string, label: string): Promise<void>;
  /** Reads the page again under a new epoch. */
  reread(): Promise<LiveRead>;
}

export type LiveActOutcome =
  | { kind: "refused" | "halted"; reason: string }
  | { kind: "applied"; label: string; control: string; scroll?: ScrollFacts };

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

/** Marks the control again and keeps the plan only if the mark is still the control the plan named. */
async function stillMarked(target: Pick<LiveActTarget, "driver" | "read" | "guard">, ref: string, index: number): Promise<boolean> {
  const marked = await target.driver.evaluateFunction<PageFacts>(readLivePage, { markIndex: index });
  return sameTarget(target.read, buildView(marked, target.read.view.epoch, target.guard), ref);
}

/** A load the window failed on a stop path goes back to the last allowed page, and the refusal reads that page again. */
async function refuseBlocked(target: LiveActTarget, reason: string): Promise<LiveActOutcome> {
  if (reason === "stop-path") {
    await target.driver.returnFromBlock();
    await target.reread();
  }
  return { kind: "refused", reason };
}

/** Enter, Tab, or Escape, on the same guards as a click. */
export async function pressLiveKey(target: LiveActTarget, key: string, ref: string): Promise<LiveActOutcome> {
  const plan = planKey(target.read, key, ref);
  if (!plan.ok) return { kind: "refused", reason: plan.refusal };
  const entry = ref ? target.read.targets.byRef.get(ref) : undefined;
  const control = ref ? target.read.view.controls.find((item) => item.ref === ref) : undefined;
  if (key === "Enter" && entry?.href) {
    const why = navigationGuard(entry.href, target.hosts, target.origins, target.stopPath);
    if (why) return { kind: "refused", reason: why };
  }
  const index = entry?.index ?? -1;
  if (entry && !await stillMarked(target, ref, index)) return { kind: "refused", reason: "stale_ref" };
  const label = control?.label || "";
  await target.before("key", `${key} ${label}`.trim());
  target.driver.takeBlockedNav();
  try {
    await target.driver.pressMarked(key, index);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "focus_moved";
    if (reason === "credential_field" || reason === "focus_moved") return { kind: "halted", reason };
    throw err;
  }
  const blockedNav = target.driver.takeBlockedNav();
  if (blockedNav) return refuseBlocked(target, blockedNav);
  return { kind: "applied", label, control: control?.kind || "" };
}

/** Scrolls the page, or the box around one listed control, so more of a long page loads. */
export async function scrollLive(target: LiveActTarget, direction: string, ref: string): Promise<LiveActOutcome> {
  const plan = planScroll(target.read, direction, ref);
  if (!plan.ok) return { kind: "refused", reason: plan.refusal };
  const entry = ref ? target.read.targets.byRef.get(ref) : undefined;
  const control = ref ? target.read.view.controls.find((item) => item.ref === ref) : undefined;
  const index = entry?.index ?? -1;
  if (entry && !await stillMarked(target, ref, index)) return { kind: "refused", reason: "stale_ref" };
  const label = control?.label || "";
  await target.before("scroll", `${direction} ${label}`.trim());
  target.driver.takeBlockedNav();
  const scroll = await target.driver.evaluateFunction<ScrollFacts>(scrollLivePage, { markIndex: index, direction });
  if (scroll.target === "none") return { kind: "refused", reason: "stale_ref" };
  await target.driver.sleep(500);
  const blockedNav = target.driver.takeBlockedNav();
  if (blockedNav) return refuseBlocked(target, blockedNav);
  return { kind: "applied", label, control: control?.kind || "", scroll };
}

interface Parked extends ReplayTarget {
  driver: CdpLiveDriver;
  cdp: CdpSocket;
  portFile: string;
}

export interface LiveReplayResult {
  id: string;
  workflowId: string;
  status: "passed" | "needs_human" | "failed";
  modelCalls: 0;
  stoppedAt: string;
  reason: string;
  steps: { id: string; status: string }[];
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
  replay(workflow: WorkflowV2): Promise<LiveReplayResult>;
  close(): Promise<void>;
} {
  const lockFile = opts.lockFile || CDP_LOCK_PATH;
  const defaultTarget = opts.target || parseLiveTarget("daily", "");
  const openProfile = opts.openProfile || openChromeProfileWindow;
  const idleMs = opts.idleMs ?? LIVE_IDLE_MS;
  let slot: SlotState = { phase: "idle" };
  let open: OpenState | null = null;
  let parked: Parked | null = null;
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
    const preset = presetForUrl(url, asked);
    if (!preset) throw new Error("unknown preset");
    const flags = guardPreset(preset);
    const host = new URL(url).hostname;
    const hosts = [...new Set([host, ...flags.hosts])];
    const origins = originsFor(url, hosts);
    const blocked = navigationGuard(url, hosts, origins, flags.stopPath);
    if (blocked) throw new Error(blocked);
    const prepared = await prepareTarget(target, opts.helper);
    if (parked) {
      await parked.driver.end().catch(() => undefined);
      parked.cdp.close();
      parked = null;
    }
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
      driver.setStopPath(flags.stopPath);
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
        guard: { commit: flags.commit, deny: flags.deny, submit: flags.submit },
        stopPath: flags.stopPath,
        hosts,
        origins,
        portFile: target.portFile,
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
      await watchTargets(cdp, driver.targetId);
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

  async function watchTargets(cdp: CdpSocket, ownId: string): Promise<void> {
    const baseline = new Set<string>([ownId]);
    let ready = false;
    cdp.on("Target.targetCreated", undefined, (params) => {
      const info = (params as { targetInfo?: { type?: string; targetId?: string; openerId?: string } }).targetInfo;
      if (!ready || !info?.targetId || !open) return;
      if (targetVerdict(info, ownId, baseline) !== "close") return;
      void cdp.send("Target.closeTarget", { targetId: info.targetId }).catch(() => undefined);
      open.halted = "new_target";
      open.refused = true;
    });
    const listed = await cdp.send<{ targetInfos?: { targetId?: string }[] }>("Target.getTargets");
    for (const info of listed.targetInfos || []) {
      if (info.targetId) baseline.add(info.targetId);
    }
    ready = true;
    await cdp.send("Target.setDiscoverTargets", { discover: true }).catch(() => undefined);
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
      identity: trailIdentity(seen?.marked),
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

  async function click(ref: string): Promise<unknown> {
    if (!open?.read) throw new Error("no live page");
    const plan = planClick(open.read, ref);
    const target = open.read.targets.byRef.get(ref);
    if (!plan.ok) {
      open.refused = true;
      await note("click", plan.refusal, "failed", null);
      return reply({ op: "live_click", session: open.id, outcome: { kind: "refused", reason: plan.refusal }, view: shown(open.read), shot: "" });
    }
    const href = target?.href || "";
    if (href) {
      const why = navigationGuard(href, open.hosts, open.origins, open.stopPath);
      if (why) {
        open.refused = true;
        await note("click", why, "failed", null);
        return reply({ op: "live_click", session: open.id, outcome: { kind: "refused", reason: why }, view: shown(open.read), shot: "" });
      }
    }
    const index = target?.index ?? -1;
    const label = open.read.view.controls.find((control) => control.ref === ref)?.label || ref;
    open.driver.takeBlockedNav();
    if (!await stillMarked({ driver: open.driver, read: open.read, guard: open.guard }, ref, index)) {
      open.refused = true;
      await note("click", "stale_ref", "failed", null);
      return reply({ op: "live_click", session: open.id, outcome: { kind: "refused", reason: "stale_ref" }, view: shown(open.read), shot: "" });
    }
    const before = await readBefore(open, index, true);
    await note("click", label, "running", null);
    open.driver.markTrust();
    try {
      await open.driver.clickCss(plan.selector);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "click failed";
      open.refused = true;
      if (reason === "element is covered") {
        return reply({ op: "live_click", session: open.id, outcome: { kind: "refused", reason }, view: shown(open.read), shot: "" });
      }
      throw err;
    }
    await open.log.patchLast(open.driver.lastTrusted());
    const blockedNav = open.driver.takeBlockedNav();
    if (blockedNav) {
      open.refused = true;
      if (blockedNav === "stop-path") {
        await open.driver.returnFromBlock();
        await reread(open);
      }
      return reply({ op: "live_click", session: open.id, outcome: { kind: "refused", reason: blockedNav }, view: shown(open.read), shot: "" });
    }
    const after = await readAfter(open, index, true);
    // The accessible name, not the redacted view label, so the item in "Add 1 ct {item}" keeps its digits.
    const name = before.identity?.name || before.identity?.text || label;
    const skipWhen = cartAddItem(name) ? inCartMarker(name, before.nodes, (await open.driver.tree().catch(() => null))?.nodes || []) : "";
    await open.trail.add({
      op: "click",
      identity: before.identity,
      beforeUrl: before.side.url,
      afterUrl: after.url || undefined,
      ...clickEffect(before.side, after),
      ...(skipWhen ? { skipWhen } : {}),
    });
    return look("click");
  }

  async function typeInto(ref: string, text: string): Promise<unknown> {
    if (!open?.read) throw new Error("no live page");
    const early = planType(open.read, ref, text);
    if (!early.ok) {
      open.refused = true;
      await note("type", early.refusal, "failed", null);
      return reply({ op: "live_type", session: open.id, outcome: { kind: "refused", reason: early.refusal }, view: shown(open.read), shot: "" });
    }
    const index = open.read.targets.byRef.get(ref)?.index ?? -1;
    const label = open.read.view.controls.find((control) => control.ref === ref)?.label || ref;
    if (!await stillMarked({ driver: open.driver, read: open.read, guard: open.guard }, ref, index)) {
      open.refused = true;
      await note("type", "stale_ref", "failed", null);
      return reply({ op: "live_type", session: open.id, outcome: { kind: "refused", reason: "stale_ref" }, view: shown(open.read), shot: "" });
    }
    const prior = await open.driver.evaluateFunction<string>(markedFieldValue, { markIndex: index });
    const plan = planType(open.read, ref, text, prior);
    if (!plan.ok) {
      open.refused = true;
      await note("type", plan.refusal, "failed", null);
      return reply({ op: "live_type", session: open.id, outcome: { kind: "refused", reason: plan.refusal }, view: shown(open.read), shot: "" });
    }
    const before = await readBefore(open, index);
    await note("type", label, "running", null);
    await open.driver.evaluateFunction(focusLiveMark, { markIndex: index });
    try {
      await open.driver.insertText(text, prior, index);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "focus_moved";
      open.refused = true;
      if (reason === "credential_field" || reason === "focus_moved") {
        open.halted = reason;
        return reply({ op: "live_type", session: open.id, outcome: { kind: "halted", reason }, view: shown(open.read), shot: "" });
      }
      throw err;
    }
    const after = await readAfter(open, index);
    const fact = open.facts?.controls.find((item) => item.index === index);
    await open.trail.add({
      op: "type",
      identity: before.identity,
      // The whole field, as the recorder keeps it. Text typed after a prefilled value includes that value.
      value: after.value || `${before.side.value}${text}`,
      ...(fact && searchField(fact) ? { parameter: QUERY_INPUT } : {}),
      beforeUrl: before.side.url,
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
    parked = {
      driver: open.driver,
      cdp: open.cdp,
      guard: open.guard,
      stopPath: open.stopPath,
      hosts: open.hosts,
      origins: open.origins,
      portFile: open.portFile,
    };
    await open.log.flush(saveError ? "failed" : status, saveError || noteText, open.host);
    releaseCdpLock(AGENT, lockFile);
    slot = { phase: "closed", id, status: saveError ? "failed" : status };
    open = null;
    if (saveError) {
      return reply({ op: "live_stop", session: id, outcome: { kind: "rejected", reason: saveError.slice(0, 180) }, view, shot: "" });
    }
    return reply({ op: "live_stop", session: id, outcome: { kind: "stopped", already: false }, view, shot: "" });
  }

  async function replay(workflow: WorkflowV2): Promise<LiveReplayResult> {
    const run = chain.then(() => {
      if (slot.phase === "open") throw new Error("stop the live session before replay");
      if (!parked) throw new Error("live chrome is not open");
      return replayLive(parked, workflow, lockFile);
    });
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async function close(): Promise<void> {
    clearTimeout(idleTimer);
    if (slot.phase === "open") {
      await stop().catch(() => undefined);
      releaseCdpLock(AGENT, lockFile);
    }
    if (parked) {
      await parked.driver.end().catch(() => undefined);
      parked.cdp.close();
      parked = null;
    }
  }

  return { call, replay, close };
}

export async function replayLive(target: ReplayTarget, workflow: WorkflowV2, lockFile = CDP_LOCK_PATH): Promise<LiveReplayResult> {
  if (workflow.driver !== "cdp-live") throw new Error("not a live workflow");
  await acquireCdpLock(AGENT, { file: lockFile, timeoutMs: 1_000 });
  try {
    const driver = target.driver;
    driver.setOrigins(target.origins);
    await driver.goto(workflow.startUrl);
    const look = async (markIndex = -1): Promise<{ read: LiveRead; facts: PageFacts; halt: string | null }> => {
      const facts = await driver.evaluateFunction<PageFacts>(readLivePage, { markIndex });
      const read = buildView(facts, 1, target.guard);
      const halt = pageHalt({
        blocked: facts.blocked,
        path: facts.path,
        passwordFields: read.view.credentialFields,
        text: facts.text,
        stopPath: target.stopPath,
      });
      return { read, facts, halt };
    };
    let guard: PageGuard | undefined;
    let stoppedAt = "";
    let status: LiveReplayResult["status"] = "passed";
    let reason = "";
    const stopAt = (id: string, next: LiveReplayResult["status"], why: string): void => {
      stoppedAt = id;
      status = next;
      reason = why;
    };
    for (const step of workflow.steps) {
      const wants = pageWhen(step);
      if (wants) {
        if (!guard || guard.key !== wants.key) {
          const { facts } = await look();
          const shows = facts.controls.some((item) => item.label.includes(wants.text)) || (facts.text || "").includes(wants.text);
          guard = { key: wants.key, open: shows === wants.shown };
        }
        if (!guard.open) continue;
      } else {
        guard = undefined;
      }
      if (step.human || step.action !== "click") {
        stopAt(step.id, "needs_human", step.action);
        break;
      }
      const name = step.identity?.name || step.locators?.find((item) => item.name)?.name || "";
      const { read, halt } = await look();
      if (halt) {
        stopAt(step.id, "needs_human", halt);
        break;
      }
      const label = redactLabel(name);
      const control = read.view.controls.find((item) => item.label === label);
      if (!control) {
        stopAt(step.id, "failed", "not_found");
        break;
      }
      const plan = planClick(read, control.ref);
      if (!plan.ok) {
        stopAt(step.id, "failed", plan.refusal);
        break;
      }
      const href = read.targets.byRef.get(control.ref)?.href || "";
      const blocked = href ? navigationGuard(href, target.hosts, target.origins, target.stopPath) : null;
      if (blocked) {
        stopAt(step.id, "failed", blocked);
        break;
      }
      const index = read.targets.byRef.get(control.ref)?.index ?? -1;
      if (!sameTarget(read, (await look(index)).read, control.ref)) {
        stopAt(step.id, "failed", "stale_ref");
        break;
      }
      driver.takeBlockedNav();
      await driver.clickCss(plan.selector);
      const blockedNav = driver.takeBlockedNav();
      if (blockedNav) {
        stopAt(step.id, "failed", blockedNav);
        break;
      }
    }
    const last = workflow.steps[workflow.steps.length - 1];
    if (!stoppedAt && last) {
      const halt = (await look()).halt;
      if (halt) stopAt(last.id, "needs_human", halt);
    }
    const at = workflow.steps.findIndex((step) => step.id === stoppedAt);
    return {
      id: workflow.id,
      workflowId: workflow.id,
      status,
      modelCalls: 0,
      stoppedAt,
      reason,
      steps: workflow.steps.map((step, i) => ({
        id: step.id,
        status: at < 0 || i < at ? "passed" : i === at ? status : "skipped",
      })),
    };
  } finally {
    releaseCdpLock(AGENT, lockFile);
  }
}
