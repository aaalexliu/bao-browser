// Playwright driver. The scorer stays in Node. The page only dumps a tree and
// receives one action on the element the scorer already accepted.

import { readFileSync } from "node:fs";
import type { Page } from "playwright";
import { dumpPage, maskPasswordFields, unmaskPasswordFields, type DomDump } from "./dom-page";
import { assignSiblingIndex } from "./identity";
import type { FailureSnapshot } from "./heal";
import type { HumanAsk } from "./human-ask";
import type { Driver, HealNotice, LiveTree, ShotTarget } from "./replay";
import type { FileArg, Identity } from "./schema";
import { paddedClip, type ShotBox } from "./shots";

export interface FileProof {
  action: "upload" | "drop";
  name: string;
  via: "input.files" | "echo";
}

export interface PersonPrompts {
  showConfirm?(label: string): void;
  clearConfirm?(): void;
  showLoginWait?(label: string): void;
  clearLoginWait?(): void;
  showAsk?(ask: HumanAsk): void;
  shouldStop?(): boolean;
  loginContinued?(): boolean;
}

export interface TraceLine {
  stepId?: string;
  type?: string;
  text: string;
  ts?: number;
}

export interface TraceRequest {
  stepId?: string;
  method?: string;
  url: string;
  status?: number;
  ts?: number;
}

export class BrowserDriver implements Driver {
  private handles = new WeakMap<Identity, string>();
  readonly proofs: FileProof[] = [];
  private currentStep = "";
  private secretOnPage = false;
  private domNodes: { role?: string; name?: string; text?: string; testId?: string; id?: string }[] = [];
  private readonly consoleLines: TraceLine[] = [];
  private readonly networkLines: TraceRequest[] = [];

  constructor(
    private readonly page: Page,
    private readonly onNotify?: (notice: HealNotice) => void,
    private readonly prompts?: PersonPrompts,
  ) {
    page.on("console", (msg) => {
      const text = maskTrace(msg.text());
      if (!text) return;
      this.consoleLines.push({ stepId: this.currentStep, type: msg.type(), text, ts: Date.now() });
      if (this.consoleLines.length > 80) this.consoleLines.shift();
    });
    page.on("response", (res) => {
      const url = publicUrl(res.url());
      if (!url) return;
      this.networkLines.push({
        stepId: this.currentStep,
        method: res.request().method(),
        url,
        status: res.status(),
        ts: Date.now(),
      });
      if (this.networkLines.length > 80) this.networkLines.shift();
    });
  }

  markStep(id: string): void {
    this.currentStep = id;
  }

  trace(): { console: TraceLine[]; network: TraceRequest[] } {
    return { console: this.consoleLines.slice(), network: this.networkLines.slice() };
  }

  async captureStep(): Promise<{ dom?: { role?: string; name?: string; text?: string; testId?: string; id?: string }[]; ax?: string }> {
    let ax = await this.page.locator("body").ariaSnapshot().catch(() => undefined);
    if (ax && this.secretOnPage) {
      ax = ax.split("\n").filter((line) => !/password/i.test(line)).join("\n").trim();
    }
    if (ax && ax.length > 4000) ax = ax.slice(0, 4000);
    return { dom: this.domNodes.slice(), ax: ax || undefined };
  }

  async tree(): Promise<LiveTree> {
    const dump = await this.evaluateDump();
    this.secretOnPage = dump.nodes.some((node) => node.id === "password" || node.nameAttr === "password" || node.role === "password");
    this.domNodes = dump.nodes
      .filter((node) => node.id !== "password" && node.nameAttr !== "password")
      .slice(0, 40)
      .map((node) => ({
        role: node.role,
        name: node.name,
        text: node.text ? node.text.slice(0, 80) : undefined,
        testId: node.testId,
        id: node.id,
      }));
    const nodes = assignSiblingIndex(dump.nodes.map((node) => toIdentity(node)));
    nodes.forEach((node, index) => {
      const handle = dump.nodes[index]?.handle;
      if (handle) this.handles.set(node, handle);
    });
    const values = dump.values.flatMap((item) => {
      const identity = nodes.find((node) => this.handles.get(node) === item.handle);
      return identity ? [{ identity, value: item.value }] : [];
    });
    return {
      nodes,
      url: dump.url,
      texts: dump.texts,
      values,
      boxes: dump.nodes.map((node) => node.bbox || { x: 0, y: 0, w: 0, h: 0 }),
      hidden: dump.nodes.map((node) => !!node.hidden),
      flags: dump.nodes.map((node) => ({ checked: node.checked, enabled: node.enabled })),
    };
  }

