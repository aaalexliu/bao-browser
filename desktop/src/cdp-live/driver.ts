import { installDataPage } from "../v1/data-page";
import type { ExtractSpec } from "../v1/data-steps";
import { dumpPage, type DomDump, type PageDump } from "../v1/dom-page";
import type { FailureSnapshot } from "../v1/heal";
import type { HumanAsk } from "../v1/human-ask";
import { assignSiblingIndex } from "../v1/identity";
import { readPageMarkers, type PageSignals } from "../v1/page-class";
import type { Driver, LiveTree } from "../v1/replay";
import type { FileArg, Identity, StepLocator } from "../v1/schema";
import { navigationAllowed, openerAllowed, publicHost } from "./allowlist";
import { CdpSocket } from "./socket";

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
    document.addEventListener("click", (event) => {
      const target = event.target;
      const el = target instanceof Element ? target : null;
      host.__baoTrustLog.push({
        isTrusted: event.isTrusted === true,
        tag: el ? el.tagName : "",
        text: el ? (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60) : "",
        ts: Date.now(),
      });
      persist();
    }, true);
  }
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
  private humanAsk: HumanAsk | undefined;
  private trustEvents: TrustEvent[] = [];
  readonly subframesSeen = { count: 0 };

  constructor(
    private readonly cdp: CdpSocket,
    private readonly sessionId: string,
    readonly targetId: string,
  ) {}

  async start(): Promise<void> {
    await this.cdp.send("Page.enable", {}, this.sessionId);
    await this.cdp.send("Runtime.enable", {}, this.sessionId);
    this.cdp.on("Page.loadEventFired", this.sessionId, () => { this.loadEpoch += 1; });
    this.cdp.on("Page.frameNavigated", this.sessionId, (params) => this.onFrame(params));
    try {
      await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: TRUST_SOURCE,
        runImmediately: true,
      }, this.sessionId);
    } catch {
      await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: TRUST_SOURCE }, this.sessionId);
    }
    await this.evaluate(TRUST_SOURCE).catch(() => undefined);
    await this.bringToFront();
  }

  private onFrame(params: Record<string, unknown>): void {
    const frame = params.frame as { parentId?: string; url?: string } | undefined;
    if (!frame) return;
    if (frame.parentId) {
      this.subframesSeen.count += 1;
      return;
    }
    const url = frame.url || "";
    if (!url || url === "about:blank" || navigationAllowed(url)) {
      void this.evaluate(TRUST_SOURCE).catch(() => undefined);
    }
    if (!url || openerAllowed(url) && url === "about:blank") return;
    if (!navigationAllowed(url)) {
      this.offHost = publicHost(url) || "off-allowlist";
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
    const url = dump.url && navigationAllowed(dump.url) ? dump.url : publicHost(dump.url || "");
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
    const url = markers.url && navigationAllowed(markers.url) ? markers.url : publicHost(markers.url || "");
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

  async goto(url: string): Promise<void> {
    if (!navigationAllowed(url)) throw new Error(`cdp-live allowlist refused ${publicHost(url) || "that url"}`);
    this.assertHost();
    const epoch = this.loadEpoch;
    const nav = await this.cdp.send<{ errorText?: string }>("Page.navigate", { url }, this.sessionId);
    if (nav.errorText) throw new Error(nav.errorText);
    await this.waitForLoad(epoch, 20_000);
    const href = await this.evaluate<string>("location.href");
    if (navigationAllowed(href)) return;
    if (!href || href === "about:blank") throw new Error("navigation did not finish");
    const host = publicHost(href) || "off-allowlist";
    await this.end().catch(() => undefined);
    throw new Error(`cdp-live allowlist refused ${host}`);
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
    const enter = key === "Enter" || key === "Return";
    const name = enter ? "Enter" : key;
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: name,
      code: name,
      windowsVirtualKeyCode: enter ? 13 : 0,
      text: enter ? "\r" : name.length === 1 ? name : "",
    }, this.sessionId);
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name }, this.sessionId);
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

  async end(): Promise<void> {
    await this.cdp.send("Target.closeTarget", { targetId: this.targetId }).catch(() => undefined);
  }

  private async clickSelector(selector: string): Promise<void> {
    this.assertHost();
    await this.bringToFront();
    const point = await this.evaluate<{ x: number; y: number; w: number; h: number } | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    })()`);
    if (!point || point.w < 1 || point.h < 1) throw new Error("element has no box");
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
      const loaded = !!state && navigationAllowed(state.href) && (state.ready === "complete" || state.ready === "interactive");
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

export async function openLiveWindow(cdp: CdpSocket): Promise<CdpLiveDriver> {
  const created = await cdp.send<{ targetId?: string }>("Target.createTarget", {
    url: "about:blank",
    newWindow: true,
    background: false,
    width: 1200,
    height: 900,
  });
  const targetId = created.targetId;
  if (!targetId) throw new Error("cdp did not open a window");
  if (!openerAllowed("about:blank")) throw new Error("cdp-live allowlist refused about:blank");
  const sessionId = await new Promise<string>((resolve, reject) => {
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
  const driver = new CdpLiveDriver(cdp, sessionId, targetId);
  await driver.start();
  return driver;
}
