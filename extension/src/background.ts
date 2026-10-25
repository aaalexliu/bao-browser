// Manifest V3 service worker. An open native port keeps it alive.
// A command is stored before it runs. If the worker dies mid-command, the next
// start reports that step as failed and does not run it again.

import { hostGrantMessage, hostGrantWait, specificHost } from "./host-grant";

const HOST = "com.bao.desktop";

export {};

interface Persist {
  phase: "idle" | "recording" | "replaying";
  tabId?: number;
  windowId?: number;
  dialogs?: boolean;
  origin?: string;
}

interface StoredCmd {
  id: string;
  op: string;
  state: "started" | "done";
  ok?: boolean;
  value?: unknown;
  error?: string;
}

interface HarHeader {
  name: string;
  value: string;
}

interface HarEntry {
  url: string;
  method: string;
  status?: number;
  requestHeaders: HarHeader[];
  responseHeaders: HarHeader[];
  tabId: number;
}

interface InflightMeta {
  at: number;
  type: string;
  tabId: number;
}

let port: chrome.runtime.Port | null = null;
let persist: Persist = { phase: "idle" };
let watchAll = false;
const har: HarEntry[] = [];
const inflight = new Map<string, HarEntry>();
const inflightMeta = new Map<string, InflightMeta>();
const observed: Record<string, unknown>[] = [];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadPersist(): Promise<void> {
  const stored = await chrome.storage.local.get("bao-persist");
  const value = stored["bao-persist"] as Persist | undefined;
  if (value && value.phase) persist = value;
}

async function savePersist(): Promise<void> {
  await chrome.storage.local.set({ "bao-persist": persist });
}

async function badge(text: string): Promise<void> {
  await chrome.action.setBadgeText({ text: text.slice(0, 4) });
  if (!text) return;
  await chrome.action.setBadgeBackgroundColor({ color: text === "REC" ? "#9f1239" : "#1d4ed8" });
  await chrome.action.setTitle({ title: text === "REC" ? "Bao is recording" : "Bao is replaying" });
}

function post(message: unknown): void {
  try {
    port?.postMessage(message);
  } catch {
    /* the host is gone; the desktop sees the drop */
  }
}

function originPattern(url: string): string {
  const parsed = new URL(url);
  const portPart = parsed.port ? `:${parsed.port}` : "";
  return `${parsed.protocol}//${parsed.hostname}${portPart}/*`;
}

async function allowed(url: string): Promise<void> {
  const pattern = originPattern(url);
  const ok = await chrome.permissions.contains({ origins: [pattern] });
  if (!ok) throw new Error(`site not allowed: ${pattern}`);
}

async function registerScripts(origin: string, opts: { recorder: boolean; dialogs: boolean }): Promise<void> {
  const matches = [`${origin}/*`];
  await registerMatches(matches, opts);
}

/** Observer only. No recorder, no dialog patch, no badge. */
async function registerObserver(patterns: string[]): Promise<void> {
  await registerMatches(patterns, { recorder: false, dialogs: false });
}

async function clearBaoScripts(): Promise<void> {
  // unregisterContentScripts rejects the whole call if any id is unknown, and then removes nothing.
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const ids = existing.map((script) => script.id).filter((id) => id.startsWith("bao-"));
  if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });
}

async function registerMatches(matches: string[], opts: { recorder: boolean; dialogs: boolean }): Promise<void> {
  await clearBaoScripts();
  if (!matches.length) return;
  await chrome.scripting.registerContentScripts([{
    id: "bao-actions",
    js: ["content.js"],
    matches,
    runAt: "document_start",
    persistAcrossSessions: false,
  }]);
  if (opts.recorder) {
    await chrome.scripting.registerContentScripts([{
      id: "bao-recorder",
      js: ["recorder.js"],
      matches,
      runAt: "document_start",
      world: "MAIN",
      persistAcrossSessions: false,
    }]);
  }
  if (opts.dialogs) {
    await chrome.scripting.registerContentScripts([{
      id: "bao-dialogs",
      js: ["dialogs.js"],
      matches,
      runAt: "document_start",
      world: "MAIN",
      persistAcrossSessions: false,
    }]);
  }
}

function waitComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let sawLoading = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      setTimeout(resolve, 180);
    };
    const onUpdated = (id: number, info: { status?: string }) => {
      if (id !== tabId) return;
      if (info.status === "loading") sawLoading = true;
      if (info.status === "complete" && sawLoading) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function sendTab(tabId: number, message: Record<string, unknown>, timeoutMs = 15000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("tab message timed out")), timeoutMs);
    chrome.tabs.sendMessage(tabId, message, (response) => {
      clearTimeout(timer);
      const err = chrome.runtime.lastError;
      if (!err) {
        resolve((response || {}) as Record<string, unknown>);
        return;
      }
      chrome.tabs.get(tabId).then(
        (tab) => reject(new Error(`${err.message || "tab closed"} (${tab.url || "no-url"})`)),
        () => reject(new Error(err.message || "tab closed")),
      );
    });
  });
}

async function ownedTab(): Promise<number> {
  if (!persist.tabId) throw new Error("replay tab is gone");
  const tab = await chrome.tabs.get(persist.tabId).catch(() => undefined);
  if (!tab) throw new Error("replay tab is gone");
  return tab.id!;
}

async function ensureInjected(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }).catch(() => undefined);
}

const RETRY_AFTER_NAV = new Set([
  "tree", "text", "captureStep", "markers", "metrics", "flush-events", "box", "point",
  "readList", "propose", "file-name", "showAsk", "clearAsk", "commit", "select-all",
  "last-trust", "gesture", "mask", "unmask", "dismiss",
  "field-state", "mark-focus", "clear-focus", "arm-click", "disarm-click",
]);

async function withTab(message: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
  const tabId = await ownedTab();
  try {
    const result = await sendTab(tabId, message, timeoutMs);
    if (result.ok === false) throw new Error(String(result.error || "page command failed"));
    return result;
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (!/Receiving end does not exist|message port closed|back\/forward cache|tab was closed/i.test(text)) throw err;
    await waitComplete(tabId, 15000);
    await ensureInjected(tabId);
    const op = String(message.op || "");
    // A click that navigated must not be sent again. A read after that navigation should.
    if (!RETRY_AFTER_NAV.has(op)) return { ok: true, navigated: true };
    const again = await sendTab(tabId, message, timeoutMs);
    if (again.ok === false) throw new Error(String(again.error || "page command failed"));
    return again;
  }
}

