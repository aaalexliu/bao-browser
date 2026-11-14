// Uploads through a file chooser and downloads by click, on Bao's own CDP connection. The native CLI only clicks.

import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CdpSocket } from "../cdp-live/socket";
import type { AgentBrowserCommandResult } from "./agent-browser-proxy";

/** A download's result, and where its file came from when it saved one. */
export type DownloadOutcome = { result: AgentBrowserCommandResult; from?: { source: "download"; url?: string } | { source: "pdf-viewer"; url: string } | { source: "link"; url: string } };

type Click = () => Promise<AgentBrowserCommandResult>;

/** agent-browser 0.41.0's upload error for a selector that is not an `<input type=file>`. */
export const NOT_FILE_INPUT = /not a file input element/i;

const CHOOSER_MS = 10_000;
const START_MS = 30_000;
const FINISH_MS = 5 * 60_000;
const CHUNK = 8 * 1024 * 1024;

const failed = (message: string): AgentBrowserCommandResult => ({ stdout: "", stderr: `\u2717 ${message}\n`, exitCode: 1 });

/**
 * Clicks with Chrome's file chooser intercepted on Bao's session to the tab, then sets the files on the input that chooser
 * belongs to. No file panel opens, also for an input the page creates on click or hides behind a button or label.
 */
export async function uploadThroughChooser(cdp: CdpSocket, targetId: string, files: string[], click: Click): Promise<AgentBrowserCommandResult> {
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, undefined, 5000);
  let opened!: (backendNodeId: unknown) => void;
  const chooser = new Promise<unknown>((resolve) => { opened = resolve; });
  const stop = cdp.on("Page.fileChooserOpened", sessionId, (params) => opened(params.backendNodeId));
  try {
    await cdp.send("Page.enable", {}, sessionId, 5000);
    await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId, 5000);
    const clicked = await click();
    if (clicked.exitCode !== 0) return clicked;
    const backendNodeId = await Promise.race([chooser, delay(CHOOSER_MS, null)]);
    if (backendNodeId === null) return failed(`The click opened no file chooser within ${CHOOSER_MS / 1000} s. Target the upload button, its label, or the file input.`);
    if (typeof backendNodeId !== "number") return failed("Chrome's file chooser named no file input.");
    await cdp.send("DOM.setFileInputFiles", { files, backendNodeId }, sessionId, 10_000);
    return { stdout: `\u2713 Done: set ${files.length === 1 ? "the file" : `${files.length} files`} on the file chooser the click opened\n`, stderr: "", exitCode: 0 };
  } finally {
    stop();
    await cdp.send("Page.setInterceptFileChooserDialog", { enabled: false }, sessionId, 5000).catch(() => undefined);
    await cdp.send("Target.detachFromTarget", { sessionId }, undefined, 5000).catch(() => undefined);
  }
}

interface PageTarget { targetId: string; type: string; url: string; openerId?: string }

async function pages(cdp: CdpSocket): Promise<PageTarget[]> {
  const { targetInfos } = await cdp.send<{ targetInfos: PageTarget[] }>("Target.getTargets", {}, undefined, 5000);
  return targetInfos.filter((info) => info.type === "page");
}

