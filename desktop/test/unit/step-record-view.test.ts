import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runHarPath, writeStepRecord, type HarEntry, type StepNetworkRecord } from "../../src/engines/step-har";
import { PAGE_STATE_SCHEMA, writePageState, type PageState } from "../../src/engines/step-page";
import { stepRecordBody } from "../../src/app/step-record-html";
import { networkView, pageMap, runRecordIndex, stepRecordDownload, stepRecordView } from "../../src/app/step-record-view";
import { runReceipt, type RunSummary } from "../../src/app/views";
import type { inspectRunView } from "../../src/mcp/run-view";
import { startApp } from "../../src/app/server";
import { sampleArchive } from "../support/mhtml";

const RUN = "run-receipt-1";

function entry(method: string, url: string, status: number, type: string, mime: string, body?: string): HarEntry {
  return {
    startedDateTime: "2026-11-14T00:00:01.000Z", time: 12.4, _resourceType: type,
    request: { method, url, headers: [], cookies: [], ...(body ? { postData: { mimeType: "application/json", text: body } } : {}) },
    response: { status, content: { mimeType: mime }, headers: [], cookies: [], redirectURL: "" },
  };
}

/** A DOMSnapshot.captureSnapshot result for a page with a form, a shadow root, and one iframe. */
function snapshot(): unknown {
  const strings: string[] = [];
  const s = (value: string) => { const at = strings.indexOf(value); if (at >= 0) return at; strings.push(value); return strings.length - 1; };
  const doc = (url: string, rows: [parent: number, type: number, name: string, attrs: string[], value?: string][], extra: Record<string, unknown> = {}) => ({
    documentURL: s(url),
    nodes: {
      parentIndex: rows.map((row) => row[0]),
      nodeType: rows.map((row) => row[1]),
      nodeName: rows.map((row) => s(row[2])),
      nodeValue: rows.map((row) => row[4] === undefined ? -1 : s(row[4])),
      attributes: rows.map((row) => row[3].map(s)),
      ...extra,
    },
  });
  const main = doc("https://broker.example/statements", [
    [-1, 9, "#document", []],
    [0, 1, "HTML", []],
    [1, 1, "A", ["href", "/statements/2026-10"]],
    [2, 3, "#text", [], "October statement"],
    [1, 1, "FORM", ["action", "/statements", "method", "post"]],
    [4, 1, "INPUT", ["name", "account", "value", "brokerage"]],
    [4, 1, "INPUT", ["name", "password", "type", "password"]],
    [4, 1, "SELECT", ["name", "year"]],
    [7, 1, "OPTION", ["value", "2025"]],
    [8, 3, "#text", [], "2025"],
    [7, 1, "OPTION", ["value", "2026"]],
    [10, 3, "#text", [], "2026"],
    [4, 1, "BUTTON", ["type", "submit"]],
    [12, 3, "#text", [], "Filter"],
    [1, 1, "STATEMENT-CARD", []],
    [14, 11, "#document-fragment", []],
    [15, 1, "A", ["href", "https://broker.example/statements/2026-09"]],
    [16, 3, "#text", [], "September"],
    [1, 1, "INPUT", ["name", "search"]],
    [1, 1, "SCRIPT", []],
    [19, 3, "#text", [], "ignored()"],
  ], {
    inputValue: { index: [5, 6, 18], value: [s("brokerage"), s("hunter2"), s("q4")] },
    optionSelected: { index: [10] },
  });
  const frame = doc("https://help.example/frame", [
    [-1, 9, "#document", []],
    [0, 1, "A", ["href", "/help"]],
    [1, 3, "#text", [], "Help center"],
  ]);
  return { documents: [main, frame], strings };
}

function pageState(withAx: boolean): PageState {
  return {
    schema: PAGE_STATE_SCHEMA, capturedAt: "2026-11-14T00:00:02.000Z", url: "https://broker.example/statements", title: "Statements",
    scroll: { x: 0, y: 300 }, layout: { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } }, dom: snapshot(),
    ...(withAx ? { ax: { nodes: [{ nodeId: "1" }, { nodeId: "2" }] } } : {}),
  };
}

