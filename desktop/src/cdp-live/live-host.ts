import path from "node:path";
import { navigationGuard, originsFor } from "./allowlist";
import { liveSessionDir, SessionLog } from "./audit";
import { workflowFromLive, type LiveAction } from "./attach";
import { checkboxReach } from "./consent";
import { connectAndAllow } from "./connect";
import { AxUnavailable, checkboxState, chromeHelper } from "./ax";
import { openLiveWindow, type CdpLiveDriver } from "./driver";
import { listenPid, readDevToolsActivePort } from "./endpoint";
import { liveChromeBlock } from "../helper-capabilities";
import { acquireCdpLock, CDP_LOCK_PATH, rememberLockTarget, releaseCdpLock, takeDeadTarget } from "./lock";
import {
  admit,
  buildView,
  focusLiveMark,
  isLiveOp,
  markedFieldValue,
  pageHalt,
  planClick,
  planType,
  publicLiveResult,
  readLivePage,
  targetVerdict,
  workflowIdsFromIntent,
  type LiveRead,
  type LiveView,
  type PageFacts,
  type SlotState,
} from "./live-ops";
import { guardPreset, presetName } from "./presets";
import type { CdpSocket } from "./socket";
import { validateWorkflow, type WorkflowV2 } from "../v1/schema";
import { Library } from "../v1/store";

const AGENT = "bao-live";

interface OpenState {
  id: string;
  intent: string;
  startUrl: string;
  driver: CdpLiveDriver;
  cdp: CdpSocket;
  log: SessionLog;
  commit: string;
  deny: string;
  stopPath: string;
  hosts: string[];
  origins: string[];
  portFile: string;
  host: string;
  epoch: number;
  read: LiveRead | null;
  halted: string;
  refused: boolean;
  actions: LiveAction[];
  steps: { name: string; status: string; ms: number }[];
}

export interface ReplayTarget {
  driver: Pick<CdpLiveDriver, "setOrigins" | "goto" | "evaluateFunction" | "clickCss">;
  commit: string;
  deny: string;
  hosts: string[];
  origins: string[];
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
  steps: { id: string; status: string }[];
}