async function openOwned(url: string, dialogs: boolean, inject: boolean): Promise<Record<string, unknown>> {
  const origin = new URL(url).origin;
  let tabId = persist.tabId;
  let windowId = persist.windowId;
  const existing = tabId ? await chrome.tabs.get(tabId).catch(() => undefined) : undefined;
  if (!existing) {
    const win = await chrome.windows.create({ url: "about:blank", focused: true, type: "normal" });
    tabId = win?.tabs?.[0]?.id;
    windowId = win?.id;
    if (!tabId || windowId == null) throw new Error("could not open a replay window");
  }
  // The document request fires during tabs.update. Own the tab first so HAR sees it.
  persist = { ...persist, tabId, windowId, dialogs, origin };
  if (inject) await registerScripts(origin, { recorder: persist.phase === "recording", dialogs });
  else await clearBaoScripts();
  const pending = waitComplete(tabId!, 30000);
  await chrome.tabs.update(tabId!, { url, active: true });
  if (windowId != null) await chrome.windows.update(windowId, { focused: true }).catch(() => undefined);
  await pending;
  if (inject) await ensureInjected(tabId!);
  persist = { phase: persist.phase === "recording" ? "recording" : "replaying", tabId, windowId, dialogs, origin };
  if (dialogs) await ensureDialogs(tabId!);
  await savePersist();
  if (persist.phase === "replaying") await badge("RUN");
  const tab = await chrome.tabs.get(tabId!);
  return { ok: true, tabId, url: tab.url || url };
}

const debuggerTabs = new Set<number>();

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) debuggerTabs.delete(source.tabId);
});

async function attachDebugger(tabId: number): Promise<void> {
  if (debuggerTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/already attached/i.test(message)) throw err;
  }
  debuggerTabs.add(tabId);
}

async function detachDebugger(tabId: number): Promise<void> {
  debuggerTabs.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => undefined);
}

/** Attach for one action and detach when it finishes. A caller that already attached keeps the session. */
async function withDebugger<T>(tabId: number, run: () => Promise<T>): Promise<T> {
  const held = debuggerTabs.has(tabId);
  if (!held) await attachDebugger(tabId);
  try {
    return await run();
  } finally {
    if (!held) await detachDebugger(tabId);
  }
}

async function ensureDialogs(tabId: number): Promise<void> {
  if (!persist.dialogs) return;
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["dialogs.js"],
    world: "MAIN",
  }).catch(() => undefined);
}

async function mouseClick(tabId: number, x: number, y: number): Promise<void> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("no point for the click");
  const point = { x, y };
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1,
  });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
    type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1,
  });
}

interface KeySpec {
  key: string;
  code: string;
  vk: number;
  text?: string;
  modifiers?: number;
}

async function dispatchKey(tabId: number, type: "keyDown" | "keyUp", spec: KeySpec): Promise<void> {
  const payload: Record<string, unknown> = {
    type,
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk,
    modifiers: spec.modifiers || 0,
  };
  if (type === "keyDown" && spec.text != null) {
    payload.text = spec.text;
    payload.unmodifiedText = spec.text;
  }
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", payload);
}

const NAMED_KEYS: Record<string, KeySpec> = {
  Enter: { key: "Enter", code: "Enter", vk: 13 },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  Home: { key: "Home", code: "Home", vk: 36 },
  End: { key: "End", code: "End", vk: 35 },
  " ": { key: " ", code: "Space", vk: 32, text: " " },
};

function specForChar(ch: string): KeySpec {
  if (ch === "\n" || ch === "\r") return { key: "Enter", code: "Enter", vk: 13, text: "\r" };
  const named = NAMED_KEYS[ch];
  if (named) return { ...named, text: named.text ?? ch };
  if (/^[a-zA-Z]$/.test(ch)) {
    const upper = ch !== ch.toLowerCase();
    return { key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), text: ch, modifiers: upper ? 8 : 0 };
  }
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, vk: ch.charCodeAt(0), text: ch };
  return { key: ch, code: "", vk: ch.charCodeAt(0), text: ch };
}

async function typeChar(tabId: number, ch: string): Promise<void> {
  const spec = specForChar(ch);
  await dispatchKey(tabId, "keyDown", spec);
  await dispatchKey(tabId, "keyUp", { key: spec.key, code: spec.code, vk: spec.vk, modifiers: spec.modifiers });
}

async function pressNamed(tabId: number, key: string): Promise<void> {
  const parts = key.split("+").map((part) => part.trim()).filter(Boolean);
  let modifiers = 0;
  const names: string[] = [];
  for (const part of parts) {
    const low = part.toLowerCase();
    if (low === "ctrl" || low === "control") modifiers |= 2;
    else if (low === "cmd" || low === "meta" || low === "command") modifiers |= 4;
    else if (low === "alt" || low === "option") modifiers |= 1;
    else if (low === "shift") modifiers |= 8;
    else names.push(part);
  }
  const last = names[0] || "Enter";
  const base = NAMED_KEYS[last] || (last.length === 1 ? specForChar(last) : NAMED_KEYS.Enter!);
  const spec: KeySpec = { key: base.key, code: base.code, vk: base.vk, modifiers };
  if (!modifiers && base.text) spec.text = base.text;
  await dispatchKey(tabId, "keyDown", spec);
  await dispatchKey(tabId, "keyUp", { key: spec.key, code: spec.code, vk: spec.vk, modifiers });
}

async function focusTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab) return;
  if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
}

