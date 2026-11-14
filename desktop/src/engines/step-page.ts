import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { runRecordDir } from "./step-har";

const gzipAsync = promisify(gzip);

export const PAGE_STATE_SCHEMA = "bao.page-state/v1";

/**
 * One page read from standard CDP calls, each result kept as Chrome returned it.
 * `dom` is DOMSnapshot.captureSnapshot with no computed styles; it covers shadow roots, iframes, input values and selected options.
 * `ax` is Accessibility.getFullAXTree for the main frame. `layout` is Page.getLayoutMetrics, which holds the viewport.
 */
export interface PageState {
  schema: typeof PAGE_STATE_SCHEMA;
  capturedAt: string;
  url: string;
  title: string;
  scroll: { x: number; y: number };
  layout: unknown;
  dom: unknown;
  ax: unknown;
}

export interface PageRead {
  state: PageState;
  mhtml?: { data: string } | { error: string };
}

/** A page read, or why it failed, with the milliseconds it took from connect to detach. */
export type PageCapture = (PageRead | { error: string }) & { ms: number };

/** What the step record says about one page read: the files beside it, or why there are none. */
export type PageStateEntry =
  | { file: string; ms: number; mhtml?: string; mhtmlError?: string }
  | { error: string; ms: number };

type CdpSend = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;

const PAGE_FACTS = "({ url: location.href, title: document.title, x: scrollX, y: scrollY })";

/** Reads the page, and an MHTML archive when `archive` says this URL has none yet. A failed archive keeps the page read. */
export async function readPage(send: CdpSend, archive: (url: string) => boolean): Promise<PageRead> {
  const [facts, layout, dom, ax] = await Promise.all([
    send<{ result: { value?: { url: string; title: string; x: number; y: number } } }>("Runtime.evaluate", { expression: PAGE_FACTS, returnByValue: true }),
    send("Page.getLayoutMetrics"),
    send("DOMSnapshot.captureSnapshot", { computedStyles: [] }),
    send("Accessibility.getFullAXTree"),
  ]);
  const value = facts.result?.value;
  if (typeof value?.url !== "string") throw new Error("page URL unavailable");
  const state: PageState = {
    schema: PAGE_STATE_SCHEMA, capturedAt: new Date().toISOString(),
    url: value.url, title: value.title, scroll: { x: value.x, y: value.y }, layout, dom, ax,
  };
  let mhtml: { data: string } | { error: string } | undefined;
  if (archive(value.url)) {
    try { mhtml = { data: (await send<{ data: string }>("Page.captureSnapshot", { format: "mhtml" })).data }; }
    catch (error) { mhtml = { error: errorText(error) }; }
  }
  return { state, ...(mhtml ? { mhtml } : {}) };
}

function pageStatePath(home: string, runId: string, stepId: string, phase: "before" | "after"): string {
  return path.join(runRecordDir(home, runId), "steps", `${stepId}.${phase}.json.gz`);
}

function pageArchivePath(home: string, runId: string, stepId: string, phase: "before" | "after"): string {
  return path.join(runRecordDir(home, runId), "steps", `${stepId}.${phase}.mhtml.gz`);
}

/** Writes the page read beside the step record. File names in the entry are relative to the run folder. */
export async function writePageState(home: string, runId: string, stepId: string, phase: "before" | "after", capture: PageCapture): Promise<PageStateEntry> {
  if ("error" in capture) return { error: capture.error, ms: capture.ms };
  const dest = pageStatePath(home, runId, stepId, phase);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, await gzipAsync(JSON.stringify(capture.state)));
  const entry: PageStateEntry = { file: path.relative(runRecordDir(home, runId), dest), ms: capture.ms };
  if (!capture.mhtml) return entry;
  if ("error" in capture.mhtml) return { ...entry, mhtmlError: capture.mhtml.error };
  const archive = pageArchivePath(home, runId, stepId, phase);
  await writeFile(archive, await gzipAsync(capture.mhtml.data));
  return { ...entry, mhtml: path.relative(runRecordDir(home, runId), archive) };
}

export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim() || "unknown error";
}
