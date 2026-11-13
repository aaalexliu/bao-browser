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

/** Fetches `url` in the page with the page's cookies. An HTML page that is not an attachment is not the file. */
async function fetchLink(cdp: CdpSocket, targetId: string, file: string, url: string): Promise<"file" | "page"> {
  const key = `__bao_file_${Date.now()}`;
  const fetched = await inPage<{ kind: "file"; total: number } | { kind: "page" }>(cdp, targetId, `(async () => {
    const response = await fetch(${JSON.stringify(url)}, { credentials: "include" });
    if (!response.ok) throw new Error("the file fetch returned HTTP " + response.status);
    const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const disposition = (response.headers.get("content-disposition") || "").toLowerCase();
    if (type === "text/html" && !disposition.includes("attachment")) return { kind: "page" };
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
  if (fetched.kind === "page") return "page";
  await writeStash(cdp, targetId, file, key, fetched.total);
  return "file";
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
 * Cancels the default action of a click on an http(s) link and records its URL. Chrome activates a tab that this click would
 * open, and answering Page.bringToFront does not stop that. The listener is removed by `TAKE_LINK`.
 */
const ARM_LINK = `(() => {
  const handle = (event) => {
    const node = event.target instanceof Element ? event.target : null;
    const link = node && node.closest("a[href]");
    if (!link) return;
    let url;
    try { url = new URL(link.href, location.href); } catch { return; }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.__baoDownloadHref = url.href;
  };
  window.__baoDownloadClick = handle;
  document.addEventListener("click", handle, true);
})()`;

const TAKE_LINK = `(() => {
  const handle = window.__baoDownloadClick;
  if (typeof handle === "function") document.removeEventListener("click", handle, true);
  const href = typeof window.__baoDownloadHref === "string" ? window.__baoDownloadHref : "";
  delete window.__baoDownloadHref;
  delete window.__baoDownloadClick;
  return href;
})()`;

async function closeOpened(cdp: CdpSocket, agentTab: string, before: { targets: ReadonlySet<string> }): Promise<void> {
  const opened = (await pages(cdp)).filter((info) => !before.targets.has(info.targetId) && info.openerId === agentTab);
  for (const info of opened) await cdp.send("Target.closeTarget", { targetId: info.targetId }, undefined, 5000).catch(() => undefined);
}

/** Opens `url` without selecting it. A page fetch cannot read a cross-origin file; Chrome's own navigation can. */
async function openBackground(cdp: CdpSocket, url: string): Promise<string | undefined> {
  try {
    const created = await cdp.send<{ targetId: string }>("Target.createTarget", { url, background: true }, undefined, 5000);
    return created.targetId;
  } catch {
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
 * Clicks an element and saves what it gives. A click on an http(s) link does not navigate: Bao fetches that URL in the page with the
 * page's cookies, so no tab opens and the owner's tab stays where it was. A page or an error status is not the file, so Bao clicks
 * again and a click handler that builds the real file still runs. A link the page cannot fetch, such as a cross-origin file, opens in
 * a background tab that Bao closes. Any other element is clicked, and Bao saves a download Chrome starts or a PDF Chrome shows. Bao points Chrome's downloads at `saved`'s folder only for this command and gives Chrome back its own download settings
 * after, so the owner's later downloads go where Chrome puts them.
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
  try {
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: folder, eventsEnabled: true }, undefined, 5000);
    await inPage(cdp, agentTab, ARM_LINK).catch(() => undefined);
    let clicked: AgentBrowserCommandResult;
    let href = "";
    try {
      clicked = await click();
    } finally {
      href = await inPage<string>(cdp, agentTab, TAKE_LINK).catch(() => "");
    }
    if (clicked.exitCode !== 0) return { result: clicked };
    if (href) {
      let clickAgain = false;
      try {
        const kind = await fetchLink(cdp, agentTab, saved, href);
        if (kind === "file") {
          await closeOpened(cdp, agentTab, before);
          return linkSaved(saved, href);
        }
        clickAgain = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/HTTP \d+/.test(message)) clickAgain = true;
        else {
          const background = await openBackground(cdp, href);
          if (!background) return { result: failed(`Bao could not fetch the link (${href}).`) };
          try {
            const outcome = await saveBackground(cdp, background, saved, href, () => ({ guid: started, url }), states);
            if (outcome) return outcome;
            return { result: failed(`The link started no download and showed no PDF within ${START_MS / 1000} s (${href}).`) };
          } finally {
            await cdp.send("Target.closeTarget", { targetId: background }, undefined, 5000).catch(() => undefined);
          }
        }
      }
      if (clickAgain) {
        const again = await click();
        if (again.exitCode !== 0) return { result: again };
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
    await cdp.send("Browser.setDownloadBehavior", { behavior: "default" }, undefined, 5000)
      .catch((error: unknown) => process.stderr.write(`Bao could not return Chrome's download settings to Chrome: ${error instanceof Error ? error.message : String(error)}\n`));
  }
}