/** Resolves once a load starts, or after `ms` if the click stayed on this document. */
function watchNavigation(tabId: number, ms = 1000): Promise<"done" | "loading" | "none"> {
  return new Promise((resolve) => {
    let loading = false;
    let settled = false;
    const finish = (value: "done" | "loading" | "none") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(value);
    };
    const timer = setTimeout(() => finish(loading ? "loading" : "none"), ms);
    const onUpdated = (id: number, info: { status?: string }) => {
      if (id !== tabId || !info.status) return;
      if (info.status === "loading") loading = true;
      if (info.status === "complete" && loading) finish("done");
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

function waitNextComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      setTimeout(resolve, 120);
    };
    const timer = setTimeout(finish, timeoutMs);
    const onUpdated = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function focusMarked(tabId: number): Promise<boolean> {
  try {
    await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument", { depth: -1, pierce: true });
    const search = await chrome.debugger.sendCommand({ tabId }, "DOM.performSearch", { query: "[data-bao-focus]" }) as { searchId?: string; resultCount?: number };
    if (!search.searchId || !search.resultCount) return false;
    const found = await chrome.debugger.sendCommand({ tabId }, "DOM.getSearchResults", {
      searchId: search.searchId,
      fromIndex: 0,
      toIndex: 1,
    }) as { nodeIds?: number[] };
    await chrome.debugger.sendCommand({ tabId }, "DOM.discardSearchResults", { searchId: search.searchId }).catch(() => undefined);
    const nodeId = found.nodeIds?.[0] || 0;
    if (!nodeId) return false;
    await chrome.debugger.sendCommand({ tabId }, "DOM.focus", { nodeId });
    return true;
  } catch {
    return false;
  }
}

/** Dispatch change in the page world so the recorder, which runs there, sees a select.
 * The chosen option is held: shop-detail writes the quantity back to 1 on a
 * microtask when the item loads, and that assignment has to keep the workflow's option.
 */
async function pageChange(tabId: number, wanted = ""): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [wanted],
    func: (wanted: string) => {
      const walk = (root: ParentNode): Element | null => {
        const hit = root.querySelector?.("[data-bao-focus]");
        if (hit) return hit;
        const nodes = root.querySelectorAll?.("*");
        if (!nodes) return null;
        for (const el of nodes) {
          if (!el.shadowRoot) continue;
          const inner = walk(el.shadowRoot);
          if (inner) return inner;
        }
        return null;
      };
      const el = walk(document);
      if (!el) return;
      if (el instanceof HTMLSelectElement) {
        const options = Array.from(el.options);
        const option = options.find((item) => item.label === wanted || item.text === wanted)
          || options.find((item) => item.value === wanted);
        const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
        const held = option ? option.value : el.value;
        if (proto && proto.get && proto.set) {
          proto.set.call(el, held);
          const node = el as HTMLSelectElement & { __baoHold?: number };
          if (node.__baoHold) window.clearTimeout(node.__baoHold);
          const restore = proto.set;
          Object.defineProperty(el, "value", {
            configurable: true,
            enumerable: true,
            get() { return proto.get!.call(this); },
            set(_next: string) { restore.call(this, held); },
          });
          node.__baoHold = window.setTimeout(() => {
            window.clearTimeout(node.__baoHold);
            delete node.__baoHold;
            Reflect.deleteProperty(el, "value");
          }, 15000);
        } else if (option) {
          el.value = option.value;
          option.selected = true;
        }
      }
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      el.removeAttribute("data-bao-focus");
    },
  }).catch(() => undefined);
}

function pendingData(tabId: number): number {
  const now = Date.now();
  let count = 0;
  for (const meta of inflightMeta.values()) {
    if (meta.tabId !== tabId) continue;
    if (meta.type !== "xmlhttprequest" && meta.type !== "fetch") continue;
    if (now - meta.at > 8000) continue;
    count += 1;
  }
  return count;
}

// A click or select that lands while the page's own XHR is still applying
// reads the control before that response. Wait it out, then one task so the
// page's microtask (a select reset) runs before we set or click.
async function waitForQuiet(tabId: number): Promise<void> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (pendingData(tabId) === 0) {
      await delay(50);
      if (pendingData(tabId) === 0) return;
    } else {
      await delay(50);
    }
  }
}

function targetOf(cmd: Record<string, unknown>): Record<string, unknown> {
  return { handle: cmd.handle, identity: cmd.identity, selector: cmd.selector, text: cmd.text };
}

function usablePoint(point: Record<string, unknown>): boolean {
  return point.ok !== false && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y));
}

async function freshPoint(tabId: number, cmd: Record<string, unknown>, fallback: Record<string, unknown>): Promise<Record<string, unknown>> {
  let point = await sendTab(tabId, { ...targetOf(cmd), op: "point", skipGesture: true }).catch(() => fallback);
  if (!usablePoint(point)) point = fallback;
  if (point.covered !== true) return point;
  await sendTab(tabId, { op: "dismiss" }).catch(() => undefined);
  const again = await sendTab(tabId, { ...targetOf(cmd), op: "point", skipGesture: true }).catch(() => point);
  return usablePoint(again) ? again : point;
}

async function trustedClick(tabId: number, cmd: Record<string, unknown>, point: Record<string, unknown>): Promise<void> {
  if (String(point.tag || "") === "SELECT") return;
  await focusTab(tabId);
  await waitForQuiet(tabId);
  let watch: Promise<"done" | "loading" | "none"> = Promise.resolve("none");
  await withDebugger(tabId, async () => {
    const fresh = await freshPoint(tabId, cmd, point);
    if (String(fresh.tag || point.tag || "") === "SELECT") return;
    if (fresh.covered === true) {
      throw new Error(`click was covered (${String(fresh.hit || "nothing")} over ${String(fresh.tag || "target")})`);
    }
    watch = watchNavigation(tabId);
    await mouseClick(tabId, Number(fresh.x), Number(fresh.y));
  });
  const state = await watch;
  if (state === "loading") {
    await waitNextComplete(tabId, 15000);
    await ensureInjected(tabId);
    await ensureDialogs(tabId);
  }
}

async function backspace(tabId: number): Promise<void> {
  await dispatchKey(tabId, "keyDown", { key: "Backspace", code: "Backspace", vk: 8 });
  await dispatchKey(tabId, "keyUp", { key: "Backspace", code: "Backspace", vk: 8 });
}

async function typeText(tabId: number, text: string, gaps: number[], maxMs: number): Promise<void> {
  if (!gaps.length) {
    await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text });
    return;
  }
  for (let i = 0; i < text.length; i++) {
    if (i > 0) {
      const gap = gaps[i - 1] != null ? gaps[i - 1]! : gaps[gaps.length - 1]!;
      if (gap > 0) await delay(Math.min(gap, maxMs));
    }
    await typeChar(tabId, text[i] || "");
  }
}

