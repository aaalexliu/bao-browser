// The Mac dials the relay. Without relay.json it dials nothing. The Chrome
// extension stays behind the native-messaging bridge and never calls the registry.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrowserContext } from "playwright";
import { redactAudit } from "../../../web/src/lib/audit-redact";
import { devicePermission, policyAllowsRemoteRun, type RemotePolicy } from "../../../web/src/lib/remote-policy";
import { isToolName, JOB_ID, type ToolName } from "../../../web/src/lib/relay-tools";
import { maxFrameBytes, openWebSocket, type LiteSocket } from "../../../web/src/lib/ws-lite";
import { CDP_LIVE_SERVER_REFUSAL, EXTENSION_NOT_CONNECTED } from "../cdp-live/launch-guard";
import { describeWorkflow, runWorkflow, searchWorkflows, withHeldPage, type WorkflowOutcome } from "../mcp/catalog";
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

/** The device's own mode. Job arguments are not a parameter. */
export function remoteRunAllowed(permission: unknown): "ask" | "deny" {
  return devicePermission(permission);
}

export interface RemoteView {
  phase: "idle" | "approval" | "running" | "confirm";
  workflowId?: string;
  workflowName?: string;
  stepLabel?: string;
  jobId?: string;
}

export interface RemoteRunners {
  extension?: (workflowId: string, inputs: Record<string, string | number>) => Promise<Record<string, unknown>>;
  cdpLive?: (workflowId: string, inputs: Record<string, string | number>) => Promise<Record<string, unknown>>;
  playwright?: (workflowId: string, inputs: Record<string, string | number>) => Promise<Record<string, unknown>>;
}

type Slot =
  | { phase: "idle" }
  | { phase: "approval"; jobId: string; workflowId: string; workflowName: string }
  | { phase: "running"; jobId: string; workflowId: string; workflowName: string }
  | { phase: "confirm"; jobId: string; workflowId: string; workflowName: string; resume: string };

type AssignedJob = {
  id: string;
  tool: ToolName;
  workflowId: string | null;
  policy: RemotePolicy;
  args: Record<string, unknown>;
  workflowName: string;
};

type SlotEvent =
  | { type: "job"; job: AssignedJob; saved: Record<string, unknown> | null; permission: "ask" | "deny" }
  | { type: "allow" }
  | { type: "deny" }
  | { type: "kill" }
  | { type: "run-finished"; jobId: string; result: Record<string, unknown>; confirm: { resume: string } | null }
  | { type: "settled"; jobId: string; reason: string | null }
  | { type: "confirm-done" };

type SlotEffect =
  | { type: "send-result"; jobId: string; result: Record<string, unknown> }
  | { type: "send-ready" }
  | { type: "start-run"; job: AssignedJob }
  | { type: "ask" }
  | { type: "abort-run" }
  | { type: "forget-result"; jobId: string }
  | { type: "none" };

