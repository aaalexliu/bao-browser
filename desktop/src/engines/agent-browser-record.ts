import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OwnerPage } from "../cdp-live/owner-wait";
import type { CdpSocket } from "../cdp-live/socket";
import { commandSentence } from "../v1/caption";
import { AGENT_CLOSED_ASK, AGENT_STEP_FAILED, AGENT_WAIT_ENDED } from "../v1/stop-copy";
import { RUN_SCHEMA_ID, stepTitle, type StepCaption } from "../v1/schema";
import { Library, type StoredRun } from "../v1/store";
import { shotFile, shotFormat, type ShotBox } from "../v1/shots";
import { describeStep, landmarkKeys, ownerReply, TASK_TAB_CLOSED, type OwnerWaitPage, type StepSummary } from "./agent-browser-describe";
import type { AgentBrowserCommandResult } from "./agent-browser-proxy";
import type { BrowserPick } from "./browser-pick";
import type { SignInImport } from "./bao-profile";
import { startCdpVideo, type CdpVideo } from "./cdp-video";

type Viewport = { width: number; height: number };

/** What the proxy learned around a command: Chrome's page metadata and a box measured for a read. */
export interface StepContext {
  page?: OwnerPage;
  /** Chrome's page just before the command ran. */
  previousPage?: OwnerPage;
  owner?: OwnerWaitPage;
  current?: boolean;
  mark?: ShotBox;
  /** The line that says Bao moved the session to the owner's running Chrome during this step. */
  moved?: string;
}

export interface RecordedAgentBrowserCommand {
  id: string;
  label: string;
  caption: StepCaption;
  status: "pending" | "passed" | "failed";
  startedAt: number;
  endedAt?: number;
  reason?: string;
  beforeShot?: string;
  target?: { rect: ShotBox; viewport: Viewport };
  afterShot?: string;
  /** A box on the after picture, such as the heading a read found new. */
  afterTarget?: { rect: ShotBox; viewport: Viewport };
  afterShotError?: string;
  /** Why the kept picture is not of the active tab, when Bao fell back to its task tab. */
  shotNote?: string;
  /** The session failed to start, so this step has no separate page picture. */
  failedToStart?: true;
  /** The plain sentence for this step, with the element's own text cited. */
  summary?: StepSummary;
  native: {
    command: string;
    args: string[];
    results: AgentBrowserCommandResult[];
    isError: boolean;
    error?: string;
    screenshots: { path: string; file: string }[];
  };
}

export interface AgentBrowserTaskOutcome {
  outcome: "passed" | "failed";
  reason: string;
  task?: string;
  /** What the task did, one short item each, as listed by the agent. */
  done?: string[];
}

export class AgentBrowserRun {
  private readonly run: Omit<StoredRun, "steps"> & {
    steps: RecordedAgentBrowserCommand[];
  } = {
    id: `run-${randomUUID()}`, schema: RUN_SCHEMA_ID, kind: "capture", pageEngine: "agent-browser", workflowId: "agent-browser",
    status: "recording", at: Date.now(), steps: [], heals: [],
  };
  private readonly shots: string;
  private snapshot: string | undefined;
  private lastSnapshot = "";
  private readonly landmarks = new Map<string, Set<string>>();
  /** Index of the step current when this owner wait began. Earlier waits stay as they finished. */
  private ownerWaitAt: number | undefined;
  private video: { kind: "unavailable" } | {
    kind: "recording"; capture: CdpVideo; cdp: CdpSocket; targetId: string; sessionId: string; startedAt: number;
  } | {
    kind: "encoding"; capture: CdpVideo; startedAt: number;
  } | undefined;

  constructor(private readonly home: string) {
    this.shots = path.join(home, "shots", "runs", this.run.id);
    this.persist();
  }

  get id(): string { return this.run.id; }

  get steps(): readonly RecordedAgentBrowserCommand[] { return this.run.steps; }

