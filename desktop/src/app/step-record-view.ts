import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { STEP_RECORD_SCHEMA, readStepRecord, runHarPath, runRecordDir, type HarEntry, type StepNetworkRecord, type StepTarget, type StepWait } from "../engines/step-har";
import type { PageState, PageStateEntry } from "../engines/step-page";
import { OVERLAY_HOST_ATTRIBUTE } from "../../../shared/takeover-overlay";
import { mhtmlPage } from "./mhtml-page";

const gunzipAsync = promisify(gunzip);

export type Phase = "before" | "after";

/** What the receipt knows about a run's step records before any step is opened. */
export interface RunRecordIndex {
  harBytes?: number;
  steps: string[];
}

export interface RequestRow {
  /** The request's place in the step's stored HAR entries. `request-<index>.json` downloads that entry. */
  index: number;
  method: string;
  url: string;
  /** 0 when agent-browser recorded no response: a request Chrome refused or dropped, one it handed to a download, or one still running when the HAR was written. */
  status: number;
  /** Chrome's network error for a request with no response, such as `net::ERR_BLOCKED_BY_CLIENT`. agent-browser writes it as the status text. */
  error?: string;
  type?: string;
  /** Left out, like `ms`, when there is no response: agent-browser fills both with placeholders. */
  mime?: string;
  ms?: number;
  /** When the request started, in epoch milliseconds. */
  at?: number;
  /** The response body's size in bytes. */
  bytes?: number;
  /** The GraphQL operation the request named. */
  operation?: string;
}

/** A step's HAR entries split into the requests that did real work and the ones the receipt files past. */
export interface NetworkView {
  total: number;
  work: RequestRow[];
  static: RequestRow[];
  analytics: RequestRow[];
}

export type PageFacts =
  | { url: string; title: string; viewport?: { width: number; height: number }; scroll: { x: number; y: number }; ms: number; axNodes?: number; mhtml: boolean; mhtmlError?: string }
  | { error: string; ms: number };

export interface FieldRow { name: string; type: string; value: string }
export interface FormRow { action: string; method: string; frame?: string; fields: FieldRow[] }
export interface SelectRow { name: string; frame?: string; options: { text: string; value: string; selected: boolean }[] }

/** What a page offered, read from its stored DOM snapshot: links, buttons, forms with their current values, fields outside a form, and select options. */
export interface PageMap {
  phase: Phase;
  links: { text: string; href: string; frame?: string }[];
  buttons: { text: string; frame?: string }[];
  forms: FormRow[];
  loose: (FieldRow & { frame?: string })[];
  selects: SelectRow[];
}

export interface LogRow { type: string; text: string }

export interface StepRecordView {
  id: string;
  why?: string;
  error?: string;
  waits: StepWait[];
  target?: StepTarget;
  network: NetworkView;
  pages: Partial<Record<Phase, PageFacts>>;
  map?: PageMap;
  console: LogRow[];
  errors: LogRow[];
}

const SAFE_ID = /^[\w-]+$/;
/** Hides Bao's own overlay, which the archive keeps without its styles, and keeps a click on a link from leaving the stored page. */
const ARCHIVE_PAGE_STYLE = `<style>[${OVERLAY_HOST_ATTRIBUTE}]{display:none!important}a,area{pointer-events:none!important}</style>`;

const STATIC_TYPES = new Set(["stylesheet", "script", "image", "font", "media", "manifest", "texttrack"]);
const ANALYTICS_HOSTS = [
  "google-analytics.com", "googletagmanager.com", "doubleclick.net", "googlesyndication.com", "segment.io", "segment.com",
  "mixpanel.com", "amplitude.com", "hotjar.com", "fullstory.com", "heapanalytics.com", "sentry.io", "nr-data.net",
  "newrelic.com", "datadoghq.com", "clarity.ms", "facebook.net", "bat.bing.com", "scorecardresearch.com",
];

