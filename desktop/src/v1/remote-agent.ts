// The Mac dials the relay. Without relay.json it dials nothing. The Chrome
// extension stays behind the native-messaging bridge and never calls the registry.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrowserContext } from "playwright";
import { redactAudit } from "../../../web/src/lib/audit-redact";
import { hasPrivatePictureInput, scrubSaved, type SavedContext } from "../../../shared/outbound-secrets";
import { isToolName, JOB_ID, type ToolName } from "../../../web/src/lib/relay-tools";
import { maxFrameBytes, openWebSocket, type LiteSocket } from "../../../web/src/lib/ws-lite";
import { EXTENSION_NOT_CONNECTED, replayRefusal } from "../cdp-live/launch-guard";
import { describeWorkflow, heldConfirmReady, heldConfirmStep, runWorkflow, searchWorkflows, type WorkflowOutcome } from "../mcp/catalog";
import type { PersonPrompts } from "./browser-driver";
import { clearRelay, loadRelay, type RelayLink } from "./relay-link";
import { remoteDriverKind } from "./remote-run";
import type { WorkflowV2 } from "./schema";
import { Library } from "./store";

/** This Mac dials out only when its own setting is on, or BAO_REMOTE_MCP=1 is set for the process. */
export function desktopRemoteEnabled(library: Library, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.BAO_REMOTE_MCP === "1") return true;
  return library.settings().remoteMcp === true;
}

export interface RemoteView {
  phase: "idle" | "running" | "waiting";
  workflowId?: string;
  workflowName?: string;
  jobId?: string;
  resumeToken?: string;
  stepId?: string;
  stepLabel?: string;
  stepNumber?: number;
  stepCount?: number;
  canDetectCompletion?: boolean;
}

export interface RemoteRunners {
  extension?: (workflowId: string, inputs: Record<string, string | number>) => Promise<Record<string, unknown>>;
  playwright?: (workflowId: string, inputs: Record<string, string | number>) => Promise<Record<string, unknown>>;
  resume?: (token: string) => Promise<Record<string, unknown>>;
}

type Slot =
  | { phase: "idle" }
  | { phase: "running"; jobId: string; workflowId: string; workflowName: string; local?: true; suspended?: { resume: string }; holding?: string }
  | { phase: "waiting"; jobId: string; workflowId: string; workflowName: string; resume: string }
  | { phase: "parked"; resume: string; jobId: string; workflowId: string; workflowName: string };

type AssignedJob = {
  id: string;
  tool: ToolName;
  workflowId: string | null;
  args: Record<string, unknown>;
  workflowName: string;
};

type SlotEvent =
  | { type: "job"; job: AssignedJob; saved: Record<string, unknown> | null }
  | { type: "kill" }
  | { type: "expired"; resume: string }
  | { type: "continue-held"; resume: string; completion: "observed" | "owner" }
  | { type: "run-finished"; jobId: string; result: Record<string, unknown>; hold: { kind: "confirm"; resume: string; deadline: number | null } | { kind: "signin" | "wall"; resume: string } | null; local?: true; release?: string }
  | { type: "settled"; jobId: string; reason: string | null };

type SlotEffect =
  | { type: "send-result"; jobId: string; result: Record<string, unknown> }
  | { type: "send-ready" }
  | { type: "start-run"; job: AssignedJob }
  | { type: "continue-held"; resume: string; jobId: string; completion: "observed" | "owner" }
  | { type: "abort-run"; keepPage?: true }
  | { type: "arm-deadline"; resume: string; deadline: number }
  | { type: "clear-context" }
  | { type: "release-held"; resume: string; expired: boolean }
  | { type: "forget-result"; jobId: string };