async function inPage<T>(cdp: CdpSocket, targetId: string, expression: string, timeoutMs = 5000): Promise<T> {
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, undefined, timeoutMs);
  try {
    const { result, exceptionDetails } = await cdp.send<{ result: { value: T }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>(
      "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId, timeoutMs);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text ?? "page script failed");
    return result.value;
  } finally {
    await cdp.send("Target.detachFromTarget", { sessionId }, undefined, 5000).catch(() => undefined);
  }
}

/** The agent's tab after it left `before`, or a tab it opened, when Chrome shows a PDF there. */
async function pdfPage(cdp: CdpSocket, agentTab: string, before: { url: string; targets: ReadonlySet<string> }): Promise<PageTarget | undefined> {
  const candidates = (await pages(cdp)).filter((info) => /^https?:/i.test(info.url)
    && (info.targetId === agentTab ? info.url !== before.url : !before.targets.has(info.targetId) && info.openerId === agentTab));
  for (const info of candidates) {
    const type = await inPage<string>(cdp, info.targetId, "document.contentType", 2000).catch(() => undefined);
    if (type === "application/pdf") return info;
  }
  return undefined;
}

/** Writes base64 the page stashed on `key` to `file`, then drops that stash. */
async function writeStash(cdp: CdpSocket, targetId: string, file: string, key: string, total: number): Promise<void> {
  const parts: string[] = [];
  try {
    for (let at = 0; at < total; at += CHUNK) parts.push(await inPage<string>(cdp, targetId, `window[${JSON.stringify(key)}].slice(${at}, ${at + CHUNK})`, 30_000));
  } finally {
    await inPage(cdp, targetId, `delete window[${JSON.stringify(key)}]`).catch(() => undefined);
  }
  await writeFile(file, Buffer.from(parts.join(""), "base64"));
}

/** Fetches `url` in the page with the page's cookies. An HTML page is not the file unless it is an attachment or the link asked to download it. */
async function fetchLink(cdp: CdpSocket, targetId: string, file: string, url: string, download: boolean): Promise<{ kind: "file" } | { kind: "page" | "http"; url: string }> {
  const key = `__bao_file_${Date.now()}`;
  const fetched = await inPage<{ kind: "file"; total: number } | { kind: "page" | "http"; url: string }>(cdp, targetId, `(async () => {
    const response = await fetch(${JSON.stringify(url)}, { credentials: "include" });
    if (!response.ok) return { kind: "http", url: response.url };
    const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const disposition = (response.headers.get("content-disposition") || "").toLowerCase();
    if (!${download ? "true" : "false"} && type === "text/html" && !disposition.includes("attachment")) return { kind: "page", url: response.url };
    const blob = await response.blob();
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    window[${JSON.stringify(key)}] = String(data).slice(String(data).indexOf(",") + 1);
    return { kind: "file", total: window[${JSON.stringify(key)}].length };
  })()`, 60_000);
  if (fetched.kind !== "file") return fetched;
  await writeStash(cdp, targetId, file, key, fetched.total);
  return { kind: "file" };
}

/** Fetches the PDF a tab shows with the page's own cookies and writes it to `file`. Bytes cross CDP as base64 in chunks. */
async function savePdf(cdp: CdpSocket, targetId: string, file: string): Promise<void> {
  const key = `__bao_pdf_${Date.now()}`;
  const total = await inPage<number>(cdp, targetId, `(async () => {
    const response = await fetch(location.href, { credentials: "include" });
    if (!response.ok) throw new Error("the PDF fetch returned HTTP " + response.status);
    const blob = await response.blob();
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    window[${JSON.stringify(key)}] = String(data).slice(String(data).indexOf(",") + 1);
    return window[${JSON.stringify(key)}].length;
  })()`, 60_000);
  await writeStash(cdp, targetId, file, key, total);
}

/**
 * For this click only: page handlers run first. A bubble listener then cancels an http(s) link the handler left in place.
 * `window.open` is recorded and not called, so a handler popup does not open a tab. `TAKE_CLICK` restores both.
 */
const ARM_CLICK = `(() => {
  window.__baoPriorOpen = window.open;
  window.open = function(url) {
    let resolved;
    try { resolved = new URL(String(url == null ? "" : url), document.baseURI); } catch { resolved = undefined; }
    if (resolved && (resolved.protocol === "http:" || resolved.protocol === "https:")) window.__baoOpened = resolved.href;
    return null;
  };
  const finish = (event) => {
    if (event.defaultPrevented) return;
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    let link = null;
    for (const node of path) {
      if (node instanceof Element && node.matches("a[href]")) { link = node; break; }
    }
    if (!link) {
      const node = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
      link = node && node.closest ? node.closest("a[href]") : null;
    }
    if (!link) return;
    let url;
    try { url = new URL(link.href, location.href); } catch { return; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    event.preventDefault();
    window.__baoDownloadHref = url.href;
    window.__baoDownloadNamed = link.hasAttribute("download") && url.origin === location.origin;
  };
  const onSubmit = (event) => {
    if (event.defaultPrevented) return;
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const submitter = event.submitter;
    const target = (submitter && submitter.getAttribute("formtarget")) || form.getAttribute("target") || "";
    if (target !== "_blank") return;
    event.preventDefault();
    const method = ((submitter && submitter.getAttribute("formmethod")) || form.getAttribute("method") || "get").toLowerCase();
    if (method !== "get") return;
    try {
      const action = new URL(submitter && submitter.hasAttribute("formaction") ? submitter.formAction : form.action);
      action.search = new URLSearchParams(submitter ? new FormData(form, submitter) : new FormData(form)).toString();
      if (action.protocol === "http:" || action.protocol === "https:") window.__baoDownloadHref = action.href;
    } catch { return; }
  };
  window.__baoDownloadClick = finish;
  window.__baoDownloadSubmit = onSubmit;
  window.addEventListener("click", finish, false);
  window.addEventListener("submit", onSubmit, false);
})()`;

const TAKE_CLICK = `(() => {
  const click = window.__baoDownloadClick;
  const submit = window.__baoDownloadSubmit;
  if (typeof click === "function") window.removeEventListener("click", click, false);
  if (typeof submit === "function") window.removeEventListener("submit", submit, false);
  if (typeof window.__baoPriorOpen === "function") window.open = window.__baoPriorOpen;
  const href = typeof window.__baoDownloadHref === "string" ? window.__baoDownloadHref : "";
  const opened = typeof window.__baoOpened === "string" ? window.__baoOpened : "";
  const download = window.__baoDownloadNamed === true;
  delete window.__baoDownloadHref;
  delete window.__baoOpened;
  delete window.__baoDownloadNamed;
  delete window.__baoDownloadClick;
  delete window.__baoDownloadSubmit;
  delete window.__baoPriorOpen;
  return { href: href, opened: opened, download: download };
})()`;

function capturedClick(value: unknown): { url: string; download: boolean } {
  if (!value || typeof value !== "object") return { url: "", download: false };
  const record = value as { href?: unknown; opened?: unknown; download?: unknown };
  const opened = typeof record.opened === "string" ? record.opened : "";
  const href = typeof record.href === "string" ? record.href : "";
  return { url: opened || href, download: !opened && record.download === true };
}

async function closeOpened(cdp: CdpSocket, agentTab: string, before: { targets: ReadonlySet<string> }): Promise<void> {
  const opened = (await pages(cdp)).filter((info) => !before.targets.has(info.targetId) && info.openerId === agentTab);
  for (const info of opened) await cdp.send("Target.closeTarget", { targetId: info.targetId }, undefined, 5000).catch(() => undefined);
}

async function contextOf(cdp: CdpSocket, targetId: string): Promise<string | undefined> {
  const { targetInfo } = await cdp.send<{ targetInfo?: { browserContextId?: string } }>("Target.getTargetInfo", { targetId }, undefined, 5000);
  const id = targetInfo?.browserContextId;
  return typeof id === "string" && id ? id : undefined;
}

/** Opens `url` in `browserContextId` only after that context is confirmed. A blank tab is not a navigation. */
async function openBackground(cdp: CdpSocket, url: string, browserContextId: string): Promise<string | undefined> {
  let targetId: string;
  try {
    targetId = (await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: true, browserContextId }, undefined, 5000)).targetId;
  } catch {
    return undefined;
  }
  const close = () => cdp.send("Target.closeTarget", { targetId }, undefined, 5000).catch(() => undefined);
  try {
    if (await contextOf(cdp, targetId) !== browserContextId) {
      await close();
      return undefined;
    }
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, undefined, 5000);
    try {
      const navigated = await cdp.send<{ errorText?: string; isDownload?: boolean }>("Page.navigate", { url }, sessionId, 10_000);
      if (navigated.errorText && navigated.isDownload !== true) {
        await close();
        return undefined;
      }
    } finally {
      await cdp.send("Target.detachFromTarget", { sessionId }, undefined, 5000).catch(() => undefined);
    }
    return targetId;
  } catch {
    await close();
    return undefined;
  }
}