function requestKind(row: RequestRow): keyof Omit<NetworkView, "total"> {
  let host = "";
  let pathname = "";
  try { ({ hostname: host, pathname } = new URL(row.url)); } catch { /* keep the row as work */ }
  const type = row.type?.toLowerCase();
  if (type === "ping" || ANALYTICS_HOSTS.some((name) => host === name || host.endsWith(`.${name}`))) return "analytics";
  if (type && STATIC_TYPES.has(type)) return "static";
  if (pathname.endsWith("/favicon.ico")) return "static";
  const mime = (row.mime || "").toLowerCase();
  if (/^(image|font|audio|video)\//.test(mime) || mime.startsWith("text/css") || mime.includes("javascript")) return "static";
  return "work";
}

function requestRow(entry: HarEntry, index: number): RequestRow {
  const request = (entry.request ?? {}) as { method?: string; url?: string; postData?: { text?: string } };
  const response = (entry.response ?? {}) as { status?: number; statusText?: string; bodySize?: number; content?: { mimeType?: string; size?: number } };
  const operation = graphqlOperation(request.url, request.postData?.text);
  const status = typeof response.status === "number" ? response.status : 0;
  const at = Date.parse(entry.startedDateTime ?? "");
  const bytes = [response.content?.size, response.bodySize].find((size) => typeof size === "number" && size >= 0);
  return {
    index,
    method: request.method || "GET",
    url: request.url || "",
    status,
    ...(!status && response.statusText ? { error: response.statusText } : {}),
    ...(typeof entry._resourceType === "string" ? { type: entry._resourceType } : {}),
    ...(status && response.content?.mimeType ? { mime: response.content.mimeType } : {}),
    ...(status && typeof entry.time === "number" ? { ms: Math.round(entry.time) } : {}),
    ...(Number.isNaN(at) ? {} : { at }),
    ...(status && bytes !== undefined ? { bytes } : {}),
    ...(operation ? { operation } : {}),
  };
}

function graphqlOperation(url: string | undefined, body: string | undefined): string | undefined {
  if (body) {
    try {
      const parsed = JSON.parse(body) as unknown;
      const names = (Array.isArray(parsed) ? parsed : [parsed])
        .map((item) => (item as { operationName?: unknown })?.operationName)
        .filter((name): name is string => typeof name === "string" && name.length > 0);
      if (names.length) return names.join(", ");
    } catch { /* not JSON */ }
  }
  try { return new URL(url || "").searchParams.get("operationName") || undefined; } catch { return undefined; }
}

export function networkView(entries: readonly HarEntry[]): NetworkView {
  const view: NetworkView = { total: entries.length, work: [], static: [], analytics: [] };
  entries.forEach((entry, index) => {
    const row = requestRow(entry, index);
    view[requestKind(row)].push(row);
  });
  return view;
}

/** Console messages and page errors from agent-browser's `console` and `errors` results, as the step record keeps them. */
function logRows(value: unknown, key: "messages" | "errors"): LogRow[] {
  const list = (value as { result?: Record<string, unknown> } | undefined)?.result?.[key];
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const text = (item as { text?: unknown })?.text;
    if (typeof text !== "string") return [];
    const type = (item as { type?: unknown }).type;
    return [{ type: key === "errors" ? "error" : typeof type === "string" ? type : "log", text }];
  });
}

interface SnapshotNodes {
  parentIndex?: number[];
  nodeType?: number[];
  nodeName?: number[];
  nodeValue?: number[];
  attributes?: number[][];
  textValue?: { index: number[]; value: number[] };
  inputValue?: { index: number[]; value: number[] };
  inputChecked?: { index: number[] };
  optionSelected?: { index: number[] };
}

interface SnapshotDocument { documentURL?: number; baseURL?: number; nodes?: SnapshotNodes }

const BUTTON_INPUTS = new Set(["submit", "button", "reset", "image"]);