async function fixture(t: test.TestContext): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "bao-step-record-view-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const before = await writePageState(home, RUN, "command-2", "before", { state: pageState(false), ms: 4 });
  const after = await writePageState(home, RUN, "command-2", "after", { state: pageState(true), mhtml: { data: "From: <Saved by Blink>\r\n" }, ms: 9 });
  const record: StepNetworkRecord = {
    schema: "bao.step-record/v1", id: "command-2", command: "click", args: ["@e4"], why: "Load the October statement.", status: "passed",
    startedAt: "2026-11-14T00:00:01.000Z", endedAt: "2026-11-14T00:00:01.300Z", waits: [{ for: "click", ms: 300 }],
    network: { entries: [
      entry("GET", "https://broker.example/statements", 200, "Document", "text/html"),
      entry("GET", "https://broker.example/app.css", 200, "Stylesheet", "text/css"),
      entry("GET", "https://broker.example/favicon.ico", 200, "Other", "text/html"),
      entry("POST", "https://www.google-analytics.com/g/collect", 204, "Fetch", "text/plain"),
      entry("POST", "https://broker.example/beacon", 0, "Ping", ""),
      entry("POST", "https://broker.example/graphql", 200, "Fetch", "application/json", JSON.stringify({ operationName: "Statement", query: "query Statement { id }" })),
      entry("GET", "https://broker.example/go", 0, "Document", ""),
      entry("GET", "https://broker.example/missing.png", 404, "Image", "text/plain"),
    ] },
    target: { ref: "@e4", role: "button", name: "Load", box: { x: 10, y: 20, width: 80, height: 24 } },
    page: { before, after },
    console: { command: ["console"], success: true, result: { messages: [{ type: "warning", text: "slow" }] } },
    errors: { command: ["errors"], success: true, result: { errors: [{ text: "TypeError: boom", line: 1, column: 1 }] } },
  };
  await writeStepRecord(home, RUN, record);
  await writeStepRecord(home, RUN, { ...record, id: "command-1", why: undefined, network: { entries: [] }, page: undefined, target: undefined });
  await writeFile(runHarPath(home, RUN), JSON.stringify({ log: { version: "1.2", creator: { name: "agent-browser", version: "0.41.2" }, entries: record.network.entries } }));
  return home;
}

test("requests that did real work stay in front; static files and analytics are filed by type, MIME type, and host", () => {
  const view = networkView([
    entry("GET", "https://a.example/", 200, "Document", "text/html"),
    entry("GET", "https://a.example/x.js", 200, "Other", "application/javascript"),
    entry("GET", "https://a.example/font", 200, "Font", "font/woff2"),
    entry("GET", "https://stats.g.doubleclick.net/collect", 200, "Image", "image/gif"),
    entry("GET", "https://a.example/api/me", 200, "XHR", "application/json"),
    entry("GET", "wss://a.example/live", 101, "WebSocket", ""),
  ]);
  assert.equal(view.total, 6);
  assert.deepEqual(view.work.map((row) => row.url), ["https://a.example/", "https://a.example/api/me", "wss://a.example/live"]);
  assert.deepEqual(view.static.map((row) => row.url), ["https://a.example/x.js", "https://a.example/font"]);
  assert.deepEqual(view.analytics.map((row) => row.url), ["https://stats.g.doubleclick.net/collect"]);
  const lower = networkView([
    entry("GET", "https://a.example/app.css", 200, "stylesheet", "text/plain"),
    entry("POST", "https://a.example/beacon", 0, "ping", ""),
    entry("GET", "https://a.example/api/me", 200, "fetch", "application/json"),
  ]);
  assert.deepEqual([lower.work.length, lower.static.length, lower.analytics.length], [1, 1, 1]);
});

