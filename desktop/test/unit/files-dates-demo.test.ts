// Hermetic fixtures plus the three public demos. Practice sites only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { runField } from "../../src/app/views";
import { BrowserDriver } from "../../src/v1/browser-driver";
import { readCalendarSelection } from "../../src/v1/files-dates";
import { replay } from "../../src/v1/replay";
import { unavailableHeal } from "../../src/v1/heal";
import { WORKFLOW_SCHEMA_ID, type WorkflowStep, type WorkflowV2 } from "../../src/v1/schema";

const CLOCK = new Date("2026-10-22T15:00:00Z");
const ARTIFACTS = "/opt/cursor/artifacts";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

function workflow(partial: Pick<WorkflowV2, "id" | "name" | "startUrl" | "inputs" | "steps">): WorkflowV2 {
  return {
    schema: WORKFLOW_SCHEMA_ID,
    version: 3,
    filesDates: 1,
    createdAt: CLOCK.getTime(),
    ...partial,
  };
}

function step(partial: Omit<WorkflowStep, "index" | "timeoutMs" | "surface"> & { index?: number; timeoutMs?: number; surface?: WorkflowStep["surface"] }): WorkflowStep {
  return {
    index: partial.index ?? 0,
    timeoutMs: partial.timeoutMs ?? 20000,
    surface: partial.surface ?? "dom",
    ...partial,
  };
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function fixturePage(): string {
  return `<!doctype html>
<html><body>
<main>
  <a id="dl" href="/file.txt">Download note</a>
  <div id="picker" data-bao-picker>
    <p data-month-label>October 2026</p>
    <button type="button" data-nav="prev">Prev</button>
    <button type="button" data-nav="next">Next</button>
    <div id="days"></div>
    <p id="picked"></p>
  </div>
  <form action="/upload" method="post" enctype="multipart/form-data">
    <input id="file-upload" type="file" name="file">
    <button id="file-submit" type="submit">Upload</button>
  </form>
  <div id="uploaded-files"></div>
</main>
<script>
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  let y = 2026, m = 10;
  const label = document.querySelector("[data-month-label]");
  const days = document.getElementById("days");
  const picked = document.getElementById("picked");
  const selected = new Set();
  function render() {
    label.textContent = months[m - 1] + " " + y;
    days.innerHTML = "";
    const count = new Date(y, m, 0).getDate();
    for (let d = 1; d <= count; d++) {
      const iso = y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.date = iso;
      button.textContent = String(d);
      button.style.cssText = "width:28px;height:28px;margin:1px";
      if (selected.has(iso)) button.dataset.selected = "1";
      button.addEventListener("click", () => {
        selected.add(iso);
        button.dataset.selected = "1";
        picked.textContent = [...selected].sort().join(" ");
      });
      days.appendChild(button);
    }
  }
  document.querySelector("[data-nav=next]").addEventListener("click", () => { m += 1; if (m > 12) { m = 1; y += 1; } render(); });
  document.querySelector("[data-nav=prev]").addEventListener("click", () => { m -= 1; if (m < 1) { m = 12; y -= 1; } render(); });
  render();
</script>
</body></html>`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function withBrowser(fn: (browser: Browser) => Promise<void>): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    await fn(browser);
  } finally {
    await browser.close();
  }
}