  async waitIdle(timeoutMs: number): Promise<void> {
    await this.page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => undefined);
  }

  private async evaluateDump() {
    try {
      return await this.page.evaluate(dumpPage);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/context was destroyed|Execution context/i.test(message)) throw err;
      await this.page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
      return await this.page.evaluate(dumpPage);
    }
  }

  async shot(target?: ShotTarget): Promise<Buffer | undefined> {
    try {
      await this.page.evaluate(maskPasswordFields).catch(() => undefined);
      const found = await locateTarget(this.page, target);
      if (!found) return;
      await found.mark();
      const view = this.page.viewportSize() || await this.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      const clip = paddedClip(found.box, view);
      return await this.page.screenshot({ type: "png", clip });
    } catch {
      return undefined;
    } finally {
      await clearShotMarks(this.page);
      await this.page.evaluate(unmaskPasswordFields).catch(() => undefined);
    }
  }

  async snapshot(): Promise<FailureSnapshot> {
    await this.page.evaluate(maskPasswordFields).catch(() => undefined);
    let png: Buffer;
    try {
      png = await this.page.screenshot({ type: "png" });
    } finally {
      await this.page.evaluate(unmaskPasswordFields).catch(() => undefined);
    }
    const dump = await this.evaluateDump();
    const secretField = dump.nodes.some((node) => node.id === "password" || node.nameAttr === "password");
    let ax: string | undefined;
    if (!secretField) {
      try {
        ax = await this.page.locator("body").ariaSnapshot();
      } catch {
        ax = undefined;
      }
    }
    return {
      screenshot: png.toString("base64"),
      screenshotRef: `png:${png.length}`,
      dom: dump.nodes.map((node) => ({
        role: node.role,
        name: node.name,
        testId: node.testId,
        id: node.id,
        text: node.text,
      })),
      ax,
    };
  }

  async click(node: Identity): Promise<void> {
    await this.page.locator(this.sel(node)).click();
  }

  async fill(node: Identity, text: string, secret = false): Promise<void> {
    const loc = this.page.locator(this.sel(node));
    if (!secret) {
      await loc.fill(text);
      return;
    }
    try {
      await loc.evaluate((el, value) => {
        if (!(el instanceof HTMLInputElement)) throw new Error("not a field");
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, text);
    } catch {
      throw new Error("could not fill the secret field");
    }
  }

  async key(key: string): Promise<void> {
    const named = key.replace(/^ctrl\+/i, "Control+").replace(/^cmd\+/i, "Meta+").replace(/^alt\+/i, "Alt+");
    await this.page.keyboard.press(named);
  }

  async upload(node: Identity, files: FileArg[]): Promise<void> {
    const want = files[0]?.name || "";
    if (!want) throw new Error("upload has no file");
    const loc = this.page.locator(this.sel(node));
    await loc.setInputFiles(files.map((file) => file.path));
    const got = await loc.evaluate((el, name) => {
      const input = el instanceof HTMLInputElement && el.type === "file"
        ? el
        : el.querySelector("input[type=file]");
      const field = input instanceof HTMLInputElement ? input : null;
      const file = field?.files?.[0];
      if (field && file && file.name === name) field.dispatchEvent(new Event("change", { bubbles: true }));
      return file?.name || "";
    }, want);
    if (got !== want) throw new Error(`upload did not land: wanted ${want}, input.files[0].name is ${got || "empty"}`);
    this.proofs.push({ action: "upload", name: got, via: "input.files" });
  }

  async drop(node: Identity, files: FileArg[]): Promise<void> {
    const want = files[0]?.name || "";
    if (!want) throw new Error("drop has no file");
    const payload = files.map((file) => ({
      name: file.name,
      b64: readFileSync(file.path).toString("base64"),
    }));
    const phrase = `Dropped file: ${want}`;
    const handle = this.handle(node);
    const landed = await this.page.evaluate(({ handle, payload, phrase }) => {
      const el = document.querySelector(`[data-bao-i="${handle}"]`);
      if (!el) throw new Error("drop target missing");
      const dt = new DataTransfer();
      for (const file of payload) {
        const bin = atob(file.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        dt.items.add(new File([bytes], file.name));
      }
      for (const type of ["dragenter", "dragover", "drop"]) {
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
      const echo = document.querySelector("[data-testid='received-drop']");
      if (echo instanceof HTMLElement) echo.scrollIntoView({ block: "nearest", inline: "nearest" });
      const text = echo instanceof HTMLElement ? (echo.innerText || "").replace(/\s+/g, " ").trim() : "";
      const rect = echo instanceof HTMLElement ? echo.getBoundingClientRect() : null;
      const visible = !!rect
        && rect.width > 0
        && rect.height > 0
        && rect.top >= 0
        && rect.left >= 0
        && rect.bottom <= window.innerHeight + 1
        && rect.right <= window.innerWidth + 1;
      return { text, visible };
    }, { handle, payload, phrase });
    if (landed.text !== phrase || !landed.visible) {
      const where = landed.text ? `"${landed.text}"` : "absent";
      const place = landed.visible ? "" : " and offscreen";
      throw new Error(`drop did not land: wanted visible "${phrase}", echo is ${where}${place}`);
    }
    this.proofs.push({ action: "drop", name: want, via: "echo" });
  }

  async digits(): Promise<void> {
    throw new Error("digits are an OS action");
  }

  async check(node: Identity, checked: boolean): Promise<void> {
    await this.page.locator(this.sel(node)).setChecked(checked);
  }

  showConfirm(label: string): void {
    this.prompts?.showConfirm?.(label);
  }

  clearConfirm(): void {
    this.prompts?.clearConfirm?.();
    void this.clearStrip();
  }

  showLoginWait(label: string): void {
    this.prompts?.showLoginWait?.(label);
  }

  clearLoginWait(): void {
    this.prompts?.clearLoginWait?.();
    void this.clearStrip();
  }

  shouldStop(): boolean {
    return this.prompts?.shouldStop?.() ?? false;
  }

  loginContinued(): boolean {
    return this.prompts?.loginContinued?.() ?? false;
  }

  showAsk(ask: HumanAsk): void {
    this.prompts?.showAsk?.(ask);
    const text = ask.kind === "confirm"
      ? `You're in control. ${ask.instruction}`
      : "You're in control. Sign in on this page. bao isn't recording keystrokes in password fields.";
    void this.injectStrip(ask.kind, text);
  }

  private async injectStrip(kind: HumanAsk["kind"], text: string): Promise<void> {
    await this.page.evaluate(({ kind, text }) => {
      document.getElementById("bao-control-strip")?.remove();
      const bar = document.createElement("div");
      bar.id = "bao-control-strip";
      bar.setAttribute("data-bao-strip", kind);
      bar.style.cssText = "position:fixed;z-index:2147483646;left:0;right:0;top:0;background:#1d1d1f;color:#fff;font:13px/1.3 -apple-system,BlinkMacSystemFont,sans-serif;padding:8px 12px;display:flex;gap:12px;align-items:center";
      const note = document.createElement("p");
      note.textContent = text;
      note.style.margin = "0";
      bar.appendChild(note);
      if (kind === "login") {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "I'm signed in, continue";
        button.onclick = () => { void fetch("/api/prompt/continue", { method: "POST" }); };
        bar.appendChild(button);
      }
      document.documentElement.appendChild(bar);
    }, { kind, text }).catch(() => undefined);
  }

  private async clearStrip(): Promise<void> {
    await this.page.evaluate(() => { document.getElementById("bao-control-strip")?.remove(); }).catch(() => undefined);
  }

  async notify(notice: HealNotice): Promise<void> {
    this.onNotify?.(notice);
    await notifyOs(notice.title, notice.body);
  }

  private handle(node: Identity): string {
    const handle = this.handles.get(node);
    if (!handle) throw new Error("element handle expired; the tree was dumped again");
    return handle;
  }

  private sel(node: Identity): string {
    return `[data-bao-i="${this.handle(node)}"]`;
  }
}

/** Crop around the step's target. A full-page picture is not used as a thumbnail. */
export async function clipBox(page: Page, target?: ShotTarget): Promise<ShotBox | undefined> {
  const found = await locateTarget(page, target);
  if (!found) return;
  const view = page.viewportSize() || await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  return paddedClip(found.box, view);
}

async function locateTarget(page: Page, target?: ShotTarget): Promise<{ box: ShotBox; mark: () => Promise<void> } | undefined> {
  const hint = target || {};
  const identity = hint.identity;
  const role = identity?.role === "textbox" || hint.action === "type" ? "textbox" : "button";
  const name = identity?.name || identity?.text;
  const tries: Array<() => ReturnType<Page["locator"]>> = [];
  if (identity?.testId) tries.push(() => page.getByTestId(identity.testId!));
  if (identity?.id && /^[\w-]+$/.test(identity.id)) tries.push(() => page.locator(`#${identity.id}`));
  if (name) tries.push(() => page.getByRole(role, { name, exact: true }));
  if (hint.action === "login") tries.push(() => page.locator("#login"));
  if (hint.action === "confirm") tries.push(() => page.locator("#apply-btn, [data-testid='apply']"));
  if (hint.action === "type" && name) tries.push(() => page.getByLabel(name, { exact: false }));
  for (const locate of tries) {
    const found = await elementBox(locate()).catch(() => null);
    if (found) return found;
  }
  return undefined;
}

async function elementBox(loc: ReturnType<Page["locator"]>): Promise<{ box: ShotBox; mark: () => Promise<void> } | null> {
  if (await loc.count().catch(() => 0) === 0) return null;
  const handle = await loc.first().elementHandle({ timeout: 250 }).catch(() => null);
  if (!handle) return null;
  const box = await handle.evaluate((el) => {
    const node = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? (el.closest("label") || el) : el;
    const rect = (node as HTMLElement).getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }).catch(() => null);
  if (!box || box.width < 2 || box.height < 2) return null;
  return {
    box,
    mark: async () => {
      await handle.evaluate((el) => {
        const node = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? (el.closest("label") || el) : el;
        node.setAttribute("data-bao-shot-outline", "1");
        (node as HTMLElement).style.outline = "2px solid #d4532b";
        (node as HTMLElement).style.outlineOffset = "2px";
      }).catch(() => undefined);
    },
  };
}

async function clearShotMarks(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll("[data-bao-shot-outline]").forEach((el) => {
      el.removeAttribute("data-bao-shot-outline");
      (el as HTMLElement).style.outline = "";
      (el as HTMLElement).style.outlineOffset = "";
    });
  }).catch(() => undefined);
}

function maskTrace(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim().slice(0, 240);
  if (!trimmed) return "";
  return trimmed.replace(/password[=:]\s*\S+/gi, "password=[secret]");
}

function publicUrl(raw: string): string {
  if (raw.startsWith("data:") || raw.startsWith("blob:")) return "";
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`.slice(0, 180);
  } catch {
    return "";
  }
}

export async function notifyOs(title: string, body: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const cmd = process.platform === "darwin"
    ? ["osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`]]
    : ["notify-send", ["-a", "Bao", "-u", "normal", "-t", "15000", title, body]];
  await new Promise<void>((resolve) => {
    const child = spawn(cmd[0] as string, cmd[1] as string[], { stdio: "ignore" });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
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
    path: node.path,
    value: node.value,
  };
}
