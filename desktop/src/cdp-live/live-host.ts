import path from "node:path";
import { navigationAllowed } from "./allowlist";
import { liveSessionDir, SessionLog } from "./audit";
import { checkboxReach } from "./consent";
import { connectAndAllow } from "./connect";
import { AxUnavailable, checkboxState, chromeHelper } from "./ax";
import { openLiveWindow, type CdpLiveDriver } from "./driver";
import { listenPid, readDevToolsActivePort } from "./endpoint";
import { acquireCdpLock, CDP_LOCK_PATH, releaseCdpLock } from "./lock";
import {
  admit,
  buildView,
  isLiveOp,
  pageHalt,
  planClick,
  planType,
  publicLiveResult,
  focusLiveMark,
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

const AGENT = "bao-live";

interface OpenState {
  id: string;
  driver: CdpLiveDriver;
  cdp: CdpSocket;
  log: SessionLog;
  commit: string;
  host: string;
  epoch: number;
  read: LiveRead | null;
  halted: string;
  steps: { name: string; status: string; ms: number }[];
}

export function createLiveHost(opts: { home: string }): {
  call(raw: unknown): Promise<unknown>;
  close(): Promise<void>;
} {
  let slot: SlotState = { phase: "idle" };
  let open: OpenState | null = null;
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
      return reply({ op, session: open?.id || session, outcome: { kind: "rejected", reason: reason.slice(0, 180) }, view: null, shot: "" });
    }
  }

  async function start(body: Record<string, unknown>): Promise<unknown> {
    const intent = typeof body.intent === "string" ? body.intent.trim() : "";
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const portFile = typeof body.portFile === "string" ? body.portFile.trim() : "";
    const preset = typeof body.preset === "string" && body.preset ? body.preset : "generic";
    if (!intent) throw new Error("intent is required");
    if (!url.startsWith("http://") && !url.startsWith("https://")) throw new Error("url must be http or https");
    if (!path.isAbsolute(portFile) || path.basename(portFile) !== "DevToolsActivePort") {
      throw new Error("port file must be an absolute DevToolsActivePort path");
    }
    if (!presetName(preset)) throw new Error("unknown preset");
    const flags = guardPreset(preset);
    const host = new URL(url).hostname;
    const hosts = [...new Set([host, ...flags.hosts])];
    if (!navigationAllowed(url, hosts)) throw new Error("url is not on the host list");
    const endpoint = await readDevToolsActivePort(portFile);
    const chromePid = await listenPid(endpoint.port);
    if (!chromePid) throw new Error("no Chrome is listening on the DevTools port");
    const helper = chromeHelper();
    const perms = await helper.permissions(false);
    if (perms.prompted) throw new Error("helper asked for a permission prompt");
    if (!perms.accessibility) throw new Error("BaoOSHelper accessibility is not granted");
    if (perms.screenCapture) throw new Error("BaoOSHelper screen recording is granted; not starting");
    await acquireCdpLock(AGENT, { file: CDP_LOCK_PATH, timeoutMs: 5_000 });
    let cdp: CdpSocket | undefined;
    let driver: CdpLiveDriver | undefined;
    try {
      const box = await checkboxState(helper, chromePid);
      if (checkboxReach(box.summary) === "stop") {
        throw new AxUnavailable("BaoOSHelper cannot see a Chrome window", box.summary);
      }
      // The port file is the debugging endpoint. The menu checkbox is not required when that file exists.
      const dialogPresentBeforeConnect = box.summary.dialog.present || box.summary.dialog.buttonCount > 0;
      if (dialogPresentBeforeConnect) throw new Error("Allow dialog was already up");
      const opened = await connectAndAllow({
        helper,
        endpoint,
        dialogPresentBeforeConnect,
        axLog: path.join(opts.home, "live-session", "ax.jsonl"),
        pid: chromePid,
      });
      cdp = opened.cdp;
      driver = await openLiveWindow(cdp, hosts);
      const ids = workflowIdsFromIntent(intent);
      const log = new SessionLog(liveSessionDir(opts.home), intent, ids.workflowId.slice(0, 40));
      open = { id: ids.workflowId.slice(0, 40), driver, cdp, log, commit: flags.commit, host, epoch: 0, read: null, halted: "", steps: [] };
      slot = { phase: "open", id: open.id };
      watchTargets(cdp, driver.targetId);
      await driver.goto(url);
      return await look("start");
    } catch (err) {
      await driver?.end().catch(() => undefined);
      cdp?.close();
      releaseCdpLock(AGENT, CDP_LOCK_PATH);
      open = null;
      slot = { phase: "idle" };
      throw err;
    }
  }

  function watchTargets(cdp: CdpSocket, ownId: string): void {
    cdp.on("Target.targetCreated", undefined, (params) => {
      const info = (params as { targetInfo?: { type?: string; targetId?: string; openerId?: string } }).targetInfo;
      if (!info?.targetId || !open) return;
      if (targetVerdict(info, ownId) !== "close") return;
      void cdp.send("Target.closeTarget", { targetId: info.targetId }).catch(() => undefined);
      open.halted = "new_target";
    });
    void cdp.send("Target.setDiscoverTargets", { discover: true }).catch(() => undefined);
  }

  async function look(action: string): Promise<unknown> {
    if (!open) throw new Error("no live session");
    const started = Date.now();
    open.epoch += 1;
    const facts = await open.driver.evaluateFunction<PageFacts>(readLivePage, { markIndex: -1 });
    open.read = buildView(facts, open.epoch, open.commit);
    const halt = pageHalt({ blocked: facts.blocked, path: facts.path, passwordFields: open.read.view.credentialFields });
    if (halt) open.halted = halt;
    const shot = await record(action, open.read.view.title || action, Date.now() - started, halt ? "needs_human" : "passed");
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
    if (!plan.ok) {
      return reply({ op: "live_click", session: open.id, outcome: { kind: "refused", reason: plan.refusal }, view: open.read.view, shot: "" });
    }
    const index = open.read.targets.byRef.get(ref)?.index ?? -1;
    await open.driver.evaluateFunction(readLivePage, { markIndex: index });
    await open.driver.clickCss(plan.selector);
    return look("click");
  }

  async function typeInto(ref: string, text: string): Promise<unknown> {
    if (!open?.read) throw new Error("no live page");
    const plan = planType(open.read, ref, text);
    if (!plan.ok) {
      return reply({ op: "live_type", session: open.id, outcome: { kind: "refused", reason: plan.refusal }, view: open.read.view, shot: "" });
    }
    const index = open.read.targets.byRef.get(ref)?.index ?? -1;
    await open.driver.evaluateFunction(readLivePage, { markIndex: index });
    await open.driver.clickCss(plan.selector);
    await open.driver.evaluateFunction(focusLiveMark, { markIndex: index });
    await open.driver.insertText(text);
    return look("type");
  }

  async function record(action: string, label: string, ms: number, status: string): Promise<string> {
    if (!open) return "";
    open.steps.push({ name: action, status, ms });
    open.log.setSteps(open.steps);
    const png = await open.driver.captureRedacted(`${action} ${open.read?.view.path || ""}`).catch(() => undefined);
    return open.log.add({
      action,
      label,
      path: open.read?.view.path || "",
      isTrusted: true,
      ms,
      png,
    });
  }

  async function stop(): Promise<unknown> {
    if (!open) {
      return reply({ op: "live_stop", session: "", outcome: { kind: "rejected", reason: "not_open" }, view: null, shot: "" });
    }
    const id = open.id;
    const view: LiveView | null = open.read?.view || null;
    const note = open.halted ? open.halted : "Stopped.";
    const status = open.halted ? "needs_human" : "passed";
    await open.driver.end().catch(() => undefined);
    open.cdp.close();
    await open.log.flush(status, note, open.host);
    releaseCdpLock(AGENT, CDP_LOCK_PATH);
    slot = { phase: "closed", id, status };
    open = null;
    return reply({ op: "live_stop", session: id, outcome: { kind: "stopped", already: false }, view, shot: "" });
  }

  async function close(): Promise<void> {
    if (slot.phase === "open") await stop().catch(() => undefined);
  }

  return { call, close };
}
