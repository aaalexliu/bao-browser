import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Library, type StoredRun } from "../v1/store";
import { shotFile, shotFormat } from "../v1/shots";
import type { AgentBrowserCommandResult } from "./agent-browser-proxy";

export interface RecordedAgentBrowserCommand {
  id: string;
  label: string;
  status: "pending" | "passed" | "failed";
  startedAt: number;
  endedAt?: number;
  reason?: string;
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
    console: { stepId: string; type: string; text: string; ts: number }[];
  } = {
    id: `run-${randomUUID()}`, kind: "capture", pageEngine: "agent-browser", workflowId: "agent-browser",
    status: "recording", at: Date.now(), steps: [], heals: [], console: [],
  };
  private readonly shots: string;

  constructor(private readonly home: string) {
    this.shots = path.join(home, "shots", "runs", this.run.id);
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
    screenshot: () => Promise<Buffer>, error?: unknown): Promise<void> {
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
    for (const result of results) {
      for (const type of ["stdout", "stderr"] as const) {
        if (result[type]) this.run.console.push({ stepId: step.id, type, text: result[type], ts: step.endedAt });
      }
    }
    this.persist();
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

  finish(): void {
    if (this.run.status !== "recording") return;
    this.run.status = this.run.steps.some((step) => step.status === "failed") ? "failed"
      : this.run.steps.some((step) => step.status === "pending") ? "paused" : "passed";
    this.persist();
  }

  private async picture(step: RecordedAgentBrowserCommand, bytes: Buffer, which: "requested" | "after"): Promise<string> {
    const format = shotFormat(bytes);
    if (!format) throw new Error("not a page screenshot");
    const file = which === "after" ? shotFile(step.id, "after", format) : `${step.id}-requested.${format}`;
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
