// Replay through the person's Chrome. The scorer stays in Node. The page only dumps and acts.

import { readFileSync } from "node:fs";
import type { ExtractSpec } from "../v1/data-steps";
import type { DomDump, PageDump } from "../v1/dom-page";
import type { FailureSnapshot } from "../v1/heal";
import type { HumanAsk } from "../v1/human-ask";
import { assignSiblingIndex } from "../v1/identity";
import type { PageSignals } from "../v1/page-class";
import type { Driver, GuideAct, HealNotice, LiveTree, ShotTarget } from "../v1/replay";
import type { FileArg, Identity, StepLocator } from "../v1/schema";
import type { FileProof, PersonPrompts } from "../v1/browser-driver";
import { clampGesture, emptyGesture, gestureCapFromEnv } from "./gestures";
import type { ExtensionLink } from "./link";
import type { Gesture } from "./protocol";

interface TraceLine {
  stepId?: string;
  type?: string;
  text: string;
  ts?: number;
}

interface TraceRequest {
  stepId?: string;
  method?: string;
  url: string;
  status?: number;
  ts?: number;
}

function toIdentity(node: DomDump): Identity {
  return {
    surface: "dom",
    role: node.role,
    name: node.name,
    testId: node.testId,
    id: node.id,
    nameAttr: node.nameAttr,
    tag: node.tag,
    label: node.label,
    text: node.text,
    cssPath: node.cssPath,
    xpath: node.xpath,
    href: node.href,
    path: node.path || [],
    value: node.value,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export class ExtensionDriver implements Driver {
  readonly proofs: FileProof[] = [];
  private readonly handles = new Map<Identity, string>();
  private readonly gestures: Gesture[];
  private network: TraceRequest[] = [];
  private consoleLines: TraceLine[] = [];
  private stepId = "";
  private cap = gestureCapFromEnv();

  constructor(
    private readonly link: ExtensionLink,
    gestures: readonly Gesture[] = [],
    private readonly prompts?: PersonPrompts,
    private readonly onNotice?: (notice: HealNotice) => void,
    readonly dialogs = false,
  ) {
    this.gestures = gestures.map((gesture) => clampGesture(gesture, this.cap));
  }

  /** The next consuming action plays this recording. Tree, extract, and activate do not. */
  private takeGesture(): Gesture {
    return this.gestures.shift() || emptyGesture();
  }

  private async cmd(op: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<Record<string, unknown>> {
    const value = await this.link.command(op, params, timeoutMs);
    return asRecord(value);
  }

  markStep(id: string): void {
    this.stepId = id;
  }

  trace(): { console: TraceLine[]; network: TraceRequest[] } {
    return { console: this.consoleLines.slice(), network: this.network.slice() };
  }

  async open(url: string): Promise<void> {
    await this.cmd("open", { url, dialogs: this.dialogs, inject: true }, 45000);
  }

  async tree(): Promise<LiveTree> {
    const dump = asRecord(await this.cmd("tree", {}, 20000)) as unknown as PageDump;
    const nodes = Array.isArray(dump.nodes) ? dump.nodes : [];
    const identities = assignSiblingIndex(nodes.map((node) => toIdentity(node)));
    this.handles.clear();
    identities.forEach((node, index) => {
      const handle = nodes[index]?.handle;
      if (handle) this.handles.set(node, handle);
    });
    const values = (dump.values || []).flatMap((item) => {
      const index = nodes.findIndex((node) => node.handle === item.handle);
      const identity = index >= 0 ? identities[index] : undefined;
      return identity ? [{ identity, value: item.value }] : [];
    });
    return {
      nodes: identities,
      url: dump.url,
      texts: dump.texts || [],
      values,
      boxes: nodes.map((node) => node.bbox || { x: 0, y: 0, w: 0, h: 0 }),
      hidden: nodes.map((node) => !!node.hidden),
      inDialog: nodes.map((node) => !!node.inDialog),
      flags: nodes.map((node) => ({ checked: node.checked, enabled: node.enabled })),
    };
  }

  async snapshot(): Promise<FailureSnapshot> {
    const shot = await this.pageShot();
    const captured = await this.captureStep();
    return {
      screenshot: shot ? shot.toString("base64") : undefined,
      screenshotRef: shot ? `jpeg:${shot.length}` : undefined,
      dom: captured.dom,
      ax: captured.ax,
    };
  }

  async click(node: Identity): Promise<void> {
    await this.act("click", node, {});
  }

  async fill(node: Identity, text: string, secret = false): Promise<void> {
    await this.act("fill", node, { text, secret });
  }

  async key(key: string): Promise<void> {
    const gesture = this.takeGesture();
    await this.cmd("key", { key, gesture });
  }

  async upload(node: Identity, files: FileArg[]): Promise<void> {
    const gesture = this.takeGesture();
    const target = this.target(node);
    const result = await this.cmd("upload", { ...target, files: files.map((file) => ({ name: file.name, path: file.path })), gesture }, 30000);
    const name = String(result.name || "");
    if (!name) throw new Error("upload did not land");
    this.proofs.push({ action: "upload", name, via: "input.files" });
  }

  async drop(node: Identity, files: FileArg[]): Promise<void> {
    const gesture = this.takeGesture();
    const target = this.target(node);
    const payload = files.map((file) => ({
      name: file.name,
      b64: readFileSync(file.path).toString("base64"),
    }));
    const result = await this.cmd("drop", { ...target, files: payload, gesture });
    const name = String(result.name || "");
    if (!name) throw new Error("drop did not land");
    this.proofs.push({ action: "drop", name, via: "echo" });
  }

  async digits(): Promise<void> {
    throw new Error("digits are an OS action");
  }

  async check(node: Identity, checked: boolean): Promise<void> {
    await this.act("check", node, { checked });
  }

  async select(node: Identity, value: string): Promise<void> {
    await this.act("select", node, { value });
  }

  async goto(url: string): Promise<void> {
    const gesture = this.takeGesture();
    await this.cmd("goto", { url, gesture }, 45000);
  }

  async focus(node: Identity): Promise<void> {
    await this.cmd("focus", this.target(node));
  }

  async readList(spec: ExtractSpec): Promise<{ rows: Record<string, string>[]; nextVisible: boolean }> {
    const result = await this.cmd("readList", { spec }, 30000);
    const rows = Array.isArray(result.rows) ? result.rows as Record<string, string>[] : [];
    return { rows, nextVisible: result.nextVisible === true };
  }

  async activate(locators: StepLocator[]): Promise<boolean> {
    const result = await this.cmd("activate", { locators }, 20000);
    return result.ok === true || result.activated === true;
  }

  async showAsk(ask: HumanAsk): Promise<void> {
    this.prompts?.showAsk?.(ask);
    const text = ask.kind === "confirm"
      ? `needs you. You're in control. ${ask.instruction}`
      : ask.kind === "wall"
        ? ask.instruction
        : "You're in control. Sign in on this page. bao isn't recording keystrokes in password fields.";
    await this.cmd("showAsk", { kind: ask.kind, text }).catch(() => undefined);
  }

  showConfirm(label: string): void {
    this.prompts?.showConfirm?.(label);
  }

  async clearConfirm(): Promise<void> {
    this.prompts?.clearConfirm?.();
    await this.cmd("clearAsk", {}).catch(() => undefined);
  }

  showLoginWait(label: string): void {
    this.prompts?.showLoginWait?.(label);
  }

  async clearLoginWait(): Promise<void> {
    this.prompts?.clearLoginWait?.();
    await this.cmd("clearAsk", {}).catch(() => undefined);
  }

  shouldStop(): boolean {
    return this.prompts?.shouldStop?.() ?? false;
  }

  loginContinued(): boolean {
    return this.prompts?.loginContinued?.() ?? false;
  }

  pauseCapture(): void {
    this.prompts?.pauseCapture?.();
  }

  resumeCapture(): void {
    this.prompts?.resumeCapture?.();
  }

  async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async waitIdle(timeoutMs: number): Promise<void> {
    await this.cmd("waitIdle", { timeoutMs }, timeoutMs + 2000).catch(() => undefined);
  }

  async pageSignals(): Promise<PageSignals> {
    const result = await this.cmd("pageSignals", {}, 20000);
    const responses = Array.isArray(result.responses) ? result.responses as PageSignals["responses"] : [];
    this.network = (responses || []).map((line) => ({
      stepId: this.stepId,
      method: line?.method,
      url: line?.url || "",
      status: line?.status,
      ts: Date.now(),
    }));
    return {
      url: typeof result.url === "string" ? result.url : undefined,
      title: typeof result.title === "string" ? result.title : undefined,
      texts: Array.isArray(result.texts) ? result.texts as string[] : [],
      iframeSrcs: Array.isArray(result.iframeSrcs) ? result.iframeSrcs as string[] : [],
      markers: Array.isArray(result.markers) ? result.markers as string[] : [],
      widgets: Array.isArray(result.widgets) ? result.widgets as PageSignals["widgets"] : [],
      hasPassword: result.hasPassword === true,
      closes: Array.isArray(result.closes) ? result.closes as PageSignals["closes"] : [],
      cookies: Array.isArray(result.cookies) ? result.cookies as { name: string }[] : [],
      responses,
    };
  }

  async dismissClutter(): Promise<boolean> {
    const result = await this.cmd("dismiss", {});
    return result.clicked === true;
  }

  async captureStep(): Promise<{ dom?: { role?: string; name?: string; text?: string; testId?: string; id?: string }[]; ax?: string }> {
    const result = await this.cmd("captureStep", {});
    const dom = Array.isArray(result.dom) ? result.dom as { role?: string; name?: string; text?: string; testId?: string; id?: string }[] : undefined;
    const ax = typeof result.ax === "string" ? result.ax : undefined;
    return { dom, ax };
  }

  async pageShot(): Promise<Buffer | undefined> {
    const result = await this.cmd("shot", {}, 20000);
    const data = typeof result.jpeg === "string" ? result.jpeg : "";
    if (!data) return undefined;
    const comma = data.indexOf(",");
    const body = comma >= 0 ? data.slice(comma + 1) : data;
    return Buffer.from(body, "base64");
  }

  async shot(_target?: ShotTarget): Promise<Buffer | undefined> {
    return this.pageShot();
  }

  async performed(): Promise<GuideAct | null> {
    return null;
  }

  async notify(notice: HealNotice): Promise<void> {
    this.onNotice?.(notice);
  }

  async end(): Promise<void> {
    await this.cmd("end", {}).catch(() => undefined);
  }

  private target(node: Identity): { handle?: string; identity: Identity } {
    return { handle: this.handles.get(node), identity: node };
  }

  private async act(op: string, node: Identity, extra: Record<string, unknown>): Promise<void> {
    const gesture = this.takeGesture();
    await this.cmd(op, { ...this.target(node), ...extra, gesture }, 30000);
  }
}
