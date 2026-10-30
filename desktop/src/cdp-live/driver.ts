import { installDataPage } from "../v1/data-page";
import type { ExtractSpec } from "../v1/data-steps";
import { dumpPage, type DomDump, type PageDump } from "../v1/dom-page";
import type { FailureSnapshot } from "../v1/heal";
import type { HumanAsk } from "../v1/human-ask";
import { assignSiblingIndex } from "../v1/identity";
import { readPageMarkers, type PageSignals } from "../v1/page-class";
import type { Driver, LiveTree } from "../v1/replay";
import type { FileArg, Identity, StepLocator } from "../v1/schema";
import { BOOKS_HOSTS, insertTextRefusal, navigationAllowed, navigationRefusal, openerAllowed, publicHost, stopPathHit } from "./allowlist";
import { focusLiveMark, focusStillMarked, markedState, type MarkedState } from "./live-ops";
import { CdpSocket } from "./socket";

/** Finds a marked element in the light DOM, then in open shadow roots. */
export const PIERCE_QUERY = `
  const pierce = (sel, root) => {
    const found = root.querySelector(sel);
    if (found) return found;
    for (const node of root.querySelectorAll("*")) {
      if (node.shadowRoot) {
        const inner = pierce(sel, node.shadowRoot);
        if (inner) return inner;
      }
    }
    return null;
  };
`;

/** Records click isTrusted. sessionStorage keeps the log across same-origin navigations. */
export const TRUST_SOURCE = `(() => {
  const host = window;
  const persist = () => {
    try { sessionStorage.setItem("__baoTrustLog", JSON.stringify(host.__baoTrustLog.slice(-20))); } catch (e) {}
  };
  if (!host.__baoTrustInstalled) {
    host.__baoTrustInstalled = true;
    let prior = [];
    try {
      const raw = sessionStorage.getItem("__baoTrustLog");
      if (raw) prior = JSON.parse(raw);
    } catch (e) {}
    host.__baoTrustLog = Array.isArray(prior) ? prior : [];
    const onClick = (event) => {
      const target = event.target;
      const el = target instanceof Element ? target : null;
      host.__baoTrustLog.push({
        isTrusted: event.isTrusted === true,
        tag: el ? el.tagName : "",
        text: el ? (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60) : "",
        ts: Date.now(),
      });
      persist();
    };
    host.__baoTrustHandler = onClick;
    document.addEventListener("click", onClick, true);
  }
})()`;

/** Removes the trust listener this driver installed. Does not read other storage keys. */
export const TRUST_CLEANUP = `(() => {
  const host = window;
  if (host.__baoTrustHandler) {
    document.removeEventListener("click", host.__baoTrustHandler, true);
    try { delete host.__baoTrustHandler; } catch (e) {}
  }
  try { delete host.__baoTrustInstalled; } catch (e) {}
  try { delete host.__baoTrustLog; } catch (e) {}
  try { sessionStorage.removeItem("__baoTrustLog"); } catch (e) {}
  document.querySelectorAll("[data-bao-pick],[data-bao-redact]").forEach((el) => {
    el.removeAttribute("data-bao-pick");
    el.removeAttribute("data-bao-redact");
  });
  const style = document.getElementById("bao-redact-style");
  if (style) style.remove();
})()`;

export interface TrustEvent {
  isTrusted: boolean;
  tag: string;
  text: string;
  ts?: number;
}

export interface PageObservation {
  webdriver: boolean;
  host: string;
  trust: TrustEvent[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Chrome runs a key's default action only when the event carries its virtual key code. */
const KEY_EVENTS: Record<string, { code: string; keyCode: number; text: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9, text: "" },
  Escape: { code: "Escape", keyCode: 27, text: "" },
};

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

export class CdpLiveDriver implements Driver {
  private handles = new WeakMap<Identity, string>();
  private loadEpoch = 0;
  private offHost = "";
  private blockedNav = "";
  /** The last top-frame URL that committed on an allowed host and off any stop path. */
  private lastAllowed = "";
  private origins: readonly string[] = [];
  private stopPath = "";
  private humanAsk: HumanAsk | undefined;
  private trustEvents: TrustEvent[] = [];
  private trustCursor = 0;
  readonly subframesSeen = { count: 0 };

  private scriptId = "";