/**
 * Saves a file from a background tab: a download Chrome starts there, or a PDF that tab shows. The tab is not the agent's, and it was
 * not opened by the click, so the click's opener check does not see it.
 */
async function saveBackground(cdp: CdpSocket, targetId: string, saved: string, href: string, read: () => { guid?: string; url?: string }, states: ReadonlyMap<string, string>): Promise<DownloadOutcome | undefined> {
  const startBy = Date.now() + START_MS;
  while (Date.now() < startBy) {
    const guid = read().guid;
    if (guid) {
      const finishBy = Date.now() + FINISH_MS;
      while (!states.has(guid) && Date.now() < finishBy) await delay(100);
      const state = states.get(guid);
      if (state !== "completed") return { result: failed(state === "canceled" ? "Chrome canceled the download." : `The download did not finish within ${FINISH_MS / 60_000} minutes.`) };
      await rename(path.join(path.dirname(saved), guid), saved);
      return { result: { stdout: `\u2713 Download saved to ${saved}\n  Bao opened the link in a background tab and did not switch tabs (${href}).\n`, stderr: "", exitCode: 0 },
        from: { source: "download", url: read().url ?? href } };
    }
    const type = await inPage<string>(cdp, targetId, "document.contentType", 2000).catch(() => undefined);
    if (type === "application/pdf") {
      await savePdf(cdp, targetId, saved);
      return { result: { stdout: `\u2713 Download saved to ${saved}\n  Bao opened the link in a background tab, fetched the PDF with the page's sign-in, and closed that tab (${href}).\n`, stderr: "", exitCode: 0 },
        from: { source: "pdf-viewer", url: href } };
    }
    await delay(250);
  }
  return undefined;
}