export function createRemoteAgent(opts: {
  library: Library;
  prompts: PersonPrompts;
  stop: () => void;
  clearStop: () => void;
  runners?: RemoteRunners;
  extensionLinked?: () => boolean;
}): {
  view(): RemoteView;
  kill(): void;
  continue(resume: string, stepId: string): void;
  start(): void;
  stop(): Promise<void>;
} {
  let slot: Slot = { phase: "idle" };
  let stopped = false;
  let context: BrowserContext | undefined;
  let wake: (() => void) | null = null;
  let socket: LiteSocket | null = null;
  let chain: Promise<void> = Promise.resolve();
  let generation = 0;
  let released: Promise<void> = Promise.resolve();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  const locallyMoved = new Map<string, Record<string, unknown>>();

  function view(): RemoteView {
    if (slot.phase === "idle" || slot.phase === "parked") return { phase: "idle" };
    return { phase: slot.phase, workflowId: slot.workflowId, workflowName: slot.workflowName, jobId: slot.jobId,
      ...(slot.phase === "waiting" ? { resumeToken: slot.resume, ...heldConfirmStep(slot.resume) } : {}),
    };
  }

  function kill(): void {
    enqueue(() => transition({ type: "kill" }));
  }

  function start(): void {
    void loop();
  }

  async function stopLoop(): Promise<void> {
    stopped = true;
    generation += 1;
    if (slot.phase === "running") opts.stop();
    socket?.close();
    wake?.();
    clearTimeout(deadlineTimer);
    clearTimeout(confirmTimer);
    await released;
    const resume = heldToken(slot);
    if (resume) {
      locallyMoved.delete(resume);
      await runWorkflow(opts.library, { resume, cancel: true });
    }
    await releaseContext();
  }

  return { view, kill, continue: continueHeld, start, stop: stopLoop };

  function continueHeld(resume: string, stepId: string, completion: "observed" | "owner" = "owner"): void {
    enqueue(() => {
      if (heldConfirmStep(resume)?.stepId !== stepId) return;
      transition({ type: "continue-held", resume, completion });
    });
  }

  function enqueue(work: () => void): void {
    chain = chain.then(work).then(() => undefined, () => undefined);
  }

  function transition(event: SlotEvent, request?: AssignedJob): void {
    const next = apply(slot, event);
    slot = next.slot;
    perform(next.effects, event.type === "job" ? event.job : request);
    if (slot.phase !== "waiting") {
      clearTimeout(confirmTimer);
      confirmTimer = undefined;
    } else {
      watchConfirm(slot.resume);
    }
  }

  function watchConfirm(token: string): void {
    if (stopped || confirmTimer) return;
    const timer = setTimeout(() => {
      const stepId = heldConfirmStep(token)?.stepId;
      void heldConfirmReady(token).then((ready) => {
        if (ready && stepId) continueHeld(token, stepId, "observed");
      }).catch(() => undefined).finally(() => {
        if (confirmTimer === timer) confirmTimer = undefined;
        if (slot.phase === "waiting") watchConfirm(slot.resume);
      });
    }, 300);
    confirmTimer = timer;
    timer.unref();
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      if (!desktopRemoteEnabled(opts.library)) {
        await sleep(1500);
        continue;
      }
      const link = loadRelay(opts.library.root);
      if (!link) {
        await sleep(1500);
        continue;
      }
      try {
        await socketOnce(link);
      } catch (err) {
        if (stopped) return;
        const message = err instanceof Error ? err.message : "";
        if (message.includes("websocket 401")) {
          const currentLink = loadRelay(opts.library.root);
          if (currentLink?.token === link.token) clearRelay(opts.library.root);
        }
        await sleep(1000);
      }
    }
  }

  async function socketOnce(link: RelayLink): Promise<void> {
    const client = await openWebSocket(`${link.server}/api/agent/relay`, {
      Authorization: `Bearer ${link.token}`,
    });
    if (stopped) {
      client.close();
      return;
    }
    socket = client;
    const ping = setInterval(() => client.send(JSON.stringify({ type: "ping" })), 10_000);
    ping.unref();
    await new Promise<void>((resolve) => {
      client.handlers.close = () => {
        clearInterval(ping);
        if (socket === client) socket = null;
        resolve();
      };
      client.handlers.message = (text) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(text) as Record<string, unknown>;
        } catch {
          return;
        }
        // The browser run is not on this chain, so a timeout abort does not wait for it.
        enqueue(() => onFrame(message));
      };
      if (slot.phase === "idle" || slot.phase === "parked") client.send(JSON.stringify({ type: "ready" }));
    });
  }

  function onFrame(message: Record<string, unknown>): void {
    if (message.type === "settled") {
      const jobId = typeof message.jobId === "string" ? message.jobId : "";
      const reason = typeof message.reason === "string" ? message.reason : null;
      transition({ type: "settled", jobId, reason });
      return;
    }
    if (message.type !== "job") return;
    const job = assigned(message.job);
    if (!job) return;
    transition({
      type: "job",
      job,
      saved: readSaved(opts.library.root, job.id),
    });
  }

  function perform(effects: SlotEffect[], request?: AssignedJob): void {
    for (const effect of effects) {
      if (effect.type === "send-ready") {
        socket?.send(JSON.stringify({ type: "ready" }));
        continue;
      }
      if (effect.type === "send-result") {
        const clean = scrubSaved(effect.result, outboundContext(request?.id === effect.jobId ? request : undefined, effect.result));
        const fitted = fitResult(effect.jobId, redactAudit(clean) as Record<string, unknown>);
        rememberResult(opts.library.root, effect.jobId, fitted);
        socket?.send(JSON.stringify({ type: "result", jobId: effect.jobId, result: fitted }));
        continue;
      }
      if (effect.type === "forget-result") {
        forgetResult(opts.library.root, effect.jobId);
        continue;
      }
      if (effect.type === "arm-deadline") {
        armDeadline(effect.resume, effect.deadline);
        continue;
      }
      if (effect.type === "clear-context") {
        const open = context;
        context = undefined;
        void open?.close().catch(() => undefined);
        continue;
      }
      if (effect.type === "release-held") {
        locallyMoved.delete(effect.resume);
        clearTimeout(deadlineTimer);
        const open = context;
        context = undefined;
        released = runWorkflow(opts.library, { resume: effect.resume, cancel: !effect.expired }, undefined, { prompts: opts.prompts })
          .finally(() => open?.close().catch(() => undefined))
          .then(() => undefined, () => undefined);
        continue;
      }
      if (effect.type === "abort-run") {
        generation += 1;
        opts.stop();
        clearTimeout(deadlineTimer);
        if (!effect.keepPage) {
          const open = context;
          context = undefined;
          setTimeout(() => { void open?.close().catch(() => undefined); }, 400);
        }
        continue;
      }
      if (effect.type === "continue-held") {
        clearTimeout(deadlineTimer);
        const gen = generation;
        void runWorkflow(opts.library, { resume: effect.resume }, undefined, { prompts: opts.prompts, confirmCompleted: effect.completion === "owner" })
          .then((result) => finish(effect.jobId, publicOutcome(result), gen, effect.resume))
          .catch(async (err) => {
            if (gen !== generation) return;
            await runWorkflow(opts.library, { resume: effect.resume, cancel: true }).catch(() => undefined);
            finish(effect.jobId, { outcome: "failed", reason: err instanceof Error ? err.message : String(err) }, gen, effect.resume);
          });
        continue;
      }
      if (effect.type === "start-run") {
        clearTimeout(deadlineTimer);
        const gen = generation;
        const job = effect.job;
        void execute(job).then((result) => {
          if (gen !== generation) return;
          finish(job.id, result, gen, undefined, job);
        }).catch((err) => {
          if (gen !== generation) return;
          enqueue(() => {
            if (gen !== generation) return;
            clearTimeout(deadlineTimer);
            const release = slot.phase === "running" ? slot.holding : undefined;
            transition({
              type: "run-finished",
              jobId: job.id,
              result: { outcome: "failed", workflowId: job.workflowId, reason: err instanceof Error ? err.message : String(err) },
              hold: null,
              ...(release ? { release } : {}),
            }, job);
          });
        });
      }
    }
  }

  function outboundContext(job: AssignedJob | undefined, result: Record<string, unknown>): SavedContext {
    const runId = stringArg(result.runId) || stringArg(result.run_id) || (job?.tool === "get_run" ? stringArg(job.args.run_id) : "");
    let stored: ReturnType<Library["readRun"]> | undefined;
    if (runId) {
      try { stored = opts.library.readRun(runId); } catch {}
    }
    const workflowId = stored?.workflowId || stringArg(result.workflowId) || job?.workflowId || stringArg(job?.args.id);
    let workflow: WorkflowV2 | undefined;
    if (workflowId) {
      try { workflow = opts.library.read(workflowId); } catch {}
    }
    const inputs = job?.args.inputs;
    const args = [
      ...(stored?.inputs ? [stored.inputs] : []),
      ...(inputs && typeof inputs === "object" && !Array.isArray(inputs) ? [inputs as Record<string, unknown>] : []),
    ];
    return { workflow, args };
  }

  function finish(jobId: string, result: Record<string, unknown>, gen: number, localToken?: string, request?: AssignedJob): void {
    enqueue(() => {
      if (gen !== generation) return;
      if (localToken) locallyMoved.set(localToken, result);
      const resume = typeof result.resume === "string" ? result.resume : "";
      const info = resumeInfo(resume);
      const kind = info?.kind;
      const deadline = typeof info?.deadline === "number" ? info.deadline : null;
      const hold: Extract<SlotEvent, { type: "run-finished" }>["hold"] =
        resume && kind === "confirm" ? { kind: "confirm", resume, deadline }
        : resume && kind === "signin" ? { kind: "signin", resume }
        : resume && kind === "wall" ? { kind: "wall", resume }
        : null;
      clearTimeout(deadlineTimer);
      transition({ type: "run-finished", jobId, result, hold, local: localToken ? true : undefined }, request);
    });
  }

  function armDeadline(token: string, deadline: number): void {
    deadlineTimer = setTimeout(() => enqueue(() => {
      if (slot.phase !== "waiting" || slot.resume !== token) return;
      if (Date.now() < deadline) {
        armDeadline(token, deadline);
        return;
      }
      transition({ type: "expired", resume: token });
    }), Math.max(0, deadline - Date.now()));
    deadlineTimer.unref();
  }

  async function execute(job: AssignedJob): Promise<Record<string, unknown>> {
    switch (job.tool) {
      case "search_workflows": {
        const hits = await searchWorkflows(opts.library, stringArg(job.args.query), {}, { extensionLinked: opts.extensionLinked?.() ?? false, relay: true });
        return { outcome: "ok", hits };
      }
      case "describe_workflow": {
        const described = await describeWorkflow(opts.library, stringArg(job.args.id));
        return { outcome: "ok", ...described };
      }
      case "get_run":
        return readRun(job);
      case "resume_workflow": {
        const token = stringArg(job.args.resume);
        const moved = locallyMoved.get(token);
        if (moved) {
          locallyMoved.delete(token);
          return moved;
        }
        opts.clearStop();
        if (opts.runners?.resume) return opts.runners.resume(token);
        if (!["signin", "confirm", "wall"].includes(resumeInfo(token)?.kind || "")) {
          return { outcome: "failed", reason: "This run is not held for a human interaction. Use run_workflow to start a new run." };
        }
        return publicOutcome(await runWorkflow(opts.library, { resume: token }, undefined, {
          prompts: opts.prompts,
          onContext: (next) => { context = next; },
        }));
      }
      case "run_workflow":
        return run(job);
      default: {
        const unreachable: never = job.tool;
        return unreachable;
      }
    }
  }

  function readRun(job: AssignedJob): Record<string, unknown> {
    const id = stringArg(job.args.run_id);
    try {
      const stored = opts.library.readRun(id);
      const outputs = stored.outputs ?? [];
      return { outcome: "ok", runId: stored.id, status: stored.status, outputs };
    } catch {
      return { outcome: "failed", reason: "run not found", runId: id };
    }
  }

  async function run(job: AssignedJob): Promise<Record<string, unknown>> {
    const id = job.workflowId || stringArg(job.args.id);
    opts.clearStop();
    await released;
    await releaseContext();
    let workflow: WorkflowV2;
    try {
      workflow = opts.library.read(id);
    } catch (err) {
      return { outcome: "failed", workflowId: id, reason: err instanceof Error ? err.message : "workflow" };
    }
    const refusal = replayRefusal(workflow.driver, { extensionLinked: opts.extensionLinked?.() ?? false });
    if (refusal) return { outcome: "failed", workflowId: id, reason: refusal };
    const inputs = job.args.inputs && typeof job.args.inputs === "object"
      ? job.args.inputs as Record<string, string | number>
      : {};
    const kind = remoteDriverKind(workflow.driver);
    try {
      if (kind === "extension") {
        return opts.runners?.extension
          ? await opts.runners.extension(id, inputs)
          : { outcome: "failed", workflowId: id, reason: EXTENSION_NOT_CONNECTED };
      }
      if (opts.runners?.playwright) return await opts.runners.playwright(id, inputs);
      const outcome = await runWorkflow(opts.library, { id, inputs }, undefined, {
        prompts: opts.prompts,
        onContext: (next) => { context = next; },
      });
      if (outcome.reason === "cancelled") {
        return { outcome: "cancelled", workflowId: outcome.workflowId || id, runId: outcome.runId };
      }
      const body = publicOutcome(outcome);
      const shot = hasPrivatePictureInput(workflow) ? undefined : shotBase64(outcome.runId || outcome.run_id);
      return shot ? { ...body, screenshot: shot } : body;
    } catch (err) {
      return { outcome: "failed", workflowId: id, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  function workflowLabel(id: string): string {
    try { return opts.library.read(id).name || id; } catch { return id; }
  }

  function resumeInfo(token: string | undefined): { kind?: string; deadline?: number | null } | undefined {
    if (!token) return undefined;
    const file = path.join(opts.library.root, "resumes", `${token}.json`);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as { kind?: string; deadline?: number | null };
    } catch {
      return undefined;
    }
  }

  function shotBase64(runId: string | undefined): string | undefined {
    if (!runId) return undefined;
    const dir = path.join(opts.library.root, "shots", "runs", runId);
    if (!existsSync(dir)) return undefined;
    const names = readdirSync(dir).filter((name) => name.endsWith(".png"));
    const preferred = names.find((name) => name.includes("after")) || names[names.length - 1];
    if (!preferred) return undefined;
    const buf = readFileSync(path.join(dir, preferred));
    if (buf.length < 32 || buf[0] !== 0x89 || buf[1] !== 0x50) return undefined;
    return buf.toString("base64");
  }

  function assigned(value: unknown): AssignedJob | null {
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : "";
    const tool = typeof row.tool === "string" ? row.tool : "";
    if (!id || !isToolName(tool)) return null;
    const workflowId = typeof row.workflowId === "string" ? row.workflowId : null;
    const args = row.args && typeof row.args === "object" && !Array.isArray(row.args) ? row.args as Record<string, unknown> : {};
    return {
      id,
      tool,
      workflowId,
      args,
      workflowName: workflowLabel(workflowId || stringArg(args.id) || id),
    };
  }

  async function releaseContext(): Promise<void> {
    const open = context;
    context = undefined;
    if (open) await open.close().catch(() => undefined);
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  }
}

function heldToken(slot: Slot): string | undefined {
  if (slot.phase === "waiting" || slot.phase === "parked") return slot.resume;
  if (slot.phase === "running") return slot.suspended?.resume ?? slot.holding;
  return undefined;
}

function parkedFrom(slot: Extract<Slot, { phase: "running" }>, suspended: { resume: string }): Extract<Slot, { phase: "parked" }> {
  return {
    phase: "parked",
    resume: suspended.resume,
    jobId: slot.jobId,
    workflowId: slot.workflowId,
    workflowName: slot.workflowName,
  };
}

function apply(slot: Slot, event: SlotEvent): { slot: Slot; effects: SlotEffect[] } {
  if (event.type === "job") {
    if (event.saved) {
      return {
        slot,
        effects: [
          { type: "send-result", jobId: event.job.id, result: event.saved },
          ...(slot.phase === "idle" || slot.phase === "parked" ? [{ type: "send-ready" } as const] : []),
        ],
      };
    }
    if (slot.phase === "running") return { slot, effects: [] };
    if (slot.phase === "waiting" && (event.job.tool !== "resume_workflow" || event.job.args.resume !== slot.resume)) {
      return {
        slot,
        effects: [{ type: "send-result", jobId: event.job.id, result: { outcome: "needs_human", reason: "This workflow is waiting for its requested interaction." } }],
      };
    }
    if (slot.phase === "parked") {
      const same = event.job.tool === "resume_workflow" && event.job.args.resume === slot.resume;
      const replaces = event.job.tool === "run_workflow";
      return {
        slot: {
          phase: "running",
          jobId: event.job.id,
          workflowId: same || !replaces ? slot.workflowId : event.job.workflowId || "",
          workflowName: same || !replaces ? slot.workflowName : event.job.workflowName,
          ...(same ? { holding: slot.resume } : {}),
          ...(replaces || same ? {} : { suspended: { resume: slot.resume } }),
        },
        effects: [
          ...(replaces ? [{ type: "release-held" as const, resume: slot.resume, expired: false }] : []),
          { type: "start-run", job: event.job },
        ],
      };
    }
    return {
      slot: {
        phase: "running",
        jobId: event.job.id,
        workflowId: slot.phase === "waiting" ? slot.workflowId : event.job.workflowId || "",
        workflowName: slot.phase === "waiting" ? slot.workflowName : event.job.workflowName,
        ...(slot.phase === "waiting" ? { holding: slot.resume } : {}),
      },
      effects: [{ type: "start-run", job: event.job }],
    };
  }
  if (event.type === "continue-held") {
    if (slot.phase !== "waiting" || slot.resume !== event.resume) return { slot, effects: [] };
    return {
      slot: { phase: "running", jobId: slot.jobId, workflowId: slot.workflowId, workflowName: slot.workflowName, local: true, holding: slot.resume },
      effects: [{ type: "continue-held", resume: slot.resume, jobId: slot.jobId, completion: event.completion }],
    };
  }
  if (event.type === "expired") {
    if (slot.phase !== "waiting" || slot.resume !== event.resume) return { slot, effects: [] };
    return { slot: { phase: "idle" }, effects: [{ type: "release-held", resume: slot.resume, expired: true }, { type: "send-ready" }] };
  }
  if (event.type === "kill") {
    if (slot.phase === "idle") return { slot, effects: [] };
    if (slot.phase === "parked") {
      return { slot: { phase: "idle" }, effects: [{ type: "release-held", resume: slot.resume, expired: false }, { type: "send-ready" }] };
    }
    if (slot.phase === "running" && (slot.suspended || slot.holding)) {
      const resume = slot.suspended?.resume ?? slot.holding;
      return {
        slot: { phase: "idle" },
        effects: [
          { type: "abort-run", keepPage: true },
          ...(resume ? [{ type: "release-held" as const, resume, expired: false }] : []),
          ...(slot.local ? [] : [{ type: "send-result" as const, jobId: slot.jobId, result: { outcome: "cancelled", workflowId: slot.workflowId } }]),
          { type: "send-ready" },
        ],
      };
    }
    return {
      slot: { phase: "idle" },
      effects: [
        slot.phase === "waiting" ? { type: "release-held", resume: slot.resume, expired: false } : { type: "abort-run" },
        ...(slot.phase === "running" && !slot.local ? [{ type: "send-result", jobId: slot.jobId, result: { outcome: "cancelled", workflowId: slot.workflowId } } as const] : []),
        { type: "send-ready" },
      ],
    };
  }
  if (event.type === "run-finished") {
    if (slot.phase !== "running" || slot.jobId !== event.jobId) return { slot, effects: [] };
    const resultEffect: SlotEffect[] = event.local ? [] : [{ type: "send-result", jobId: event.jobId, result: event.result }];
    if (event.hold?.kind === "confirm") {
      const stale = slot.suspended && slot.suspended.resume !== event.hold.resume
        ? [{ type: "release-held" as const, resume: slot.suspended.resume, expired: false }]
        : [];
      return {
        slot: {
          phase: "waiting",
          jobId: slot.jobId,
          workflowId: slot.workflowId,
          workflowName: slot.workflowName,
          resume: event.hold.resume,
        },
        effects: [
          ...stale,
          ...(typeof event.hold.deadline === "number" ? [{ type: "arm-deadline" as const, resume: event.hold.resume, deadline: event.hold.deadline }] : []),
          ...resultEffect,
        ],
      };
    }
    if (event.hold) {
      const stale = slot.suspended && slot.suspended.resume !== event.hold.resume
        ? [{ type: "release-held" as const, resume: slot.suspended.resume, expired: false }]
        : [];
      return {
        slot: {
          phase: "parked",
          resume: event.hold.resume,
          jobId: slot.jobId,
          workflowId: slot.workflowId,
          workflowName: slot.workflowName,
        },
        effects: [...stale, ...resultEffect, { type: "send-ready" }],
      };
    }
    if (slot.suspended) {
      return { slot: parkedFrom(slot, slot.suspended), effects: [...resultEffect, { type: "send-ready" }] };
    }
    const dropped = event.release ? [{ type: "release-held" as const, resume: event.release, expired: false }] : [];
    return {
      slot: { phase: "idle" },
      effects: [...resultEffect, ...dropped, { type: "send-ready" }, ...(dropped.length ? [] : [{ type: "clear-context" as const }])],
    };
  }
  const effects: SlotEffect[] = [{ type: "forget-result", jobId: event.jobId }];
  if (event.reason === "timed out" && slot.phase === "running" && !slot.local && slot.jobId === event.jobId) {
    if (slot.suspended) return { slot: parkedFrom(slot, slot.suspended), effects: [...effects, { type: "send-ready" }] };
    if (slot.holding) {
      return {
        slot: { phase: "idle" },
        effects: [...effects, { type: "abort-run", keepPage: true }, { type: "release-held", resume: slot.holding, expired: false }, { type: "send-ready" }],
      };
    }
    return { slot: { phase: "idle" }, effects: [...effects, { type: "abort-run" }, { type: "send-ready" }] };
  }
  return { slot, effects };
}

function fitResult(jobId: string, result: Record<string, unknown>): Record<string, unknown> {
  const fitted = { ...result };
  const bytes = Buffer.byteLength(JSON.stringify({ type: "result", jobId, result: fitted }));
  if (bytes > maxFrameBytes()) delete fitted.screenshot;
  return fitted;
}

function rememberResult(root: string, jobId: string, result: Record<string, unknown>): void {
  if (!JOB_ID.test(jobId)) return;
  const dir = path.join(root, "relay-results");
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${jobId}.json`);
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, JSON.stringify(result), { mode: 0o600 });
  renameSync(tmp, dest);
}

function readSaved(root: string, jobId: string): Record<string, unknown> | null {
  if (!JOB_ID.test(jobId)) return null;
  const dest = path.join(root, "relay-results", `${jobId}.json`);
  if (!existsSync(dest)) return null;
  try {
    const parsed = JSON.parse(readFileSync(dest, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* unreadable */ }
  return null;
}

function forgetResult(root: string, jobId: string): void {
  if (!JOB_ID.test(jobId)) return;
  try { unlinkSync(path.join(root, "relay-results", `${jobId}.json`)); } catch { /* already gone */ }
}

function publicOutcome(outcome: WorkflowOutcome): Record<string, unknown> {
  const human = outcome.outcome === "needs_signin" || outcome.pageClass?.class === "bot_wall" || outcome.pageClass?.class === "login_wall";
  return {
    ...outcome,
    outcome: human && outcome.outcome !== "ok" ? "needs_human" : outcome.outcome,
    status: human && outcome.outcome !== "ok" ? "needs_human" : outcome.status,
  };
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value : "";
}