  /** Headings and dialogs earlier reads saw on a page since the last open, kept in memory so captions never depend on stored snapshot text. */
  seenOn(url: string | undefined): ReadonlySet<string> | undefined {
    return url ? this.landmarks.get(pageKey(url)) : undefined;
  }

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
    step.caption = {
      ...step.caption,
      targetBox: { x: target.rect.x, y: target.rect.y, width: target.rect.width, height: target.rect.height, viewport: target.viewport },
    };
    this.persist();
  }

  begin(command: string, args: string[]): RecordedAgentBrowserCommand {
    const spoken = commandSentence(command, args[0], this.lastSnapshot || latestSnapshot(this.run.steps));
    const caption: StepCaption = { text: spoken.text, ...(spoken.citation ? { citation: spoken.citation } : {}) };
    const step: RecordedAgentBrowserCommand = {
      id: `command-${this.run.steps.length + 1}`,
      label: stepTitle({ caption }),
      caption,
      status: "pending", startedAt: Date.now(), native: { command, args: [...args], results: [], isError: false, screenshots: [] },
    };
    this.run.steps.push(step);
    this.persist();
    return step;
  }

  async complete(step: RecordedAgentBrowserCommand, results: AgentBrowserCommandResult[], stateDir: string,
    screenshot: () => Promise<Buffer | { bytes: Buffer; viewport?: Viewport; note?: string }>, error?: unknown, privatePage = false,
    context: StepContext = {}): Promise<void> {
    step.endedAt = Date.now();
    step.native.results = results;
    const snap = step.native.command === "snapshot"
      ? results.find((result) => result.stdout.includes("[ref="))?.stdout || results.find((result) => result.stderr.includes("[ref="))?.stderr
      : undefined;
    if (snap) this.lastSnapshot = snap;
    step.native.isError = results.some((result) => result.exitCode !== 0) || error !== undefined;
    step.status = step.native.isError ? "failed" : "passed";
    if (error !== undefined) {
      step.native.error = error instanceof Error ? error.message : String(error);
      step.reason = step.native.error;
    } else if (step.native.isError) {
      step.reason = AGENT_STEP_FAILED;
    } else if (step.native.command === "wait_for_owner" && this.run.envelope?.reason === "session_closed") {
      step.status = "failed";
      step.reason = AGENT_WAIT_ENDED;
    }
    const summary = describeStep({
      command: step.native.command, args: step.native.args, results, error: step.native.error,
      snapshot: this.snapshot, seen: this.seenOn(context.page?.url), page: context.page, previousPage: context.previousPage, owner: context.owner, current: context.current, at: step.endedAt,
    });
    step.summary = context.moved ? { ...summary, parts: [`${context.moved} `, ...summary.parts], text: `${context.moved} ${summary.text}` } : summary;
    if (step.native.command === "open" && !step.native.isError) this.landmarks.clear();
    const read = step.native.command === "snapshot" && !step.native.isError ? results.find((result) => result.exitCode === 0)?.stdout : undefined;
    if (read) {
      this.snapshot = read;
      if (context.page?.url) {
        const key = pageKey(context.page.url);
        const seen = this.landmarks.get(key) ?? new Set<string>();
        for (const landmark of landmarkKeys(read)) seen.add(landmark);
        this.landmarks.set(key, seen);
      }
    }
    this.persist();
    // The session already ended. A picture error would sit next to the closed result and hide the cause.
    if (ownerReply(results)?.instruction === TASK_TAB_CLOSED) return;
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
      const shot = await screenshot();
      const frame = Buffer.isBuffer(shot) ? { bytes: shot } : shot;
      step.afterShot = await this.picture(step, frame.bytes, "after");
      if (frame.note) step.shotNote = frame.note;
      else {
        const rect = context.mark;
        if (rect && frame.viewport && rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0
          && rect.x + rect.width <= frame.viewport.width && rect.y + rect.height <= frame.viewport.height) {
          step.afterTarget = { rect, viewport: frame.viewport };
        }
      }
    } catch (shotError) {
      step.afterShotError = step.native.command === "close" ? "Session closed; no page remains." : pageShotError(shotError);
      if (step.native.command !== "close") this.warn("page screenshot");
    }
    this.persist();
  }

  /** Records this route beside any earlier one, with the step it started at. `browser` stays the latest. */
  pickBrowser(pick: BrowserPick): void {
    const last = this.run.steps.at(-1);
    const fromStep = last?.status === "pending" ? this.run.steps.length : this.run.steps.length + 1;
    this.run.routes = [...this.run.routes ?? [], { fromStep, browser: pick }];
    this.run.browser = pick;
    this.persist();
  }

  async recordTab(cdp: CdpSocket, targetId: string): Promise<void> {
    if (this.video && this.video.kind !== "recording") return;
    if (this.video?.targetId === targetId) return;
    let sessionId: string | undefined;
    try {
      ({ sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, undefined, 5000));
      if (this.video?.kind === "recording") {
        const previous = this.video;
        await previous.capture.switchSession(sessionId);
        this.video = { ...previous, targetId, sessionId };
        await cdp.send("Target.detachFromTarget", { sessionId: previous.sessionId }, undefined, 2000).catch(() => undefined);
      } else {
        const startedAt = Date.now();
        const capture = await startCdpVideo(cdp, sessionId, path.join(this.home, "videos", `${this.id}.mp4`), { noBlur: true });
        this.video = { kind: "recording", capture, cdp, targetId, sessionId, startedAt };
      }
    } catch {
      if (this.video?.kind === "recording") this.video.capture.pause();
      if (sessionId) await cdp.send("Target.detachFromTarget", { sessionId }, undefined, 2000).catch(() => undefined);
      await this.stopVideo();
      this.warn("tab video");
    }
  }

  async endVideoCapture(): Promise<void> {
    const video = this.video;
    if (video?.kind === "encoding") return;
    if (video?.kind !== "recording") {
      this.video = { kind: "unavailable" };
      return;
    }
    this.video = { kind: "encoding", capture: video.capture, startedAt: video.startedAt };
    try {
      try {
        const { targetInfos } = await video.cdp.send<{ targetInfos: { targetId: string }[] }>("Target.getTargets", {}, undefined, 2000);
        if (!targetInfos.some((target) => target.targetId === video.targetId)) video.capture.pause();
      } catch { video.capture.pause(); }
      await video.capture.endCapture();
    } finally {
      await video.cdp.send("Target.detachFromTarget", { sessionId: video.sessionId }, undefined, 2000).catch(() => undefined);
    }
  }

  async encodeVideo(): Promise<void> {
    const video = this.video;
    this.video = { kind: "unavailable" };
    if (video?.kind !== "encoding") return;
    try {
      const result = await video.capture.stop();
      if (result.wrote) {
        this.run.video = `${this.id}.mp4`;
        this.run.videoStartedAt = video.startedAt;
        this.run.videoTruncated = result.truncated;
        this.persist();
      }
    } catch { this.warn("tab video encoding"); }
  }

  async stopVideo(): Promise<void> {
    await this.endVideoCapture();
    await this.encodeVideo();
  }

  signInImported(report: SignInImport): void {
    this.run.signInImports = [...this.run.signInImports ?? [], report];
    this.persist();
  }

  /** The session's cleanup failed after its outcome was recorded. */
  cleanupFailed(error: string): void {
    this.run.cleanupError = error;
    this.persist();
  }

  ownerWaiting(waiting: boolean): void {
    const wasWaiting = this.run.status === "needs_human";
    this.run.status = waiting ? "needs_human" : "recording";
    if (this.video?.kind === "recording") {
      if (waiting && !wasWaiting) this.video.capture.pause();
      else if (!waiting && wasWaiting) this.video.capture.resume();
    }
    if (waiting) {
      const last = this.run.steps.at(-1);
      this.ownerWaitAt ??= last?.status === "pending" ? this.run.steps.length - 1 : this.run.steps.length;
      this.run.envelope = { status: "needs_human", run_id: this.run.id, reason: "owner_signin", ask: "Bao is waiting for you to sign in or clear the check in its browser window. The agent will continue here." };
    } else {
      this.ownerWaitAt = undefined;
      delete this.run.envelope;
    }
    this.persist();
  }

  finish(result?: "session_closed" | AgentBrowserTaskOutcome): void {
    if (this.run.status !== "recording" && this.run.status !== "needs_human"
      && (typeof result !== "object" || this.run.envelope)) return;
    if (result === "session_closed" || this.run.status === "needs_human") {
      this.cutOffOwnerWait();
      this.run.envelope = { status: "failed", run_id: this.run.id, reason: "session_closed", ask: AGENT_CLOSED_ASK };
      this.run.status = "failed";
    } else if (result) {
      this.run.status = result.outcome;
      this.run.envelope = { status: result.outcome, run_id: this.run.id, reason: result.reason };
      const task = result.task?.trim();
      if (task) this.run.task = task;
      if (result.done?.length) this.run.done = result.done;
    } else this.run.status = this.run.steps.some((step) => step.status === "failed") ? "failed"
      : this.run.steps.some((step) => step.status === "pending") ? "paused" : "passed";
    this.persist();
  }

  private cutOffOwnerWait(): void {
    if (this.ownerWaitAt === undefined) return;
    for (let i = this.run.steps.length - 1; i >= this.ownerWaitAt; i--) {
      const step = this.run.steps[i]!;
      if (step.native.command !== "wait_for_owner") continue;
      if (step.status !== "failed") {
        step.status = "failed";
        step.reason = AGENT_WAIT_ENDED;
      }
      return;
    }
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
    try {
      new Library(this.home).saveRun({
        ...this.run,
        steps: this.run.steps.map((step) => ({
          ...step,
          native: {
            ...step.native,
            results: step.native.command === "ax"
              ? step.native.results.map((result) => ({ ...result, stdout: "", stderr: "" }))
              : step.native.results,
          },
        })),
      });
    }
    catch { this.warn("run write"); }
  }

  private warn(operation: string): void {
    process.stderr.write(`Bao recording unavailable: ${operation}. Command forwarding continues.\n`);
  }
}

function pageShotError(error: unknown): string {
  const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
  if (!detail) return "Page screenshot unavailable.";
  return `Page screenshot unavailable: ${detail.endsWith(".") ? detail : `${detail}.`}`;
}

function pageKey(url: string): string {
  return url.replace(/#.*$/, "");
}

function latestSnapshot(steps: RecordedAgentBrowserCommand[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (step.native.command !== "snapshot") continue;
    const text = step.native.results.find((result) => result.exitCode === 0 && result.stdout.includes("[ref="))?.stdout;
    if (text) return text;
  }
  return undefined;
}

function screenshotPath(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { data?: { path?: unknown } };
    if (typeof parsed.data?.path === "string") return parsed.data.path;
  } catch {}
  return /Screenshot saved to (.+)(?:\r?\n|$)/.exec(stdout)?.[1]?.replace(/\r$/, "");
}