const linkSaved = (saved: string, url: string): DownloadOutcome => ({ result: { stdout: `\u2713 Download saved to ${saved}\n  Bao fetched the link with the page's sign-in and did not open a tab (${url}).\n`, stderr: "", exitCode: 0 },
  from: { source: "link", url } });

/**
 * Clicks an element and saves what it gives. Page handlers run on that click. Bao then fetches the http(s) URL they left, or the
 * URL they passed to `window.open`, in the page with the page's cookies, so no tab opens and the owner's tab stays where it was.
 * A link the page cannot fetch opens in a background tab in that tab's own browser context, which Bao closes. If that context
 * cannot be confirmed, Bao does not open the tab. Any other element is clicked with the same guard, and Bao saves a download
 * Chrome starts or a PDF Chrome shows. Bao points Chrome's downloads at `saved`'s folder only for this command and gives Chrome
 * back its own download settings after, so the owner's later downloads go where Chrome puts them.
 */
export async function downloadByClick(cdp: CdpSocket, agentTab: string, saved: string, click: Click): Promise<DownloadOutcome> {
  const folder = path.dirname(saved);
  const all = await pages(cdp);
  const before = { url: all.find((info) => info.targetId === agentTab)?.url ?? "", targets: new Set(all.map((info) => info.targetId)) };
  let started: string | undefined;
  let url: string | undefined;
  const states = new Map<string, string>();
  const stops = [
    cdp.on("Browser.downloadWillBegin", undefined, (params) => {
      if (started) return;
      started = String(params.guid);
      if (typeof params.url === "string") url = params.url;
    }),
    cdp.on("Browser.downloadProgress", undefined, (params) => {
      if (params.state === "completed" || params.state === "canceled") states.set(String(params.guid), String(params.state));
    }),
  ];
  let behaviorContext: string | undefined;
  const behavior = (mode: "allowAndName" | "default") => {
    const params: { behavior: string; downloadPath?: string; eventsEnabled?: boolean; browserContextId?: string } = { behavior: mode };
    if (mode === "allowAndName") {
      params.downloadPath = folder;
      params.eventsEnabled = true;
    }
    if (behaviorContext) params.browserContextId = behaviorContext;
    return params;
  };
  try {
    const contextId = await contextOf(cdp, agentTab).catch(() => undefined);
    if (contextId) {
      const listed = await cdp.send<{ browserContextIds?: string[] }>("Target.getBrowserContexts", {}, undefined, 5000).catch(() => undefined);
      if (listed?.browserContextIds?.includes(contextId)) behaviorContext = contextId;
    }
    await cdp.send("Browser.setDownloadBehavior", behavior("allowAndName"), undefined, 5000);
    try {
      await inPage(cdp, agentTab, ARM_CLICK);
    } catch {
      return { result: failed("Bao could not keep this download from opening a tab.") };
    }
    let clicked: AgentBrowserCommandResult;
    let href = "";
    let named = false;
    try {
      clicked = await click();
    } finally {
      const captured = capturedClick(await inPage(cdp, agentTab, TAKE_CLICK).catch(() => undefined));
      href = captured.url;
      named = captured.download;
    }
    if (clicked.exitCode !== 0) return { result: clicked };
    if (href && !started) {
      let fetched: { kind: "file" } | { kind: "page" | "http"; url: string } | undefined;
      try {
        fetched = await fetchLink(cdp, agentTab, saved, href, named);
      } catch {
        fetched = undefined;
      }
      if (fetched?.kind === "file") {
        await closeOpened(cdp, agentTab, before);
        return linkSaved(saved, href);
      }
      const settled = fetched?.url || href;
      let cross = false;
      try { cross = new URL(settled).origin !== new URL(before.url).origin; } catch { cross = false; }
      if (!started && !cross && fetched?.kind === "page") return { result: failed(`The link returned a page, not a file (${href}).`) };
      if (!started && !cross && fetched?.kind === "http") return { result: failed(`Bao could not fetch the link (${href}).`) };
      if (!started && !contextId) return { result: failed(`Bao could not open the link in this tab's Chrome profile (${href}).`) };
      if (!started && contextId) {
        const background = await openBackground(cdp, href, contextId);
        if (!background) return { result: failed(`Bao could not open the link in this tab's Chrome profile (${href}).`) };
        try {
          const outcome = await saveBackground(cdp, background, saved, href, () => ({ guid: started, url }), states);
          if (outcome) return outcome;
          return { result: failed(`The link started no download and showed no PDF within ${START_MS / 1000} s (${href}).`) };
        } finally {
          await cdp.send("Target.closeTarget", { targetId: background }, undefined, 5000).catch(() => undefined);
        }
      }
    }
    const startBy = Date.now() + START_MS;
    while (!started && Date.now() < startBy) {
      const pdf = await pdfPage(cdp, agentTab, before);
      if (pdf) {
        await savePdf(cdp, pdf.targetId, saved);
        const opened = pdf.targetId !== agentTab;
        if (opened) await cdp.send("Target.closeTarget", { targetId: pdf.targetId }, undefined, 5000).catch(() => undefined);
        const where = opened ? "a new tab, which Bao closed" : "this tab, which still shows it";
        return { result: { stdout: `\u2713 Download saved to ${saved}\n  Chrome showed the PDF in ${where}, so Bao saved it from that page (${pdf.url}).\n`, stderr: "", exitCode: 0 },
          from: { source: "pdf-viewer", url: pdf.url } };
      }
      await delay(250);
    }
    if (!started) return { result: failed(`The click started no download and showed no PDF within ${START_MS / 1000} s.`) };
    const finishBy = Date.now() + FINISH_MS;
    while (!states.has(started) && Date.now() < finishBy) await delay(100);
    const state = states.get(started);
    if (state !== "completed") return { result: failed(state === "canceled" ? "Chrome canceled the download." : `The download did not finish within ${FINISH_MS / 60_000} minutes.`) };
    await rename(path.join(folder, started), saved);
    return { result: { stdout: `\u2713 Download saved to ${saved}\n`, stderr: "", exitCode: 0 }, from: { source: "download", ...url ? { url } : {} } };
  } finally {
    for (const stop of stops) stop();
    await cdp.send("Browser.setDownloadBehavior", behavior("default"), undefined, 5000)
      .catch((error: unknown) => process.stderr.write(`Bao could not return Chrome's download settings to Chrome: ${error instanceof Error ? error.message : String(error)}\n`));
  }
}
