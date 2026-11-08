import { testWorkflow } from "../support/workflow";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { Browser } from "playwright";
import { testChromium as chromium } from "../../src/test-browser.js";
import { BrowserDriver } from "../../src/v1/browser-driver";
import { readCalendarSelection } from "../../src/v1/files-dates";
import { unavailableHeal } from "../../src/v1/heal";
import { replay } from "../../src/v1/replay";
import { WORKFLOW_SCHEMA_ID, type WorkflowV2 } from "../../src/v1/schema";
import { testArtifacts, tryWriteEvidence } from "../artifacts";
import { liveSkip, offOriginFailureUrl, ownApiOutage, probeSite, type SiteProbe } from "../runtime";

const CLOCK = new Date("2026-10-22T15:00:00Z");
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const liveOnly = process.env.BAO_LIVE_TESTS === "1" ? false : "set BAO_LIVE_TESTS=1";

function workflow(partial: Pick<WorkflowV2, "id" | "name" | "startUrl" | "inputs" | "steps">): WorkflowV2 {
  return testWorkflow({
    schema: WORKFLOW_SCHEMA_ID,
    createdAt: CLOCK.getTime(),
    ...partial,
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

async function requireSite(t: TestContext, url: string): Promise<SiteProbe | undefined> {
  const probe = await probeSite(url);
  const dir = testArtifacts("files-dates-public");
  const name = createHash("sha256").update(url).digest("hex").slice(0, 12);
  await tryWriteEvidence(() => writeFileSync(path.join(dir, `probe-${name}.json`), `${JSON.stringify(probe)}\n`));
  const outage = liveSkip(probe);
  if (outage) {
    t.skip(`infrastructure ${outage.result} http=${outage.status} ${url}`);
    return undefined;
  }
  return probe;
}

function failureForSkip(
  probe: SiteProbe,
  failure: { phase?: string; reason?: string } | undefined,
  network: { url: string; status?: number }[] | undefined,
): { phase?: string; reason?: string; url?: string } | undefined {
  if (!failure) return undefined;
  const url = offOriginFailureUrl(probe.url, network);
  return url ? { ...failure, url } : failure;
}

test("restful-booker selects the replayed check-in and check-out cells", { timeout: 120_000, skip: liveOnly }, async (t) => {
  const start = "https://automationintesting.online/reservation/1?checkin=2027-06-01&checkout=2027-06-04";
  const probe = await requireSite(t, start);
  if (!probe) return;
  const shots = testArtifacts("files-dates-public");
  const videoDir = mkdtempSync(path.join(tmpdir(), "bao-video-"));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: UA,
    recordVideo: { dir: videoDir, size: { width: 1280, height: 900 } },
  });
  const page = await context.newPage();
  let failure: unknown;
  try {
    const doc = workflow({
      id: "wf-booker",
      name: "Restful booker dates",
      startUrl: start,
      inputs: [
        {
          name: "checkIn",
          type: "date",
          label: "Check in",
          supply: "must",
          format: "YYYY-MM-DD",
          relative: "+14d",
          zone: "UTC",
        },
        {
          name: "checkOut",
          type: "date",
          label: "Check out",
          supply: "must",
          format: "YYYY-MM-DD",
          relative: "+17d",
          zone: "UTC",
        },
      ],
      steps: [
        {
          id: "open",
          index: 0,
          timeoutMs: 20000,
          caption: { text: "Open the room" },
          action: "open",
          open: { target: "url", url: start },
        },
        {
          id: "stay",
          index: 1,
          timeoutMs: 20000,
          caption: { text: "Pick dates" },
          action: "pickDate",
          date: { input: "checkIn", endInput: "checkOut" },
          target: { locators: [], hint: { role: "group", surface: "dom", tag: "div" } },
        },
      ],
    });
    const result = await replay(doc, { checkIn: "+21d", checkOut: "+23d" }, new BrowserDriver(page), {
      clock: CLOCK,
      zone: "UTC",
      runId: "booker",
      heal: unavailableHeal(),
    });
    const selected = await page.evaluate(readCalendarSelection).catch(() => ({ isos: [] as string[], reserve: false }));
    const outage = result.status === "passed"
      ? undefined
      : (liveSkip(probe, failureForSkip(probe, result.failure, result.network))
        ?? ownApiOutage(start, result.failure, result.network));
    if (outage) {
      console.log(`live ${start} http=${outage.status} result=${outage.result} phase=${result.failure?.phase || ""}`);
      await tryWriteEvidence(() => writeFileSync(path.join(shots, "booking-outage.json"), JSON.stringify({ probe, outage, failure: result.failure, selected }, null, 2)));
      t.skip(`infrastructure ${outage.result} http=${outage.status} ${start}`);
      return;
    }
    assert.equal(result.status, "passed", `product failure after HTTP ${probe.status} ${result.failure?.phase || ""} ${result.failure?.reason || ""} ${JSON.stringify(selected)}`);
    assert.equal(result.modelCalls, 0);
    assert.equal(selected.reserve, true, JSON.stringify(selected));
    assert.ok(selected.isos.includes("2026-11-12"), JSON.stringify(selected));
    assert.ok(selected.isos.includes("2026-11-14"), JSON.stringify(selected));
    const reserve = page.getByRole("button", { name: /reserve/i });
    await reserve.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1000);
    await tryWriteEvidence(() => writeFileSync(path.join(shots, "booking-selection.json"), JSON.stringify({ selected, modelCalls: result.modelCalls, status: result.status, http: probe.status }, null, 2)));
  } catch (err) {
    failure = err;
    const shot = path.join(shots, "booking-failure.png");
    await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
    await tryWriteEvidence(() => writeFileSync(path.join(shots, "booking-failure.txt"), `${page.url()}\nhttp=${probe.status}\n${err instanceof Error ? err.stack : String(err)}\n`));
  } finally {
    const video = page.video();
    await context.close();
    if (video) await tryWriteEvidence(() => video.saveAs(path.join(shots, "replay_booking_dates.webm")));
    await browser.close();
  }
  if (failure) throw failure;
});