export function createRemoteAgent(opts: {
  library: Library;
  prompts: PersonPrompts;
  stop: () => void;
  clearStop: () => void;
  runners?: RemoteRunners;
  /** Tests skip the Allow wait. Deny still wins, and a client field does not. */
  autoAllow?: boolean;
}): {
  view(): RemoteView;
  allow(): void;
  deny(): void;
  kill(): void;
  approveConfirm(): Promise<{ outcome: string; reason?: string }>;
  start(): void;
  stop(): Promise<void>;
} {
  let slot: Slot = { phase: "idle" };
  let stopped = false;
  let clicking = false;
  let context: BrowserContext | undefined;
  let approval: ((decision: "allow" | "deny") => void) | null = null;
  let approvalTimer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;
  let socket: LiteSocket | null = null;
  let chain: Promise<void> = Promise.resolve();
  let generation = 0;
  let current: AssignedJob | null = null;

  function view(): RemoteView {
    if (clicking && slot.phase === "confirm") {
      return { phase: "running", workflowId: slot.workflowId, workflowName: slot.workflowName, stepLabel: "Place Order", jobId: slot.jobId };
    }
    if (slot.phase === "idle") return { phase: "idle" };
    if (slot.phase === "confirm") {
      return { phase: "confirm", workflowId: slot.workflowId, workflowName: slot.workflowName, stepLabel: "Place Order", jobId: slot.jobId };
    }
    return { phase: slot.phase, workflowId: slot.workflowId, workflowName: slot.workflowName, jobId: slot.jobId };
  }

  function disarmApproval(): void {
    if (approvalTimer) clearTimeout(approvalTimer);
    approvalTimer = null;
    approval = null;
  }

  function allow(): void {
    disarmApproval();
    enqueue(() => transition({ type: "allow" }));
  }

  function deny(): void {
    disarmApproval();
    enqueue(() => transition({ type: "deny" }));
  }

  function kill(): void {
    disarmApproval();
    enqueue(() => transition({ type: "kill" }));
  }

  async function approveConfirm(): Promise<{ outcome: string; reason?: string }> {
    if (slot.phase !== "confirm") return { outcome: "failed", reason: "no confirm is waiting" };
    const pending = slot;
    clicking = true;
    try {
      await withHeldPage(pending.resume, async (page) => {
        await page.evaluate(() => { document.getElementById("bao-control-strip")?.remove(); });
        const button = page.locator("#place-order");
        if (await button.count() < 1) {
          const body = await page.locator("body").innerText().catch(() => "");
          throw new Error(`no place-order button on ${page.url()} (${body.slice(0, 180)})`);
        }
        await button.click({ timeout: 5000 });
      });
      const done = await runWorkflow(opts.library, { resume: pending.resume });
      return { outcome: done.outcome === "needs_signin" ? "needs_human" : done.outcome, reason: done.reason };
    } catch (err) {
      return { outcome: "failed", reason: err instanceof Error ? err.message : String(err) };
    } finally {
      clicking = false;
      enqueue(() => transition({ type: "confirm-done" }));
    }
  }

  function start(): void {
    void loop();
  }

  async function stopLoop(): Promise<void> {
    stopped = true;
    generation += 1;
    socket?.close();
    wake?.();
    disarmApproval();
    await releaseContext();
  }

  return { view, allow, deny, kill, approveConfirm, start, stop: stopLoop };

  function enqueue(work: () => void): void {
    chain = chain.then(work).then(() => undefined, () => undefined);
  }

  function transition(event: SlotEvent): void {
    const next = apply(slot, event, current);
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
    if (!policyAllowsRemoteRun(job.policy)) {
      if (slot.phase !== "idle") return;
      perform([
        { type: "send-result", jobId: job.id, result: { outcome: "failed", reason: "policy", workflowId: job.workflowId } },
        { type: "send-ready" },
      ]);
      return;
    }
    if (slot.phase === "idle") current = job;
    transition({
      type: "job",
      job,
      saved: readSaved(opts.library.root, job.id),
      permission: remoteRunAllowed(opts.library.settings().remotePermission),
    });
  }

  function perform(effects: SlotEffect[]): void {
    for (const effect of effects) {
      if (effect.type === "none") continue;
      if (effect.type === "send-ready") {
        socket?.send(JSON.stringify({ type: "ready" }));
        continue;
      }
      if (effect.type === "send-result") {
        const fitted = fitResult(effect.jobId, presentResult(effect.result));
        rememberResult(opts.library.root, effect.jobId, fitted);
        socket?.send(JSON.stringify({ type: "result", jobId: effect.jobId, result: fitted }));
        continue;
      }
      if (effect.type === "forget-result") {
        forgetResult(opts.library.root, effect.jobId);
        continue;
      }
      if (effect.type === "abort-run") {
        generation += 1;
        approval = null;
        opts.stop();
        const open = context;
        setTimeout(() => { void open?.close().catch(() => undefined); }, 400);
        continue;
      }
      if (effect.type === "ask") {
        if (opts.autoAllow) {
          queueMicrotask(() => allow());
          continue;
        }
        disarmApproval();
        approvalTimer = setTimeout(() => deny(), 45_000);
        approvalTimer.unref();
        approval = (decision) => {
          if (decision === "allow") allow();
          else deny();
        };
        continue;
      }
      if (effect.type === "start-run") {
        const gen = generation;
        const job = effect.job;
        void execute(job).then((result) => {
          if (gen !== generation) return;
          enqueue(() => {
            if (gen !== generation) return;
            const resume = typeof result.resume === "string" ? result.resume : "";
            const confirm = resume && resumeKind(resume) === "confirm" ? { resume } : null;
            transition({ type: "run-finished", jobId: job.id, result, confirm });
          });
        }).catch((err) => {
          if (gen !== generation) return;
          enqueue(() => {
            if (gen !== generation) return;
            transition({
              type: "run-finished",
              jobId: job.id,
              result: { outcome: "failed", workflowId: job.workflowId, reason: err instanceof Error ? err.message : String(err) },
              confirm: null,
            });
          });
        });
      }
    }
  }

  async function execute(job: AssignedJob): Promise<Record<string, unknown>> {
    switch (job.tool) {
      case "search_workflows": {
        const hits = await searchWorkflows(opts.library, stringArg(job.args.query));
        return { outcome: "ok", hits };
      }
      case "describe_workflow": {
        const described = await describeWorkflow(opts.library, stringArg(job.args.id));
        return { outcome: "ok", ...described };
      }
      case "get_run":
        return readRun(job);
      case "resume_workflow":
        return {
          outcome: "needs_human",
          reason: "Approve this on the Mac. A remote agent cannot.",
        };
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
      const outputs = redactAudit(stored.outputs ?? []) as unknown;
      return { outcome: "ok", runId: stored.id, status: stored.status, outputs };
    } catch {
      return { outcome: "failed", reason: "run not found", runId: id };
    }
  }

  async function run(job: AssignedJob): Promise<Record<string, unknown>> {
    const id = job.workflowId || stringArg(job.args.id);
    const workflowName = job.workflowName || workflowLabel(id);
    opts.clearStop();
    await releaseContext();
    let workflow: WorkflowV2;
    try {
      workflow = opts.library.read(id);
    } catch (err) {
      return { outcome: "failed", workflowId: id, reason: err instanceof Error ? err.message : "workflow" };
    }
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
      if (kind === "cdp-live") {
        return opts.runners?.cdpLive
          ? await opts.runners.cdpLive(id, inputs)
          : { outcome: "failed", workflowId: id, reason: CDP_LIVE_SERVER_REFUSAL };
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

  function resumeKind(token: string | undefined): string | undefined {
    if (!token) return undefined;
    const file = path.join(opts.library.root, "resumes", `${token}.json`);
    if (!existsSync(file)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { kind?: string };
      return parsed.kind;
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
      policy: row.policy as RemotePolicy,
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

function apply(slot: Slot, event: SlotEvent, current: AssignedJob | null): { slot: Slot; effects: SlotEffect[] } {
  if (event.type === "job") {
    if (slot.phase !== "idle") {
      if (event.saved && "jobId" in slot && slot.jobId === event.job.id) {
        return { slot, effects: [{ type: "send-result", jobId: event.job.id, result: event.saved }] };
      }
      // Refuse without send-ready. The confirm stays up, and the next run stays queued.
      if (event.job.tool === "resume_workflow") {
        return {
          slot,
          effects: [{
            type: "send-result",
            jobId: event.job.id,
            result: { outcome: "needs_human", reason: "Approve this on the Mac. A remote agent cannot." },
          }],
        };
      }
      return { slot, effects: [{ type: "none" }] };
    }
    if (event.saved) {
      // The server will not claim the next job until it sees ready.
      return {
        slot,
        effects: [
          { type: "send-result", jobId: event.job.id, result: event.saved },
          { type: "send-ready" },
        ],
      };
    }
    if (event.job.tool === "resume_workflow") {
      return {
        slot: { phase: "idle" },
        effects: [
          {
            type: "send-result",
            jobId: event.job.id,
            result: { outcome: "needs_human", reason: "Approve this on the Mac. A remote agent cannot." },
          },
          { type: "send-ready" },
        ],
      };
    }
    if (event.job.tool === "run_workflow" && event.permission === "deny") {
      return {
        slot: { phase: "idle" },
        effects: [
          {
            type: "send-result",
            jobId: event.job.id,
            result: { outcome: "denied", workflowId: event.job.workflowId, reason: "this Mac denies remote runs" },
          },
          { type: "send-ready" },
        ],
      };
    }
    if (event.job.tool === "run_workflow") {
      const workflowId = event.job.workflowId || "";
      return {
        slot: { phase: "approval", jobId: event.job.id, workflowId, workflowName: event.job.workflowName },
        effects: [{ type: "ask" }],
      };
    }
    return {
      slot: {
        phase: "running",
        jobId: event.job.id,
        workflowId: event.job.workflowId || "",
        workflowName: event.job.workflowName,
      },
      effects: [{ type: "start-run", job: event.job }],
    };
  }
  if (event.type === "allow") {
    if (slot.phase !== "approval" || !current) return { slot, effects: [{ type: "none" }] };
    return {
      slot: { phase: "running", jobId: slot.jobId, workflowId: slot.workflowId, workflowName: slot.workflowName },
      effects: [{ type: "start-run", job: current }],
    };
  }
  if (event.type === "deny") {
    if (slot.phase !== "approval") return { slot, effects: [{ type: "none" }] };
    return {
      slot: { phase: "idle" },
      effects: [
        { type: "send-result", jobId: slot.jobId, result: { outcome: "denied", workflowId: slot.workflowId } },
        { type: "send-ready" },
      ],
    };
  }
  if (event.type === "kill") {
    if (slot.phase === "approval") {
      return {
        slot: { phase: "idle" },
        effects: [
          { type: "abort-run" },
          { type: "send-result", jobId: slot.jobId, result: { outcome: "denied", workflowId: slot.workflowId } },
          { type: "send-ready" },
        ],
      };
    }
    if (slot.phase === "running") {
      // The row stays running until a result is stored. Kill has to send one.
      return {
        slot: { phase: "idle" },
        effects: [
          { type: "abort-run" },
          { type: "send-result", jobId: slot.jobId, result: { outcome: "cancelled", workflowId: slot.workflowId } },
          { type: "send-ready" },
        ],
      };
    }
    if (slot.phase === "confirm") {
      return { slot: { phase: "idle" }, effects: [{ type: "abort-run" }, { type: "send-ready" }] };
    }
    return { slot, effects: [{ type: "none" }] };
  }
  if (event.type === "run-finished") {
    const active = (slot.phase === "approval" || slot.phase === "running") && slot.jobId === event.jobId;
    if (!active) return { slot, effects: [{ type: "none" }] };
    if (event.confirm) {
      return {
        slot: {
          phase: "confirm",
          jobId: slot.jobId,
          workflowId: slot.workflowId,
          workflowName: slot.workflowName,
          resume: event.confirm.resume,
        },
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
  if (event.type === "settled") {
    const effects: SlotEffect[] = [{ type: "forget-result", jobId: event.jobId }];
    const active = (slot.phase === "approval" || slot.phase === "running") && slot.jobId === event.jobId;
    if (event.reason === "timed out" && active) {
      return { slot: { phase: "idle" }, effects: [...effects, { type: "abort-run" }, { type: "send-ready" }] };
    }
    return { slot, effects };
  }
  if (slot.phase !== "confirm") return { slot, effects: [{ type: "none" }] };
  return { slot: { phase: "idle" }, effects: [{ type: "send-ready" }] };
}

function presentResult(result: Record<string, unknown>): Record<string, unknown> {
  const shot = typeof result.screenshot === "string" ? result.screenshot : "";
  const resume = typeof result.resume === "string" ? result.resume : undefined;
  const resumeToken = typeof result.resume_token === "string" ? result.resume_token : undefined;
  const clean = redactAudit(result) as Record<string, unknown>;
  delete clean.screenshot;
  if (resume !== undefined) clean.resume = resume;
  if (resumeToken !== undefined) clean.resume_token = resumeToken;
  if (shot.startsWith("iVBORw0KGgo")) clean.screenshot = shot;
  return clean;
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