describe("files and dates demos", { concurrency: 1 }, () => {
  test("date cells are computed from the resolved date", { timeout: 60_000 }, async () => {
    const site = await listen((req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(fixturePage());
      void req;
    });
    try {
      await withBrowser(async (browser) => {
        const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
        await page.goto(site.url);
        const doc = workflow({
          id: "wf-fixture-dates",
          name: "Fixture dates",
          startUrl: site.url,
          inputs: [
            { name: "checkIn", type: "date", relative: "+14d", format: "YYYY-MM-DD", zone: "UTC", required: true },
            { name: "checkOut", type: "date", relative: "+17d", format: "YYYY-MM-DD", zone: "UTC", required: true },
          ],
          steps: [step({
            id: "stay",
            action: "click",
            label: "Pick dates",
            identity: { surface: "dom", role: "button", tag: "button", path: [], id: "trap" },
            datePicker: { input: "checkIn", endInput: "checkOut" },
          })],
        });
        const result = await replay(doc, { checkIn: "+21d", checkOut: "+23d" }, new BrowserDriver(page), {
          clock: CLOCK,
          zone: "UTC",
          runId: "fixture-dates",
          heal: unavailableHeal(),
        });
        assert.equal(result.status, "passed", result.failure?.reason);
        assert.equal(result.modelCalls, 0);
        const picked = await page.locator("#picked").innerText();
        assert.equal(picked, "2026-11-12 2026-11-14");
      });
    } finally {
      await site.close();
    }
  });

  test("a download is templated, hashed, and uploaded through the bound file input", { timeout: 60_000 }, async () => {
    const payload = Buffer.from("hello bao chain\n");
    const site = await listen(async (req, res) => {
      const url = req.url || "/";
      if (url === "/file.txt") {
        res.setHeader("content-type", "application/octet-stream");
        res.setHeader("content-disposition", "attachment; filename=\"note.txt\"");
        res.end(payload);
        return;
      }
      if (url === "/upload" && req.method === "POST") {
        const body = await readBody(req);
        const name = /filename="([^"]+)"/.exec(body.toString("latin1"))?.[1] || "";
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(`<!doctype html><p>File Uploaded!</p><div id="uploaded-files">${name}</div>`);
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(fixturePage());
    });
    try {
      await withBrowser(async (browser) => {
        const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
        const root = mkdtempSync(path.join(tmpdir(), "bao-fixture-dl-"));
        const doc = workflow({
          id: "wf-fixture-chain",
          name: "Fixture chain",
          startUrl: site.url,
          inputs: [
            { name: "company", type: "text", default: "acme" },
            { name: "upload", type: "file", fromOutput: "note", required: false },
          ],
          steps: [
            step({
              id: "dl",
              index: 0,
              action: "download",
              label: "Download",
              download: { output: "note", name: "{{run.date}}-{{company}}-{{suggested}}", url: `${site.url}/file.txt` },
            }),
            step({
              id: "back",
              index: 1,
              action: "open",
              label: "Open upload",
              open: { target: "url", url: `${site.url}/` },
            }),
            step({
              id: "up",
              index: 2,
              action: "upload",
              label: "Upload",
              input: "upload",
              value: "{{upload}}",
              fileFrom: "note",
              identity: { surface: "dom", role: "textbox", tag: "input", path: [], id: "file-upload" },
            }),
            step({
              id: "submit",
              index: 3,
              action: "click",
              label: "Submit",
              identity: { surface: "dom", role: "button", tag: "button", path: [], id: "file-submit", text: "Upload" },
            }),
            step({
              id: "see",
              index: 4,
              action: "verify",
              label: "Filename is shown",
              expect: { kind: "text", match: "2026-10-22-acme-note.txt", timeoutMs: 8000 },
            }),
          ],
        });
        const result = await replay(doc, { company: "acme" }, new BrowserDriver(page), {
          clock: CLOCK,
          zone: "UTC",
          runId: "fixture-chain",
          downloadDir: root,
          heal: unavailableHeal(),
        });
        assert.equal(result.status, "passed", `${result.failure?.phase || ""} ${result.failure?.reason || ""}`);
        assert.equal(result.modelCalls, 0);
        const file = result.files?.note;
        assert.ok(file);
        assert.equal(file.name, "2026-10-22-acme-note.txt");
        assert.equal(file.sha256, createHash("sha256").update(payload).digest("hex"));
        assert.equal(await page.locator("#uploaded-files").innerText(), file.name);
      });
    } finally {
      await site.close();
    }
  });

  test("the run form previews the resolved date in light and dark", { timeout: 60_000 }, async () => {
    const sheet = readFileSync("desktop/src/app/public/index.html", "utf8").match(/<style>([\s\S]*?)<\/style>/)?.[1] || "";
    const fields = [
      runField({ name: "checkIn", type: "date", label: "Check in", relative: "+14d", format: "D MMM YYYY", zone: "UTC", required: true }, undefined, CLOCK),
      runField({ name: "checkOut", type: "date", label: "Check out", relative: "+17d", format: "D MMM YYYY", zone: "UTC", required: true }, undefined, CLOCK),
      runField({ name: "monday", type: "date", label: "Next Monday", relative: "next monday", format: "D MMM YYYY", zone: "UTC" }, undefined, CLOCK),
      runField({ name: "month", type: "date", label: "First of next month", relative: "first of next month", format: "D MMM YYYY", zone: "UTC" }, undefined, CLOCK),
      runField({ name: "statement", type: "file", label: "Statement", fromOutput: "statement", boundStep: "Download W-9" }),
    ].join("");
    const html = (theme: string) => `<!doctype html><html lang="en" data-theme="${theme}"><head><style>${sheet}</style></head><body><main id="main"><section class="card"><h2>Run inputs</h2>${fields}</section></main></body></html>`;
    mkdirSync(ARTIFACTS, { recursive: true });
    await withBrowser(async (browser) => {
      const page = await browser.newPage({ viewport: { width: 720, height: 640 }, deviceScaleFactor: 2 });
      for (const theme of ["light", "dark"] as const) {
        await page.setContent(html(theme));
        const resolved = await page.locator(".date-preview").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-resolved")));
        assert.deepEqual(resolved, ["5 Nov 2026", "8 Nov 2026", "26 Oct 2026", "1 Nov 2026"]);
        assert.equal(await page.locator(".drop input").count(), 0);
        assert.equal(await page.locator(".drop span").innerText(), "From this run: Download W-9");
        const file = path.join(ARTIFACTS, `date_form_${theme}.png`);
        await page.screenshot({ path: file });
        const png = readFileSync(file);
        assert.equal(png[0], 0x89);
        assert.ok(png.length > 5000);
      }
    });
  });

  test("restful-booker selects the replayed check-in and check-out cells", { timeout: 120_000 }, async () => {
    mkdirSync(ARTIFACTS, { recursive: true });
    const videoDir = mkdtempSync(path.join(tmpdir(), "bao-video-"));
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: UA,
      recordVideo: { dir: videoDir, size: { width: 1280, height: 900 } },
    });
    const page = await context.newPage();
    const start = "https://automationintesting.online/reservation/1?checkin=2027-06-01&checkout=2027-06-04";
    let failure: unknown;
    try {
      const doc = workflow({
        id: "wf-booker",
        name: "Restful booker dates",
        startUrl: start,
        inputs: [
          { name: "checkIn", type: "date", label: "Check in", relative: "+14d", format: "YYYY-MM-DD", zone: "UTC", required: true },
          { name: "checkOut", type: "date", label: "Check out", relative: "+17d", format: "YYYY-MM-DD", zone: "UTC", required: true },
        ],
        steps: [
          step({
            id: "open",
            index: 0,
            action: "open",
            label: "Open the room",
            open: { target: "url", url: start },
          }),
          step({
            id: "stay",
            index: 1,
            action: "click",
            label: "Pick dates",
            datePicker: { input: "checkIn", endInput: "checkOut" },
            identity: { surface: "dom", role: "group", tag: "div", path: [] },
          }),
        ],
      });
      const result = await replay(doc, { checkIn: "+21d", checkOut: "+23d" }, new BrowserDriver(page), {
        clock: CLOCK,
        zone: "UTC",
        runId: "booker",
        heal: unavailableHeal(),
      });
      const selected = await page.evaluate(readCalendarSelection).catch(() => ({ isos: [] as string[], reserve: false }));
      assert.equal(result.status, "passed", `${result.failure?.phase || ""} ${result.failure?.reason || ""} ${JSON.stringify(selected)}`);
      assert.equal(result.modelCalls, 0);
      assert.equal(selected.reserve, true, JSON.stringify(selected));
      assert.ok(selected.isos.includes("2026-11-12"), JSON.stringify(selected));
      assert.ok(selected.isos.includes("2026-11-14"), JSON.stringify(selected));
      const reserve = page.getByRole("button", { name: /reserve/i });
      await reserve.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1000);
      writeFileSync(path.join(ARTIFACTS, "booking-selection.json"), JSON.stringify({ selected, modelCalls: result.modelCalls, status: result.status }, null, 2));
    } catch (err) {
      failure = err;
      const shot = path.join(ARTIFACTS, "booking-failure.png");
      await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      writeFileSync(path.join(ARTIFACTS, "booking-failure.txt"), `${page.url()}\n${err instanceof Error ? err.stack : String(err)}\n`);
    } finally {
      const video = page.video();
      await context.close();
      if (video) await video.saveAs(path.join(ARTIFACTS, "replay_booking_dates.webm"));
      await browser.close();
    }
    if (failure) throw failure;
  });

  test("the IRS W-9 downloads twice to the same templated hash", { timeout: 120_000 }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bao-w9-"));
    const url = "https://www.irs.gov/pub/irs-pdf/fw9.pdf";
    const doc = workflow({
      id: "wf-w9",
      name: "W-9",
      startUrl: url,
      inputs: [{ name: "company", type: "text", default: "irs" }],
      steps: [step({
        id: "dl",
        action: "download",
        label: "Download W-9",
        download: { output: "statement", name: "{{run.date}}-{{company}}-statement.pdf", url },
      })],
    });
    const hashes: string[] = [];
    const paths: string[] = [];
    await withBrowser(async (browser) => {
      for (const runId of ["w9-a", "w9-b"]) {
        const context = await browser.newContext({ acceptDownloads: true, userAgent: UA });
        const page = await context.newPage();
        try {
          const result = await replay(doc, { company: "irs" }, new BrowserDriver(page), {
            clock: CLOCK,
            zone: "UTC",
            runId,
            downloadDir: root,
            heal: unavailableHeal(),
          });
          assert.equal(result.status, "passed", `${result.failure?.phase || ""} ${result.failure?.reason || ""}`);
          assert.equal(result.modelCalls, 0);
          const file = result.files?.statement;
          assert.ok(file);
          assert.equal(file.name, "2026-10-22-irs-statement.pdf");
          const bytes = readFileSync(file.path);
          assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
          hashes.push(file.sha256);
          paths.push(file.path);
        } finally {
          await context.close();
        }
      }
    });
    assert.equal(hashes[0], hashes[1]);
    assert.notEqual(paths[0], paths[1]);
    writeFileSync(path.join(ARTIFACTS, "w9-downloads.json"), JSON.stringify({ sha256: hashes[0], paths, name: "2026-10-22-irs-statement.pdf" }, null, 2));
  });

  test("a downloaded file uploads to the-internet and the filename is shown", { timeout: 120_000 }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bao-internet-"));
    const fileUrl = "https://the-internet.herokuapp.com/download/some-file.txt";
    const uploadUrl = "https://the-internet.herokuapp.com/upload";
    const doc = workflow({
      id: "wf-internet",
      name: "Download then upload",
      startUrl: uploadUrl,
      inputs: [
        { name: "company", type: "text", default: "acme" },
        { name: "upload", type: "file", fromOutput: "note", required: false },
      ],
      steps: [
        step({
          id: "dl",
          index: 0,
          action: "download",
          label: "Download",
          download: { output: "note", name: "{{run.date}}-{{company}}-{{suggested}}", url: fileUrl },
        }),
        step({
          id: "open",
          index: 1,
          action: "open",
          label: "Open upload",
          open: { target: "url", url: uploadUrl },
        }),
        step({
          id: "up",
          index: 2,
          action: "upload",
          label: "Upload",
          input: "upload",
          value: "{{upload}}",
          fileFrom: "note",
          identity: { surface: "dom", role: "textbox", tag: "input", path: [], id: "file-upload" },
        }),
        step({
          id: "submit",
          index: 3,
          action: "click",
          label: "Upload",
          identity: { surface: "dom", role: "button", tag: "button", path: [], id: "file-submit", text: "Upload" },
        }),
        step({
          id: "see",
          index: 4,
          action: "verify",
          label: "Filename is shown",
          expect: { kind: "text", match: "some-file.txt", timeoutMs: 15000 },
        }),
      ],
    });
    await withBrowser(async (browser) => {
      const context = await browser.newContext({ acceptDownloads: true, userAgent: UA });
      const page = await context.newPage();
      try {
        const result = await replay(doc, { company: "acme" }, new BrowserDriver(page), {
          clock: CLOCK,
          zone: "UTC",
          runId: "internet",
          downloadDir: root,
          heal: unavailableHeal(),
        });
        assert.equal(result.status, "passed", `${result.failure?.phase || ""} ${result.failure?.reason || ""}`);
        assert.equal(result.modelCalls, 0);
        const file = result.files?.note;
        assert.ok(file);
        assert.equal(file.name, "2026-10-22-acme-some-file.txt");
        assert.match(file.sha256, /^[a-f0-9]{64}$/);
        const shown = await page.locator("#uploaded-files").innerText();
        assert.equal(shown.trim(), file.name);
        writeFileSync(path.join(ARTIFACTS, "upload-chain.json"), JSON.stringify({ name: file.name, sha256: file.sha256, shown: shown.trim() }, null, 2));
      } finally {
        await context.close();
      }
    });
  });
});
