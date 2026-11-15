import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import type { CdpSocket } from "../../src/cdp-live/socket";
import { Takeover } from "../../src/cdp-live/takeover";

interface OverlayView { phase?: string; activity?: string }

interface El {
  tagName: string;
  className: string;
  hidden: boolean;
  style: Record<string, string>;
  textContent: string;
  children: El[];
  parentNode: El | null;
  isConnected: boolean;
  setAttribute(name: string, value: string): void;
  append(...nodes: El[]): void;
  appendChild(node: El): El;
  remove(): void;
  addEventListener(type: string, fn: unknown): void;
  removeEventListener(type: string, fn: unknown): void;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): El[];
  matches(sel: string): boolean;
  classList: { add(name: string): void; remove(name: string): void; toggle(name: string, force?: boolean): void };
  showPopover(): void;
  getBoundingClientRect(): { left: number; width: number; bottom: number };
  attachShadow(init: { mode: string }): El;
}

interface Page {
  listeners: { type: string; fn: unknown }[];
  documentListeners: { type: string; fn: unknown }[];
  host?: El;
  applies: OverlayView[];
  context: vm.Context;
}

function element(tag: string): El {
  const el: El = {
    tagName: tag.toUpperCase(),
    className: "",
    hidden: false,
    style: {},
    textContent: "",
    children: [],
    parentNode: null,
    isConnected: false,
    setAttribute() {},
    append(...nodes) {
      for (const node of nodes) {
        node.parentNode = el;
        el.children.push(node);
      }
    },
    appendChild(node) {
      el.append(node);
      node.isConnected = true;
      return node;
    },
    remove() {
      this.isConnected = false;
      this.parentNode = null;
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector(sel) {
      return query(el, sel)[0] ?? null;
    },
    querySelectorAll(sel) {
      return query(el, sel);
    },
    matches() { return false; },
    classList: {
      add(name) { el.className = `${el.className} ${name}`.trim(); },
      remove(name) { el.className = el.className.split(/\s+/).filter((item) => item !== name).join(" "); },
      toggle(name, force) {
        const has = el.className.split(/\s+/).includes(name);
        if (force === true || (force === undefined && !has)) el.classList.add(name);
        if (force === false || (force === undefined && has)) el.classList.remove(name);
      },
    },
    showPopover() {},
    getBoundingClientRect() { return { left: 0, width: 0, bottom: 0 }; },
    attachShadow() {
      const shadow = element("shadow");
      (el as El & { shadow?: El }).shadow = shadow;
      return shadow;
    },
  };
  let html = "";
  Object.defineProperty(el, "innerHTML", {
    get: () => html,
    set: (value: string) => {
      html = value;
      el.children = [];
      parseInto(el, value);
    },
  });
  return el;
}

function hasClass(el: El, name: string): boolean {
  return el.className.split(/\s+/).includes(name);
}

function walk(el: El, sel: string, out: El[]): void {
  if (sel.startsWith(".") && hasClass(el, sel.slice(1))) out.push(el);
  for (const child of el.children) walk(child, sel, out);
  const shadow = (el as El & { shadow?: El }).shadow;
  if (shadow) walk(shadow, sel, out);
}

function query(el: El, sel: string): El[] {
  const out: El[] = [];
  for (const child of el.children) walk(child, sel, out);
  const shadow = (el as El & { shadow?: El }).shadow;
  if (shadow) walk(shadow, sel, out);
  return out;
}

function parseInto(parent: El, html: string): void {
  const src = html.replace(/<svg[\s\S]*?<\/svg>/g, "");
  const re = /<\/?([a-zA-Z0-9]+)([^>]*)\/?>/g;
  const stack = [parent];
  for (const match of src.matchAll(re)) {
    const raw = match[0];
    if (raw.startsWith("</")) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const child = element(match[1]);
    const className = /class="([^"]*)"/.exec(match[2] ?? "")?.[1];
    if (className) child.className = className;
    if (/(?:^|\s)hidden(?:\s|=|$)/.test(match[2] ?? "")) child.hidden = true;
    stack[stack.length - 1].append(child);
    if (!raw.endsWith("/>")) stack.push(child);
  }
}

function track(list: { type: string; fn: unknown }[]) {
  return {
    addEventListener(type: string, fn: unknown) { list.push({ type, fn }); },
    removeEventListener(type: string, fn: unknown) {
      const at = list.findIndex((item) => item.type === type && item.fn === fn);
      if (at >= 0) list.splice(at, 1);
    },
  };
}