test("a failed step shows its error, and one filed request reads as one", () => {
  const view = {
    id: "command-5", error: "Unknown ref: e999", waits: [{ for: "click", ms: 70 }], pages: {}, console: [], errors: [],
    network: networkView([entry("GET", "https://a.example/api/me", 200, "xhr", "application/json"), entry("GET", "https://a.example/a.png", 200, "image", "image/png")]),
  };
  const html = stepRecordBody(RUN, "command-5", view);
  assert.match(html, /<h4>Error<\/h4><p>Unknown ref: e999<\/p>/);
  assert.ok(html.indexOf("Unknown ref") < html.indexOf("Timing"));
  assert.match(html, /2 requests\. 1 did real work; 1 static file is filed below them\./);
  assert.doesNotMatch(stepRecordBody(RUN, "command-5", { ...view, error: undefined }), /<h4>Error<\/h4>/);
});

test("a request with no recorded response is not a failed load; one Chrome refused shows its network error", () => {
  const noResponse = (method: string, url: string, type: string, statusText: string): HarEntry => {
    const base = entry(method, url, 0, type, "application/octet-stream");
    return { ...base, time: 0, response: { ...(base.response as object), statusText } };
  };
  const download = "https://files.example/statement.pdf?Signature=abc";
  const blocked = "https://o1.ingest.example/envelope";
  const view = {
    id: "command-6", waits: [{ for: "download", ms: 1100 }], pages: {}, console: [], errors: [],
    network: networkView([noResponse("GET", download, "xhr", ""), noResponse("POST", blocked, "fetch", "net::ERR_BLOCKED_BY_CLIENT")]),
  };
  assert.deepEqual(view.network.work.map((row) => [row.status, row.error, row.mime, row.ms]), [
    [0, undefined, undefined, undefined],
    [0, "net::ERR_BLOCKED_BY_CLIENT", undefined, undefined],
  ]);
  const html = stepRecordBody(RUN, "command-6", view);
  const rows = html.split('<div class="record-row');
  const downloadRow = rows.find((row) => row.includes(download) && row.includes("GET"))!;
  assert.match(downloadRow, /^"><span class="record-key">GET no response recorded<\/span>/);
  assert.doesNotMatch(downloadRow, /octet-stream|0 ms/);
  const blockedRow = rows.find((row) => row.includes(blocked) && row.includes("POST"))!;
  assert.match(blockedRow, /^ failed"><span class="record-key">POST failed<\/span>/);
  assert.match(blockedRow, /net::ERR_BLOCKED_BY_CLIENT/);
  const consoleSection = html.slice(html.indexOf("Console and errors"));
  assert.match(consoleSection, /Load failed<\/span><span class="record-value">https:\/\/o1\.ingest\.example\/envelope<span class="record-facts">net::ERR_BLOCKED_BY_CLIENT/);
  assert.doesNotMatch(consoleSection, /statement\.pdf|No response/);
  const quiet = stepRecordBody(RUN, "command-6", { ...view, network: networkView([noResponse("GET", download, "xhr", "")]) });
  assert.match(quiet, /No console messages, page errors, or failed loads recorded\./);
});

test("the link and form map comes from the stored DOM snapshot, shadow roots and frames included", () => {
  const map = pageMap(snapshot(), "after");
  assert.deepEqual(map.links, [
    { text: "October statement", href: "https://broker.example/statements/2026-10" },
    { text: "September", href: "https://broker.example/statements/2026-09" },
    { text: "Help center", href: "https://help.example/help", frame: "https://help.example/frame" },
  ]);
  assert.deepEqual(map.buttons, [{ text: "Filter" }]);
  assert.deepEqual(map.forms, [{ action: "https://broker.example/statements", method: "POST", fields: [
    { name: "account", type: "text", value: "brokerage" },
    { name: "password", type: "password", value: "Hidden" },
    { name: "year", type: "select", value: "2026" },
  ] }]);
  assert.deepEqual(map.loose, [{ name: "search", type: "text", value: "q4" }]);
  assert.deepEqual(map.selects, [{ name: "year", options: [{ text: "2025", value: "2025", selected: false }, { text: "2026", value: "2026", selected: true }] }]);
});

/** A DOMSnapshot.captureSnapshot result. Rare string values are indexes into `strings`, as CDP stores them. */
function captured(documents: { url: string; base?: string; rows: [parent: number, type: number, name: string, attrs: string[], value?: string][] }[]): { strings: string[]; documents: { nodes: Record<string, unknown> }[] } {
  const strings: string[] = [];
  const s = (value: string) => { const at = strings.indexOf(value); if (at >= 0) return at; strings.push(value); return strings.length - 1; };
  return {
    strings,
    documents: documents.map((document) => ({
      documentURL: s(document.url),
      ...(document.base === undefined ? {} : { baseURL: s(document.base) }),
      nodes: {
        parentIndex: document.rows.map((row) => row[0]),
        nodeType: document.rows.map((row) => row[1]),
        nodeName: document.rows.map((row) => s(row[2])),
        nodeValue: document.rows.map((row) => row[4] === undefined ? -1 : s(row[4])),
        attributes: document.rows.map((row) => row[3].map(s)),
      },
    })),
  };
}

test("page map keeps textarea text, every selected option, the document base URL, and the form a control names", () => {
  const note = "October statement attached";
  const dom = captured([
    {
      url: "https://example.test/account",
      base: "https://files.example.test/archive/",
      rows: [
        [-1, 9, "#document", []],
        [0, 1, "HTML", []],
        [1, 1, "A", ["href", "october.pdf"]],
        [2, 3, "#text", [], "October"],
        [1, 1, "INPUT", ["form", "upload", "name", "early", "value", "first"]],
        [1, 1, "FORM", ["id", "upload", "action", "/submit", "method", "post"]],
        [5, 1, "INPUT", ["name", "member", "value", "attr"]],
        [5, 1, "INPUT", ["name", "stray", "form", "missing", "value", "nope"]],
        [1, 1, "FORM", ["id", "local", "action", ""]],
        [8, 1, "TEXTAREA", ["name", "note", "form", "upload"]],
        [9, 3, "#text", [], "stale default"],
        [8, 1, "SELECT", ["name", "years", "form", "upload", "multiple", "multiple"]],
        [11, 1, "OPTGROUP", ["label", "Years"]],
        [12, 1, "OPTION", ["value", "2025"]],
        [13, 3, "#text", [], "Y2025"],
        [12, 1, "OPTION", ["value", "2026"]],
        [15, 3, "#text", [], "Y2026"],
        [11, 1, "OPTION", []],
        [17, 3, "#text", [], "All"],
        [8, 1, "INPUT", ["name", "kept", "value", "inside"]],
        [1, 1, "INPUT", ["form", "upload", "name", "account", "value", "brokerage"]],
        [1, 1, "DIV", ["id", "taken"]],
        [1, 1, "FORM", ["id", "taken"]],
        [1, 1, "INPUT", ["form", "taken", "name", "blocked", "value", "x"]],
        [1, 1, "AREA", ["href", "map.pdf", "title", "Map"]],
      ],
    },
    {
      url: "https://help.example/frame",
      base: "https://cdn.example/files/",
      rows: [
        [-1, 9, "#document", []],
        [0, 1, "A", ["href", "guide.html"]],
        [1, 3, "#text", [], "Guide"],
        [0, 1, "FORM", ["id", "upload", "action", "/frame-submit"]],
        [0, 1, "INPUT", ["form", "upload", "name", "framefield", "value", "yes"]],
      ],
    },
  ]);
  const s = (value: string) => { const at = dom.strings.indexOf(value); if (at >= 0) return at; dom.strings.push(value); return dom.strings.length - 1; };
  dom.documents[0]!.nodes.textValue = { index: [9], value: [s(note)] };
  dom.documents[0]!.nodes.inputValue = { index: [6, 9, 19, 20], value: [s("owner-now"), s("wrong-input-value"), s("inside"), s("brokerage")] };
  dom.documents[0]!.nodes.optionSelected = { index: [17, 15, 13] };
  const map = pageMap(dom, "after");
  assert.deepEqual(map.links, [
    { text: "October", href: "https://files.example.test/archive/october.pdf" },
    { text: "Map", href: "https://files.example.test/archive/map.pdf" },
    { text: "Guide", href: "https://cdn.example/files/guide.html", frame: "https://help.example/frame" },
  ]);
  assert.deepEqual(map.forms, [
    { action: "https://files.example.test/submit", method: "POST", fields: [
      { name: "early", type: "text", value: "first" },
      { name: "member", type: "text", value: "owner-now" },
      { name: "note", type: "textarea", value: note },
      { name: "years", type: "select", value: "2025, 2026, All" },
      { name: "account", type: "text", value: "brokerage" },
    ] },
    { action: "https://example.test/account", method: "GET", fields: [{ name: "kept", type: "text", value: "inside" }] },
    { action: "https://example.test/account", method: "GET", fields: [] },
    { action: "https://cdn.example/frame-submit", method: "GET", frame: "https://help.example/frame", fields: [{ name: "framefield", type: "text", value: "yes" }] },
  ]);
  assert.deepEqual(map.loose, [
    { name: "stray", type: "text", value: "nope" },
    { name: "blocked", type: "text", value: "x" },
  ]);
  assert.equal(map.selects[0]?.options.filter((option) => option.selected).map((option) => option.value).join(", "), "2025, 2026, All");
  const html = stepRecordBody("run-1", "step-1", {
    id: "step-1", waits: [], network: { total: 0, work: [], static: [], analytics: [] }, pages: {}, console: [], errors: [], map,
  });
  assert.match(html, /October statement attached/);
  assert.match(html, /https:\/\/files\.example\.test\/archive\/october\.pdf/);
  assert.match(html, /2025, 2026, All/);
  assert.match(html, /Fields outside a form/);
  assert.match(html, /account = brokerage/);
  assert.match(html, /No requests recorded for this step\./);
  assert.match(html, /No console messages, page errors, or failed loads recorded\./);
});

test("a step view reads the stored record and page files, and the raw files download as the tools wrote them", async (t) => {
  const home = await fixture(t);
  const index = await runRecordIndex(home, RUN);
  assert.deepEqual(index.steps.sort(), ["command-1", "command-2"]);
  assert.ok(index.harBytes! > 0);

  const view = await stepRecordView(home, RUN, "command-2");
  assert.ok(view);
  assert.equal(view.why, "Load the October statement.");
  assert.deepEqual(view.waits, [{ for: "click", ms: 300 }]);
  assert.deepEqual(view.network.work.map((row) => `${row.method} ${row.status} ${row.url}${row.operation ? ` ${row.operation}` : ""}`), [
    "GET 200 https://broker.example/statements",
    "POST 200 https://broker.example/graphql Statement",
    "GET 0 https://broker.example/go",
  ]);
  assert.equal(view.network.static.length, 3);
  assert.equal(view.network.analytics.length, 2);
  assert.deepEqual(view.pages.after, { url: "https://broker.example/statements", title: "Statements", scroll: { x: 0, y: 300 }, ms: 9, viewport: { width: 1280, height: 800 }, axNodes: 2, mhtml: true });
  assert.equal((view.pages.before as { axNodes?: number }).axNodes, undefined);
  assert.equal(view.map?.phase, "after");
  assert.deepEqual(view.console, [{ type: "warning", text: "slow" }]);
  assert.deepEqual(view.errors, [{ type: "error", text: "TypeError: boom" }]);

  const har = await stepRecordDownload(home, RUN, "command-2", "network.har");
  assert.equal((JSON.parse(String(har!.body)) as { log: { entries: unknown[] } }).log.entries.length, 8);
  const dom = JSON.parse(String((await stepRecordDownload(home, RUN, "command-2", "after.dom.json"))!.body)) as PageState;
  assert.equal(dom.ax, undefined);
  assert.ok(dom.dom);
  assert.deepEqual(JSON.parse(String((await stepRecordDownload(home, RUN, "command-2", "after.ax.json"))!.body)), { nodes: [{ nodeId: "1" }, { nodeId: "2" }] });
  assert.equal(String((await stepRecordDownload(home, RUN, "command-2", "after.mhtml"))!.body), "From: <Saved by Blink>\r\n");
  assert.equal(await stepRecordDownload(home, RUN, "command-2", "before.ax.json"), undefined);
  assert.equal(await stepRecordDownload(home, RUN, "command-2", "before.mhtml"), undefined);
  assert.equal(await stepRecordDownload(home, RUN, "command-2", "../run.har"), undefined);
  assert.equal(await stepRecordView(home, RUN, "../command-2"), undefined);
  assert.equal(await stepRecordView(home, "../runs", "command-2"), undefined);
  assert.deepEqual(await runRecordIndex(home, "run-none"), { steps: [] });
});

test("a step serves one request's HAR entry, and its archive as a page that runs no script and loads nothing from the web", async (t) => {
  const home = await fixture(t);
  const after = await writePageState(home, RUN, "command-3", "after", { state: pageState(true), mhtml: { data: sampleArchive() }, ms: 9 });
  await writeStepRecord(home, RUN, {
    schema: "bao.step-record/v1", id: "command-3", command: "click", args: ["@e5"], status: "passed", startedAt: "2026-11-14T00:00:02.000Z", endedAt: "2026-11-14T00:00:02.100Z",
    waits: [{ for: "click", ms: 100 }], page: { after },
    network: { entries: [
      { ...entry("GET", "https://broker.example/api/me", 200, "xhr", "application/json"), startedDateTime: "2026-11-14T00:00:02.050Z", response: { status: 200, bodySize: 44, content: { mimeType: "application/json", size: 120 } } },
      { ...entry("GET", "https://broker.example/old", 301, "document", "text/html"), startedDateTime: "not a time", response: { status: 301, bodySize: 0, content: { mimeType: "text/html", size: -1 } } },
    ] },
  });
  const view = (await stepRecordView(home, RUN, "command-3"))!;
  assert.deepEqual(view.network.work.map((row) => [row.index, row.at, row.bytes]), [[0, Date.parse("2026-11-14T00:00:02.050Z"), 120], [1, undefined, 0]]);
  const second = (await stepRecordDownload(home, RUN, "command-3", "request-1.json"))!;
  assert.equal((JSON.parse(String(second.body)) as { request: { url: string } }).request.url, "https://broker.example/old");
  assert.equal(await stepRecordDownload(home, RUN, "command-3", "request-2.json"), undefined);
  const page = (await stepRecordDownload(home, RUN, "command-3", "after.html"))!;
  assert.equal(page.page, true);
  assert.match(String(page.body), /<h1>October – Statement<\/h1>/);
  assert.match(String(page.body), /<style>\[data-bao-overlay\]\{display:none!important\}a,area\{pointer-events:none!important\}<\/style>$/);
  assert.equal(await stepRecordDownload(home, RUN, "command-3", "before.html"), undefined, "the step kept no before archive");
  assert.equal(await stepRecordDownload(home, RUN, "command-2", "after.html"), undefined, "a stored file that is not an archive gives no page");

  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  t.after(async () => {
    await app.close();
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  });
  const served = await fetch(`http://127.0.0.1:${app.port}/api/runs/${RUN}/steps/command-3/after.html`);
  assert.equal(served.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(served.headers.get("content-security-policy"), "sandbox; default-src 'none'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:; frame-src data:");
  assert.equal(served.headers.get("content-disposition"), null, "the page shows in place");
  const raw = await fetch(`http://127.0.0.1:${app.port}/api/runs/${RUN}/steps/command-3/after.mhtml`);
  assert.match(raw.headers.get("content-disposition") || "", /^attachment; filename="run-receipt-1-command-3-after\.mhtml"$/, "the raw archive still downloads");
});

test("the receipt shows why, a run.har download, and a step section only where a step record exists", async (t) => {
  const home = await fixture(t);
  const run = {
    id: RUN, workflowId: "agent-browser", kind: "capture", status: "passed", at: 0,
    steps: [
      { id: "command-1", status: "passed", label: "Open the page", startedAt: 0, endedAt: 10, why: "Open the statements." },
      { id: "command-2", status: "passed", label: "Click Load", startedAt: 10, endedAt: 20, why: "Load the October statement." },
      { id: "command-3", status: "passed", label: "Read the page", startedAt: 20, endedAt: 30 },
    ],
  } as unknown as RunSummary;
  const view = { run: { at: 0, stepCount: 3, modelCalls: null }, steps: [] } as unknown as ReturnType<typeof inspectRunView>;
  const html = runReceipt(view, "Statements", run, undefined, { index: await runRecordIndex(home, RUN), open: new Set(["command-2"]) });
  assert.match(html, new RegExp(`<a href="/api/runs/${RUN}/run.har" download="${RUN}.har">Download run.har</a>`));
  assert.match(html, /<strong>Why:<\/strong> Load the October statement\./);
  assert.equal(html.match(/The HAR leaves out cookies, request initiators, redirect targets, and multipart form bodies; each upload step lists its files' paths and SHA-256 instead\. Not recorded: the accessibility tree before a step, and a stable selector or frame for a step's target\./g)?.length, 1);
  assert.match(html, /<details class="receipt-record" data-record-step="command-1">/);
  assert.match(html, /<details class="receipt-record" data-record-step="command-2" open>/);
  assert.doesNotMatch(html, /data-record-step="command-3"/);
  assert.doesNotMatch(runReceipt(view, "Statements", run), /run\.har|data-record-step|Not recorded/);
});

test("the run.har size counts a megabyte as a million bytes, as Finder does", () => {
  const run = { id: RUN, workflowId: "agent-browser", kind: "capture", status: "passed", at: 0, steps: [] } as unknown as RunSummary;
  const view = { run: { at: 0, stepCount: 0, modelCalls: null }, steps: [] } as unknown as ReturnType<typeof inspectRunView>;
  const size = (harBytes: number) => / <span class="record-quiet">([^.]+(?:\.\d)?[^.]*)\. Every request/.exec(runReceipt(view, "Statements", run, undefined, { index: { harBytes, steps: [] }, open: new Set() }))?.[1];
  assert.equal(size(13_529_262), "13.5 MB");
  assert.equal(size(999), "999 bytes");
  assert.equal(size(1_000), "1 KB");
  assert.equal(size(150_499), "150 KB");
  assert.equal(size(999_499), "999 KB");
  assert.equal(size(999_500), "1.0 MB");
});

test("a step section lists real work first, files the rest behind counts, and links the raw files", async (t) => {
  const home = await fixture(t);
  const html = stepRecordBody(RUN, "command-2", (await stepRecordView(home, RUN, "command-2"))!);
  assert.match(html, /8 requests\. 3 did real work; 3 static files and 2 analytics requests are filed below them\./);
  assert.ok(html.indexOf("graphql") < html.indexOf("Static files (3)"));
  assert.match(html, /GraphQL Statement/);
  assert.match(html, /<summary>Analytics \(2\)<\/summary>/);
  for (const name of ["network.har", "before.dom.json", "after.dom.json", "after.ax.json", "after.mhtml"]) {
    assert.match(html, new RegExp(`href="/api/runs/${RUN}/steps/command-2/${name.replace(".", "\\.")}" download=`));
  }
  assert.doesNotMatch(html, /before\.ax\.json|before\.mhtml|Not recorded/);
  assert.match(html, /Waited 300 ms for click to finish\. Bao read the page in 4 ms before and 9 ms after, outside that wait\./);
  assert.match(html, /<summary>Links \(3\)<\/summary>/);
  assert.match(html, /password = Hidden/);
  assert.match(html, /TypeError: boom/);
  assert.match(html, /Load 404/);
  const empty = stepRecordBody(RUN, "command-1", (await stepRecordView(home, RUN, "command-1"))!);
  assert.match(empty, /No requests recorded for this step\./);
  assert.doesNotMatch(html, /No requests recorded for this step/);
  assert.doesNotMatch(html, /No console messages, page errors, or failed loads recorded/);
  assert.doesNotMatch(empty, /network\.har/);
  assert.match(empty, /Bao did not read the page for this step\./);
});