export function createLiveHost(opts: { home: string; lockFile?: string; connectTimeoutMs?: number }): {
  call(raw: unknown): Promise<unknown>;
  replay(workflow: WorkflowV2): Promise<LiveReplayResult>;
  close(): Promise<void>;
} {
  const lockFile = opts.lockFile || CDP_LOCK_PATH;
  let slot: SlotState = { phase: "idle" };
  let open: OpenState | null = null;
  let parked: Parked | null = null;
  let chain = Promise.resolve();

  function reply(body: Record<string, unknown>): unknown {
    return publicLiveResult(body);
  }

  async function call(raw: unknown): Promise<unknown> {
    const run = chain.then(() => dispatch(raw));
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async function dispatch(raw: unknown): Promise<unknown> {
    const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const op = typeof body.op === "string" ? body.op : "";
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
        return reply({ op, session: open.id, outcome: { kind: "halted", reason: open.halted }, view: open.read?.view || null, shot: "" });
      }
      if (op === "live_snapshot") return await look("snapshot");
      if (op === "live_click") return await click(String(body.ref || ""));
      if (op === "live_type") return await typeInto(String(body.ref || ""), String(body.text || ""));
      return await look("screenshot");
    } catch (err) {
      const reason = err instanceof Error ? err.message : "live call failed";
      if (open) {
        open.refused = true;
        await note(op, reason, "failed", null);
      }
      return reply({ op, session: open?.id || session, outcome: { kind: "rejected", reason: reason.slice(0, 180) }, view: open?.read?.view || null, shot: "" });
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
    const preset = typeof body.preset === "string" && body.preset ? body.preset : "generic";
    const workflowId = typeof body.workflowId === "string" ? body.workflowId.trim() : "";
    if (!intent) throw new Error("intent is required");
    if (!url.startsWith("http://") && !url.startsWith("https://")) throw new Error("url must be http or https");
    if (!path.isAbsolute(portFile) || path.basename(portFile) !== "DevToolsActivePort") {
      throw new Error("port file must be an absolute DevToolsActivePort path");
    }
    if (!presetName(preset)) throw new Error("unknown preset");
    const flags = guardPreset(preset);
    const host = new URL(url).hostname;
    const hosts = [...new Set([host, ...flags.hosts])];
    const origins = originsFor(url, hosts);
    const blocked = navigationGuard(url, hosts, origins, flags.stopPath);
    if (blocked) throw new Error(blocked);
    const endpoint = await readDevToolsActivePort(portFile);
    const chromePid = await listenPid(endpoint.port);
    if (!chromePid) throw new Error("no Chrome is listening on the DevTools port");
    const helper = chromeHelper();
    const perms = await helper.permissions(false);
    const permissionBlock = liveChromeBlock(perms);
    if (permissionBlock) throw new Error(permissionBlock);
    if (parked) {
      await parked.driver.end().catch(() => undefined);
      parked.cdp.close();
      parked = null;
    }
    await acquireCdpLock(AGENT, { file: lockFile, timeoutMs: 5_000 });
    let cdp: CdpSocket | undefined;
    let driver: CdpLiveDriver | undefined;
    try {
      const box = await checkboxState(helper, chromePid);
      if (checkboxReach(box.summary) === "stop") {
        throw new AxUnavailable("BaoOSHelper cannot see a Chrome window", box.summary);
      }
      const dialogPresentBeforeConnect = box.summary.dialog.present || box.summary.dialog.buttonCount > 0;
      if (dialogPresentBeforeConnect) throw new Error("Allow dialog was already up");
      const opened = await connectAndAllow({
        helper,
        endpoint,
        dialogPresentBeforeConnect,
        axLog: path.join(opts.home, "live-session", "ax.jsonl"),
        pid: chromePid,
        timeoutMs: opts.connectTimeoutMs,
      });
      cdp = opened.cdp;
      driver = await openLiveWindow(cdp, hosts);
      driver.setOrigins(origins);
      const ids = workflowIdsFromIntent(intent, workflowId);
      const log = new SessionLog(liveSessionDir(opts.home), intent, ids.workflowId.slice(0, 40));
      open = {
        id: ids.workflowId.slice(0, 40),
        intent,
        startUrl: url,
        driver,
        cdp,
        log,
        commit: flags.commit,
        deny: flags.deny,
        stopPath: flags.stopPath,
        hosts,
        origins,
        portFile,
        host,
        epoch: 0,
        read: null,
        halted: "",
        refused: false,
        actions: [],
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

  async function look(action: string): Promise<unknown> {
    if (!open) throw new Error("no live session");
    const started = Date.now();
    open.epoch += 1;
    const facts = await open.driver.evaluateFunction<PageFacts>(readLivePage, { markIndex: -1 });
    open.read = buildView(facts, open.epoch, open.commit, open.deny);
    const halt = pageHalt({
      blocked: facts.blocked,
      path: facts.path,
      passwordFields: open.read.view.credentialFields,
      text: facts.text,
    });
    if (halt) {
      open.halted = halt;
      open.refused = true;
    }
    const shot = await record(action, open.read.view.title || action, Date.now() - started, halt ? "needs_human" : "passed", null);
    const op = action === "start" ? "live_session_start"
      : action === "snapshot" ? "live_snapshot"
        : action === "click" ? "live_click"
          : action === "type" ? "live_type"
            : "live_screenshot";
    return reply({
      op,
      session: open.id,
      outcome: halt ? { kind: "halted", reason: halt } : { kind: "applied" },
      view: open.read.view,
      shot,
    });
  }

  async function click(ref: string): Promise<unknown> {
    if (!open?.read) throw new Error("no live page");
    const plan = planClick(open.read, ref);
    const target = open.read.targets.byRef.get(ref);
    if (!plan.ok) {
      open.refused = true;
      await note("click", plan.refusal, "failed", null);
      return reply({ op: "live_click", session: open.id, outcome: { kind: "refused", reason: plan.refusal }, view: open.read.view, shot: "" });
    }
    const href = target?.href || "";
    if (href) {
      const why = navigationGuard(href, open.hosts, open.origins, open.stopPath);
      if (why) {
        open.refused = true;
        await note("click", why, "failed", null);
        return reply({ op: "live_click", session: open.id, outcome: { kind: "refused", reason: why }, view: open.read.view, shot: "" });
      }
    }
    const index = target?.index ?? -1;
    const label = open.read.view.controls.find((control) => control.ref === ref)?.label || ref;
    const kind = open.read.view.controls.find((control) => control.ref === ref)?.kind || "button";
    await note("click", label, "running", null);
    open.driver.takeBlockedNav();
    await open.driver.evaluateFunction(readLivePage, { markIndex: index });
    open.driver.markTrust();
    try {
      await open.driver.clickCss(plan.selector);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "click failed";
      open.refused = true;
      if (reason === "element is covered") {
        return reply({ op: "live_click", session: open.id, outcome: { kind: "refused", reason }, view: open.read.view, shot: "" });
      }
      throw err;
    }
    await open.log.patchLast(open.driver.lastTrusted());
    const blockedNav = open.driver.takeBlockedNav();
    if (blockedNav) {
      open.refused = true;
      return reply({ op: "live_click", session: open.id, outcome: { kind: "refused", reason: blockedNav }, view: open.read.view, shot: "" });
    }
    open.actions.push({ name: "click", label, path: open.read.view.path, kind });
    return look("click");
  }

  async function typeInto(ref: string, text: string): Promise<unknown> {
    if (!open?.read) throw new Error("no live page");
    const early = planType(open.read, ref, text);
    if (!early.ok) {
      open.refused = true;
      await note("type", early.refusal, "failed", null);
      return reply({ op: "live_type", session: open.id, outcome: { kind: "refused", reason: early.refusal }, view: open.read.view, shot: "" });
    }
    const index = open.read.targets.byRef.get(ref)?.index ?? -1;
    const label = open.read.view.controls.find((control) => control.ref === ref)?.label || ref;
    await open.driver.evaluateFunction(readLivePage, { markIndex: index });
    const prior = await open.driver.evaluateFunction<string>(markedFieldValue, { markIndex: index });
    const plan = planType(open.read, ref, text, prior);
    if (!plan.ok) {
      open.refused = true;
      await note("type", plan.refusal, "failed", null);
      return reply({ op: "live_type", session: open.id, outcome: { kind: "refused", reason: plan.refusal }, view: open.read.view, shot: "" });
    }
    await note("type", label, "running", null);
    await open.driver.evaluateFunction(focusLiveMark, { markIndex: index });
    try {
      await open.driver.insertText(text, prior, index);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "focus_moved";
      open.refused = true;
      if (reason === "credential_field" || reason === "focus_moved") {
        open.halted = reason;
        return reply({ op: "live_type", session: open.id, outcome: { kind: "halted", reason }, view: open.read.view, shot: "" });
      }
      throw err;
    }
    open.actions.push({ name: "type", label, path: open.read.view.path, kind: "field", value: text });
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

  function saveWorkflow(): void {
    if (!open) return;
    const workflow = workflowFromLive({
      id: open.id,
      name: open.intent.slice(0, 80),
      intent: open.intent,
      startUrl: open.startUrl,
      createdAt: Date.now(),
      actions: open.actions,
    });
    const errors = validateWorkflow(workflow);
    if (errors.length) throw new Error(errors.join(", "));
    new Library(opts.home).save(workflow);
  }

  async function stop(): Promise<unknown> {
    if (!open) {
      return reply({ op: "live_stop", session: "", outcome: { kind: "rejected", reason: "not_open" }, view: null, shot: "" });
    }
    const id = open.id;
    const view: LiveView | null = open.read?.view || null;
    const noteText = open.halted ? open.halted : open.refused ? "Refused." : "Stopped.";
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
      commit: open.commit,
      deny: open.deny,
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
    if (slot.phase === "open") await stop().catch(() => undefined);
    if (parked) {
      await parked.driver.end().catch(() => undefined);
      parked.cdp.close();
      parked = null;
    }
    releaseCdpLock(AGENT, lockFile);
  }

  return { call, replay, close };
}

export async function replayLive(target: ReplayTarget, workflow: WorkflowV2, lockFile = CDP_LOCK_PATH): Promise<LiveReplayResult> {
  if (workflow.driver !== "cdp-live") throw new Error("not a live workflow");
  await acquireCdpLock(AGENT, { file: lockFile, timeoutMs: 0 });
  try {
    const driver = target.driver;
    driver.setOrigins(target.origins);
    await driver.goto(workflow.startUrl);
    const look = async (): Promise<{ read: LiveRead; halt: string | null }> => {
      const facts = await driver.evaluateFunction<PageFacts>(readLivePage, { markIndex: -1 });
      const read = buildView(facts, 1, target.commit, target.deny);
      return { read, halt: pageHalt({ blocked: facts.blocked, path: facts.path, passwordFields: read.view.credentialFields, text: facts.text }) };
    };
    let stoppedAt = "";
    let failed = "";
    for (const step of workflow.steps) {
      if (step.human || step.action !== "click") {
        stoppedAt = step.id;
        break;
      }
      const name = step.identity?.name || step.locators?.find((item) => item.name)?.name || "";
      const { read, halt } = await look();
      if (halt) {
        stoppedAt = step.id;
        break;
      }
      const control = read.view.controls.find((item) => item.label === name);
      if (!control) {
        failed = name || step.id;
        break;
      }
      const plan = planClick(read, control.ref);
      if (!plan.ok) {
        failed = plan.refusal;
        break;
      }
      const href = read.targets.byRef.get(control.ref)?.href || "";
      if (href && navigationGuard(href, target.hosts, target.origins, "")) {
        failed = "stop-path";
        break;
      }
      const index = read.targets.byRef.get(control.ref)?.index ?? -1;
      await driver.evaluateFunction(readLivePage, { markIndex: index });
      await driver.clickCss(plan.selector);
    }
    const last = workflow.steps[workflow.steps.length - 1];
    if (!stoppedAt && !failed && last && (await look()).halt) stoppedAt = last.id;
    const status = failed ? "failed" : stoppedAt ? "needs_human" : "passed";
    return {
      id: workflow.id,
      workflowId: workflow.id,
      status,
      modelCalls: 0,
      stoppedAt: stoppedAt || failed,
      steps: workflow.steps.map((step) => ({
        id: step.id,
        status: step.id === stoppedAt || step.id === failed ? status : "passed",
      })),
    };
  } finally {
    releaseCdpLock(AGENT, lockFile);
  }
}
