import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { runRecordIndex, stepRecordView } from "../../src/app/step-record-view";
import { axOutline, openPhase, requestDetail, shotAt, stepAt, traceShell, traceSnapshot, traceTabs, type TraceRun } from "../../src/app/trace-view";
import { writeStepRecord, type HarEntry, type StepNetworkRecord } from "../../src/engines/step-har";
import { PAGE_STATE_SCHEMA, writePageState, type PageState } from "../../src/engines/step-page";
import { testChromium } from "../../src/test-browser";
import { scaledMs } from "../runtime";
import { ARCHIVE_PICTURE, sampleArchive } from "../support/mhtml";

const RUN = "run-trace-1";
const AT = Date.parse("2026-11-14T00:00:00.000Z");

function entry(method: string, url: string, status: number, type: string, extra: { statusText?: string; body?: string; at?: number } = {}): HarEntry {
  return {
    startedDateTime: new Date(AT + (extra.at ?? 5100)).toISOString(), time: 12.4, _resourceType: type,
    request: { method, url, headers: [{ name: "Accept", value: "*/*" }], queryString: [], cookies: [] },
    response: {
      status, statusText: extra.statusText ?? "", headers: [{ name: "content-type", value: "application/json" }], cookies: [], redirectURL: "", bodySize: 31,
      content: { mimeType: status ? "application/json" : "application/octet-stream", size: 31, ...(extra.body ? { text: extra.body } : {}) },
    },
  };
}

const run: TraceRun = {
  id: RUN, workflowId: "agent-browser", kind: "capture", pageEngine: "agent-browser", status: "failed", at: AT, task: "Download the October statement",
  steps: [
    { id: "command-1", status: "passed", label: "Open broker.example/statements", startedAt: AT, endedAt: AT + 2000, why: "Open the statements page.",
      native: { command: "open", args: ["https://broker.example/statements"], results: [{ stdout: "✓ Done\n", stderr: "", exitCode: 0 }] }, afterShotError: "Page screenshot unavailable: owner input is private." },
    { id: "command-2", status: "passed", label: `Click "<img src=x onerror=alert(1)>"`, startedAt: AT + 5000, endedAt: AT + 6000, why: "Open the October statement.",
      native: { command: "click", args: ["@e4"], results: [{ stdout: "✓ Done\n", stderr: "", exitCode: 0 }] },
      beforeShot: "command-2-before.png", afterShot: "command-2-after.png", target: { rect: { x: 120, y: 200, width: 240, height: 40 }, viewport: { width: 1200, height: 800 } } },
    { id: "command-3", status: "failed", label: "Fill Password", startedAt: AT + 9000, endedAt: AT + 10000, reason: "Unknown ref: e9",
      native: { command: "fill", args: ["@e9", "hunter2"], results: [{ stdout: "", stderr: "✗ Unknown ref: e9\n", exitCode: 1 }] } },
  ],
};

function pageState(): PageState {
  return {
    schema: PAGE_STATE_SCHEMA, capturedAt: "2026-11-14T00:00:06.000Z", url: "https://broker.example/statements/2026-10", title: "October statement",
    scroll: { x: 0, y: 0 }, layout: { cssLayoutViewport: { clientWidth: 1200, clientHeight: 800 } }, dom: { documents: [], strings: [] },
    ax: { nodes: [
      { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "October statement" }, childIds: ["2"] },
      { nodeId: "2", parentId: "1", ignored: true, role: { value: "none" }, childIds: ["3", "4"] },
      { nodeId: "3", parentId: "2", role: { value: "link" }, name: { value: "Download PDF" }, childIds: ["5"] },
      { nodeId: "4", parentId: "2", role: { value: "button" }, name: { value: "" } },
      { nodeId: "5", parentId: "3", role: { value: "StaticText" }, name: { value: "Download PDF" }, childIds: ["6"] },
      { nodeId: "6", parentId: "5", role: { value: "InlineTextBox" }, name: { value: "Download PDF" } },
    ] },
  };
}