async function trustedFill(tabId: number, cmd: Record<string, unknown>, point: Record<string, unknown>): Promise<void> {
  const text = String(cmd.text ?? "");
  const secret = cmd.secret === true;
  const { gaps, maxMs } = keyGapsOf(cmd);
  const target = targetOf(cmd);
  let landed = "";
  let focused = false;
  await focusTab(tabId);
  await withDebugger(tabId, async () => {
    try {
      for (let attempt = 0; attempt < 2 && landed !== text; attempt++) {
        await sendTab(tabId, { op: "arm-click" }).catch(() => undefined);
        const fresh = await freshPoint(tabId, cmd, point);
        if (String(fresh.tag || "") === "SELECT") return;
        if (fresh.covered !== true) await mouseClick(tabId, Number(fresh.x), Number(fresh.y));
        await sendTab(tabId, { op: "mark-focus", ...target });
        await focusMarked(tabId);
        await delay(30);
        const state = await sendTab(tabId, { op: "field-state", ...target });
        focused = state.focused === true;
        await sendTab(tabId, { op: "select-all", ...target }).catch(() => undefined);
        const current = String(state.value ?? "");
        // One Backspace deletes a selection in the focused field. Ctrl+A is
        // not used: without focus it selects the page and Backspace leaves it.
        if (focused && current && current !== text) await backspace(tabId);
        if (text) {
          if (attempt === 0) await typeText(tabId, text, gaps, maxMs);
          else for (const ch of text) await typeChar(tabId, ch);
        }
        await delay(40);
        const after = await sendTab(tabId, { op: "field-state", ...target });
        landed = String(after.value ?? "");
        focused = after.focused === true || focused;
      }
    } finally {
      await sendTab(tabId, { op: "disarm-click" }).catch(() => undefined);
      await sendTab(tabId, { op: "clear-focus" }).catch(() => undefined);
    }
  });
  if (landed !== text) {
    const got = secret ? `${landed.length} chars` : JSON.stringify(landed).slice(0, 48);
    throw new Error(`typed text did not land (wanted ${text.length}, got ${got}, focused ${focused})`);
  }
  await withTab({ op: "commit", ...target, flush: true }).catch(() => undefined);
}

function keyGapsOf(cmd: Record<string, unknown>): { gaps: number[]; maxMs: number } {
  const gesture = cmd.gesture;
  if (!gesture || typeof gesture !== "object") return { gaps: [], maxMs: Number.POSITIVE_INFINITY };
  const record = gesture as { keyGaps?: unknown; maxMs?: unknown };
  const gaps = Array.isArray(record.keyGaps) ? record.keyGaps.map((item) => Number(item)).filter((item) => Number.isFinite(item)) : [];
  const max = Number(record.maxMs);
  return { gaps, maxMs: max > 0 ? max : Number.POSITIVE_INFINITY };
}

async function setFiles(tabId: number, paths: string[], selector?: string): Promise<void> {
  await withDebugger(tabId, async () => {
    await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument", { depth: -1, pierce: true });
    const queries = ["[data-bao-file]"];
    if (selector) queries.push(selector);
    let nodeId = 0;
    for (const query of queries) {
      const search = await chrome.debugger.sendCommand({ tabId }, "DOM.performSearch", { query }) as { searchId: string; resultCount?: number };
      if (!search.resultCount) continue;
      const found = await chrome.debugger.sendCommand({ tabId }, "DOM.getSearchResults", {
        searchId: search.searchId,
        fromIndex: 0,
        toIndex: 1,
      }) as { nodeIds?: number[] };
      nodeId = found.nodeIds?.[0] || 0;
      if (nodeId) break;
    }
    if (!nodeId) throw new Error("file input missing");
    await chrome.debugger.sendCommand({ tabId }, "DOM.setFileInputFiles", { nodeId, files: paths });
  });
}

function watching(tabId: number): boolean {
  if (tabId < 0) return false;
  if (watchAll) return true;
  return tabId === persist.tabId;
}

const onSend: Parameters<typeof chrome.webRequest.onBeforeSendHeaders.addListener>[0] = (details) => {
  if (!watching(details.tabId)) return;
  inflightMeta.set(details.requestId, { at: Date.now(), type: details.type, tabId: details.tabId });
  inflight.set(details.requestId, {
    url: details.url,
    method: details.method,
    requestHeaders: (details.requestHeaders || []).map((header) => ({ name: header.name, value: header.value || "" })),
    responseHeaders: [],
    tabId: details.tabId,
  });
};

const onDone: Parameters<typeof chrome.webRequest.onCompleted.addListener>[0] = (details) => {
  inflightMeta.delete(details.requestId);
  const entry = inflight.get(details.requestId);
  if (!entry) return;
  entry.status = details.statusCode;
  entry.responseHeaders = (details.responseHeaders || []).map((header) => ({ name: header.name, value: header.value || "" }));
  inflight.delete(details.requestId);
  har.push(entry);
  if (har.length > 240) har.shift();
};

const onFail: Parameters<typeof chrome.webRequest.onErrorOccurred.addListener>[0] = (details) => {
  inflightMeta.delete(details.requestId);
  inflight.delete(details.requestId);
};

// webRequest throws until a host permission is actually held. Never pass <all_urls>.
// Listen only on origins contains() has confirmed, and drop them again on revoke.

const WILDCARDS = ["http://*/*", "https://*/*"];
let networkUrls: string[] | null = null;
let networkChain: Promise<void> = Promise.resolve();
const pinnedOrigins: string[] = [];
let prompting: string | null = null;

function listenPattern(origin: string): string | null {
  if (specificHost(origin)) return origin;
  if (WILDCARDS.includes(origin)) return origin;
  try {
    const base = origin.endsWith("/*") ? origin.slice(0, -1) : origin;
    const url = new URL(base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || url.hostname.includes("*")) return null;
    return `${url.protocol}//${url.host}/*`;
  } catch {
    return null;
  }
}

