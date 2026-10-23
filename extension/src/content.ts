// Isolated world. Listens and acts. It does not patch navigator.
// The recorder, when it is armed, lives in the page world and posts events here.

import { installDataPage } from "../../desktop/src/v1/data-page";
import { dumpPage, maskPasswordFields, unmaskPasswordFields } from "../../desktop/src/v1/dom-page";
import { clickKnownClose, dismissCoveringAds, readPageMarkers } from "../../desktop/src/v1/page-class";

interface Gesture {
  dwellMs?: number;
  pointer?: { dt: number; x: number; y: number }[];
  keyGaps?: number[];
  maxMs?: number;
}

interface IdentityHint {
  id?: string;
  testId?: string;
  cssPath?: string;
  href?: string;
  name?: string;
  text?: string;
}

declare global {
  var __baoContent: boolean | undefined;
  interface Window {
    __baoPromptAnswer?: string;
  }
}

(() => {
  if (globalThis.__baoContent) return;
  globalThis.__baoContent = true;

  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  document.documentElement?.setAttribute("data-bao-nonce", nonce);

  const observed: Record<string, unknown>[] = [];
  const pointerBuf: { t: number; x: number; y: number }[] = [];
  const keyGaps: number[] = [];
  let lastAct = performance.now();
  let lastKey = 0;
  let lastPointer = 0;

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function note(event: Event): void {
    const now = performance.now();
    const trusted = event.isTrusted;
    const pointer = event instanceof PointerEvent || event instanceof MouseEvent;
    const key = event instanceof KeyboardEvent;
    if (pointer && event.type === "pointermove") {
      if (now - lastPointer < 16) return;
      lastPointer = now;
      const pe = event as PointerEvent;
      pointerBuf.push({ t: now, x: pe.clientX, y: pe.clientY });
      if (pointerBuf.length > 80) pointerBuf.shift();
      return;
    }
    if (key && event.type === "keydown") {
      if (lastKey) keyGaps.push(Math.round(now - lastKey));
      lastKey = now;
      if (keyGaps.length > 80) keyGaps.shift();
    }
    const target = event.target instanceof Element ? event.target : null;
    const password = target instanceof HTMLInputElement && target.type === "password";
    const row: Record<string, unknown> = {
      type: event.type,
      isTrusted: trusted,
      t: Math.round(now),
    };
    if (pointer) {
      const pe = event as MouseEvent;
      row.x = Math.round(pe.clientX);
      row.y = Math.round(pe.clientY);
    }
    if (key && !password) row.key = (event as KeyboardEvent).key;
    observed.push(row);
    if (observed.length > 1500) observed.shift();
    if (event.type === "click" || event.type === "keydown" || event.type === "pointerdown") {
      chrome.runtime.sendMessage({ source: "bao-observe", event: row }).catch(() => undefined);
    }
  }

  for (const type of ["pointermove", "pointerdown", "click", "keydown", "keyup"]) {
    document.addEventListener(type, note, true);
  }

  function recordedGesture(): Gesture {
    const now = performance.now();
    const started = lastAct;
    const pointer = pointerBuf
      .filter((sample) => sample.t >= started)
      .slice(-40)
      .map((sample) => ({ dt: Math.round(sample.t - started), x: Math.round(sample.x), y: Math.round(sample.y) }));
    const gesture = {
      dwellMs: Math.max(0, Math.round(now - started)),
      pointer,
      keyGaps: keyGaps.slice(),
    };
    lastAct = now;
    lastKey = 0;
    keyGaps.length = 0;
    return gesture;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data as { source?: string; nonce?: string; payload?: unknown } | null;
    if (!data || data.source !== "bao-record" || data.nonce !== nonce || !data.payload) return;
    chrome.runtime.sendMessage({ source: "bao-trail", event: data.payload, gesture: recordedGesture() }).catch(() => undefined);
  });

  function capOf(gesture?: Gesture): number {
    return gesture?.maxMs && gesture.maxMs > 0 ? gesture.maxMs : Number.POSITIVE_INFINITY;
  }

  async function playGesture(gesture?: Gesture): Promise<void> {
    if (!gesture) return;
    const max = capOf(gesture);
    const dwell = Math.min(Math.max(0, gesture.dwellMs || 0), max);
    const started = performance.now();
    for (const sample of gesture.pointer || []) {
      const at = Math.min(Math.max(0, sample.dt || 0), max);
      const wait = at - (performance.now() - started);
      if (wait > 8) await delay(wait);
      document.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        clientX: sample.x,
        clientY: sample.y,
        pointerId: 1,
        pointerType: "mouse",
      }));
    }
    const rest = dwell - (performance.now() - started);
    if (rest > 8) await delay(rest);
  }

  function shown(el: Element): boolean {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  }

  // A selector can match a hidden copy in an earlier shadow root. Replay uses the one on screen.
  function findDeep(query: (root: ParentNode) => Element | null, root: ParentNode = document): Element | null {
    const found: Element[] = [];
    const walk = (node: ParentNode) => {
      try {
        const hit = query(node);
        if (hit) found.push(hit);
      } catch {
        /* a recorded css path can be stale */
      }
      const nodes = node.querySelectorAll ? node.querySelectorAll("*") : [];
      for (const el of nodes) {
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(root);
    return found.find(shown) || found[0] || null;
  }

  function byHandle(handle: string): Element | null {
    const esc = window.CSS && CSS.escape ? CSS.escape(handle) : handle;
    return findDeep((root) => root.querySelector(`[data-bao-i="${esc}"]`));
  }

  function byIdentity(identity?: IdentityHint): Element | null {
    if (!identity) return null;
    if (identity.id) {
      const esc = window.CSS && CSS.escape ? CSS.escape(identity.id) : identity.id;
      const hit = findDeep((root) => root.querySelector(`#${esc}`));
      if (hit) return hit;
    }
    if (identity.testId) {
      const esc = window.CSS && CSS.escape ? CSS.escape(identity.testId) : identity.testId;
      const hit = findDeep((root) => root.querySelector(`[data-testid="${esc}"], [data-qa="${esc}"], [data-test="${esc}"]`));
      if (hit) return hit;
    }
    if (identity.cssPath) {
      const hit = findDeep((root) => root.querySelector(identity.cssPath || ""));
      if (hit) return hit;
    }
    if (identity.href) {
      const href = identity.href;
      const hit = findDeep((root) => root.querySelector(`a[href="${href.replace(/"/g, "")}"]`));
      if (hit) return hit;
    }
    return null;
  }

  function targetOf(message: { handle?: string; identity?: IdentityHint; selector?: string; text?: string }): Element {
    const found = (message.handle && byHandle(message.handle))
      || byIdentity(message.identity)
      || (message.selector ? findDeep((root) => root.querySelector(message.selector || "")) : null)
      || (message.text ? findText(message.text) : null);
    if (!found) throw new Error("target missing");
    return found;
  }

  function findText(needle: string): Element | null {
    const hits: Element[] = [];
    const walk = (root: ParentNode) => {
      const nodes = root.querySelectorAll ? root.querySelectorAll("a, button, label, summary, [role=button], [role=link], input, option") : [];
      nodes.forEach((el) => {
        const raw = el instanceof HTMLInputElement ? el.value : (el.textContent || "");
        const text = raw.replace(/\s+/g, " ").trim();
        if (!text) return;
        if (text === needle || (needle.length > 2 && text.includes(needle) && text.length < needle.length + 48)) hits.push(el);
      });
      root.querySelectorAll?.("*").forEach((el) => {
        if (el.shadowRoot) walk(el.shadowRoot);
      });
    };
    walk(document);
    const pool = hits.some(shown) ? hits.filter(shown) : hits;
    pool.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
    return pool[0] || null;
  }

  function setNativeValue(el: Element, value: string): void {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, value);
    else if ("value" in el) (el as HTMLInputElement).value = value;
  }

  async function fill(el: Element, text: string, gesture?: Gesture): Promise<void> {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error("not a field");
    el.focus();
    const gaps = gesture?.keyGaps || [];
    const max = capOf(gesture);
    if (!gaps.length) {
      setNativeValue(el, text);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return;
    }
    setNativeValue(el, "");
    let built = "";
    for (let i = 0; i < text.length; i++) {
      if (i > 0) {
        const gap = gaps[i - 1] != null ? gaps[i - 1] : gaps[gaps.length - 1];
        if (gap != null && gap > 0) await delay(Math.min(gap, max));
      }
      const key = text[i] || "";
      el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true }));
      built += key;
      setNativeValue(el, built);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: key, inputType: "insertText" }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, composed: true, cancelable: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  function choose(el: Element, value: string): void {
    if (!(el instanceof HTMLSelectElement)) throw new Error("not a select");
    const options = [...el.options];
    const option = options.find((item) => item.label === value || item.text === value) || options.find((item) => item.value === value);
    if (!option) throw new Error(`option missing: ${value}`);
    el.value = option.value;
    option.selected = true;
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  function setChecked(el: Element, checked: boolean): void {
    const input = el instanceof HTMLInputElement ? el : el.querySelector("input[type=checkbox], input[type=radio]");
    if (!(input instanceof HTMLInputElement)) throw new Error("not a checkbox");
    if (input.checked !== checked) input.click();
  }

  function press(key: string): void {
    const el = document.activeElement instanceof Element ? document.activeElement : document.body;
    const named = key.replace(/^ctrl\+/i, "Control+").replace(/^cmd\+/i, "Meta+").replace(/^alt\+/i, "Alt+");
    el.dispatchEvent(new KeyboardEvent("keydown", { key: named, bubbles: true, composed: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { key: named, bubbles: true, composed: true, cancelable: true }));
  }

  function pageText(): string {
    const parts: string[] = [];
    const visit = (node: Node): void => {
      if (node instanceof Element) {
        if (node.tagName === "SCRIPT" || node.tagName === "STYLE" || node.tagName === "NOSCRIPT") return;
        if (node instanceof HTMLInputElement && node.type === "password") return;
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return;
        if (node.shadowRoot) visit(node.shadowRoot);
        if ((node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) && node.type !== "password" && node.value) {
          parts.push(node.value);
        }
        if (node instanceof HTMLSelectElement) {
          const label = node.selectedOptions[0]?.label || node.selectedOptions[0]?.text || "";
          if (label) parts.push(label);
        }
      }
      const children = node instanceof ShadowRoot || node instanceof Document || node instanceof Element ? node.childNodes : [];
      for (const child of children) {
        if (child.nodeType === Node.TEXT_NODE) {
          const bit = (child.textContent || "").replace(/\s+/g, " ").trim();
          if (bit) parts.push(bit);
        } else {
          visit(child);
        }
      }
    };
    const strip = document.getElementById("bao-control-strip");
    if (strip) parts.push((strip.innerText || "").replace(/\s+/g, " ").trim());
    if (document.body) visit(document.body);
    return parts.join("\n").split("\n").filter((line) => !/password/i.test(line)).join("\n").slice(0, 16000);
  }

  function screenPoint(el: Element): Record<string, number> {
    el.scrollIntoView({ block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    const chromeY = Math.max(0, window.outerHeight - window.innerHeight);
    return {
      x: Math.round(window.screenX + rect.left + rect.width / 2),
      y: Math.round(window.screenY + chromeY + rect.top + rect.height / 2),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      innerHeight: window.innerHeight,
      outerHeight: window.outerHeight,
      innerWidth: window.innerWidth,
      outerWidth: window.outerWidth,
    };
  }

  function showStrip(kind: string, text: string): void {
    document.getElementById("bao-control-strip")?.remove();
    const bar = document.createElement("div");
    bar.id = "bao-control-strip";
    bar.setAttribute("data-bao-strip", kind);
    bar.style.cssText = "position:fixed;z-index:2147483646;left:0;right:0;top:0;background:#1d1d1f;color:#fff;font:13px/1.3 -apple-system,BlinkMacSystemFont,sans-serif;padding:8px 12px";
    const note = document.createElement("p");
    note.textContent = text;
    note.style.margin = "0";
    bar.appendChild(note);
    document.documentElement.appendChild(bar);
  }

  async function handle(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const op = String(message.op || "");
    const gesture = message.gesture as Gesture | undefined;
    if (op === "gesture") {
      await playGesture(gesture);
      return { ok: true };
    }
    if (op === "mask") {
      maskPasswordFields();
      return { ok: true };
    }
    if (op === "unmask") {
      unmaskPasswordFields();
      return { ok: true };
    }
    if (op === "metrics") {
      return {
        ok: true,
        webdriver: navigator.webdriver,
        userAgent: navigator.userAgent,
        language: navigator.language,
        languages: [...navigator.languages],
        hardwareConcurrency: navigator.hardwareConcurrency,
        platform: navigator.platform,
        innerHeight: window.innerHeight,
        outerHeight: window.outerHeight,
        innerWidth: window.innerWidth,
        outerWidth: window.outerWidth,
      };
    }
    if (op === "flush-events") return { ok: true, events: observed.slice() };
    if (op === "text") return { ok: true, text: pageText(), title: document.title, url: location.href };
    if (op === "box") {
      const el = targetOf(message as { selector?: string; text?: string });
      return { ok: true, ...screenPoint(el) };
    }
    if (op === "tree") {
      const dump = dumpPage();
      return { ok: true, ...dump };
    }
    if (op === "markers") return { ok: true, ...readPageMarkers() };
    if (op === "dismiss") {
      dismissCoveringAds();
      return { ok: true, clicked: clickKnownClose() };
    }
    if (op === "showAsk") {
      showStrip(String(message.kind || "wall"), String(message.text || ""));
      return { ok: true };
    }
    if (op === "clearAsk") {
      document.getElementById("bao-control-strip")?.remove();
      return { ok: true };
    }
    if (op === "captureStep") {
      const dump = dumpPage();
      const dom = dump.nodes
        .filter((node) => node.id !== "password" && node.nameAttr !== "password")
        .slice(0, 40)
        .map((node) => ({ role: node.role, name: node.name, text: node.text, testId: node.testId, id: node.id }));
      return { ok: true, dom, ax: pageText() };
    }
    if (op === "click" || op === "drive-click") {
      await playGesture(gesture);
      dismissCoveringAds();
      const el = targetOf(message as { handle?: string; identity?: IdentityHint; selector?: string; text?: string });
      if (el instanceof HTMLElement) {
        el.scrollIntoView({ block: "center", inline: "nearest" });
        el.click();
      }
      return { ok: true };
    }
    if (op === "fill" || op === "drive-fill") {
      await playGesture(gesture);
      const el = targetOf(message as { handle?: string; identity?: IdentityHint; selector?: string });
      await fill(el, String(message.text ?? ""), gesture);
      return { ok: true };
    }
    if (op === "select" || op === "drive-select") {
      await playGesture(gesture);
      const el = targetOf(message as { handle?: string; identity?: IdentityHint; selector?: string });
      choose(el, String(message.value ?? message.label ?? ""));
      return { ok: true };
    }
    if (op === "check") {
      await playGesture(gesture);
      const el = targetOf(message as { handle?: string; identity?: IdentityHint });
      setChecked(el, message.checked === true);
      return { ok: true };
    }
    if (op === "key") {
      await playGesture(gesture);
      press(String(message.key || "Enter"));
      return { ok: true };
    }
    if (op === "focus") {
      const el = targetOf(message as { handle?: string; identity?: IdentityHint });
      if (el instanceof HTMLElement) el.focus();
      return { ok: true };
    }
    if (op === "mark-file") {
      const el = targetOf(message as { handle?: string; identity?: IdentityHint; selector?: string });
      const input = el instanceof HTMLInputElement && el.type === "file" ? el : el.querySelector("input[type=file]");
      if (!(input instanceof HTMLInputElement)) throw new Error("file input missing");
      input.setAttribute("data-bao-file", "1");
      return { ok: true };
    }
    if (op === "file-name") {
      const input = document.querySelector("[data-bao-file]") || findDeep((root) => root.querySelector("[data-bao-file]"));
      const field = input instanceof HTMLInputElement ? input : null;
      const name = field?.files?.[0]?.name || "";
      field?.removeAttribute("data-bao-file");
      return { ok: true, name };
    }
    if (op === "readList") {
      installDataPage();
      const host = window as unknown as { __baoReadList?: (spec: unknown) => { rows: Record<string, string>[]; nextVisible: boolean } };
      if (!host.__baoReadList) throw new Error("extract is not installed");
      return { ok: true, ...host.__baoReadList(message.spec) };
    }
    if (op === "propose") {
      installDataPage();
      const host = window as unknown as { __baoPropose?: (arg: unknown) => Record<string, unknown> };
      if (!host.__baoPropose) throw new Error("extract is not installed");
      return { ok: true, proposal: host.__baoPropose({ selector: message.selector }) };
    }
    if (op === "activate") {
      installDataPage();
      const host = window as unknown as { __baoMark?: (locators: unknown) => boolean };
      const marked = host.__baoMark ? host.__baoMark(message.locators) : false;
      if (!marked) return { ok: false, activated: false };
      const el = document.querySelector("[data-bao-pick]");
      if (el instanceof HTMLElement) el.click();
      return { ok: true, activated: true };
    }
    if (op === "drop") {
      await playGesture(gesture);
      const el = targetOf(message as { handle?: string; identity?: IdentityHint });
      const files = Array.isArray(message.files) ? message.files as { name: string; b64: string }[] : [];
      const dt = new DataTransfer();
      for (const file of files) {
        const bin = atob(file.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        dt.items.add(new File([bytes], file.name));
      }
      for (const type of ["dragenter", "dragover", "drop"]) {
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
      return { ok: true, name: files[0]?.name || "" };
    }
    throw new Error(`unknown page op ${op}`);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const body = message as { source?: string; op?: string };
    if (!body || body.source === "bao-trail" || body.source === "bao-observe" || !body.op) return;
    void handle(message as Record<string, unknown>).then(
      (result) => sendResponse(result),
      (err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
  });
})();