/** A Library home with the run's pictures and two step records: `command-2` with both page reads and an archive, `command-3` with none. */
async function fixture(t: test.TestContext): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "bao-trace-view-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "shots", "runs", RUN), { recursive: true });
  for (const name of ["command-2-before.png", "command-2-after.png"]) await writeFile(path.join(home, "shots", "runs", RUN, name), Buffer.from(ARCHIVE_PICTURE, "base64"));
  const before = await writePageState(home, RUN, "command-2", "before", { state: pageState(), ms: 4 });
  const after = await writePageState(home, RUN, "command-2", "after", { state: pageState(), mhtml: { data: sampleArchive() }, ms: 9 });
  const record: StepNetworkRecord = {
    schema: "bao.step-record/v1", id: "command-2", command: "click", args: ["@e4"], why: "Open the October statement.", status: "passed",
    startedAt: new Date(AT + 5000).toISOString(), endedAt: new Date(AT + 6000).toISOString(), waits: [{ for: "click", ms: 1000 }],
    network: { entries: [
      entry("GET", "https://broker.example/statements/2026-10", 200, "document", { body: `{"note":"<b>bold</b>"}` }),
      entry("GET", "https://broker.example/api/missing", 500, "xhr", { at: 5200 }),
      entry("POST", "https://o1.ingest.example/envelope", 0, "fetch", { statusText: "net::ERR_BLOCKED_BY_CLIENT", at: 5300 }),
      entry("GET", "https://files.example/statement.pdf?Signature=abc", 0, "xhr", { at: 5400 }),
    ] },
    target: { ref: "@e4", role: "link", name: "October 2026", box: { x: 120, y: 200, width: 240, height: 40 } },
    page: { before, after },
    console: { command: ["console"], success: true, result: { messages: [{ type: "warning", text: "slow <script>" }] } },
    errors: { command: ["errors"], success: true, result: { errors: [{ text: "TypeError: boom" }] } },
  };
  await writeStepRecord(home, RUN, record);
  await writeStepRecord(home, RUN, { ...record, id: "command-3", command: "fill", args: ["@e9", "hunter2"], status: "failed", error: "Unknown ref: e9", network: { entries: [] }, page: undefined, target: undefined, console: undefined, errors: undefined });
  return home;
}

