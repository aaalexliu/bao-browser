// Playwright driver. The scorer stays in Node. The page only dumps a tree and
// receives one action on the element the scorer already accepted.

import { readFileSync } from "node:fs";
import type { Dialog, Page } from "playwright";
import { shotWithBlur } from "./blur";
import { installDataPage } from "./data-page";
import type { ExtractSpec } from "./data-steps";
import { dumpPage, maskPasswordFields, unblurSensitiveFields, unmaskPasswordFields, type DomDump } from "./dom-page";
import { assignSiblingIndex } from "./identity";
import type { FailureSnapshot } from "./heal";
import type { HumanAsk } from "./human-ask";
import { clickKnownClose, dismissCoveringAds, readPageMarkers, type PageSignals } from "./page-class";
import type { Driver, GuideAct, HealNotice, LiveTree, ShotTarget } from "./replay";
import { clickInDrive } from "./drive-click";
import { armBrowserDownloads, inspectDatePicker, readCalendarSelection, waitForDownloadFile, watchDownload } from "./files-dates";
import type { FileArg, Identity, StepLocator } from "./schema";
import { paddedClip, type ShotBox } from "./shots";

const dialogHandlers = new WeakMap<Page, (dialog: Dialog) => void>();

function samePath(before: string, after: string): boolean {
  try {
    const left = new URL(before);
    const right = new URL(after);
    return left.origin === right.origin && left.pathname === right.pathname && left.search === right.search;
  } catch {
    return before.split("#")[0] === after.split("#")[0];
  }
}

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
  /** Drop UI trail events while a person has the page. */
  pauseCapture?(): void;
  resumeCapture?(): void;
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
  private readonly headerNotes: { url: string; headers: { name: string; value: string }[] }[] = [];
  private automated = 0;
  private nextPrompt: string | undefined;
  private guideBound = false;
  private readonly guideEvents: GuideAct[] = [];

  constructor(
    private readonly page: Page,
    private readonly onNotify?: (notice: HealNotice) => void,
    private readonly prompts?: PersonPrompts,
  ) {
    // A second replay on the same page must not leave the first handler in
    // front. That handler would accept the prompt before this one supplies the text.
    const previous = dialogHandlers.get(page);
    if (previous) page.off("dialog", previous);
    const onDialog = (dialog: Dialog) => {
      const answer = this.nextPrompt;
      this.nextPrompt = undefined;
      if (dialog.type() === "prompt" && answer != null) dialog.accept(answer).catch(() => undefined);
      else dialog.accept().catch(() => undefined);
    };
    dialogHandlers.set(page, onDialog);
    page.on("dialog", onDialog);
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
      const headers = vendorHeaders(res.headers());
      if (headers.length) {
        this.headerNotes.push({ url, headers });
        if (this.headerNotes.length > 80) this.headerNotes.shift();
      }
    });
  }

  answerDialog(value: string): void {
    this.nextPrompt = value;
  }

  markStep(id: string): void {
    this.currentStep = id;
  }

  trace(): { console: TraceLine[]; network: TraceRequest[] } {
    return { console: this.consoleLines.slice(), network: this.networkLines.slice() };
  }

  async pageSignals(): Promise<PageSignals> {
    const markers = await this.page.evaluate(readPageMarkers);
    const cookies = await this.page.context().cookies().catch(() => []);
    return {
      url: markers.url,
      title: markers.title,
      texts: markers.texts,
      iframeSrcs: markers.iframeSrcs,
      markers: markers.markers,
      widgets: markers.widgets,
      hasPassword: markers.hasPassword,
      closes: markers.closes,
      cookies: cookies.map((cookie) => ({ name: cookie.name })),
      responses: this.networkLines.map((line) => ({
        url: line.url,
        method: line.method,
        status: line.status,
        headers: this.headerNotes.find((note) => note.url === line.url)?.headers,
      })),
    };
  }

  async dismissClutter(): Promise<boolean> {
    return this.page.evaluate(clickKnownClose);
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
      inDialog: dump.nodes.map((node) => !!node.inDialog),
      flags: dump.nodes.map((node) => ({ checked: node.checked, enabled: node.enabled })),
    };
  }

  async waitIdle(timeoutMs: number): Promise<void> {
    await this.page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => undefined);
  }

  async readList(spec: ExtractSpec): Promise<{ rows: Record<string, string>[]; nextVisible: boolean }> {
    await this.page.evaluate(installDataPage);
    return this.page.evaluate((payload) => {
      const host = window as unknown as {
        __baoReadList?: (spec: unknown) => { rows: Record<string, string>[]; nextVisible: boolean };
      };
      if (!host.__baoReadList) throw new Error("extract is not installed");
      return host.__baoReadList(payload);
    }, spec);
  }

  async activate(locators: StepLocator[]): Promise<boolean> {
    await this.page.evaluate(installDataPage);
    const marked = await this.page.evaluate((list) => {
      const host = window as unknown as { __baoMark?: (locators: unknown) => boolean };
      return host.__baoMark ? host.__baoMark(list) : false;
    }, locators);
    if (!marked) return false;
    try {
      await this.page.locator("[data-bao-pick]").click();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/navigation|detached|Execution context|Target closed/i.test(message)) throw err;
    }
    return true;
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
    return elementShot(this.page, target);
  }

  /** The whole viewport. Proof uses this when the end page no longer shows who ran. */
  async pageShot(): Promise<Buffer | undefined> {
    await this.page.evaluate(maskPasswordFields).catch(() => undefined);
    try {
      return await this.page.screenshot({ type: "png" });
    } catch {
      return undefined;
    } finally {
      await this.page.evaluate(unmaskPasswordFields).catch(() => undefined);
    }
  }

  async probe(queries: { kind: "css" | "text" | "role" | "xpath"; query: string; role?: string; name?: string }[]): Promise<{ url: string; hits: { kind: string; query: string; count: number; visible: number }[] }> {
    const hits: { kind: string; query: string; count: number; visible: number }[] = [];
    for (const query of queries) {
      const loc = query.kind === "css"
        ? this.page.locator(query.query)
        : query.kind === "xpath"
          ? this.page.locator(`xpath=${query.query}`)
          : query.kind === "text"
            ? this.page.getByText(query.query, { exact: true })
            : this.page.getByRole(query.role as "button", { name: query.name || undefined, exact: true });
      const count = await loc.count().catch(() => -1);
      let visible = 0;
      const cap = Math.min(Math.max(count, 0), 12);
      for (let i = 0; i < cap; i++) {
        if (await loc.nth(i).isVisible().catch(() => false)) visible += 1;
      }
      hits.push({ kind: query.kind, query: query.query, count, visible });
    }
    return { url: this.page.url(), hits };
  }

  async snapshot(): Promise<FailureSnapshot> {
    await this.page.evaluate(maskPasswordFields).catch(() => undefined);
    let png: Buffer;
    try {
      png = await shotWithBlur(this.page, { type: "png" });
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

  actions(): number {
    return this.automated;
  }

  /** Listen for the person's clicks and typing. Guide Me uses this and does not act. */
  async watchGuide(): Promise<void> {
    if (!this.guideBound) {
      this.guideBound = true;
      await this.page.exposeBinding("__baoGuideAct", async (_source, payload: GuideAct) => {
        if (!payload || (payload.op !== "click" && payload.op !== "type" && payload.op !== "key" && payload.op !== "check")) return;
        this.guideEvents.push({
          op: payload.op,
          id: payload.id || undefined,
          testId: payload.testId || undefined,
          name: payload.name || undefined,
          value: payload.secret ? undefined : payload.value,
          key: payload.key,
          secret: payload.secret === true,
          ts: payload.ts || Date.now(),
        });
        if (this.guideEvents.length > 40) this.guideEvents.shift();
      });
    }
    await this.page.evaluate(installGuideWatch);
  }

  async performed(): Promise<GuideAct | null> {
    return this.guideEvents.shift() ?? null;
  }

  async click(node: Identity): Promise<void> {
    this.automated += 1;
    await this.page.evaluate(dismissCoveringAds).catch(() => undefined);
    const loc = this.page.locator(this.sel(node));
    const before = this.page.url();
    await loc.click();
    // A Google vignette swallows the click that would have followed the link.
    const href = node.href || "";
    if (node.tag !== "a" || !href || href.startsWith("#") || href.startsWith("javascript:")) return;
    const after = this.page.url();
    if (!after.includes("#google_vignette") || !samePath(before, after)) return;
    await this.page.evaluate(dismissCoveringAds).catch(() => undefined);
    await this.page.goto(new URL(href, before).href, { waitUntil: "domcontentloaded" });
  }

  async goto(url: string): Promise<void> {
    this.automated += 1;
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  async download(spec: { dir: string; filename: string; timeoutMs: number; url?: string; node?: Identity }): Promise<{ suggestedFilename: string; path: string }> {
    this.automated += 1;
    const client = await armBrowserDownloads(this.page, spec.dir);
    const pending = watchDownload(client, spec.timeoutMs);
    try {
      if (spec.url) {
        await this.page.goto(spec.url, { waitUntil: "commit", timeout: spec.timeoutMs }).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          if (!/ERR_ABORTED|Download is starting/i.test(message)) throw err;
        });
      } else if (spec.node) {
        const selector = selectorForIdentity(spec.node);
        if (!selector) throw new Error("download has no trigger");
        await clickInDrive(this.page, selector, spec.timeoutMs).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          if (!/ERR_ABORTED|Download is starting/i.test(message)) throw err;
        });
      } else {
        throw new Error("download has no trigger");
      }
      const began = await pending.done;
      const found = await waitForDownloadFile(spec.dir, began.suggestedFilename, spec.timeoutMs);
      return { suggestedFilename: began.suggestedFilename, path: found };
    } finally {
      pending.cancel();
      await client.detach().catch(() => undefined);
    }
  }

  private async calendarHas(iso: string, endIso?: string): Promise<boolean> {
    const selected = await this.page.evaluate(readCalendarSelection).catch(() => ({ isos: [] as string[] }));
    if (!selected.isos.includes(iso)) return false;
    return !endIso || selected.isos.includes(endIso);
  }

  async pickDate(spec: { iso: string; endIso?: string; formatted?: string; node?: Identity }): Promise<void> {
    this.automated += 1;
    if (spec.node && spec.formatted && await this.fillTextDate(spec.node, spec.formatted)) return;
    if (spec.node && (spec.node.tag === "input" || spec.node.role === "textbox" || spec.node.role === "input")) {
      const selector = this.dateSelector(spec.node);
      const open = await this.page.locator(".react-datepicker, .rbc-calendar, [data-bao-picker]").first().isVisible().catch(() => false);
      // A second click on the opener toggles a react-datepicker closed.
      if (!open && selector) {
        await this.page.locator(selector).click();
        await this.page.waitForTimeout(150);
      }
    }
    for (let i = 0; i < 24; i++) {
      const plan = await this.page.evaluate(inspectDatePicker, { startIso: spec.iso, endIso: spec.endIso ?? null });
      if (plan.status === "error") {
        // The calendar is often painted after navigation. Keep looking until it is there.
        if ((plan.error === "no date picker" || plan.error === "picker month") && i < 23) {
          await this.page.waitForTimeout(250);
          continue;
        }
        throw new Error(plan.error || "date picker");
      }
      if (plan.status === "select" && plan.month != null && plan.year != null) {
        await this.page.locator(".react-datepicker__month-select").selectOption(String(plan.month - 1));
        await this.page.locator(".react-datepicker__year-select").selectOption(String(plan.year));
        await this.page.waitForTimeout(150);
        continue;
      }
      if (plan.status === "nav" && plan.x != null && plan.y != null) {
        await this.page.mouse.click(plan.x, plan.y);
        await this.page.waitForTimeout(180);
        continue;
      }
      if (plan.status === "drag" && plan.from && plan.to) {
        if (plan.kind === "fixture") {
          await this.page.mouse.click(plan.from.x, plan.from.y);
          await this.page.mouse.click(plan.to.x, plan.to.y);
          return;
        }
        await this.page.mouse.move(plan.from.x, plan.from.y);
        await this.page.mouse.down();
        await this.page.mouse.move(plan.to.x, plan.to.y, { steps: 18 });
        await this.page.mouse.up();
        if (plan.kind === "rbc" && await this.calendarHas(spec.iso, spec.endIso)) return;
        if (plan.kind !== "rbc") return;
        await this.page.waitForTimeout(200);
        continue;
      }
      if (plan.status === "click" && plan.x != null && plan.y != null) {
        await this.page.mouse.click(plan.x, plan.y);
        return;
      }
    }
    throw new Error("date picker did not resolve");
  }

  async fill(node: Identity, text: string, secret = false): Promise<void> {
    this.automated += 1;
    const loc = this.page.locator(this.sel(node));
    if (!secret) {
      const combo = await loc.evaluate((el) => {
        return el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete") === "list";
      }).catch(() => false);
      if (combo) {
        // A click toggles an open react-select menu shut. Focus leaves it open.
        const expanded = await loc.evaluate((el) => el.getAttribute("aria-expanded") === "true").catch(() => false);
        if (!expanded) await loc.click();
        await loc.press("Control+a").catch(() => undefined);
        await loc.press("Backspace").catch(() => undefined);
        await loc.pressSequentially(text, { delay: 15 });
        return;
      }
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

  async focus(node: Identity): Promise<void> {
    await this.page.locator(this.sel(node)).focus();
  }

  async key(key: string): Promise<void> {
    this.automated += 1;
    const named = key.replace(/^ctrl\+/i, "Control+").replace(/^cmd\+/i, "Meta+").replace(/^alt\+/i, "Alt+");
    await this.page.keyboard.press(named);
  }

  async upload(node: Identity, files: FileArg[]): Promise<void> {
    this.automated += 1;
    const want = files[0]?.name || "";
    if (!want) throw new Error("upload has no file");
    const loc = this.page.locator(this.sel(node));
    // Playwright setInputFiles sends CDP DOM.setFileInputFiles. The path lives only on this run.
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
    this.automated += 1;
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
    this.automated += 1;
    throw new Error("digits are an OS action");
  }

  async check(node: Identity, checked: boolean): Promise<void> {
    this.automated += 1;
    const loc = this.page.locator(this.sel(node));
    if (node.id) {
      const label = this.page.locator(`label[for="${cssEscape(node.id)}"]`);
      if (await label.count()) {
        const current = await loc.isChecked().catch(() => !checked);
        if (current !== checked) await label.click();
        if (await loc.isChecked().catch(() => !checked) === checked) return;
      }
    }
    await loc.setChecked(checked);
  }

  async select(node: Identity, value: string): Promise<void> {
    this.automated += 1;
    const loc = this.page.locator(this.sel(node));
    const byLabel = await loc.selectOption({ label: value }).catch(() => [] as string[]);
    if (byLabel.length) return;
    await loc.selectOption(value);
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

  pauseCapture(): void {
    this.prompts?.pauseCapture?.();
  }

  resumeCapture(): void {
    this.prompts?.resumeCapture?.();
  }

  showAsk(ask: HumanAsk): void {
    this.prompts?.showAsk?.(ask);
    const text = ask.kind === "confirm"
      ? `You're in control. ${ask.instruction}`
      : ask.kind === "wall"
        ? ask.instruction
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
      if (kind === "login" || kind === "wall") {
        const button = document.createElement("button");
        button.type = "button";
        button.id = "bao-continue";
        button.textContent = kind === "wall" ? "Continue" : "I'm signed in, continue";
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

  /** A step identity is not the tree node, so download and date open use a stable selector. */
  private locatorFor(node: Identity): string {
    return selectorForIdentity(node) || this.sel(node);
  }

  /** Date fields often have no id. The recorded css path still tells the two inputs apart. */
  private dateSelector(node: Identity): string | undefined {
    if (node.id) return `#${cssEscape(node.id)}`;
    if (node.testId) return `[data-testid="${cssEscape(node.testId)}"]`;
    if (node.nameAttr && node.tag) return `${node.tag}[name="${cssEscape(node.nameAttr)}"]`;
    if (node.cssPath) return node.cssPath;
    return undefined;
  }

  /** A visible text date field is filled with the resolved date. Popup calendars keep the cell plan. */
  private async fillTextDate(node: Identity, formatted: string): Promise<boolean> {
    const selector = this.dateSelector(node);
    if (!selector) return false;
    const mode = await this.page.locator(selector).evaluate((el) => {
      const input = el instanceof HTMLInputElement ? el : null;
      const popup = document.querySelector(".react-datepicker, .rbc-calendar, [data-bao-picker]");
      const box = popup instanceof HTMLElement ? popup.getBoundingClientRect() : null;
      const opener = !!input && !!input.closest(".react-datepicker__input-container, .react-datepicker-wrapper");
      return {
        editable: !!input && !opener && !input.readOnly && !input.disabled && input.type !== "date" && input.type !== "hidden",
        open: !!box && box.width > 2 && box.height > 2,
      };
    }).catch(() => ({ editable: false, open: false }));
    if (!mode.editable || mode.open) return false;
    const loc = this.page.locator(selector);
    await loc.click().catch(() => undefined);
    await loc.press("Control+a").catch(() => undefined);
    await loc.press("Backspace").catch(() => undefined);
    await loc.pressSequentially(formatted, { delay: 15 });
    await loc.blur().catch(() => undefined);
    return true;
  }

  /** Outline the node the scorer accepted. Does not click or type. */
  async outline(node: Identity): Promise<void> {
    await clearShotMarks(this.page);
    const loc = this.page.locator(this.sel(node));
    await loc.scrollIntoViewIfNeeded().catch(() => undefined);
    await loc.evaluate((el) => {
      const target = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? (el.closest("label") || el) : el;
      target.setAttribute("data-bao-shot-outline", "1");
      (target as HTMLElement).style.outline = "2px solid #d4532b";
      (target as HTMLElement).style.outlineOffset = "2px";
    });
  }

  /** Ring the control itself for Guide Me. Leaves outline() on the label for crops. */
  async highlightTarget(node: Identity): Promise<void> {
    const loc = this.page.locator(this.sel(node));
    await loc.scrollIntoViewIfNeeded().catch(() => undefined);
    await loc.evaluate((el) => {
      document.querySelectorAll("[data-bao-guide-ring]").forEach((prev) => {
        prev.removeAttribute("data-bao-guide-ring");
        const host = prev as HTMLElement;
        host.style.outline = "";
        host.style.outlineOffset = "";
      });
      const target = el as HTMLElement;
      target.setAttribute("data-bao-guide-ring", "1");
      target.style.outline = "3px solid #d4532b";
      target.style.outlineOffset = "4px";
    });
  }

  /** Crop of the outlined match. The outline stays on the live page. */
  async outlinePreview(): Promise<string | undefined> {
    const box = await this.page.locator("[data-bao-shot-outline]").first().boundingBox().catch(() => null);
    if (!box || box.width < 2 || box.height < 2) return;
    const view = this.page.viewportSize() || await this.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const clip = paddedClip(box, view);
    const png = await this.page.screenshot({ type: "png", clip }).catch(() => undefined);
    return png?.toString("base64");
  }
}

function installGuideWatch(): void {
  const host = window as unknown as { __baoGuideBound?: boolean; __baoGuideAct?: (payload: GuideAct) => void };
  if (host.__baoGuideBound) return;
  host.__baoGuideBound = true;
  const send = (payload: GuideAct) => {
    host.__baoGuideAct?.(payload);
  };
  const describe = (el: Element | null) => {
    const hostEl = el?.closest("input, textarea, button, a, label, [data-testid]") || el;
    const control = hostEl instanceof HTMLLabelElement ? hostEl.querySelector("input, textarea, button") : hostEl;
    const node = control instanceof Element ? control : hostEl;
    if (!(node instanceof Element)) return {};
    return {
      id: node.id || undefined,
      testId: node.getAttribute("data-testid") || undefined,
      name: node.getAttribute("name") || node.getAttribute("aria-label") || undefined,
    };
  };
  document.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    send({ op: "click", ...describe(target), ts: Date.now() });
  }, true);
  document.addEventListener("input", (ev) => {
    const el = ev.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    const secret = el instanceof HTMLInputElement && el.type === "password";
    send({
      op: "type",
      ...describe(el),
      value: secret ? "" : el.value.slice(0, 80),
      secret,
      ts: Date.now(),
    });
  }, true);
}

/** Crop around the step's target and outline it. A full-page picture is not used. */
export async function elementShot(page: Page, target?: ShotTarget, opts?: { blur?: boolean }): Promise<Buffer | undefined> {
  try {
    await page.evaluate(maskPasswordFields).catch(() => undefined);
    const found = await locateTarget(page, target);
    if (!found) return;
    await found.mark();
    const view = page.viewportSize() || await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const clip = paddedClip(found.box, view);
    if (opts?.blur === false) return await page.screenshot({ type: "png", clip });
    return await shotWithBlur(page, { type: "png", clip });
  } catch {
    return undefined;
  } finally {
    await clearShotMarks(page);
    await page.evaluate(unmaskPasswordFields).catch(() => undefined);
  }
}

/**
 * Crop of the same control with its value cleared and no blur.
 * A clone covers the live field, so the person's typing is left alone.
 */
export async function guideFieldShot(page: Page, target?: ShotTarget): Promise<Buffer | undefined> {
  const identity = target?.identity;
  if (!identity) return;
  await page.evaluate(unblurSensitiveFields).catch(() => undefined);
  await page.evaluate(unmaskPasswordFields).catch(() => undefined);
  const found = await locateTarget(page, target);
  if (!found) return;
  const mounted = await page.evaluate(mountEmptyField, {
    id: identity.id,
    nameAttr: identity.nameAttr,
    testId: identity.testId,
  }).catch(() => false);
  if (!mounted) return;
  try {
    const view = page.viewportSize() || await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const clip = paddedClip(found.box, view);
    return await page.screenshot({ type: "png", clip });
  } finally {
    await page.evaluate(removeEmptyField).catch(() => undefined);
  }
}

function mountEmptyField(hint: { id?: string; nameAttr?: string; testId?: string }): boolean {
  document.querySelectorAll("[data-bao-guide-shot]").forEach((el) => el.remove());
  let el: Element | null = null;
  if (hint.id && document.getElementById(hint.id)) el = document.getElementById(hint.id);
  if (!el && hint.nameAttr) el = document.querySelector(`[name="${CSS.escape(hint.nameAttr)}"]`);
  if (!el && hint.testId) el = document.querySelector(`[data-testid="${CSS.escape(hint.testId)}"]`);
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
  const source = el.closest("label") || el;
  const rect = source.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const pad = 8;
  const host = document.createElement("div");
  host.setAttribute("data-bao-guide-shot", "1");
  host.style.position = "fixed";
  host.style.left = `${rect.x - pad}px`;
  host.style.top = `${rect.y - pad}px`;
  host.style.width = `${rect.width + pad * 2}px`;
  host.style.height = `${rect.height + pad * 2}px`;
  host.style.margin = "0";
  host.style.padding = `${pad}px`;
  host.style.boxSizing = "border-box";
  host.style.zIndex = "2147483647";
  host.style.background = getComputedStyle(document.body).backgroundColor;
  host.style.pointerEvents = "none";
  const clone = source.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return false;
  clone.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
  clone.removeAttribute("id");
  const nodes = clone.querySelectorAll("*");
  for (const node of [clone, ...nodes]) {
    if (!(node instanceof HTMLElement)) continue;
    node.style.removeProperty("filter");
    node.style.setProperty("filter", "none", "important");
    node.style.removeProperty("-webkit-filter");
    node.style.setProperty("backdrop-filter", "none", "important");
  }
  const field = clone instanceof HTMLInputElement || clone instanceof HTMLTextAreaElement
    ? clone
    : clone.querySelector("input, textarea");
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) field.value = "";
  clone.style.margin = "0";
  clone.style.outline = "2px solid #d4532b";
  clone.style.outlineOffset = "2px";
  host.appendChild(clone);
  document.body.appendChild(host);
  return true;
}

function removeEmptyField(): void {
  document.querySelectorAll("[data-bao-guide-shot]").forEach((el) => el.remove());
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
  if (identity?.nameAttr && /^[\w.-]+$/.test(identity.nameAttr)) tries.push(() => page.locator(`[name="${identity.nameAttr}"]`));
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
  const first = loc.first();
  await first.scrollIntoViewIfNeeded().catch(() => undefined);
  const handle = await first.elementHandle({ timeout: 250 }).catch(() => null);
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

function vendorHeaders(headers: Record<string, string>): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (!/^(server|cf-|x-cdn|x-iinfo|x-akamai|x-datadome|x-dd-|x-px)/i.test(name) && !/incap|datadome|cloudflare|akamai|perimeterx|imperva/i.test(name)) continue;
    out.push({ name, value: value.slice(0, 120) });
    if (out.length >= 12) break;
  }
  return out;
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

export type NotifyReport = {
  ok: boolean;
  authorization?: string;
  prompt?: boolean;
  delivered?: boolean;
  badge?: string;
  titles?: string[];
  bodies?: string[];
  title?: string;
  body?: string;
  tooltip?: string;
  error?: string;
};

/** Darwin posts through the signed Bao.app process. osascript display notification does not. */
async function baoNotify(cmd: "act" | "clear", title = "", body = "", tooltip = ""): Promise<NotifyReport> {
  const sock = process.env.BAO_NOTIFY_SOCK;
  if (!sock) return { ok: false, error: "no bao notifier", delivered: false };
  const { createConnection } = await import("node:net");
  return new Promise((resolve) => {
    const socket = createConnection(sock);
    let buf = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, error: "timeout", delivered: false });
    }, 8000);
    const finish = (report: NotifyReport) => {
      clearTimeout(timer);
      socket.end();
      resolve(report);
    };
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ cmd, title, body, tooltip })}\n`);
    });
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        finish(JSON.parse(buf.slice(0, nl)) as NotifyReport);
      } catch {
        finish({ ok: false, error: "bad response", delivered: false });
      }
    });
    socket.on("error", () => finish({ ok: false, error: "unreachable", delivered: false }));
  });
}

let onOsNotify: (report: NotifyReport) => void = () => {};

/** startApp registers this so a denied notification updates the capture bar. */
export function watchOsNotify(watch: (report: NotifyReport) => void): void {
  onOsNotify = watch;
}

export async function notifyOs(title: string, body: string, tooltip = ""): Promise<NotifyReport> {
  if (process.platform === "darwin") {
    const report = await baoNotify("act", title, body, tooltip);
    console.log(`bao notify ${JSON.stringify({
      authorization: report.authorization || "",
      prompt: report.prompt === true,
      delivered: report.delivered === true,
      badge: report.badge || "",
      titles: report.titles || [],
      bodies: report.bodies || [],
      title: report.title || "",
      body: report.body || "",
      tooltip: report.tooltip || "",
      error: report.error || "",
    })}`);
    onOsNotify(report);
    return report;
  }
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve) => {
    const child = spawn("notify-send", ["-a", "Bao", "-u", "normal", "-t", "15000", title, body], { stdio: "ignore" });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
  const report: NotifyReport = { ok: true, delivered: false };
  onOsNotify(report);
  return report;
}

export async function clearOsNotify(): Promise<void> {
  if (process.platform !== "darwin" || !process.env.BAO_NOTIFY_SOCK) return;
  await baoNotify("clear");
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
    path: node.path,
    value: node.value,
  };
}

function cssEscape(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, (ch) => `\\${ch}`);
}

/** Download replay has no live tree handle. Prefer a durable id, then a path that contains one. */
export function selectorForIdentity(node: Identity): string | undefined {
  if (node.id) return `#${cssEscape(node.id)}`;
  if (node.testId) return `[data-testid="${cssEscape(node.testId)}"]`;
  if (node.cssPath && node.cssPath.includes("#")) return node.cssPath;
  if ((node.tag === "a" || node.role === "link") && node.href && !node.href.startsWith("javascript:")) {
    const href = node.href.replace(/"/g, "");
    if (href) return `a[href="${href}"]`;
  }
  if (node.cssPath) return node.cssPath;
  return undefined;
}