async function containsOrigin(origin: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

function pinOrigin(pattern: string): void {
  if (!pinnedOrigins.includes(pattern)) pinnedOrigins.push(pattern);
}

async function grantedListenUrls(): Promise<string[] | null> {
  const held: string[] = [];
  for (const origin of WILDCARDS) {
    if (await containsOrigin(origin)) held.push(origin);
  }
  let listed: string[] = [];
  try {
    const all = await chrome.permissions.getAll();
    listed = all.origins || [];
  } catch {
    listed = [];
  }
  const candidates = [...new Set(
    [...listed, ...pinnedOrigins].map((origin) => listenPattern(origin)).filter((origin): origin is string => !!origin),
  )];
  for (const origin of candidates) {
    if (held.includes(origin)) continue;
    if (WILDCARDS.includes(origin)) continue;
    if (await containsOrigin(origin)) held.push(origin);
  }
  for (let i = pinnedOrigins.length - 1; i >= 0; i--) {
    if (!held.includes(pinnedOrigins[i]!)) pinnedOrigins.splice(i, 1);
  }
  held.sort();
  return held.length ? held : null;
}

function safeAdd(run: () => void): boolean {
  try {
    run();
  } catch {
    return false;
  }
  return !chrome.runtime.lastError?.message;
}

function detachNetwork(): void {
  try { chrome.webRequest.onBeforeSendHeaders.removeListener(onSend); } catch { /* not registered */ }
  try { chrome.webRequest.onCompleted.removeListener(onDone); } catch { /* not registered */ }
  try { chrome.webRequest.onErrorOccurred.removeListener(onFail); } catch { /* not registered */ }
  networkUrls = null;
}

function listenersAttached(): boolean {
  return chrome.webRequest.onBeforeSendHeaders.hasListener(onSend)
    && chrome.webRequest.onCompleted.hasListener(onDone)
    && chrome.webRequest.onErrorOccurred.hasListener(onFail);
}

function sameUrls(left: string[] | null, right: string[]): boolean {
  if (!left || left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

function tryListen(urls: string[], extra: boolean): boolean {
  const filter: chrome.webRequest.RequestFilter = { urls };
  const send: chrome.webRequest.OnBeforeSendHeadersOptions[] = extra
    ? ["requestHeaders", "extraHeaders"]
    : ["requestHeaders"];
  const done: chrome.webRequest.OnCompletedOptions[] = extra
    ? ["responseHeaders", "extraHeaders"]
    : ["responseHeaders"];
  if (!safeAdd(() => chrome.webRequest.onBeforeSendHeaders.addListener(onSend, filter, send))) return false;
  if (!safeAdd(() => chrome.webRequest.onCompleted.addListener(onDone, filter, done))) return false;
  if (!safeAdd(() => chrome.webRequest.onErrorOccurred.addListener(onFail, filter))) return false;
  return listenersAttached();
}

function attachNetwork(urls: string[]): boolean {
  const safe = urls.filter((url) => url !== "<all_urls>" && url !== "*://*/*");
  if (!safe.length) {
    detachNetwork();
    return false;
  }
  detachNetwork();
  if (tryListen(safe, true)) {
    networkUrls = safe.slice();
    return true;
  }
  detachNetwork();
  if (tryListen(safe, false)) {
    networkUrls = safe.slice();
    return true;
  }
  detachNetwork();
  return false;
}

async function reconcileNetwork(): Promise<void> {
  try {
    const urls = await grantedListenUrls();
    if (!urls) {
      detachNetwork();
      return;
    }
    if (sameUrls(networkUrls, urls) && listenersAttached()) return;
    attachNetwork(urls);
  } catch {
    detachNetwork();
  }
}

function syncNetwork(): Promise<void> {
  const run = networkChain.then(() => reconcileNetwork());
  networkChain = run.then(() => undefined, () => undefined);
  return run;
}

type GrantOutcome = "yes" | "no" | "timeout";

function waitForHost(pattern: string, grantMs: number): Promise<GrantOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    let poll: ReturnType<typeof setInterval>;
    const finish = (outcome: GrantOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      chrome.permissions.onAdded.removeListener(onAdded);
      chrome.runtime.onMessage.removeListener(onAllow);
      resolve(outcome);
    };
    const onAdded = (permissions: chrome.permissions.Permissions) => {
      const origins = permissions.origins || [];
      if (origins.includes(pattern)) {
        finish("yes");
        return;
      }
      void containsOrigin(pattern).then((ok) => { if (ok) finish("yes"); });
    };
    const onAllow = (message: { source?: string; granted?: boolean; origins?: string[] }) => {
      if (!message || message.source !== "bao-allow") return;
      const origins = Array.isArray(message.origins) ? message.origins : [];
      if (origins.length && !origins.includes(pattern)) return;
      finish(message.granted ? "yes" : "no");
    };
    chrome.permissions.onAdded.addListener(onAdded);
    chrome.runtime.onMessage.addListener(onAllow);
    poll = setInterval(() => {
      void containsOrigin(pattern).then((ok) => { if (ok) finish("yes"); });
    }, 250);
    timer = setTimeout(() => finish("timeout"), grantMs);
    void containsOrigin(pattern).then((ok) => { if (ok) finish("yes"); });
  });
}

async function promptSpecificHost(
  pattern: string,
  grantMs: number,
): Promise<{ ok: true } | { needsHuman: true; pattern: string; message: string }> {
  if (grantMs <= 0) return { needsHuman: true, pattern, message: hostGrantMessage(pattern, "timeout") };
  const page = `${chrome.runtime.getURL("allow.html")}?origins=${encodeURIComponent(pattern)}`;
  prompting = page;
  let windowId: number | undefined;
  try {
    try {
      const win = await chrome.windows.create({ url: page, type: "popup", focused: true, width: 520, height: 420 });
      windowId = win?.id;
    } catch {
      const win = await chrome.windows.create({ url: page, type: "normal", focused: true, width: 520, height: 420 });
      windowId = win?.id;
    }
    const outcome = await waitForHost(pattern, grantMs);
    if (outcome === "yes") {
      pinOrigin(pattern);
      await syncNetwork();
      return { ok: true };
    }
    return {
      needsHuman: true,
      pattern,
      message: hostGrantMessage(pattern, outcome === "no" ? "denied" : "timeout"),
    };
  } catch {
    return { needsHuman: true, pattern, message: hostGrantMessage(pattern, "timeout") };
  } finally {
    prompting = null;
    if (windowId != null) await chrome.windows.remove(windowId).catch(() => undefined);
  }
}

async function ensureHost(
  url: string,
  grantMs: number,
): Promise<{ ok: true } | { needsHuman: true; pattern: string; message: string }> {
  const pattern = originPattern(url);
  if (!specificHost(pattern)) throw new Error("refusing a broad host permission");
  if (await containsOrigin(pattern)) {
    pinOrigin(pattern);
    await syncNetwork();
    return { ok: true };
  }
  return promptSpecificHost(pattern, grantMs);
}

function grantWaitMs(cmd: Record<string, unknown>): number {
  if (!Object.prototype.hasOwnProperty.call(cmd, "grantMs")) return hostGrantWait(undefined);
  return hostGrantWait(cmd.grantMs);
}

