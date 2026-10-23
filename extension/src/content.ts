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
  let lastClickTrusted: boolean | null = null;
  let lastKeyTrusted: boolean | null = null;
  let lastInputTrusted: boolean | null = null;

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function note(event: Event): void {
    const now = performance.now();
    const trusted = event.isTrusted;
    if (event.type === "click") lastClickTrusted = trusted;
    if (event.type === "keydown") lastKeyTrusted = trusted;
    if (event.type === "input" || event.type === "beforeinput") lastInputTrusted = trusted;
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

  for (const type of ["pointermove", "pointerdown", "click", "keydown", "keyup", "beforeinput", "input"]) {
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
    const visible = found.filter(shown);
    const pool = visible.length ? visible : found;
    // A link under the app shell still has a box. Prefer the one the pointer can hit.
    const hittable = pool.find((el) => pointerHits(el));
    return hittable || pool[0] || null;
  }

  function pointerHits(el: Element): boolean {
    const rects = el.getClientRects();
    const boxes: DOMRect[] = [];
    for (let i = 0; i < rects.length; i++) {
      const rect = rects.item(i);
      if (rect && rect.width >= 1 && rect.height >= 1) boxes.push(rect);
    }
    if (!boxes.length) boxes.push(el.getBoundingClientRect());
    for (const rect of boxes) {
      const x = rect.left + Math.min(rect.width / 2, Math.max(rect.width - 2, 1));
      const y = rect.top + Math.min(rect.height / 2, Math.max(rect.height - 2, 1));
      if (x < 1 || y < 1 || x > window.innerWidth - 1 || y > window.innerHeight - 1) continue;
      if (onTarget(el, document.elementFromPoint(x, y))) return true;
    }
    return false;
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

  function choose(el: Element, value: string): void {
    if (!(el instanceof HTMLSelectElement)) throw new Error("not a select");
    const options = [...el.options];
    const option = options.find((item) => item.label === value || item.text === value) || options.find((item) => item.value === value);
    if (!option) throw new Error(`option missing: ${value}`);
    walkElements((node) => node.removeAttribute("data-bao-focus"));
    el.value = option.value;
    option.selected = true;
    el.setAttribute("data-bao-focus", "1");
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  // Same visible string the Playwright proof reads (body.innerText), plus open
  // shadow text. Inline siblings stay on one line so "$" + "29.50" remains "$29.50".
  // Prices, file names, and field values are kept at the front so a long page
  // cannot slice them off.
  function pageText(): string {
    const prices = new Set<string>();
    const files: string[] = [];
    const values: string[] = [];
    const skipTag = /^(SCRIPT|STYLE|NOSCRIPT|SVG)$/;
    const blockDisplay = /^(block|flex|grid|list-item|table|table-row|table-caption|flow-root)$/;
    const walk = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
      if (!(node instanceof Element) && !(node instanceof ShadowRoot)) return "";
      if (node instanceof Element) {
        if (skipTag.test(node.tagName)) return "";
        if (node instanceof HTMLInputElement && node.type === "password") return "";
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return "";
        if (node instanceof HTMLInputElement && node.type === "file") {
          const name = node.files?.[0]?.name || "";
          if (name) files.push(name);
          return "";
        }
        if ((node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) && node.value) values.push(node.value);
        if (node instanceof HTMLSelectElement) {
          const label = node.selectedOptions[0]?.label || node.selectedOptions[0]?.text || "";
          if (label) values.push(label);
        }
        if (node.shadowRoot) {
          const joined = `${walk(node.shadowRoot)}${[...node.childNodes].map((child) => walk(child)).join("")}`;
          for (const price of joined.match(/\$\d+\.\d{2}/g) || []) prices.add(price);
          return blockDisplay.test(style.display) ? `\n${joined}\n` : joined;
        }
        const joined = [...node.childNodes].map((child) => walk(child)).join("");
        for (const price of joined.match(/\$\d+\.\d{2}/g) || []) prices.add(price);
        if (blockDisplay.test(style.display) || node.tagName === "BR") return `\n${joined}\n`;
        return joined;
      }
      const joined = [...node.childNodes].map((child) => walk(child)).join("");
      for (const price of joined.match(/\$\d+\.\d{2}/g) || []) prices.add(price);
      return `\n${joined}\n`;
    };
    const rendered = document.body ? walk(document.body) : "";
    const plain = document.body?.innerText || "";
    for (const price of plain.match(/\$\d+\.\d{2}/g) || []) prices.add(price);
    const strip = document.getElementById("bao-control-strip")?.innerText || "";
    const text = [strip, [...prices].join(" "), files.join("\n"), values.join("\n"), plain, rendered]
      .filter((part) => part && part.trim())
      .join("\n");
    return text.split("\n").filter((line) => !/password/i.test(line)).join("\n").slice(0, 20000);
  }

  function deepActive(): Element | null {
    let node: Element | null = document.activeElement;
    while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
    return node;
  }

  // The point has to land on the target or something inside it. A parent that
  // contains the target (the li around a category link) is not a hit: clicking
  // that padding does not activate the link.
  function onTarget(target: Element, hit: Element | null): boolean {
    if (!hit) return false;
    if (hit === target || target.contains(hit)) return true;
    if (target instanceof HTMLLabelElement && target.control) {
      const control = target.control;
      if (hit === control || control.contains(hit)) return true;
    }
    let node: Node | null = hit;
    while (node) {
      if (node === target) return true;
      if (node instanceof ShadowRoot) {
        node = node.host;
        continue;
      }
      node = node.parentNode;
    }
    return false;
  }

  function walkElements(visit: (el: Element) => void, root: ParentNode = document): void {
    root.querySelectorAll?.("*").forEach((el) => {
      visit(el);
      if (el.shadowRoot) walkElements(visit, el.shadowRoot);
    });
  }

  function checkable(el: Element): HTMLInputElement | null {
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return el;
    if (el instanceof HTMLLabelElement && el.control instanceof HTMLInputElement) {
      const input = el.control;
      if (input.type === "checkbox" || input.type === "radio") return input;
    }
    const inner = el.querySelector("input[type=checkbox], input[type=radio]");
    return inner instanceof HTMLInputElement ? inner : null;
  }

  function fieldOf(message: { handle?: string; identity?: IdentityHint; selector?: string }): HTMLInputElement | HTMLTextAreaElement | null {
    try {
      const el = targetOf(message);
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el;
    } catch {
      /* the caret is the field when the locator was not sent */
    }
    const active = deepActive();
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return active;
    return null;
  }

  // CSS pixels in the viewport. The debugger click uses this point, not a stale sample.
  // An inline link with a blank line has a union box whose center sits on the parent.
  // Sample each line box and keep the first point that is actually on the element.
  function viewportPoint(el: Element): { x: number; y: number; covered: boolean; hit: string } {
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" } as ScrollIntoViewOptions);
    }
    dismissCoveringAds();
    const rects: DOMRect[] = [];
    const client = el.getClientRects();
    for (let i = 0; i < client.length; i++) {
      const rect = client.item(i);
      if (rect && rect.width >= 1 && rect.height >= 1) rects.push(rect);
    }
    if (!rects.length) rects.push(el.getBoundingClientRect());
    const samples: { x: number; y: number }[] = [];
    for (const rect of rects) {
      samples.push({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          samples.push({
            x: rect.left + (rect.width * (col + 0.5)) / 3,
            y: rect.top + (rect.height * (row + 0.5)) / 3,
          });
        }
      }
    }
    let fallbackHit = "";
    let fallbackEl: Element | null = null;
    for (const sample of samples) {
      if (sample.x < 1 || sample.y < 1 || sample.x > window.innerWidth - 1 || sample.y > window.innerHeight - 1) continue;
      const hit = document.elementFromPoint(sample.x, sample.y);
      if (!hit) continue;
      fallbackHit = hit.tagName;
      fallbackEl = hit;
      if (onTarget(el, hit)) return { x: sample.x, y: sample.y, covered: false, hit: hit.tagName };
    }
    const rect = el.getBoundingClientRect();
    const x = Math.min(window.innerWidth - 1, Math.max(1, rect.left + Math.max(rect.width, 0) / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(1, rect.top + Math.max(rect.height, 0) / 2));
    // A closed shadow host is what elementFromPoint returns for a link inside it.
    // The click at the link's box still reaches that link. A plain parent (an li)
    // does not, so those stay covered.
    if (fallbackEl && fallbackEl.tagName.includes("-") && insideHost(el, fallbackEl)) {
      return { x, y, covered: false, hit: fallbackHit };
    }
    return { x, y, covered: true, hit: fallbackHit };
  }

  function insideHost(target: Element, hit: Element): boolean {
    let node: Node | null = target;
    while (node) {
      if (node === hit) return true;
      if (node instanceof ShadowRoot) {
        if (node.host === hit) return true;
        node = node.host;
        continue;
      }
      node = node.parentNode;
    }
    return false;
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
    if (op === "point") {
      if (message.skipGesture !== true) await playGesture(gesture);
      const el = targetOf(message as { handle?: string; identity?: IdentityHint; selector?: string; text?: string });
      const input = checkable(el);
      if (typeof message.desiredChecked === "boolean" && input && input.checked === message.desiredChecked) {
        return { ok: true, skipClick: true };
      }
      const point = viewportPoint(el);
      const tag = el.tagName;
      const inputType = el instanceof HTMLInputElement ? el.type : "";
      return {
        ok: true,
        x: point.x,
        y: point.y,
        covered: point.covered,
        hit: point.hit,
        tag,
        inputType,
        checked: input ? input.checked : undefined,
      };
    }
    if (op === "raw-click") {
      const el = targetOf(message as { handle?: string; identity?: IdentityHint; selector?: string; text?: string });
      let trusted = false;
      const onClick = (event: Event) => { trusted = event.isTrusted; };
      document.addEventListener("click", onClick, true);
      if (el instanceof HTMLElement) el.click();
      document.removeEventListener("click", onClick, true);
      return { ok: true, isTrusted: trusted };
    }
    if (op === "last-trust") {
      return {
        ok: true,
        click: lastClickTrusted === true,
        key: lastKeyTrusted === true,
        input: lastInputTrusted === true,
      };
    }
    if (op === "arm-click") {
      document.documentElement?.setAttribute("data-bao-ignore-click", "1");
      return { ok: true };
    }
    if (op === "disarm-click") {
      document.documentElement?.removeAttribute("data-bao-ignore-click");
      return { ok: true };
    }
    if (op === "mark-focus") {
      walkElements((el) => el.removeAttribute("data-bao-focus"));
      const el = targetOf(message as { handle?: string; identity?: IdentityHint; selector?: string; text?: string });
      el.setAttribute("data-bao-focus", "1");
      return { ok: true, tag: el.tagName };
    }
    if (op === "clear-focus") {
      walkElements((el) => el.removeAttribute("data-bao-focus"));
      return { ok: true };
    }
    if (op === "field-state") {
      let el: Element | null = null;
      try {
        el = targetOf(message as { handle?: string; identity?: IdentityHint; selector?: string; text?: string });
      } catch {
        el = null;
      }
      const active = deepActive();
      const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
      return {
        ok: true,
        found: !!el,
        focused: !!(el && active === el),
        value: field ? field.value : "",
        tag: el ? el.tagName : "",
        type: field ? field.type : "",
      };
    }
    if (op === "select-all") {
      const el = fieldOf(message as { handle?: string; identity?: IdentityHint; selector?: string });
      if (el) {
        el.focus();
        try {
          el.select();
          el.setSelectionRange(0, el.value.length);
        } catch {
          /* number and date inputs refuse a selection range */
        }
      }
      const active = deepActive();
      return { ok: true, focused: !!(el && active === el), value: el ? el.value : "" };
    }
    if (op === "commit") {
      const el = fieldOf(message as { handle?: string; identity?: IdentityHint; selector?: string });
      // insertText already fired the trusted input. A second input event makes
      // some bindings append. change is what the recorder and plain forms read.
      if (el && message.flush === true) {
        el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      }
      return { ok: true, value: el ? el.value : "" };
    }
    if (op === "click" || op === "drive-click" || op === "fill" || op === "drive-fill" || op === "check" || op === "key") {
      throw new Error(`${op} is dispatched through the debugger`);
    }
    if (op === "select" || op === "drive-select") {
      await playGesture(gesture);
      const el = targetOf(message as { handle?: string; identity?: IdentityHint; selector?: string });
      choose(el, String(message.value ?? message.label ?? ""));
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
      if (!(el instanceof HTMLElement)) return { ok: false, activated: false };
      const point = viewportPoint(el);
      return { ok: true, activated: true, pendingClick: true, x: point.x, y: point.y };
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
