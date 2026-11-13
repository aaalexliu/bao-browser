// Uploads through a file chooser and downloads by click, on Bao's own CDP connection. The native CLI only clicks.

import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CdpSocket } from "../cdp-live/socket";
import type { AgentBrowserCommandResult } from "./agent-browser-proxy";

/** A download's result, and where its file came from when it saved one. */
export type DownloadOutcome = { result: AgentBrowserCommandResult; from?: { source: "download"; url?: string } | { source: "pdf-viewer"; url: string } };

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
  const parts: string[] = [];
  try {
    for (let at = 0; at < total; at += CHUNK) parts.push(await inPage<string>(cdp, targetId, `window[${JSON.stringify(key)}].slice(${at}, ${at + CHUNK})`, 30_000));
  } finally {
    await inPage(cdp, targetId, `delete window[${JSON.stringify(key)}]`).catch(() => undefined);
  }
  await writeFile(file, Buffer.from(parts.join(""), "base64"));
}

/**
 * Clicks an element and saves what it gives: a download Chrome starts, or a PDF Chrome shows in its viewer in the agent's tab or in
 * a tab the click opened. Bao points Chrome's downloads at `saved`'s folder only for this command and gives Chrome back its own
 * download settings after, so the owner's later downloads go where Chrome puts them. A tab the click opened for a PDF closes.
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
    const clicked = await click();
    if (clicked.exitCode !== 0) return { result: clicked };
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