function makePage(): Page {
  const listeners: { type: string; fn: unknown }[] = [];
  const documentListeners: { type: string; fn: unknown }[] = [];
  const page: Page = { listeners, documentListeners, applies: [], context: null as unknown as vm.Context };
  const window = track(listeners) as { top: unknown; addEventListener: (type: string, fn: unknown) => void; removeEventListener: (type: string, fn: unknown) => void };
  window.top = window;
  const root = element("html");
  const document = {
    documentElement: root,
    fullscreenElement: null,
    visibilityState: "visible",
    createElement(tag: string) {
      const created = element(tag);
      if (tag.startsWith("b-")) page.host = created;
      return created;
    },
    querySelectorAll() { return []; },
    ...track(documentListeners),
  };
  function MutationObserver(this: { observe(): void; disconnect(): void }) {
    this.observe = () => {};
    this.disconnect = () => {};
  }
  page.context = vm.createContext({
    window,
    document,
    globalThis: window,
    crypto: globalThis.crypto,
    MutationObserver,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    Date,
  });
  return page;
}

function followFake(): {
  cdp: CdpSocket;
  pages: Page[];
  dropped: string[];
  log: string[];
} {
  const pages: Page[] = [];
  const sessions: string[] = [];
  const apis = new Map<string, { page: Page; api: { apply(view: OverlayView): void; dispose(): void } }>();
  const dropped: string[] = [];
  const log: string[] = [];
  let seq = 0;
  const send = async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
    if (method === "Target.attachToTarget") {
      const session = `s-${++seq}`;
      sessions.push(session);
      pages.push(makePage());
      return { sessionId: session };
    }
    if (method === "Target.detachFromTarget") {
      log.push("detach");
      return {};
    }
    if (method === "Target.getTargets") return { targetInfos: [] };
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame" } } };
    if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "script" };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
    if (method === "Page.removeScriptToEvaluateOnNewDocument") return {};
    const page = pages[sessions.indexOf(sessionId ?? "")];
    if (method === "Runtime.evaluate") {
      const api = vm.runInContext(String(params?.expression ?? ""), page.context) as { apply(view: OverlayView): void; dispose(): void };
      const objectId = `obj-${++seq}`;
      apis.set(objectId, { page, api });
      return { result: { objectId } };
    }
    if (method === "Runtime.callFunctionOn") {
      const found = apis.get(String(params?.objectId ?? ""));
      const name = /this\.(\w+)\(/.exec(String(params?.functionDeclaration ?? ""))?.[1];
      const arg = (params?.arguments as { value?: OverlayView }[] | undefined)?.[0]?.value;
      if (!found || !name) return { result: {} };
      if (name === "apply" && arg) {
        found.api.apply(arg);
        found.page.applies.push(arg);
      } else if (name === "dispose") {
        log.push("dispose");
        found.api.dispose();
      } else {
        (found.api as unknown as Record<string, (value?: OverlayView) => void>)[name]?.(arg);
      }
      return { result: {} };
    }
    return {};
  };
  const cdp = {
    send,
    on: (method: string, sessionId?: string) => {
      const id = `${method}:${sessionId ?? ""}`;
      return () => { dropped.push(id); };
    },
  } as unknown as CdpSocket;
  return { cdp, pages, dropped, log };
}

test("following another tab retires the old shield and keeps the run chart", async () => {
  const fake = followFake();
  const takeover = new Takeover({ quiet: true, heartbeatMs: 0, finishHoldMs: 0 });
  try {
    await takeover.attachShared(fake.cdp, "tab-a");
    await takeover.activityLine("Clicking Add to cart");
    const old = fake.pages[0];
    assert.equal(old.host?.isConnected, true);
    assert.ok(old.listeners.length > 0);
    await takeover.follow("tab-b");
    const next = fake.pages[1];
    assert.equal(old.host?.isConnected, false);
    assert.equal(old.listeners.length, 0);
    assert.equal(old.documentListeners.length, 0);
    assert.ok(fake.log.indexOf("dispose") >= 0 && fake.log.indexOf("dispose") < fake.log.indexOf("detach"));
    assert.equal(fake.dropped.filter((id) => id.endsWith(":s-1")).length, 1);
    assert.equal(fake.dropped.filter((id) => id.endsWith(":s-2")).length, 0);
    assert.equal(next.applies.at(-1)?.phase, "working");
    assert.equal(next.applies.at(-1)?.activity, "Clicking Add to cart");
    await takeover.activityLine("still on this run");
    assert.equal(next.applies.at(-1)?.activity, "still on this run");
    assert.equal(next.host?.isConnected, true);
  } finally {
    await takeover.dispose();
  }
});
