// The Mac dials out with its device token and runs jobs locally. The Chrome
// extension stays behind the native-messaging bridge and never calls the registry.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { BrowserContext } from "playwright";
import { describeWorkflow, runWorkflow, searchWorkflows, withHeldPage, type WorkflowOutcome } from "../mcp/catalog";
import type { PersonPrompts } from "./browser-driver";
import { policyAllowsRemoteRun } from "../../../web/src/lib/remote-policy";
import { Library } from "./store";
import { loadState } from "./sync";

export interface RemoteView {
  phase: "idle" | "approval" | "running" | "confirm";
  workflowId?: string;
  workflowName?: string;
  stepLabel?: string;
  jobId?: string;
}

interface RemoteJob {
  id: string;
  tool: string;
  workflowId?: string | null;
  policy: unknown;
  args: Record<string, unknown>;
}

export function createRemoteAgent(opts: {
  library: Library;
  prompts: PersonPrompts;
  stop: () => void;
  clearStop: () => void;
}): {
  view(): RemoteView;
  allow(): void;
  deny(): void;
  kill(): void;
  approveConfirm(): Promise<{ outcome: string; reason?: string }>;
  start(): void;
  stop(): Promise<void>;
} {
  let phase: RemoteView = { phase: "idle" };
  let stopped = false;
  let killed = false;
  let context: BrowserContext | undefined;
  let approval: ((decision: "allow" | "deny") => void) | null = null;
  let wake: (() => void) | null = null;
  let abort: AbortController | null = null;
  let pendingConfirm: { resume: string; workflowId: string; workflowName: string } | null = null;

  function view(): RemoteView {
    return { ...phase };
  }

  function allow(): void {
    approval?.("allow");
  }

  function deny(): void {
    approval?.("deny");
  }

  function kill(): void {
    killed = true;
    opts.stop();
    approval?.("deny");
    approval = null;
    const open = context;
    if (phase.phase === "confirm") {
      pendingConfirm = null;
      phase = { phase: "idle" };
    }
    setTimeout(() => { void open?.close().catch(() => undefined); }, 400);
  }

  async function approveConfirm(): Promise<{ outcome: string; reason?: string }> {
    const pending = pendingConfirm;
    if (!pending) return { outcome: "failed", reason: "no confirm is waiting" };
    pendingConfirm = null;
    phase = { phase: "running", workflowId: pending.workflowId, workflowName: pending.workflowName, stepLabel: "Place Order" };
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
      phase = { phase: "idle" };
    }
  }

  function start(): void {
    void loop();
  }

  async function stopLoop(): Promise<void> {
    stopped = true;
    abort?.abort();
    wake?.();
    approval?.("deny");
    await releaseContext();
  }

  return { view, allow, deny, kill, approveConfirm, start, stop: stopLoop };

  async function loop(): Promise<void> {
    while (!stopped) {
      const state = loadState(opts.library.root);
      if (!state.server || !state.deviceToken) {
        await sleep(1500);
        continue;
      }
      try {
        await pollOnce(state.server, state.deviceToken);
      } catch {
        if (stopped) return;
        await sleep(1000);
      }
    }
  }

  async function pollOnce(server: string, token: string): Promise<void> {
    abort = new AbortController();
    const signal = abort.signal;
    const res = await fetch(`${server}/api/agent/poll`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ waitMs: 20000 }),
      signal,
    });
    if (!res.ok) throw new Error(`poll ${res.status}`);
    const body = await res.json() as { job?: RemoteJob | null };
    if (!body.job) return;
    const beat = setInterval(() => {
      void fetch(`${server}/api/agent/poll`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ heartbeat: true }),
      }).catch(() => undefined);
    }, 400);
    let result: Record<string, unknown>;
    try {
      result = await execute(body.job);
    } catch (err) {
      result = {
        outcome: killed ? "cancelled" : "failed",
        reason: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearInterval(beat);
    }
    await fetch(`${server}/api/agent/jobs/${encodeURIComponent(body.job.id)}/result`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(result),
      signal,
    });
  }

  async function execute(job: RemoteJob): Promise<Record<string, unknown>> {
    if (!policyAllowsRemoteRun(job.policy)) {
      return { outcome: "failed", reason: "policy", workflowId: stringArg(job.args.id) };
    }
    const tool = job.tool;
    if (tool === "search_workflows") {
      const hits = await searchWorkflows(opts.library, stringArg(job.args.query));
      return { outcome: "ok", hits };
    }
    if (tool === "describe_workflow") {
      const described = await describeWorkflow(opts.library, stringArg(job.args.id));
      return { outcome: "ok", ...described };
    }
    if (tool === "resume_workflow") return resume(job);
    if (tool === "run_workflow") return run(job);
    return { outcome: "failed", reason: "unknown tool" };
  }

  async function run(job: RemoteJob): Promise<Record<string, unknown>> {
    const id = stringArg(job.args.id);
    const workflowName = workflowLabel(id);
    phase = { phase: "approval", workflowId: id, workflowName, jobId: job.id };
    const decision = await ask();
    if (decision !== "allow") {
      phase = { phase: "idle" };
      return { outcome: "denied", workflowId: id };
    }
    killed = false;
    opts.clearStop();
    await releaseContext();
    phase = { phase: "running", workflowId: id, workflowName, jobId: job.id };
    try {
      const inputs = job.args.inputs && typeof job.args.inputs === "object"
        ? job.args.inputs as Record<string, string | number>
        : {};
      const outcome = await runWorkflow(opts.library, { id, inputs }, undefined, {
        prompts: opts.prompts,
        onContext: (next) => { context = next; },
      });
      if (killed || outcome.reason === "cancelled") {
        phase = { phase: "idle" };
        return { outcome: "cancelled", workflowId: outcome.workflowId || id, runId: outcome.runId };
      }
      const kind = resumeKind(outcome.resume);
      const body = publicOutcome(outcome);
      if (kind === "confirm" && outcome.resume) {
        pendingConfirm = { resume: outcome.resume, workflowId: outcome.workflowId || id, workflowName };
        phase = { phase: "confirm", workflowId: outcome.workflowId || id, workflowName, stepLabel: "Place Order", jobId: job.id };
      } else {
        phase = { phase: "idle" };
      }
      const shot = shotBase64(outcome.runId || outcome.run_id);
      return shot ? { ...body, screenshot: shot } : body;
    } catch (err) {
      phase = { phase: "idle" };
      if (killed) return { outcome: "cancelled", workflowId: id };
      return { outcome: "failed", workflowId: id, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async function resume(job: RemoteJob): Promise<Record<string, unknown>> {
    const token = stringArg(job.args.resume);
    const kind = resumeKind(token);
    if (kind === "confirm" || kind === "wall" || kind === "signin" || !kind) {
      return {
        outcome: "needs_human",
        reason: "Approve this on the Mac. A remote agent cannot.",
        resume: token,
        kind: kind || "confirm",
      };
    }
    return { outcome: "needs_human", reason: "Approve this on the Mac. A remote agent cannot.", resume: token };
  }

  function ask(): Promise<"allow" | "deny"> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish("deny"), 45_000);
      approval = (decision) => finish(decision);
      function finish(decision: "allow" | "deny"): void {
        clearTimeout(timer);
        approval = null;
        resolve(decision);
      }
    });
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