  constructor(
    private readonly cdp: CdpSocket,
    private readonly sessionId: string,
    readonly targetId: string,
    private readonly hosts: readonly string[] = BOOKS_HOSTS,
    /** True leaves an existing tab open. False closes a tab this driver opened. */
    private readonly preserveTarget = false,
  ) {}

  setOrigins(origins: readonly string[]): void {
    this.origins = origins;
  }

  /** A page load on a stop path is failed before the request leaves Chrome. */
  setStopPath(stopPath: string): void {
    this.stopPath = stopPath;
  }

  private allows(url: string): boolean {
    if (!url || url === "about:blank" || url.startsWith("about:") || url.startsWith("chrome:") || url.startsWith("devtools:") || url.startsWith("chrome-error:")) {
      return true;
    }
    if (this.origins.length) return navigationRefusal(url, this.hosts, this.origins) == null;
    return navigationAllowed(url, this.hosts);
  }

  private refusal(url: string): string {
    const reason = this.origins.length
      ? navigationRefusal(url, this.hosts, this.origins)
      : navigationRefusal(url, this.hosts);
    return reason || "that url";
  }

  async start(): Promise<void> {
    await this.cdp.send("Page.enable", {}, this.sessionId);
    await this.cdp.send("Runtime.enable", {}, this.sessionId);
    this.cdp.on("Page.loadEventFired", this.sessionId, () => { this.loadEpoch += 1; });
    this.cdp.on("Page.frameNavigated", this.sessionId, (params) => this.onFrame(params));
    this.cdp.on("Fetch.requestPaused", this.sessionId, (params) => this.onPaused(params));
    if (!this.preserveTarget) {
      await this.cdp.send("Fetch.enable", {
        patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }],
      }, this.sessionId);
    }
    let added: { identifier?: string } = {};
    try {
      added = await this.cdp.send<{ identifier?: string }>("Page.addScriptToEvaluateOnNewDocument", {
        source: TRUST_SOURCE,
        runImmediately: true,
      }, this.sessionId);
    } catch {
      added = await this.cdp.send<{ identifier?: string }>("Page.addScriptToEvaluateOnNewDocument", { source: TRUST_SOURCE }, this.sessionId);
    }
    this.scriptId = added.identifier || "";
    await this.evaluate(TRUST_SOURCE).catch(() => undefined);
    await this.bringToFront();
  }

  private onPaused(params: Record<string, unknown>): void {
    const requestId = typeof params.requestId === "string" ? params.requestId : "";
    if (!requestId) return;
    const request = params.request as { url?: string } | undefined;
    const url = request?.url || "";
    const allowed = this.allows(url);
    if (params.frameId !== this.targetId || (allowed && !stopPathHit(url, this.stopPath))) {
      void this.cdp.send("Fetch.continueRequest", { requestId }, this.sessionId).catch(() => undefined);
      return;
    }
    this.blockedNav = allowed ? "stop-path" : this.refusal(url);
    void this.cdp.send("Fetch.failRequest", {
      requestId,
      errorReason: "BlockedByClient",
    }, this.sessionId).catch(() => undefined);
  }

  takeBlockedNav(): string {
    const reason = this.blockedNav;
    this.blockedNav = "";
    return reason;
  }

  /**
   * After a load failed on a stop path, takes the tab off Chrome's error page and back to the
   * last allowed page: one history step when that lands on it, otherwise a load of that URL.
   */
  async returnFromBlock(timeoutMs = 10_000): Promise<void> {
    const target = this.lastAllowed;
    if (this.preserveTarget || !target) return;
    type History = { currentIndex: number; entries: { id: number; url: string }[] };
    const history = () => this.cdp.send<History>("Page.getNavigationHistory", {}, this.sessionId);
    let now = await history();
    const settle = Date.now() + 2_000;
    while (now.entries[now.currentIndex]?.url === target && Date.now() < settle) {
      await sleep(100);
      now = await history();
    }
    if (now.entries[now.currentIndex]?.url === target) return;
    const prior = now.entries[now.currentIndex - 1];
    if (prior?.url === target) {
      await this.cdp.send("Page.navigateToHistoryEntry", { entryId: prior.id }, this.sessionId);
    } else {
      const nav = await this.cdp.send<{ errorText?: string }>("Page.navigate", { url: target }, this.sessionId);
      if (nav.errorText) throw new Error(nav.errorText);
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.evaluate<{ href: string; ready: string }>(
        "({ href: location.href, ready: document.readyState })",
      ).catch(() => undefined);
      if (state && /^https?:/.test(state.href) && this.allows(state.href) && !stopPathHit(state.href, this.stopPath) && state.ready === "complete") return;
      await sleep(100);
    }
    throw new Error("could not return to the last allowed page");
  }

  markTrust(): void {
    this.trustCursor = this.trustEvents.length;
  }

  lastTrusted(): boolean | null {
    if (this.trustEvents.length <= this.trustCursor) return null;
    const last = this.trustEvents[this.trustEvents.length - 1];
    return last ? last.isTrusted : null;
  }

  private onFrame(params: Record<string, unknown>): void {
    const frame = params.frame as { parentId?: string; url?: string; unreachableUrl?: string } | undefined;
    if (!frame) return;
    if (frame.parentId) {
      this.subframesSeen.count += 1;
      return;
    }
    const url = frame.url || "";
    if (/^https?:/.test(url) && !frame.unreachableUrl && this.allows(url) && !stopPathHit(url, this.stopPath)) {
      this.lastAllowed = url;
    }
    if (url && this.allows(url)) {
      if (this.preserveTarget) this.offHost = "";
      void this.evaluate(TRUST_SOURCE).catch(() => undefined);
      return;
    }
    if (!url || (url === "about:blank" && openerAllowed(url, this.hosts))) {
      void this.evaluate(TRUST_SOURCE).catch(() => undefined);
      return;
    }
    this.offHost = this.refusal(url);
    if (!this.preserveTarget) {
      void this.cdp.send("Target.closeTarget", { targetId: this.targetId }).catch(() => undefined);
    }
  }

  private assertHost(): void {
    if (this.offHost) throw new Error(`cdp-live allowlist refused ${this.offHost}`);
  }

  private async bringToFront(): Promise<void> {
    await this.cdp.send("Target.activateTarget", { targetId: this.targetId }).catch(() => undefined);
    await this.cdp.send("Page.bringToFront", {}, this.sessionId).catch(() => undefined);
  }

  /** Bring this driver's own target forward. Does not raise any other window. */
  async show(): Promise<void> {
    await this.bringToFront();
  }

  private async evaluateOnce<T>(expression: string): Promise<T> {
    this.assertHost();
    const payload = await this.cdp.send<{
      result?: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      timeout: 15000,
    }, this.sessionId);
    if (payload.exceptionDetails) {
      throw new Error(payload.exceptionDetails.exception?.description || payload.exceptionDetails.text || "evaluate failed");
    }
    return payload.result?.value as T;
  }

  private async evaluate<T>(expression: string): Promise<T> {
    try {
      return await this.evaluateOnce<T>(expression);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/context|destroyed|navigat/i.test(message)) throw err;
      await sleep(250);
      return this.evaluateOnce<T>(expression);
    }
  }

  private async evaluateDump(): Promise<PageDump> {
    return this.evaluate<PageDump>(`(${dumpPage.toString()})()`);
  }

  async tree(): Promise<LiveTree> {
    const dump = await this.evaluateDump();
    const nodes = assignSiblingIndex(dump.nodes.map((node) => toIdentity(node)));
    this.handles = new WeakMap();
    nodes.forEach((node, index) => {
      const handle = dump.nodes[index]?.handle;
      if (handle) this.handles.set(node, handle);
    });
    const values = dump.values.flatMap((item) => {
      const identity = nodes.find((node) => this.handles.get(node) === item.handle);
      return identity ? [{ identity, value: item.value }] : [];
    });
    const url = dump.url && this.allows(dump.url) ? dump.url : publicHost(dump.url || "");
    return {
      nodes,
      url,
      texts: dump.texts,
      values,
      boxes: dump.nodes.map((node) => node.bbox || { x: 0, y: 0, w: 0, h: 0 }),
      hidden: dump.nodes.map((node) => !!node.hidden),
      inDialog: dump.nodes.map((node) => !!node.inDialog),
      flags: dump.nodes.map((node) => ({ checked: node.checked, enabled: node.enabled })),
    };
  }

  /** The data-bao-i handle the last tree() gave this node. Empty when that tree() did not list it. */
  handleOf(node: Identity): string {
    return this.handles.get(node) || "";
  }

  /** tree(), and the node in it that carries the live mark. A mark tree() did not list leaves `marked` out. */
  async markedTree(markIndex: number): Promise<{ tree: LiveTree; marked?: Identity; mark: MarkedState }> {
    const tree = await this.tree();
    const mark = await this.evaluateFunction<MarkedState>(markedState, { markIndex });
    const marked = mark.handle ? tree.nodes.find((node) => this.handles.get(node) === mark.handle) : undefined;
    return { tree, marked, mark };
  }

  async snapshot(): Promise<FailureSnapshot> {
    const dump = await this.evaluateDump().catch(() => undefined);
    return {
      dom: (dump?.nodes || []).slice(0, 40).map((node) => ({
        role: node.role,
        name: node.name,
        text: node.text ? node.text.slice(0, 80) : undefined,
        testId: node.testId,
        id: node.id,
      })),
      ax: dump?.title,
    };
  }

  async pageSignals(): Promise<PageSignals> {
    const markers = await this.evaluate<Awaited<ReturnType<typeof readPageMarkers>>>(`(${readPageMarkers.toString()})()`);
    const url = markers.url && this.allows(markers.url) ? markers.url : publicHost(markers.url || "");
    return {
      url,
      title: markers.title,
      texts: markers.texts,
      iframeSrcs: markers.iframeSrcs,
      markers: markers.markers,
      widgets: markers.widgets,
      hasPassword: markers.hasPassword,
      closes: markers.closes,
      cookies: [],
    };
  }

  async locationHref(): Promise<string> {
    return this.evaluate<string>("location.href");
  }

  async goto(url: string, timeoutMs = 20_000): Promise<void> {
    if (this.preserveTarget) throw new Error("cdp-live will not navigate an attached tab");
    if (!this.allows(url)) throw new Error(`cdp-live allowlist refused ${this.refusal(url)}`);
    this.assertHost();
    const epoch = this.loadEpoch;
    const nav = await this.cdp.send<{ errorText?: string }>("Page.navigate", { url }, this.sessionId);
    if (nav.errorText) throw new Error(nav.errorText);
    await this.waitForLoad(epoch, timeoutMs);
    const href = await this.evaluate<string>("location.href");
    if (this.allows(href)) return;
    if (!href || href === "about:blank") throw new Error("navigation did not finish");
    await this.end().catch(() => undefined);
    throw new Error(`cdp-live allowlist refused ${this.refusal(href)}`);
  }

  /** Trusted click of a selector this process just marked. Does not call element.click(). */
  async clickCss(selector: string): Promise<void> {
    if (!selector.startsWith("[data-bao-")) throw new Error("cdp-live click refused");
    const before = await this.evaluate<string>("location.href").catch(() => "");
    await this.clickSelector(selector);
    await this.waitAfterClick(before, 10_000);
  }

  async evaluateFunction<T>(
    fn: { toString(): string },
    arg: unknown,
    helpers: ReadonlyArray<{ name: string; toString(): string }> = [],
  ): Promise<T> {
    const prelude = helpers.map((helper) => {
      if (!/^[A-Za-z_$][\w$]*$/.test(helper.name)) throw new Error("cdp-live refused a page helper");
      return `const ${helper.name} = ${helper.toString()};`;
    }).join("\n");
    const call = `(${fn.toString()})(${JSON.stringify(arg)})`;
    return this.evaluate<T>(prelude ? `(() => {\n${prelude}\nreturn ${call};\n})()` : call);
  }

  async insertText(text: string, prior = "", markIndex = -1): Promise<void> {
    const refusal = insertTextRefusal(text, prior);
    if (refusal) throw new Error(refusal);
    const check = await this.evaluateFunction<{ ok: boolean; credential: boolean }>(focusStillMarked, { markIndex });
    if (!check.ok) throw new Error(check.credential ? "credential_field" : "focus_moved");
    await this.cdp.send("Input.insertText", { text }, this.sessionId);
  }

  async click(node: Identity): Promise<void> {
    const handle = this.handles.get(node);
    if (!handle) throw new Error("element handle expired");
    const before = await this.evaluate<string>("location.href");
    await this.clickSelector(`[data-bao-i="${handle}"]`);
    await this.waitAfterClick(before, 10_000);
  }

  async readList(spec: ExtractSpec): Promise<{ rows: Record<string, string>[]; nextVisible: boolean }> {
    await this.evaluate(`(${installDataPage.toString()})()`);
    return this.evaluate(`window.__baoReadList(${JSON.stringify(spec)})`);
  }

  async activate(locators: StepLocator[]): Promise<boolean> {
    await this.evaluate(`(${installDataPage.toString()})()`);
    const marked = await this.evaluate<boolean>(`window.__baoMark(${JSON.stringify(locators)})`);
    if (!marked) return false;
    const before = await this.evaluate<string>("location.href");
    await this.clickSelector("[data-bao-pick]");
    await this.waitAfterClick(before, 10_000);
    return true;
  }

  async waitIdle(timeoutMs: number): Promise<void> {
    const epoch = this.loadEpoch;
    const started = Date.now();
    const deadline = started + timeoutMs;
    while (Date.now() < deadline) {
      const ready = await this.evaluate<string>("document.readyState").catch(() => "");
      if (this.loadEpoch > epoch && ready === "complete") return;
      if (ready === "complete" && Date.now() - started > 400 && this.loadEpoch === epoch) return;
      await sleep(100);
    }
  }

  async fill(node: Identity, text: string, secret: boolean): Promise<void> {
    if (secret) throw new Error("cdp-live does not fill secrets");
    await this.click(node);
    await this.cdp.send("Input.insertText", { text }, this.sessionId);
  }

  async key(key: string): Promise<void> {
    if (key === "cmd+a" || key === "Meta+a") {
      await this.chord("a", "KeyA", 4, 65);
      return;
    }
    const name = key === "Return" ? "Enter" : key;
    const known = KEY_EVENTS[name];
    const before = await this.evaluate<string>("location.href").catch(() => "");
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: name,
      code: known?.code || name,
      windowsVirtualKeyCode: known?.keyCode || 0,
      text: known ? known.text : name.length === 1 ? name : "",
    }, this.sessionId);
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: name,
      code: known?.code || name,
      windowsVirtualKeyCode: known?.keyCode || 0,
    }, this.sessionId);
    await this.waitAfterClick(before, 10_000);
  }

  /**
   * Presses one key where focus is. With a mark, focus must still be that control.
   * Focus in a credential field stops the key either way.
   */
  async pressMarked(key: string, markIndex: number): Promise<void> {
    this.assertHost();
    await this.bringToFront();
    if (markIndex >= 0) await this.evaluateFunction(focusLiveMark, { markIndex });
    const check = await this.evaluateFunction<{ ok: boolean; credential: boolean }>(focusStillMarked, { markIndex });
    if (!check.ok) throw new Error(check.credential ? "credential_field" : "focus_moved");
    await this.key(key);
  }

  async upload(_node: Identity, _files: FileArg[]): Promise<void> {
    throw new Error("cdp-live does not choose files");
  }

  async drop(_node: Identity, _files: FileArg[]): Promise<void> {
    throw new Error("cdp-live does not drop files");
  }

  async digits(): Promise<void> {
    throw new Error("cdp-live does not type app digits");
  }

  async check(node: Identity, _checked: boolean): Promise<void> {
    await this.click(node);
  }

  async notify(): Promise<void> {}

  async sleep(ms: number): Promise<void> {
    await sleep(ms);
  }

  showAsk(ask: HumanAsk): void {
    this.humanAsk = ask;
  }

  asked(): HumanAsk | undefined {
    return this.humanAsk;
  }

  async observe(): Promise<PageObservation> {
    await this.noteTrust();
    const page = await this.evaluate<{ webdriver: boolean; host: string }>(`({
      webdriver: navigator.webdriver === true,
      host: location.hostname,
    })`).catch(() => undefined);
    return {
      webdriver: page ? page.webdriver : false,
      host: page?.host || "",
      trust: this.trustEvents.slice(0, 20),
    };
  }

  private rememberTrust(events: TrustEvent[]): void {
    for (const event of events) {
      const seen = this.trustEvents.some((prev) =>
        prev.isTrusted === event.isTrusted && prev.tag === event.tag && prev.text === event.text && prev.ts === event.ts);
      if (!seen) this.trustEvents.push(event);
    }
  }

  private async noteTrust(): Promise<void> {
    const events = await this.evaluate<TrustEvent[]>(`(() => {
      const log = Array.isArray(window.__baoTrustLog) ? window.__baoTrustLog : [];
      return log.slice(0, 20).map((event) => ({
        isTrusted: event.isTrusted === true,
        tag: String(event.tag || ""),
        text: String(event.text || "").slice(0, 60),
        ts: typeof event.ts === "number" ? event.ts : 0,
      }));
    })()`).catch(() => [] as TrustEvent[]);
    this.rememberTrust(events);
  }

  private async chord(key: string, code: string, modifiers: number, virtualKey: number): Promise<void> {
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown", key, code, modifiers, windowsVirtualKeyCode: virtualKey,
    }, this.sessionId);
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp", key, code, modifiers, windowsVirtualKeyCode: virtualKey,
    }, this.sessionId);
  }

  async screenshotPng(): Promise<Buffer> {
    this.assertHost();
    const shot = await this.cdp.send<{ data?: string }>("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    }, this.sessionId);
    if (!shot.data) throw new Error("cdp screenshot was empty");
    return Buffer.from(shot.data, "base64");
  }

  /** Page screenshot after a local blur veil. The PNG stays in this process until the caller writes it. */
  async captureRedacted(caption: string): Promise<Buffer> {
    this.assertHost();
    const label = caption.replace(/\s+/g, " ").trim().slice(0, 80);
    await this.evaluateFunction(redactOverlay, label);
    try {
      return await this.screenshotPng();
    } finally {
      await this.evaluate(`document.getElementById("bao-redact")?.remove()`).catch(() => undefined);
    }
  }

  /** One history step, only for a tab this driver did not open. */
  async returnToAllowlist(): Promise<void> {
    if (!this.preserveTarget) throw new Error("cdp-live will not move a window it does not own");
    this.offHost = "";
    await this.cdp.send("Runtime.evaluate", {
      expression: "history.back()",
      returnByValue: true,
    }, this.sessionId);
  }

  async end(): Promise<void> {
    if (this.preserveTarget) {
      this.offHost = "";
      if (this.scriptId) {
        await this.cdp.send("Page.removeScriptToEvaluateOnNewDocument", {
          identifier: this.scriptId,
        }, this.sessionId).catch(() => undefined);
      }
      await this.evaluate(TRUST_CLEANUP).catch(() => undefined);
      await this.cdp.send("Target.detachFromTarget", { sessionId: this.sessionId }).catch(() => undefined);
      return;
    }
    await this.cdp.send("Target.closeTarget", { targetId: this.targetId }).catch(() => undefined);
  }

  private async clickSelector(selector: string): Promise<void> {
    this.assertHost();
    await this.bringToFront();
    const point = await this.evaluate<{ x: number; y: number; w: number; h: number; covered: boolean } | null>(`(() => {
      ${PIERCE_QUERY}
      const el = pierce(${JSON.stringify(selector)}, document);
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2;
      const y = r.y + r.height / 2;
      let hit = document.elementFromPoint(x, y);
      while (hit && hit.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === hit) break;
        hit = inner;
      }
      const hosts = (node) => {
        let current = node;
        while (current) {
          if (current === el) return true;
          const root = current.getRootNode();
          if (!(root instanceof ShadowRoot)) return el.contains(current);
          if (root.host === el || el.contains(root.host)) return true;
          current = root.host;
        }
        return false;
      };
      return { x, y, w: r.width, h: r.height, covered: !hit || !hosts(hit) };
    })()`);
    if (!point || point.w < 1 || point.h < 1) throw new Error("element has no box");
    if (point.covered) throw new Error("element is covered");
    const x = point.x;
    const y = point.y;
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, this.sessionId);
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", clickCount: 1,
    }, this.sessionId);
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", clickCount: 1,
    }, this.sessionId);
    await this.noteTrust();
  }

  private async waitForLoad(epoch: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.assertHost();
      const state = await this.evaluate<{ href: string; ready: string }>(
        "({ href: location.href, ready: document.readyState })",
      ).catch(() => undefined);
      const loaded = !!state && this.allows(state.href) && (state.ready === "complete" || state.ready === "interactive");
      if (loaded && (this.loadEpoch > epoch || state?.ready === "complete")) return;
      await sleep(100);
    }
  }

  private async waitAfterClick(before: string, timeoutMs: number): Promise<void> {
    const started = Date.now();
    const deadline = started + timeoutMs;
    while (Date.now() < deadline) {
      this.assertHost();
      const state = await this.evaluate<{ href: string; ready: string }>(
        "({ href: location.href, ready: document.readyState })",
      ).catch(() => undefined);
      if (!state) {
        await sleep(100);
        continue;
      }
      if (state.href !== before && (state.ready === "complete" || state.ready === "interactive")) return;
      if (state.href === before && state.ready === "complete" && Date.now() - started > 800) return;
      await sleep(100);
    }
  }
}

