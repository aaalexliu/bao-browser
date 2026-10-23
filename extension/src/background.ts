// Manifest V3 service worker. An open native port keeps it alive.
// A command is stored before it runs. If the worker dies mid-command, the next
// start reports that step as failed and does not run it again.

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

let port: chrome.runtime.Port | null = null;
let persist: Persist = { phase: "idle" };
let watchAll = false;
const har: HarEntry[] = [];
const inflight = new Map<string, HarEntry>();
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
    return { ok: true, navigated: true };
  }
}

async function openOwned(url: string, dialogs: boolean, inject: boolean): Promise<Record<string, unknown>> {
  await allowed(url);
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
  if (inject) await registerScripts(origin, { recorder: persist.phase === "recording", dialogs });
  else await clearBaoScripts();
  const pending = waitComplete(tabId!, 30000);
  await chrome.tabs.update(tabId!, { url, active: true });
  if (windowId != null) await chrome.windows.update(windowId, { focused: true }).catch(() => undefined);
  await pending;
  if (inject) await ensureInjected(tabId!);
  persist = { phase: persist.phase === "recording" ? "recording" : "replaying", tabId, windowId, dialogs, origin };
  await savePersist();
  if (persist.phase === "replaying") await badge("RUN");
  const tab = await chrome.tabs.get(tabId!);
  return { ok: true, tabId, url: tab.url || url };
}

async function setFiles(tabId: number, paths: string[]): Promise<void> {
  await chrome.debugger.attach({ tabId }, "1.3");
  try {
    await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument", { depth: -1, pierce: true });
    const search = await chrome.debugger.sendCommand({ tabId }, "DOM.performSearch", { query: "[data-bao-file]" }) as { searchId: string; resultCount?: number };
    const found = await chrome.debugger.sendCommand({ tabId }, "DOM.getSearchResults", {
      searchId: search.searchId,
      fromIndex: 0,
      toIndex: 1,
    }) as { nodeIds?: number[] };
    const nodeId = found.nodeIds?.[0];
    if (!nodeId) throw new Error("file input missing");
    await chrome.debugger.sendCommand({ tabId }, "DOM.setFileInputFiles", { nodeId, files: paths });
  } finally {
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
  }
}

function watching(tabId: number): boolean {
  if (tabId < 0) return false;
  if (watchAll) return true;
  return tabId === persist.tabId;
}

const onSend: Parameters<typeof chrome.webRequest.onBeforeSendHeaders.addListener>[0] = (details) => {
  if (!watching(details.tabId)) return;
  inflight.set(details.requestId, {
    url: details.url,
    method: details.method,
    requestHeaders: (details.requestHeaders || []).map((header) => ({ name: header.name, value: header.value || "" })),
    responseHeaders: [],
    tabId: details.tabId,
  });
};

const onDone: Parameters<typeof chrome.webRequest.onCompleted.addListener>[0] = (details) => {
  const entry = inflight.get(details.requestId);
  if (!entry) return;
  entry.status = details.statusCode;
  entry.responseHeaders = (details.responseHeaders || []).map((header) => ({ name: header.name, value: header.value || "" }));
  inflight.delete(details.requestId);
  har.push(entry);
  if (har.length > 240) har.shift();
};

function watchNetwork(): void {
  const filter: chrome.webRequest.RequestFilter = { urls: ["<all_urls>"] };
  const send = () => chrome.webRequest.onBeforeSendHeaders.addListener(onSend, filter, ["requestHeaders", "extraHeaders"]);
  const done = () => chrome.webRequest.onCompleted.addListener(onDone, filter, ["responseHeaders", "extraHeaders"]);
  try {
    send();
    done();
  } catch {
    chrome.webRequest.onBeforeSendHeaders.addListener(onSend, filter, ["requestHeaders"]);
    chrome.webRequest.onCompleted.addListener(onDone, filter, ["responseHeaders"]);
  }
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
    if (persist.phase !== "recording") persist.phase = "replaying";
    return openOwned(String(cmd.url || ""), cmd.dialogs === true, cmd.inject !== false);
  }
  if (op === "goto") {
    const url = String(cmd.url || "");
    await allowed(url);
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
    await setFiles(tabId, paths);
    const named = await withTab({ op: "file-name" });
    return { ok: true, name: named.name || files[0]?.name || "" };
  }
  if (op === "measure-debugger") {
    const tabId = await ownedTab();
    const before = await sendTab(tabId, { op: "metrics" });
    await chrome.debugger.attach({ tabId }, "1.3");
    await delay(500);
    const after = await sendTab(tabId, { op: "metrics" });
    return {
      attached: true,
      before,
      after,
      webdriver: after.webdriver === true,
      innerDelta: Number(before.innerHeight || 0) - Number(after.innerHeight || 0),
    };
  }
  if (op === "detach-debugger") {
    if (persist.tabId) await chrome.debugger.detach({ tabId: persist.tabId }).catch(() => undefined);
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
    const list = await chrome.cookies.getAll({ url });
    for (const cookie of list) await chrome.cookies.remove({ url, name: cookie.name });
    return { removed: list.length };
  }
  if (op === "waitIdle") {
    const tabId = persist.tabId;
    if (tabId) await waitComplete(tabId, Number(cmd.timeoutMs || 4000));
    return { ok: true };
  }
  const pageOps = new Set([
    "tree", "click", "fill", "select", "check", "key", "focus", "readList", "activate",
    "showAsk", "clearAsk", "captureStep", "dismiss", "text", "box", "metrics", "flush-events",
    "drive-click", "drive-fill", "drive-select", "propose", "gesture",
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

watchNetwork();
void boot(false);