/** Reads links, buttons, forms, loose fields, and select options out of a stored DOMSnapshot.captureSnapshot result. */
export function pageMap(dom: unknown, phase: Phase): PageMap {
  const map: PageMap = { phase, links: [], buttons: [], forms: [], loose: [], selects: [] };
  const snapshot = dom as { documents?: SnapshotDocument[]; strings?: string[] } | undefined;
  const strings = snapshot?.strings ?? [];
  const text = (index: number | undefined) => index === undefined || index < 0 ? "" : strings[index] ?? "";
  (snapshot?.documents ?? []).forEach((doc, docIndex) => {
    const nodes = doc.nodes ?? {};
    const names = nodes.nodeName ?? [];
    const count = names.length;
    const documentURL = text(doc.documentURL);
    const frame = docIndex === 0 ? undefined : documentURL || undefined;
    const base = text(doc.baseURL) || documentURL;
    const children: number[][] = Array.from({ length: count }, () => []);
    (nodes.parentIndex ?? []).forEach((parent, child) => { if (parent >= 0 && parent < count) children[parent]!.push(child); });
    const attrs = (node: number) => {
      const flat = nodes.attributes?.[node] ?? [];
      const out: Record<string, string> = {};
      for (let i = 0; i + 1 < flat.length; i += 2) out[text(flat[i]).toLowerCase()] = text(flat[i + 1]);
      return out;
    };
    const rareText = (data: { index: number[]; value: number[] } | undefined) => new Map((data?.index ?? []).map((node, i) => [node, text(data!.value[i])]));
    const values = rareText(nodes.inputValue);
    const textValues = rareText(nodes.textValue);
    const checked = new Set(nodes.inputChecked?.index ?? []);
    const selected = new Set(nodes.optionSelected?.index ?? []);
    const tag = (node: number) => text(names[node]).toUpperCase();
    const innerText = (node: number): string => {
      const parts: string[] = [];
      const walk = (at: number) => {
        if (nodes.nodeType?.[at] === 3) parts.push(text(nodes.nodeValue?.[at]));
        const name = tag(at);
        if (name === "SCRIPT" || name === "STYLE") return;
        for (const child of children[at]!) walk(child);
      };
      walk(node);
      return parts.join(" ").replace(/\s+/g, " ").trim();
    };
    const optionsOf = (select: number) => children[select]!.flatMap((child) => tag(child) === "OPTGROUP" ? children[child]! : [child]).filter((child) => tag(child) === "OPTION");
    const resolve = (href: string) => { try { return new URL(href, base).href; } catch { return href; } };
    const optionValue = (option: number) => attrs(option).value ?? innerText(option);
    const field = (node: number): FieldRow | undefined => {
      const name = tag(node);
      const a = attrs(node);
      if (name === "SELECT") {
        const picks = optionsOf(node).filter((option) => selected.has(option)).map(optionValue);
        return { name: a.name || a.id || "", type: "select", value: picks.join(", ") };
      }
      if (name === "TEXTAREA") return { name: a.name || a.id || "", type: "textarea", value: textValues.get(node) ?? "" };
      if (name !== "INPUT") return undefined;
      const type = (a.type || "text").toLowerCase();
      if (BUTTON_INPUTS.has(type)) return undefined;
      if (type === "checkbox" || type === "radio") return { name: a.name || a.id || "", type, value: `${a.value ?? "on"}${checked.has(node) ? " (checked)" : ""}` };
      return { name: a.name || a.id || "", type, value: type === "password" && (values.get(node) ?? "") ? "Hidden" : values.get(node) ?? a.value ?? "" };
    };
    const firstById = new Map<string, FormRow | null>();
    const placed: { row: FieldRow; owner?: FormRow; formId?: string }[] = [];
    const visit = (node: number, form: FormRow | undefined) => {
      const name = tag(node);
      const a = attrs(node);
      if (OVERLAY_HOST_ATTRIBUTE in a) return;
      let inside = form;
      if (name === "FORM") {
        inside = { action: a.action ? resolve(a.action) : documentURL, method: (a.method || "get").toUpperCase(), ...(frame ? { frame } : {}), fields: [] };
        map.forms.push(inside);
      } else if ((name === "A" || name === "AREA") && a.href !== undefined) {
        map.links.push({ text: innerText(node) || a["aria-label"] || a.title || "", href: resolve(a.href), ...(frame ? { frame } : {}) });
      } else if (name === "BUTTON" || (name === "INPUT" && BUTTON_INPUTS.has((a.type || "").toLowerCase())) || a.role === "button") {
        map.buttons.push({ text: innerText(node) || a.value || a["aria-label"] || a.title || "", ...(frame ? { frame } : {}) });
      }
      if (a.id && !firstById.has(a.id)) firstById.set(a.id, name === "FORM" ? inside! : null);
      const row = field(node);
      if (row) placed.push("form" in a ? { row, formId: a.form } : inside ? { row, owner: inside } : { row });
      if (name === "SELECT") {
        map.selects.push({
          name: a.name || a.id || "", ...(frame ? { frame } : {}),
          options: optionsOf(node).map((option) => ({ text: innerText(option), value: optionValue(option), selected: selected.has(option) })),
        });
      }
      for (const child of children[node]!) visit(child, inside);
    };
    (nodes.parentIndex ?? []).forEach((parent, node) => { if (parent < 0) visit(node, undefined); });
    for (const item of placed) {
      const owner = item.formId !== undefined ? firstById.get(item.formId) || undefined : item.owner;
      if (owner) owner.fields.push(item.row);
      else map.loose.push({ ...item.row, ...(frame ? { frame } : {}) });
    }
  });
  return map;
}