test("the trace page lists each step with its why and time, and places each on the timeline", () => {
  const html = traceShell(run, { steps: ["command-2", "command-3"], harBytes: 13_529_262 });
  assert.match(html, /<a class="back" href="\/\?run=run-trace-1">/);
  assert.match(html, /<h1>Download the October statement<\/h1>\s*<span class="status failed">failed<\/span>/);
  const bars = [...html.matchAll(/class="bar (\w+)[^"]*" data-step="(\d)" style="left:([\d.]+)%;width:([\d.]+)%"/g)].map((match) => match.slice(1, 5));
  assert.deepEqual(bars, [["passed", "0", "0", "20"], ["passed", "1", "50", "10"], ["failed", "2", "90", "10"]]);
  assert.match(html, /data-step="0"><span class="n">1<\/span><span class="title">Open broker\.example\/statements<\/span><span class="took">2\.0 s<\/span><span class="why">Open the statements page\.<\/span>/);
  assert.match(html, /<span class="mark" aria-label="Failed">✗<\/span>Fill Password/);
  assert.doesNotMatch(html, /<img src=x/, "a step label is text, not markup");
  assert.match(html, /3, 2 with a step record/);
  assert.match(html, /run\.har<\/a>, 13\.5 MB/);
});

test("a time on the timeline picks the latest step that had started, and the newest picture kept by then", () => {
  assert.deepEqual([AT - 1, AT + 4999, AT + 5000, AT + 99_000].map((time) => stepAt(run, time)), [0, 0, 1, 2]);
  assert.equal(shotAt(run, AT + 4999), "");
  assert.equal(shotAt(run, AT + 5500), `/api/runs/${RUN}/shots/command-2-before.png`);
  assert.equal(shotAt(run, AT + 6000), `/api/runs/${RUN}/shots/command-2-after.png`);
});

test("a step opens on the picture with its target's box, offers the stored archive beside it, and says why a picture is missing", async (t) => {
  const home = await fixture(t);
  const [open, click, fill] = run.steps!;
  const record = await stepRecordView(home, RUN, "command-2");
  assert.equal(openPhase(run, click!, record), "before");
  const before = traceSnapshot(run, click!, record, "before", "picture");
  assert.match(before, /<img src="\/api\/runs\/run-trace-1\/shots\/command-2-before\.png"[^>]*><span class="target" style="left:10%;top:25%;width:20%;height:5%"><\/span>/);
  assert.match(before, /<strong>October statement<\/strong> https:\/\/broker\.example\/statements\/2026-10/);
  assert.doesNotMatch(before, /data-source=/, "the before read kept no archive, so there is nothing to switch to");
  const after = traceSnapshot(run, click!, record, "after", "page");
  assert.match(after, /<iframe class="archive" sandbox="" src="\/api\/runs\/run-trace-1\/steps\/command-2\/after\.html"[^>]*data-width="1200">/);
  assert.match(after, /data-source="picture" aria-pressed="false">Screenshot<\/button><button type="button" data-source="page" aria-pressed="true">Snapshot</);
  assert.doesNotMatch(traceSnapshot(run, click!, record, "after", "picture"), /class="target"/, "the box was measured before the step");
  assert.equal(openPhase(run, open!, undefined), "after");
  assert.match(traceSnapshot(run, open!, undefined, "after", "picture"), /<p class="empty">Page screenshot unavailable: owner input is private\.<\/p>/);
  assert.match(traceSnapshot(run, fill!, await stepRecordView(home, RUN, "command-3"), "before", "picture"), /Bao kept no picture or page archive of the page before this step\./);
});

test("a step's tabs show its call, errors, console, requests in the order they ran, and files; a step with no record says so", async (t) => {
  const home = await fixture(t);
  const [open, click, fill] = run.steps!;
  const html = traceTabs(run, click!, await stepRecordView(home, RUN, "command-2"), "network");
  assert.match(html, /data-tab="errors" aria-selected="false">Errors <span class="count failed">3<\/span>/);
  assert.match(html, /data-tab="console" aria-selected="false">Console <span class="count">1<\/span>/);
  assert.match(html, /data-tab="network" aria-selected="true">Network <span class="count">4<\/span>/);
  assert.match(html, /data-panel="call" hidden>/);
  assert.match(html, /<dt>Command<\/dt><dd><code>click @e4<\/code><\/dd>/);
  assert.match(html, /<dt>Started<\/dt><dd>0:05\.0 into the run<\/dd>/);
  assert.match(html, /<dt>Target<\/dt><dd>@e4 link &quot;October 2026&quot;, box 120, 200, 240 × 40<\/dd>/);
  const rows = [...html.matchAll(/<tr data-request="(\d)" tabindex="0"( class="failed")?>\s*<td class="url" title="([^"]+)">[\s\S]*?<td>(\w+)<\/td><td title="([^"]*)">([^<]+)<\/td>/g)].map((match) => match.slice(1, 7));
  assert.deepEqual(rows, [
    ["0", undefined, "https://broker.example/statements/2026-10", "GET", "", "200"],
    ["1", ` class="failed"`, "https://broker.example/api/missing", "GET", "", "500"],
    ["2", ` class="failed"`, "https://o1.ingest.example/envelope", "POST", "net::ERR_BLOCKED_BY_CLIENT", "failed"],
    ["3", undefined, "https://files.example/statement.pdf?Signature=abc", "GET", "", "no response"],
  ]);
  assert.match(html, /<td class="num">0:05\.2<\/td><td class="num">12 ms<\/td><td class="num">31 bytes<\/td>/);
  const errors = /data-panel="errors"[^>]*>([\s\S]*?)<\/div><div class="panel"/.exec(html)![1]!;
  assert.match(errors, /Page error<\/span><span>TypeError: boom/);
  assert.match(errors, /Load 500<\/span><span>https:\/\/broker\.example\/api\/missing/);
  assert.match(errors, /Load failed<\/span><span>https:\/\/o1\.ingest\.example\/envelope <em>net::ERR_BLOCKED_BY_CLIENT<\/em>/);
  assert.doesNotMatch(errors, /statement\.pdf/);
  assert.match(html, /<span class="key">warning<\/span><span>slow &lt;script&gt;<\/span>/);
  assert.match(html, /data-ax="\/api\/runs\/run-trace-1\/steps\/command-2\/after\.ax\.json"/);
  const failed = traceTabs(run, fill!, await stepRecordView(home, RUN, "command-3"), "call");
  assert.match(failed, /<code>fill @e9 Hidden<\/code>/, "a value typed into a password field reads Hidden, as in the receipt");
  assert.match(failed, /<span class="key">Step<\/span><span>Unknown ref: e9<\/span>/);
  assert.match(failed, /<dt>Error output<\/dt><dd><pre>✗ Unknown ref: e9<\/pre>/);
  const bare = traceTabs(run, open!, undefined, "call");
  assert.equal(bare.match(/Bao kept no step record for this step\./g)?.length, 4, "errors, console, network and page each say so");
  assert.match(bare, /<code>open https:\/\/broker\.example\/statements<\/code>/);
  assert.match(bare, /This step saved or attached no files\./);
});

test("a request's detail prints its headers and bodies as text, and says when Chrome failed it", () => {
  const detail = requestDetail(entry("GET", "https://broker.example/statements/2026-10", 200, "document", { body: `{"note":"<b>bold</b>"}` }));
  assert.match(detail, /<strong>GET<\/strong> https:\/\/broker\.example\/statements\/2026-10/);
  assert.match(detail, /<h4>Request headers<\/h4><dl class="facts"><dt>Accept<\/dt><dd>\*\/\*<\/dd>/);
  assert.match(detail, /<h4>Response body<\/h4><pre>\{\n {2}&quot;note&quot;: &quot;&lt;b&gt;bold&lt;\/b&gt;&quot;\n\}<\/pre>/);
  assert.match(requestDetail(entry("POST", "https://o1.ingest.example/envelope", 0, "fetch", { statusText: "net::ERR_BLOCKED_BY_CLIENT" })), /Chrome failed this request: net::ERR_BLOCKED_BY_CLIENT/);
  assert.match(requestDetail(entry("GET", "https://files.example/statement.pdf", 0, "xhr")), /No response was recorded for this request\./);
  assert.match(requestDetail(entry("GET", "https://a.example/big.js", 200, "script", { body: "x".repeat(60_000) })), /The first 50,000 of 60,000 characters\./);
});

test("the accessibility tree reads as an outline of roles and names, with ignored nodes passing their children up", () => {
  assert.equal(axOutline(pageState().ax), `RootWebArea "October statement"\n  link "Download PDF"\n    "Download PDF"\n  button`);
  assert.equal(axOutline(undefined), "");
});

test("the receipt opens the trace view, which loads each step from its stored files and leads back to the receipt", { timeout: scaledMs(60_000) }, async (t) => {
  const home = await fixture(t);
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  t.after(async () => {
    await browser.close();
    await app.close();
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  });
  app.library.saveRun({ ...run, heals: [] } as never);
  assert.deepEqual((await runRecordIndex(home, RUN)).steps.sort(), ["command-2", "command-3"]);
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${app.port}`;
  await page.goto(url);
  await page.locator(`[data-open-run="${RUN}"]`).click();
  await page.locator("#run-receipt").getByRole("link", { name: "Open trace" }).click();
  await page.locator('#actions .action[aria-current="true"]').waitFor();
  assert.equal(new URL(page.url()).pathname, "/trace");
  assert.equal(await page.locator('#actions [aria-current="true"] .title').innerText(), "✗Fill Password", "the trace opens on the failed step");
  assert.match(await page.locator('[data-panel="call"]').innerText(), /fill @e9 Hidden/);

  await page.keyboard.press("ArrowUp");
  await page.locator("#snapshot .shot img").waitFor();
  assert.equal(new URL(page.url()).searchParams.get("step"), "2");
  assert.equal(await page.locator("#snapshot .shot img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), 1);
  assert.equal(await page.locator("#snapshot .target").count(), 1);
  assert.equal(await page.locator('#timeline .bar[aria-current="true"]').innerText(), "2");

  await page.locator('[data-phase="after"]').click();
  await page.locator('[data-source="page"]').click();
  const frame = page.frameLocator("iframe.archive");
  assert.equal(await frame.locator("h1").innerText(), "October – Statement");
  assert.equal(await frame.locator("h1").evaluate((el) => getComputedStyle(el).color), "rgb(0, 200, 5)", "the archive's stylesheet applies");
  assert.equal(await frame.locator("[data-bao-overlay]").evaluate((el) => getComputedStyle(el).display), "none");
  const archive = await fetch(`${url}/api/runs/${RUN}/steps/command-2/after.html`);
  assert.match(archive.headers.get("content-security-policy") || "", /^sandbox; default-src 'none'/);
  assert.equal(archive.headers.get("content-disposition"), null);

  await page.locator('[data-tab="network"]').click();
  await page.locator('tr[data-request="0"]').click();
  await page.locator(".request-row .request").waitFor();
  assert.match(await page.locator(".request-row").innerText(), /Response body\s*\{\s*"note": "<b>bold<\/b>"/);
  assert.equal(await page.locator(".request-row b").count(), 0, "a response body is text, not markup");
  await page.locator('tr[data-request="0"]').click();
  assert.equal(await page.locator(".request-row").count(), 0);
  await page.locator(".net-filter").fill("envelope");
  assert.deepEqual(await page.locator("tr[data-request]:visible").evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.request)), ["2"]);
  await page.locator(".net-filter").fill("");

  await page.locator("#actions .action").first().click();
  await page.locator("#snapshot .empty").waitFor();
  assert.equal(await page.locator('[data-panel="network"]').innerText(), "Bao kept no step record for this step.", "the picked tab stays open across steps");
  assert.match(await page.locator("#snapshot .empty").innerText(), /owner input is private/);

  await page.locator("#bar .back").click();
  await page.locator("#run-receipt h2").waitFor();
  assert.equal(await page.locator("#run-receipt h2").innerText(), "Download the October statement");
  assert.deepEqual(errors, []);
});