async function perform(cmd: { id: string; op: string } & Record<string, unknown>): Promise<unknown> {
  const op = cmd.op;
  if (op === "ping") return { ok: true, phase: persist.phase, tabId: persist.tabId || 0 };
  if (op === "drop-worker") {
    setTimeout(() => chrome.runtime.reload(), 300);
    return { dropped: true };
  }
  if (op === "stall-and-drop") {
    await chrome.storage.local.set({ "bao-cmd": { id: cmd.id, op, state: "started" } satisfies StoredCmd });
    setTimeout(() => chrome.runtime.reload(), 150);
    return new Promise(() => {});
  }
  if (op === "watch") {
    watchAll = cmd.all !== false;
    return { watchAll };
  }
  if (op === "observe") {
    watchAll = true;
    const patterns = Array.isArray(cmd.patterns) ? cmd.patterns.map((item) => String(item)) : [];
    await registerObserver(patterns);
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0];
    persist = { phase: "idle", tabId: tab?.id, windowId: tab?.windowId, dialogs: false, origin: persist.origin };
    await savePersist();
    await badge("");
    if (tab?.id) await ensureInjected(tab.id);
    return { ok: true, tabId: tab?.id || 0, url: tab?.url || "" };
  }
  if (op === "follow") {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0];
    if (!tab?.id) throw new Error("no active tab");
    persist = {
      ...persist,
      tabId: tab.id,
      windowId: tab.windowId,
      phase: persist.phase === "recording" ? "recording" : persist.phase,
    };
    await savePersist();
    if (tab.url && /^https?:/i.test(tab.url)) await ensureInjected(tab.id);
    return { ok: true, url: tab.url || "", tabId: tab.id };
  }
  if (op === "status") {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0];
    const text = await chrome.action.getBadgeText({});
    return { ok: true, url: tab?.url || "", title: tab?.title || "", tabId: tab?.id || 0, phase: persist.phase, badge: text };
  }
  if (op === "read") {
    const active = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    const tabId = Number(cmd.tabId || persist.tabId || active?.id || 0);
    if (!tabId) throw new Error("no tab");
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const body = document.body;
        const text = body && body.innerText ? body.innerText.slice(0, 20000) : "";
        const strip = document.getElementById("bao-control-strip");
        const iframes: string[] = [];
        document.querySelectorAll("iframe").forEach((frame) => {
          const src = frame.getAttribute("src") || "";
          if (src) iframes.push(src.slice(0, 300));
        });
        const markers: string[] = [];
        document.querySelectorAll("[id], [class]").forEach((el) => {
          const blob = `${el.id} ${el.getAttribute("class") || ""}`.replace(/\s+/g, " ").trim();
          if (blob && /captcha|challenge|cf-|incapsula|imperva|turnstile/i.test(blob)) markers.push(blob.slice(0, 160));
        });
        return {
          title: document.title,
          url: location.href,
          text: strip ? `${strip.innerText || ""}\n${text}` : text,
          webdriver: navigator.webdriver === true,
          userAgent: navigator.userAgent,
          language: navigator.language,
          languages: navigator.languages.join(","),
          hardwareConcurrency: navigator.hardwareConcurrency,
          platform: navigator.platform,
          innerHeight: window.innerHeight,
          outerHeight: window.outerHeight,
          iframes: iframes.slice(0, 20),
          markers: markers.slice(0, 20),
        };
      },
    });
    return { ok: true, ...(injected?.result || {}) };
  }
  if (op === "dom-box") {
    const active = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    const tabId = Number(cmd.tabId || persist.tabId || active?.id || 0);
    if (!tabId) throw new Error("no tab");
    const selector = String(cmd.selector || "");
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel: string) => {
        const el = document.querySelector(sel);
        if (!(el instanceof Element)) return { found: false };
        el.scrollIntoView({ block: "center", inline: "center" });
        const rect = el.getBoundingClientRect();
        const chromeY = Math.max(0, window.outerHeight - window.innerHeight);
        return {
          found: true,
          x: Math.round(window.screenX + rect.left + rect.width / 2),
          y: Math.round(window.screenY + chromeY + rect.top + rect.height / 2),
          url: location.href,
        };
      },
      args: [selector],
    });
    return { ok: true, ...(injected?.result || { found: false }) };
  }
  if (op === "shot-raw") {
    const active = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    const tabId = Number(cmd.tabId || persist.tabId || active?.id || 0);
    if (!tabId) throw new Error("no tab");
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
    await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
    try {
      const jpeg = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 60 });
      return { ok: true, jpeg };
    } catch (err) {
      return { ok: true, jpeg: "", error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (op === "flush-har") {
    const entries = har.slice();
    har.length = 0;
    return { entries };
  }
  if (op === "net-state") {
    return {
      listening: listenersAttached(),
      urls: networkUrls ? networkUrls.slice() : [],
      allowUrl: prompting || "",
    };
  }
  if (op === "flush-observed") {
    const events = observed.slice();
    return { events };
  }
  if (op === "badge") {
    await badge(String(cmd.text || ""));
    return { ok: true };
  }
  if (op === "disarm") {
    await chrome.scripting.unregisterContentScripts().catch(() => undefined);
    watchAll = false;
    persist = { phase: "idle" };
    await savePersist();
    await badge("");
    return { ok: true };
  }
  if (op === "end") {
    if (persist.tabId) await sendTab(persist.tabId, { op: "clearAsk" }).catch(() => undefined);
    if (persist.phase !== "recording") await badge("");
    if (persist.phase === "replaying") {
      persist = { ...persist, phase: "idle" };
      await savePersist();
    }
    return { ok: true };
  }
  if (op === "arm-record") {
    const url = String(cmd.url || "");
    await allowed(url);
    const origin = new URL(url).origin;
    persist = { ...persist, phase: "recording", origin, dialogs: cmd.dialogs === true };
    await savePersist();
    await registerScripts(origin, { recorder: true, dialogs: cmd.dialogs === true });
    await badge("REC");
    post({ type: "record-start", url });
    return { ok: true };
  }
  if (op === "open") {
    if (cmd.fresh === true && persist.tabId) {
      await chrome.tabs.remove(persist.tabId).catch(() => undefined);
      persist = { ...persist, tabId: undefined, windowId: undefined };
    }
    const gate = await ensureHost(String(cmd.url || ""), grantWaitMs(cmd));
    if ("needsHuman" in gate) return gate;
    if (persist.phase !== "recording") persist.phase = "replaying";
    return openOwned(String(cmd.url || ""), cmd.dialogs === true, cmd.inject !== false);
  }
  if (op === "goto") {
    const url = String(cmd.url || "");
    const gate = await ensureHost(url, grantWaitMs(cmd));
    if ("needsHuman" in gate) return gate;
    const tabId = await ownedTab();
    if (cmd.gesture) await sendTab(tabId, { op: "gesture", gesture: cmd.gesture }).catch(() => undefined);
    const origin = new URL(url).origin;
    if (persist.origin !== origin) {
      await registerScripts(origin, { recorder: persist.phase === "recording", dialogs: persist.dialogs === true });
    }
    const pending = waitComplete(tabId, 30000);
    await chrome.tabs.update(tabId, { url, active: true });
    await pending;
    await ensureInjected(tabId);
    await ensureDialogs(tabId);
    persist.origin = origin;
    await savePersist();
    const tab = await chrome.tabs.get(tabId);
    return { ok: true, url: tab.url || url };
  }
  if (op === "upload") {
    const tabId = await ownedTab();
    const files = Array.isArray(cmd.files) ? cmd.files as { name?: string; path?: string }[] : [];
    const paths = files.map((file) => file.path || "").filter(Boolean);
    await withTab({ op: "gesture", gesture: cmd.gesture });
    await withTab({ op: "mark-file", handle: cmd.handle, identity: cmd.identity, selector: cmd.selector });
    await setFiles(tabId, paths, typeof cmd.selector === "string" ? cmd.selector : undefined);
    const named = await withTab({ op: "file-name" });
    return { ok: true, name: named.name || files[0]?.name || "" };
  }
  if (op === "measure-debugger") {
    const tabId = await ownedTab();
    const raw = await sendTab(tabId, { op: "raw-click", selector: "#one" });
    const before = await sendTab(tabId, { op: "metrics" });
    await attachDebugger(tabId);
    const clicked = await sendTab(tabId, { op: "point", selector: "#two" });
    await mouseClick(tabId, Number(clicked.x), Number(clicked.y));
    const note = await sendTab(tabId, { op: "point", selector: "#note" });
    await mouseClick(tabId, Number(note.x), Number(note.y));
    await chrome.debugger.sendCommand({ tabId }, "Input.insertText", { text: "ab" });
    await delay(80);
    const trust = await sendTab(tabId, { op: "last-trust" });
    await delay(400);
    const after = await sendTab(tabId, { op: "metrics" });
    return {
      attached: true,
      before,
      after,
      webdriver: after.webdriver === true,
      innerDelta: Number(before.innerHeight || 0) - Number(after.innerHeight || 0),
      clickBefore: raw.isTrusted === true,
      clickAfter: trust.click === true,
      typeAfter: trust.input === true || trust.key === true,
    };
  }
  if (op === "detach-debugger") {
    if (persist.tabId) await detachDebugger(persist.tabId);
    return { attached: false };
  }
  if (op === "shot") {
    const tabId = await ownedTab();
    await sendTab(tabId, { op: "mask" }).catch(() => undefined);
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
      await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
      let jpeg = "";
      try {
        jpeg = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 40 });
      } catch {
        jpeg = "";
      }
      return { ok: true, jpeg };
    } finally {
      await sendTab(tabId, { op: "unmask" }).catch(() => undefined);
    }
  }
  if (op === "pageSignals") {
    const tabId = await ownedTab();
    const markers = await sendTab(tabId, { op: "markers" });
    const tab = await chrome.tabs.get(tabId);
    const cookies = tab.url ? await chrome.cookies.getAll({ url: tab.url }) : [];
    const responses = har.filter((entry) => entry.tabId === tabId).slice(-40).map((entry) => ({
      url: entry.url,
      method: entry.method,
      status: entry.status,
      headers: entry.responseHeaders,
    }));
    return {
      ...markers,
      cookies: cookies.map((cookie) => ({ name: cookie.name })),
      responses,
    };
  }
  if (op === "cookies") {
    const url = String(cmd.url || "");
    const list = await chrome.cookies.getAll({ url });
    return { cookies: list.map((cookie) => ({ name: cookie.name, value: cookie.value, domain: cookie.domain })) };
  }
  if (op === "clear-site") {
    const url = String(cmd.url || "");
    const host = new URL(url).hostname.replace(/^www\./, "");
    const all = await chrome.cookies.getAll({});
    let removed = 0;
    for (const cookie of all) {
      const domain = cookie.domain.replace(/^\./, "");
      if (domain !== host && !domain.endsWith(`.${host}`) && host !== domain) continue;
      const cookieUrl = `${cookie.secure ? "https" : "http"}://${domain}${cookie.path}`;
      const gone = await chrome.cookies.remove({ url: cookieUrl, name: cookie.name });
      if (gone) removed += 1;
    }
    const tabId = persist.tabId;
    if (tabId) {
      // The shop keeps its cart in an app-localstorage-document inside shadow DOM.
      // Clearing storage on the previous document loses to that element writing the
      // cart back as the next page loads, so the live element is zeroed too.
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          const wipe = (root: ParentNode) => {
            const nodes = root.querySelectorAll?.("*");
            if (!nodes) return;
            for (const el of nodes) {
              if (el.localName === "app-localstorage-document") {
                try { (el as { data?: unknown }).data = []; } catch { /* the element can reject the write */ }
              }
              if (el.shadowRoot) wipe(el.shadowRoot);
            }
          };
          try { wipe(document); } catch { /* the page can refuse the walk */ }
          try { localStorage.clear(); } catch { /* the page can refuse storage */ }
          try { sessionStorage.clear(); } catch { /* same */ }
        },
      }).catch(() => undefined);
    }
    return { removed };
  }
  if (op === "waitIdle") {
    const tabId = persist.tabId;
    if (tabId) await waitComplete(tabId, Number(cmd.timeoutMs || 4000));
    return { ok: true };
  }
  if (op === "click" || op === "drive-click") {
    const tabId = await ownedTab();
    await ensureDialogs(tabId);
    const point = await withTab({ ...cmd, op: "point" });
    if (point.skipClick === true || String(point.tag || "") === "SELECT") return { ok: true, trusted: String(point.tag || "") !== "SELECT", skipped: point.tag || true };
    await trustedClick(tabId, cmd, point);
    return { ok: true, trusted: true, covered: point.covered === true, hit: point.hit || "" };
  }
  if (op === "fill" || op === "drive-fill") {
    const tabId = await ownedTab();
    await ensureDialogs(tabId);
    const point = await withTab({ ...cmd, op: "point" });
    await trustedFill(tabId, cmd, point);
    return { ok: true, trusted: true };
  }
  if (op === "check") {
    const tabId = await ownedTab();
    await ensureDialogs(tabId);
    const point = await withTab({ ...cmd, op: "point", desiredChecked: cmd.checked === true });
    if (point.skipClick === true) return { ok: true, trusted: true, skipped: true };
    await trustedClick(tabId, cmd, point);
    return { ok: true, trusted: true };
  }
  if (op === "key") {
    const tabId = await ownedTab();
    await ensureDialogs(tabId);
    if (cmd.gesture) await withTab({ op: "gesture", gesture: cmd.gesture });
    await withDebugger(tabId, () => pressNamed(tabId, String(cmd.key || "Enter")));
    return { ok: true, trusted: true };
  }
  if (op === "select" || op === "drive-select") {
    const tabId = await ownedTab();
    await waitForQuiet(tabId);
    const result = await withTab(cmd);
    await pageChange(tabId, String(cmd.value ?? cmd.text ?? ""));
    return result;
  }
  if (op === "activate") {
    const tabId = await ownedTab();
    const marked = await withTab(cmd, 20000);
    if (marked.pendingClick === true) await trustedClick(tabId, cmd, marked);
    return marked;
  }
  const pageOps = new Set([
    "tree", "select", "focus", "readList",
    "showAsk", "clearAsk", "captureStep", "dismiss", "text", "box", "metrics", "flush-events",
    "drive-select", "propose", "gesture", "drop",
  ]);
  if (pageOps.has(op)) return withTab(cmd, op === "readList" ? 30000 : 20000);
  throw new Error(`unknown command ${op}`);
}