function pageFacts(entry: PageStateEntry, state: PageState | undefined): PageFacts {
  if ("error" in entry) return entry;
  if (!state) return { error: "Bao could not read the stored page file.", ms: entry.ms };
  const layout = state.layout as { cssLayoutViewport?: { clientWidth?: number; clientHeight?: number } } | undefined;
  const viewport = layout?.cssLayoutViewport;
  const ax = (state.ax as { nodes?: unknown[] } | undefined)?.nodes;
  return {
    url: state.url, title: state.title, scroll: state.scroll, ms: entry.ms,
    ...(typeof viewport?.clientWidth === "number" && typeof viewport.clientHeight === "number" ? { viewport: { width: viewport.clientWidth, height: viewport.clientHeight } } : {}),
    ...(Array.isArray(ax) ? { axNodes: ax.length } : {}),
    mhtml: Boolean(entry.mhtml),
    ...(entry.mhtmlError ? { mhtmlError: entry.mhtmlError } : {}),
  };
}

/** Resolves a file a step record names, refusing any path outside the run folder. */
function recordFile(home: string, runId: string, relative: string): string | undefined {
  const dir = runRecordDir(home, runId);
  const file = path.resolve(dir, relative);
  return file.startsWith(dir + path.sep) ? file : undefined;
}

async function readPageState(home: string, runId: string, entry: PageStateEntry | undefined): Promise<PageState | undefined> {
  if (!entry || "error" in entry) return undefined;
  const file = recordFile(home, runId, entry.file);
  if (!file) return undefined;
  try { return JSON.parse((await gunzipAsync(await readFile(file))).toString("utf8")) as PageState; }
  catch { return undefined; }
}

async function readRecord(home: string, runId: string, stepId: string): Promise<StepNetworkRecord | undefined> {
  if (!SAFE_ID.test(runId) || !SAFE_ID.test(stepId)) return undefined;
  try { return await readStepRecord(home, runId, stepId); }
  catch { return undefined; }
}