test("the IRS W-9 downloads twice to the same templated hash", { timeout: 120_000, skip: liveOnly }, async (t) => {
  const url = "https://www.irs.gov/pub/irs-pdf/fw9.pdf";
  const probe = await requireSite(t, url);
  if (!probe) return;
  const root = mkdtempSync(path.join(tmpdir(), "bao-w9-"));
  const doc = workflow({
    id: "wf-w9",
    name: "W-9",
    startUrl: url,
    inputs: [{ name: "company", type: "text", label: "company", supply: "saved", default: "irs" }],
    steps: [{
      id: "dl",
      index: 0,
      timeoutMs: 20000,
      caption: { text: "Download W-9" },
      action: "download",
      download: { output: "statement", name: "{{run.date}}-{{company}}-statement.pdf", url: url },
    }],
  });
  const hashes: string[] = [];
  const paths: string[] = [];
  let skipped = false;
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
        const outage = result.status === "passed" ? undefined : liveSkip(probe, failureForSkip(probe, result.failure, result.network));
        if (outage) {
          console.log(`live ${url} http=${outage.status} result=${outage.result} phase=${result.failure?.phase || ""}`);
          t.skip(`infrastructure ${outage.result} http=${outage.status} ${url}`);
          skipped = true;
          return;
        }
        assert.equal(result.status, "passed", `product failure after HTTP ${probe.status} ${result.failure?.phase || ""} ${result.failure?.reason || ""}`);
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
  if (skipped) return;
  assert.equal(hashes[0], hashes[1]);
  assert.notEqual(paths[0], paths[1]);
  await tryWriteEvidence(() => writeFileSync(path.join(testArtifacts("files-dates-public"), "w9-downloads.json"), JSON.stringify({ sha256: hashes[0], paths, name: "2026-10-22-irs-statement.pdf", http: probe.status }, null, 2)));
});