async function handleCommand(cmd: { id: string; op: string } & Record<string, unknown>): Promise<void> {
  const previous = await chrome.storage.local.get("bao-cmd");
  const stored = previous["bao-cmd"] as StoredCmd | undefined;
  if (stored && stored.id === cmd.id && stored.state === "done") {
    post({ type: "result", id: cmd.id, ok: stored.ok !== false, value: stored.value, error: stored.error });
    return;
  }
  if (cmd.op !== "stall-and-drop") {
    await chrome.storage.local.set({ "bao-cmd": { id: cmd.id, op: cmd.op, state: "started" } satisfies StoredCmd });
  }
  try {
    const value = await perform(cmd);
    if (cmd.op === "stall-and-drop") return;
    await chrome.storage.local.set({ "bao-cmd": { id: cmd.id, op: cmd.op, state: "done", ok: true, value } satisfies StoredCmd });
    post({ type: "result", id: cmd.id, ok: true, value });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await chrome.storage.local.set({ "bao-cmd": { id: cmd.id, op: cmd.op, state: "done", ok: false, error } satisfies StoredCmd });
    post({ type: "result", id: cmd.id, ok: false, error });
  }
}

async function resumeInterrupted(onlyId: string): Promise<void> {
  if (!onlyId) return;
  const previous = await chrome.storage.local.get("bao-cmd");
  const stored = previous["bao-cmd"] as StoredCmd | undefined;
  // A command that started after this boot has a different id. Do not fail that one.
  if (!stored || stored.id !== onlyId || stored.state !== "started") return;
  const error = "extension restarted during the step";
  await chrome.storage.local.set({ "bao-cmd": { ...stored, state: "done", ok: false, error } satisfies StoredCmd });
  post({ type: "result", id: stored.id, ok: false, error });
}

