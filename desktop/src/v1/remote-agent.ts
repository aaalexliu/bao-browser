// The Mac dials the relay. Without relay.json it dials nothing. The Chrome
// extension stays behind the native-messaging bridge and never calls the registry.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrowserContext } from "playwright";
import { redactAudit } from "../../../web/src/lib/audit-redact";
import { isToolName, JOB_ID, type ToolName } from "../../../web/src/lib/relay-tools";
import { maxFrameBytes, openWebSocket, type LiteSocket } from "../../../web/src/lib/ws-lite";
import { EXTENSION_NOT_CONNECTED, replayRefusal } from "../cdp-live/launch-guard";
import { describeWorkflow, runWorkflow, searchWorkflows, type WorkflowOutcome } from "../mcp/catalog";
import type { PersonPrompts } from "./browser-driver";
import { clearRelay, loadRelay, type RelayLink } from "./relay-link";
import { remoteDriverKind } from "./remote-run";
import type { WorkflowV2 } from "./schema";
import { Library } from "./store";
import { scrubSaved } from "../../../shared/saved-secrets";

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
}

export interface RemoteRunners {
  extension?: (workflowId: string, inputs: Record<string, string | number>) => Promise<Record<string, unknown>>;
  playwright?: (workflowId: string, inputs: Record<string, string | number>) => Promise<Record<string, unknown>>;
  resume?: (token: string) => Promise<Record<string, unknown>>;
}

type Slot =
  | { phase: "idle" }
  | { phase: "running"; jobId: string; workflowId: string; workflowName: string }
  | { phase: "waiting"; jobId: string; workflowId: string; workflowName: string; resume: string };

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
  | { type: "run-finished"; jobId: string; result: Record<string, unknown>; waiting: { resume: string } | null }
  | { type: "settled"; jobId: string; reason: string | null };

