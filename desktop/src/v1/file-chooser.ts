// Capture records a file input from a chooser or a drop. The workflow keeps
// the basename only. The absolute path is used once, to show the file on the page.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import type { Identity } from "./schema";

interface Cdp {
  send(method: string, params?: object): Promise<Record<string, unknown>>;
  on(event: string, handler: (params: { backendNodeId?: number }) => void): void;
}

export interface ChosenFile {
  fileName: string;
  identity: Identity;
}

/** Basename only. A path, `.`, or `..` is refused. */
export function fileParamName(filePath: string): string {
  const base = path.basename(filePath);
  if (!base || base === "." || base === ".." || base.includes("/") || base.includes("\\")) {
    throw new Error("file name");
  }
  return base;
}

/** Drop rawPath and reduce fileName to a basename before the trail is saved. */
export function storedFileEvent<T extends { op: string; fileName?: string; rawPath?: string }>(event: T): T {
  if (event.op !== "upload" && event.op !== "drop") return event;
  const copy: T = { ...event };
  delete copy.rawPath;
  if (copy.fileName) {
    try {
      copy.fileName = fileParamName(copy.fileName);
    } catch {
      delete copy.fileName;
    }
  }
  return copy;
}

let queuedPath: string | null = null;
let queuedDone: ((ok: boolean) => void) | null = null;

/** The next intercepted chooser uses this path and does not open a panel. */
export function queueChooserFile(file: string): Promise<void> {
  queuedPath = file;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (queuedPath === file) queuedPath = null;
      queuedDone = null;
      reject(new Error("file chooser did not open"));
    }, 15000);
    queuedDone = (ok) => {
      clearTimeout(timer);
      queuedDone = null;
      if (ok) resolve();
      else reject(new Error("file chooser did not land"));
    };
  });
}

function takeQueued(): string | null {
  const file = queuedPath;
  queuedPath = null;
  return file;
}

function finishQueued(ok: boolean): void {
  const done = queuedDone;
  queuedDone = null;
  done?.(ok);
}

/** Native open panel. Cancel resolves to null. The path is not logged. */
export function chooseFilePanel(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", [
      "-e",
      'POSIX path of (choose file with prompt "Choose a file for bao")',
    ], { timeout: 180000 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const picked = stdout.replace(/\n$/, "");
      resolve(picked || null);
    });
  });
}

export async function armFileChooser(
  page: Page,
  onFile: (chosen: ChosenFile) => Promise<void>,
): Promise<Cdp> {
  const client = await page.context().newCDPSession(page) as unknown as Cdp;
  await client.send("Page.enable");
  await client.send("DOM.enable");
  await client.send("Page.setInterceptFileChooserDialog", { enabled: true });
  let chain = Promise.resolve();
  client.on("Page.fileChooserOpened", (event) => {
    chain = chain.then(() => acceptChooser(page, client, event, onFile)).catch(() => undefined);
  });
  return client;
}

async function acceptChooser(
  page: Page,
  client: Cdp,
  event: { backendNodeId?: number },
  onFile: (chosen: ChosenFile) => Promise<void>,
): Promise<void> {
  const backendNodeId = event.backendNodeId;
  const absolute = takeQueued() || await chooseFilePanel();
  if (!backendNodeId || !absolute || !existsSync(absolute)) {
    finishQueued(false);
    return;
  }
  let fileName: string;
  try {
    fileName = fileParamName(absolute);
  } catch {
    finishQueued(false);
    return;
  }
  const identity = await identityOf(client, backendNodeId);
  await page.evaluate(() => {
    (window as unknown as { __baoSkipNextFile?: boolean }).__baoSkipNextFile = true;
  });
  try {
    await client.send("DOM.setFileInputFiles", { files: [absolute], backendNodeId });
  } catch {
    await page.evaluate(() => {
      (window as unknown as { __baoSkipNextFile?: boolean }).__baoSkipNextFile = false;
    }).catch(() => undefined);
    finishQueued(false);
    return;
  }
  await page.evaluate(() => {
    const w = window as unknown as { __baoSkipNextFile?: boolean };
    if (!w.__baoSkipNextFile) return;
    document.querySelectorAll("input[type=file]").forEach((el) => {
      if (!(el instanceof HTMLInputElement) || !el.files?.length) return;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }).catch(() => undefined);
  await onFile({ fileName, identity });
  finishQueued(true);
}

async function identityOf(client: Cdp, backendNodeId: number): Promise<Identity> {
  const resolved = await client.send("DOM.resolveNode", { backendNodeId }) as { object?: { objectId?: string } };
  const objectId = resolved.object?.objectId;
  const blank: Identity = { surface: "dom", role: "input", tag: "input", path: [] };
  if (!objectId) return blank;
  try {
    const called = await client.send("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      functionDeclaration: `function() {
        const el = this;
        const attr = (name) => (el.getAttribute ? el.getAttribute(name) : "") || "";
        return {
          role: attr("role") || (el.tagName ? el.tagName.toLowerCase() : "input"),
          testId: attr("data-testid"),
          id: el.id || "",
          nameAttr: attr("name"),
          tag: el.tagName ? el.tagName.toLowerCase() : "input",
          label: attr("aria-label"),
        };
      }`,
    }) as { result?: { value?: Record<string, string> } };
    const value = called.result?.value || {};
    return {
      surface: "dom",
      role: value.role || "input",
      testId: value.testId || undefined,
      id: value.id || undefined,
      nameAttr: value.nameAttr || undefined,
      tag: value.tag || "input",
      label: value.label || undefined,
      path: [],
    };
  } catch {
    return blank;
  } finally {
    await client.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
  }
}