function connect(resumed: boolean): void {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (err) {
    void chrome.storage.local.set({ baoLinkError: err instanceof Error ? err.message : String(err) });
    return;
  }
  port.onMessage.addListener((message) => {
    const body = message as { type?: string; id?: string; op?: string };
    if (body?.type === "cmd" && body.id && body.op) {
      void handleCommand(body as { id: string; op: string } & Record<string, unknown>);
    }
  });
  port.onDisconnect.addListener(() => {
    const message = chrome.runtime.lastError?.message || "";
    void chrome.storage.local.set({ baoLinkError: message });
    port = null;
  });
  post({ type: "hello", extensionId: chrome.runtime.id, version: chrome.runtime.getManifest().version, resumed });
}

let booting = false;

async function boot(resumed: boolean): Promise<void> {
  if (booting || port) return;
  booting = true;
  try {
    await syncNetwork();
    await loadPersist();
    const previous = await chrome.storage.local.get("bao-cmd");
    const interrupted = previous["bao-cmd"] as StoredCmd | undefined;
    const interruptedId = interrupted?.state === "started" ? interrupted.id : "";
    const again = resumed || persist.phase !== "idle";
    for (let attempt = 0; attempt < 25 && !port; attempt++) {
      connect(again);
      await delay(200);
      if (port) break;
    }
    await resumeInterrupted(interruptedId);
  } finally {
    booting = false;
  }
}

chrome.runtime.onInstalled.addListener(() => { void boot(false); });
chrome.runtime.onStartup.addListener(() => { void boot(true); });
chrome.alarms.create("bao-link", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => { if (!port) void boot(true); });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const body = message as { source?: string; op?: string; event?: unknown; gesture?: unknown; url?: string };
  if (body?.source === "bao-trail") {
    post({ type: "trail", event: body.event, gesture: body.gesture });
    return;
  }
  if (body?.source === "bao-observe") {
    observed.push((body.event || {}) as Record<string, unknown>);
    if (observed.length > 2000) observed.shift();
    return;
  }
  if (body?.op === "popup-record") {
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url) throw new Error("no tab");
      await allowed(tab.url);
      persist = { phase: "recording", tabId: tab.id, windowId: tab.windowId, origin: new URL(tab.url).origin, dialogs: false };
      await savePersist();
      await registerScripts(persist.origin!, { recorder: true, dialogs: false });
      await ensureInjected(tab.id);
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["recorder.js"], world: "MAIN" }).catch(() => undefined);
      await badge("REC");
      post({ type: "record-start", url: tab.url, tabId: tab.id });
      sendResponse({ ok: true });
    })().catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }
  if (body?.op === "popup-stop") {
    post({ type: "record-stop", url: sender.tab?.url || "" });
    persist = { ...persist, phase: "idle" };
    void savePersist();
    void badge("");
    void chrome.scripting.unregisterContentScripts({ ids: ["bao-recorder"] }).catch(() => undefined);
    sendResponse({ ok: true });
    return;
  }
  if (body?.op === "popup-status") {
    sendResponse({
      ok: true,
      linked: !!port,
      phase: persist.phase,
      error: "",
      extensionId: chrome.runtime.id,
    });
    return;
  }
  return;
});

chrome.permissions.onAdded.addListener((permissions) => {
  if (permissions.origins?.length) void syncNetwork();
});
chrome.permissions.onRemoved.addListener((permissions) => {
  if (permissions.origins?.length) void syncNetwork();
});
void boot(false);