export interface LiveWindowOptions {
  /** False opens a tab. True opens a window. Default true. */
  newWindow?: boolean;
  /** Join an existing context. Omit this to use the default context. */
  browserContextId?: string;
  /** First URL for the new page. Default about:blank. */
  url?: string;
}

/** Runs in the page. Covers the viewport so a CDP screenshot does not keep readable page text. */
export function redactOverlay(caption: string): void {
  document.getElementById("bao-redact")?.remove();
  const veil = document.createElement("div");
  veil.id = "bao-redact";
  veil.setAttribute("data-bao-redact", "1");
  veil.style.cssText = "position:fixed;inset:0;z-index:2147483646;background:rgba(245,245,247,0.82);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)";
  const cap = document.createElement("div");
  cap.textContent = String(caption || "").slice(0, 80);
  cap.style.cssText = "position:absolute;left:16px;bottom:16px;max-width:70%;background:#1d1d1f;color:#f5f5f7;padding:8px 12px;border-radius:8px;font:13px/1.3 -apple-system,sans-serif";
  veil.appendChild(cap);
  document.documentElement.appendChild(veil);
}

async function flattenedSession(cdp: CdpSocket, targetId: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cdp did not attach")), 8000);
    cdp.on("Target.attachedToTarget", undefined, (params) => {
      const info = params.targetInfo as { targetId?: string } | undefined;
      const id = typeof params.sessionId === "string" ? params.sessionId : "";
      if (info?.targetId !== targetId || !id) return;
      if (params.waitingForDebugger === true) {
        void cdp.send("Runtime.runIfWaitingForDebugger", {}, id).catch(() => undefined);
      }
      clearTimeout(timer);
      resolve(id);
    });
    void cdp.send<{ sessionId?: string }>("Target.attachToTarget", { targetId, flatten: true }).then((attached) => {
      if (attached.sessionId) {
        clearTimeout(timer);
        resolve(attached.sessionId);
      }
    }).catch((err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

export async function openLiveWindow(
  cdp: CdpSocket,
  hosts: readonly string[] = BOOKS_HOSTS,
  options: LiveWindowOptions = {},
): Promise<CdpLiveDriver> {
  const url = options.url ?? "about:blank";
  if (!openerAllowed(url, hosts)) throw new Error("cdp-live allowlist refused the new page");
  const createParams: Record<string, unknown> = {
    url,
    newWindow: options.newWindow !== false,
    background: false,
  };
  if (options.newWindow !== false) {
    createParams.width = 1200;
    createParams.height = 900;
  }
  if (options.browserContextId) createParams.browserContextId = options.browserContextId;
  const created = await cdp.send<{ targetId?: string }>("Target.createTarget", createParams);
  const targetId = created.targetId;
  if (!targetId) throw new Error("cdp did not open a window");
  const sessionId = await flattenedSession(cdp, targetId);
  const driver = new CdpLiveDriver(cdp, sessionId, targetId, hosts);
  await driver.start();
  return driver;
}

/** Drive a window this process asked Chrome to open. Like openLiveWindow, end() closes it. */
export async function adoptLiveWindow(
  cdp: CdpSocket,
  hosts: readonly string[],
  targetId: string,
): Promise<CdpLiveDriver> {
  const sessionId = await flattenedSession(cdp, targetId);
  const driver = new CdpLiveDriver(cdp, sessionId, targetId, hosts);
  await driver.start();
  return driver;
}

/** Attach to a tab the person already opened. Does not create, navigate, or close it. */
export async function attachLivePage(
  cdp: CdpSocket,
  hosts: readonly string[],
  targetId: string,
): Promise<CdpLiveDriver> {
  if (!targetId) throw new Error("cdp did not name a page");
  const sessionId = await flattenedSession(cdp, targetId);
  const driver = new CdpLiveDriver(cdp, sessionId, targetId, hosts, true);
  await driver.start();
  return driver;
}

/** Attach to a tab the person already opened. Closing the driver detaches and leaves the tab. */
export async function attachLiveTarget(
  cdp: CdpSocket,
  targetId: string,
  hosts: readonly string[] = BOOKS_HOSTS,
): Promise<CdpLiveDriver> {
  return attachLivePage(cdp, hosts, targetId);
}