export async function runRecordIndex(home: string, runId: string): Promise<RunRecordIndex> {
  if (!SAFE_ID.test(runId)) return { steps: [] };
  const har = await stat(runHarPath(home, runId)).catch(() => undefined);
  const names = await readdir(path.join(runRecordDir(home, runId), "steps")).catch(() => [] as string[]);
  return {
    ...(har?.isFile() ? { harBytes: har.size } : {}),
    steps: names.flatMap((name) => /^([\w-]+)\.json\.gz$/.exec(name)?.[1] ?? []),
  };
}

/** Builds what the receipt shows for one step from its stored record and page files. Reads no browser. */
export async function stepRecordView(home: string, runId: string, stepId: string): Promise<StepRecordView | undefined> {
  const record = await readRecord(home, runId, stepId);
  if (!record) return undefined;
  const pages: StepRecordView["pages"] = {};
  let map: PageMap | undefined;
  for (const phase of ["after", "before"] as const) {
    const entry = record.page?.[phase];
    if (!entry) continue;
    const state = await readPageState(home, runId, entry);
    pages[phase] = pageFacts(entry, state);
    if (!map && state) map = pageMap(state.dom, phase);
  }
  return {
    id: record.id,
    ...(record.why ? { why: record.why } : {}),
    ...(record.error ? { error: record.error } : {}),
    waits: record.waits,
    ...(record.target ? { target: record.target } : {}),
    network: networkView(record.network.entries),
    pages,
    ...(map ? { map } : {}),
    console: logRows(record.console, "messages"),
    errors: logRows(record.errors, "errors"),
  };
}

/** `page` marks the one file a window shows in place, not a download: the archive as a page. */
export interface RecordDownload { body: Buffer | string; type: string; filename: string; page?: true }

/**
 * One raw file behind a step: `network.har` (the step's HAR entries as a HAR 1.2 log), `request-<index>.json` (one of those entries),
 * `<phase>.dom.json` (the page read without its accessibility tree), `<phase>.ax.json` (Accessibility.getFullAXTree as stored),
 * `<phase>.mhtml` (the page archive), or `<phase>.html` (that archive as one HTML page).
 */
export async function stepRecordDownload(home: string, runId: string, stepId: string, name: string): Promise<RecordDownload | undefined> {
  const record = await readRecord(home, runId, stepId);
  if (!record) return undefined;
  const filename = `${runId}-${stepId}-${name}`;
  if (name === "network.har") {
    const har = { log: { version: "1.2", creator: { name: "Bao step record", version: STEP_RECORD_SCHEMA }, entries: record.network.entries } };
    return { body: JSON.stringify(har), type: "application/json", filename };
  }
  const request = /^request-(\d+)\.json$/.exec(name);
  if (request) {
    const found = record.network.entries[Number(request[1])];
    return found ? { body: JSON.stringify(found), type: "application/json", filename } : undefined;
  }
  const match = /^(before|after)\.(dom\.json|ax\.json|mhtml|html)$/.exec(name);
  if (!match) return undefined;
  const entry = record.page?.[match[1] as Phase];
  if (!entry || "error" in entry) return undefined;
  if (match[2] === "mhtml" || match[2] === "html") {
    const file = entry.mhtml ? recordFile(home, runId, entry.mhtml) : undefined;
    if (!file) return undefined;
    try {
      const mhtml = await gunzipAsync(await readFile(file));
      if (match[2] === "mhtml") return { body: mhtml, type: "multipart/related", filename };
      const page = mhtmlPage(mhtml);
      return page === undefined ? undefined : { body: page + ARCHIVE_PAGE_STYLE, type: "text/html; charset=utf-8", filename, page: true };
    } catch { return undefined; }
  }
  const state = await readPageState(home, runId, entry);
  if (!state) return undefined;
  if (match[2] === "ax.json") return state.ax === undefined ? undefined : { body: JSON.stringify(state.ax), type: "application/json", filename };
  return { body: JSON.stringify({ ...state, ax: undefined }), type: "application/json", filename };
}
