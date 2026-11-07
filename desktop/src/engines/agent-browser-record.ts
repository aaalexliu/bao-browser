import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Library, type StoredRun } from "../v1/store";
import { shotFile, shotFormat, type ShotBox } from "../v1/shots";
import type { AgentBrowserCommandResult } from "./agent-browser-proxy";

export interface RecordedAgentBrowserCommand {
  id: string;
  label: string;
  status: "pending" | "passed" | "failed";
  startedAt: number;
  endedAt?: number;
  reason?: string;
  beforeShot?: string;
  target?: { rect: ShotBox; viewport: { width: number; height: number } };
  afterShot?: string;
  afterShotError?: string;
  native: {
    command: string;
    args: string[];
    results: AgentBrowserCommandResult[];
    isError: boolean;
    error?: string;
    screenshots: { path: string; file: string }[];
  };
}

export class AgentBrowserRun {
  private readonly run: Omit<StoredRun, "steps"> & {
    steps: RecordedAgentBrowserCommand[];
  } = {
    id: `run-${randomUUID()}`, kind: "capture", pageEngine: "agent-browser", workflowId: "agent-browser",
    status: "recording", at: Date.now(), steps: [], heals: [],
  };
  private readonly shots: string;

  constructor(private readonly home: string) {
    this.shots = path.join(home, "shots", "runs", this.run.id);
    this.persist();
  }

  get id(): string { return this.run.id; }

  get lastPicture(): { stepId: string; phase: "before" | "after" } | undefined {
    for (let i = this.run.steps.length - 1; i >= 0; i--) {
      const step = this.run.steps[i]!;
      if (step.afterShot) return { stepId: step.id, phase: "after" };
      if (step.beforeShot) return { stepId: step.id, phase: "before" };
    }
    return undefined;
  }

  async actionPicture(step: RecordedAgentBrowserCommand, bytes: Buffer, target: NonNullable<RecordedAgentBrowserCommand["target"]>): Promise<void> {
    step.beforeShot = await this.picture(step, bytes, "before");
    step.target = target;
    this.persist();
  }

  begin(command: string, args: string[]): RecordedAgentBrowserCommand {
    const step: RecordedAgentBrowserCommand = {
      id: `command-${this.run.steps.length + 1}`, label: [command, ...args.map((arg) => JSON.stringify(arg))].join(" "),
      status: "pending", startedAt: Date.now(), native: { command, args: [...args], results: [], isError: false, screenshots: [] },
    };
    this.run.steps.push(step);
    this.persist();
    return step;
  }

  async complete(step: RecordedAgentBrowserCommand, results: AgentBrowserCommandResult[], stateDir: string,
    screenshot: () => Promise<Buffer>, error?: unknown, privatePage = false): Promise<void> {
    step.endedAt = Date.now();
    step.native.results = results;
    step.native.isError = results.some((result) => result.exitCode !== 0) || error !== undefined;
    step.status = step.native.isError ? "failed" : "passed";
    if (error !== undefined) {
      step.native.error = error instanceof Error ? error.message : String(error);
      step.reason = step.native.error;
    } else if (step.native.isError) {
      step.reason = "Native agent-browser command failed.";
    }
    this.persist();
    if (privatePage) {
      step.afterShotError = "Owner input is private; no page screenshot or snapshot was taken.";
      this.persist();
      return;
    }
    if (step.native.command === "screenshot") {
      for (const result of results.filter((item) => item.exitCode === 0)) {
        const original = screenshotPath(result.stdout);
        if (!original) continue;
        try {
          const bytes = await readFile(path.resolve(stateDir, original));
          const file = await this.picture(step, bytes, "requested");
          step.native.screenshots.push({ path: original, file });
        } catch { this.warn("requested screenshot copy"); }
      }
    }
    try {
      step.afterShot = await this.picture(step, await screenshot(), "after");
    } catch {
      step.afterShotError = step.native.command === "close" ? "Session closed; no page remains." : "Page screenshot unavailable.";
      if (step.native.command !== "close") this.warn("page screenshot");
    }
    this.persist();
  }

  ownerWaiting(waiting: boolean): void {
    this.run.status = waiting ? "needs_human" : "recording";
    if (waiting) this.run.envelope = { status: "needs_human", run_id: this.run.id, reason: "owner_signin", ask: "Bao is waiting for you to sign in or clear the check in its browser window. The agent will continue here." };
    else delete this.run.envelope;
    this.persist();
  }

  finish(reason?: "session_closed"): void {
    if (this.run.status !== "recording" && this.run.status !== "needs_human") return;
    if (reason === "session_closed" || this.run.status === "needs_human") {
      this.run.envelope = { status: "failed", run_id: this.run.id, reason: "session_closed", ask: "The Bao session ended before the owner wait completed. This session cannot continue." };
      this.run.status = "failed";
    } else this.run.status = this.run.steps.some((step) => step.status === "failed") ? "failed"
      : this.run.steps.some((step) => step.status === "pending") ? "paused" : "passed";
    this.persist();
  }

  private async picture(step: RecordedAgentBrowserCommand, bytes: Buffer, which: "requested" | "before" | "after"): Promise<string> {
    const format = shotFormat(bytes);
    if (!format) throw new Error("not a page screenshot");
    const file = which === "requested" ? `${step.id}-requested.${format}` : shotFile(step.id, which, format);
    await mkdir(this.shots, { recursive: true });
    await writeFile(path.join(this.shots, file), bytes);
    return file;
  }

  private persist(): void {
    try { new Library(this.home).saveRun(this.run); }
    catch { this.warn("run write"); }
  }

  private warn(operation: string): void {
    process.stderr.write(`Bao recording unavailable: ${operation}. Command forwarding continues.\n`);
  }
}

function screenshotPath(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { data?: { path?: unknown } };
    if (typeof parsed.data?.path === "string") return parsed.data.path;
  } catch {}
  return /Screenshot saved to (.+)(?:\r?\n|$)/.exec(stdout)?.[1]?.replace(/\r$/, "");
}