test("a downloaded file uploads to the-internet and the filename is shown", { timeout: 120_000, skip: liveOnly }, async (t) => {
  const fileUrl = "https://the-internet.herokuapp.com/download/some-file.txt";
  const uploadUrl = "https://the-internet.herokuapp.com/upload";
  const downloaded = await requireSite(t, fileUrl);
  if (!downloaded) return;
  const uploaded = await requireSite(t, uploadUrl);
  if (!uploaded) return;
  const root = mkdtempSync(path.join(tmpdir(), "bao-internet-"));
  const doc = workflow({
    id: "wf-internet",
    name: "Download then upload",
    startUrl: uploadUrl,
    inputs: [
      { name: "company", type: "text", label: "company", supply: "saved", default: "acme" },
      { name: "upload", type: "file", label: "upload", supply: "must", fromOutput: "note" },
    ],
    steps: [
      {
        id: "dl",
        index: 0,
        timeoutMs: 20000,
        caption: { text: "Download" },
        action: "download",
        download: { output: "note", name: "{{run.date}}-{{company}}-{{suggested}}", url: fileUrl },
      },
      {
        id: "open",
        index: 1,
        timeoutMs: 20000,
        caption: { text: "Open upload" },
        action: "open",
        open: { target: "url", url: uploadUrl },
      },
      {
        id: "up",
        index: 2,
        timeoutMs: 20000,
        caption: { text: "Upload" },
        action: "upload",
        target: {
          locators: [{ kind: "css", value: "#file-upload" }, { kind: "xpath", value: "//*[@id=\"file-upload\"]" }],
          hint: { role: "textbox", surface: "dom", tag: "input", id: "file-upload" },
        },
        file: { fromOutput: "note" },
      },
      {
        id: "submit",
        index: 3,
        timeoutMs: 20000,
        caption: { text: "Upload", citation: { text: "Upload", source: "text" } },
        action: "click",
        target: {
          locators: [
            { kind: "role", role: "button", name: "Upload" },
            { kind: "text", value: "Upload" },
            { kind: "css", value: "#file-submit" },
            { kind: "xpath", value: "//*[@id=\"file-submit\"]" },
          ],
          hint: { role: "button", surface: "dom", tag: "button", id: "file-submit" },
        },
      },
      {
        id: "see",
        index: 4,
        timeoutMs: 20000,
        caption: { text: "Filename is shown" },
        action: "verify",
        check: { kind: "text", match: "some-file.txt", timeoutMs: 15000 },
      },
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
      const outage = result.status === "passed" ? undefined : liveSkip(uploaded, failureForSkip(uploaded, result.failure, result.network));
      if (outage) {
        console.log(`live ${uploadUrl} http=${outage.status} result=${outage.result} phase=${result.failure?.phase || ""}`);
        t.skip(`infrastructure ${outage.result} http=${outage.status} ${uploadUrl}`);
        return;
      }
      assert.equal(result.status, "passed", `product failure after HTTP ${uploaded.status} ${result.failure?.phase || ""} ${result.failure?.reason || ""}`);
      assert.equal(result.modelCalls, 0);
      const file = result.files?.note;
      assert.ok(file);
      assert.equal(file.name, "2026-10-22-acme-some-file.txt");
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
      const shown = await page.locator("#uploaded-files").innerText();
      assert.equal(shown.trim(), file.name);
      await tryWriteEvidence(() => writeFileSync(path.join(testArtifacts("files-dates-public"), "upload-chain.json"), JSON.stringify({ name: file.name, sha256: file.sha256, shown: shown.trim(), http: uploaded.status }, null, 2)));
    } finally {
      await context.close();
    }
  });
});