type SlotEffect =
  | { type: "send-result"; jobId: string; result: Record<string, unknown> }
  | { type: "send-ready" }
  | { type: "start-run"; job: AssignedJob }
  | { type: "abort-run" }
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
  let heldResume: string | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  function view(): RemoteView {
    if (slot.phase === "idle") return { phase: "idle" };
    return { phase: slot.phase, workflowId: slot.workflowId, workflowName: slot.workflowName, jobId: slot.jobId };
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
    socket?.close();
    wake?.();
    clearTimeout(deadlineTimer);
    if (heldResume) await runWorkflow(opts.library, { resume: heldResume, cancel: true });
    heldResume = undefined;
    await releaseContext();
  }

  return { view, kill, start, stop: stopLoop };

  function enqueue(work: () => void): void {
    chain = chain.then(work).then(() => undefined, () => undefined);
  }

  function transition(event: SlotEvent): void {
    const next = apply(slot, event);
    slot = next.slot;
    perform(next.effects);
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
      if (slot.phase === "idle") client.send(JSON.stringify({ type: "ready" }));
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

  function perform(effects: SlotEffect[]): void {
    for (const effect of effects) {
      if (effect.type === "send-ready") {
        socket?.send(JSON.stringify({ type: "ready" }));
        continue;
      }
      if (effect.type === "send-result") {
        const fitted = fitResult(effect.jobId, redactAudit(effect.result) as Record<string, unknown>);
        rememberResult(opts.library.root, effect.jobId, fitted);
        socket?.send(JSON.stringify({ type: "result", jobId: effect.jobId, result: fitted }));
        continue;
      }
      if (effect.type === "forget-result") {
        forgetResult(opts.library.root, effect.jobId);
        continue;
      }
      if (effect.type === "release-held") {
        clearTimeout(deadlineTimer);
        const open = context;
        heldResume = undefined;
        context = undefined;
        void runWorkflow(opts.library, { resume: effect.resume, cancel: !effect.expired }, undefined, { prompts: opts.prompts })
          .finally(() => open?.close().catch(() => undefined)).catch(() => undefined);
        continue;
      }
      if (effect.type === "abort-run") {
        generation += 1;
        opts.stop();
        clearTimeout(deadlineTimer);
        if (heldResume) void runWorkflow(opts.library, { resume: heldResume, cancel: true }).catch(() => undefined);
        heldResume = undefined;
        const open = context;
        setTimeout(() => { void open?.close().catch(() => undefined); }, 400);
        continue;
      }
      if (effect.type === "start-run") {
        clearTimeout(deadlineTimer);
        const gen = generation;
        const job = effect.job;
        void execute(job).then((result) => {
          if (gen !== generation) return;
          enqueue(() => {
            if (gen !== generation) return;
            const resume = typeof result.resume === "string" ? result.resume : "";
            const info = resumeInfo(resume);
            const waiting = resume && info?.kind === "confirm" ? { resume } : null;
            clearTimeout(deadlineTimer);
            heldResume = waiting?.resume;
            if (heldResume && typeof info?.deadline === "number") {
              armDeadline(heldResume, info.deadline);
            }
            transition({ type: "run-finished", jobId: job.id, result, waiting });
          });
        }).catch((err) => {
          if (gen !== generation) return;
          enqueue(() => {
            if (gen !== generation) return;
            clearTimeout(deadlineTimer);
            if (heldResume) void runWorkflow(opts.library, { resume: heldResume, cancel: true }).catch(() => undefined);
            heldResume = undefined;
            transition({
              type: "run-finished",
              jobId: job.id,
              result: { outcome: "failed", workflowId: job.workflowId, reason: err instanceof Error ? err.message : String(err) },
              waiting: null,
            });
          });
        });
      }
    }
  }

  function armDeadline(token: string, deadline: number): void {
    deadlineTimer = setTimeout(() => enqueue(() => {
      if (heldResume !== token || slot.phase !== "waiting") return;
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
        opts.clearStop();
        if (opts.runners?.resume) return opts.runners.resume(token);
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
      const shot = shotBase64(outcome.runId || outcome.run_id);
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

function apply(slot: Slot, event: SlotEvent): { slot: Slot; effects: SlotEffect[] } {
  if (event.type === "job") {
    if (event.saved) {
      return {
        slot,
        effects: [
          { type: "send-result", jobId: event.job.id, result: event.saved },
          ...(slot.phase === "idle" ? [{ type: "send-ready" } as const] : []),
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
    return {
      slot: {
        phase: "running",
        jobId: event.job.id,
        workflowId: slot.phase === "waiting" ? slot.workflowId : event.job.workflowId || "",
        workflowName: slot.phase === "waiting" ? slot.workflowName : event.job.workflowName,
      },
      effects: [{ type: "start-run", job: event.job }],
    };
  }
  if (event.type === "expired") {
    if (slot.phase !== "waiting" || slot.resume !== event.resume) return { slot, effects: [] };
    return { slot: { phase: "idle" }, effects: [{ type: "release-held", resume: slot.resume, expired: true }, { type: "send-ready" }] };
  }
  if (event.type === "kill") {
    if (slot.phase === "idle") return { slot, effects: [] };
    return {
      slot: { phase: "idle" },
      effects: [
        slot.phase === "waiting" ? { type: "release-held", resume: slot.resume, expired: false } : { type: "abort-run" },
        ...(slot.phase === "running" ? [{ type: "send-result", jobId: slot.jobId, result: { outcome: "cancelled", workflowId: slot.workflowId } } as const] : []),
        { type: "send-ready" },
      ],
    };
  }
  if (event.type === "run-finished") {
    if (slot.phase !== "running" || slot.jobId !== event.jobId) return { slot, effects: [] };
    if (event.waiting) {
      return {
        slot: { ...slot, phase: "waiting", resume: event.waiting.resume },
        effects: [{ type: "send-result", jobId: event.jobId, result: event.result }],
      };
    }
    return {
      slot: { phase: "idle" },
      effects: [
        { type: "send-result", jobId: event.jobId, result: event.result },
        { type: "send-ready" },
      ],
    };
  }
  const effects: SlotEffect[] = [{ type: "forget-result", jobId: event.jobId }];
  if (event.reason === "timed out" && slot.phase === "running" && slot.jobId === event.jobId) {
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
  writeFileSync(tmp, JSON.stringify(scrubSaved(result)), { mode: 0o600 });
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
