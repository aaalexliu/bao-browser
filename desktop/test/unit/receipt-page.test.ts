import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { testChromium } from "../../src/test-browser";
import { scaledMs } from "../runtime";

/** A recorded run of `count` steps, two to a page, each with a picture the fixture page stands in for. */
function recorded(id: string, count: number) {
  return {
    id, workflowId: "agent-browser", kind: "capture" as const, pageEngine: "agent-browser" as const, status: "passed", at: 1_000, heals: [], task: `Run of ${count}`,
    steps: Array.from({ length: count }, (_, index) => {
      const pageNumber = Math.floor(index / 2) + 1;
      return {
        id: `command-${index + 1}`, status: "passed" as const, label: `Click "Row ${index + 1}"`,
        startedAt: 1_000 + index * 1_000, endedAt: 1_500 + index * 1_000, afterShot: "page.png",
        native: { command: "click", args: [`@e${index + 1}`] },
        summary: { text: "", page: { title: `Page ${pageNumber}`, url: `https://fixture.test/page/${pageNumber}` } },
      };
    }),
  };
}

test("a receipt shows the proof shot above a step list that scrolls inside its own pane", { timeout: scaledMs(60_000) }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-receipt-page-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  try {
    await page.goto(`http://127.0.0.1:${app.port}/fixture`);
    for (const id of ["short", "long"]) {
      const shots = path.join(home, "shots", "runs", id);
      mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: path.join(shots, "page.png") });
    }
    app.library.saveRun(recorded("short", 3) as never);
    app.library.saveRun(recorded("long", 40) as never);
    await page.goto(`http://127.0.0.1:${app.port}/`);

    await page.locator('[data-open-run="long"]').click();
    await page.locator("#run-receipt .receipt-proof img").waitFor();
    await page.waitForFunction(() => (document.querySelector(".receipt-proof img") as HTMLImageElement).naturalWidth > 0);
    const long = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const list = document.querySelector<HTMLElement>(".receipt-list")!;
      return {
        proofWidth: box(".receipt-proof img").width,
        receiptWidth: box("#run-receipt").width,
        proofBottom: box(".receipt-proof img").bottom,
        listTop: box(".receipt-list").top,
        rows: list.querySelectorAll("li[data-step]").length,
        chapters: [...list.querySelectorAll(".receipt-chapter-title")].map((node) => node.textContent),
        listHeight: list.clientHeight,
        listScroll: list.scrollHeight,
        viewport: innerHeight,
      };
    });
    assert.ok(long.proofWidth > long.receiptWidth * 0.6, `the proof shot is large: ${long.proofWidth} of ${long.receiptWidth}`);
    assert.ok(long.proofBottom <= long.listTop, "the proof shot sits above the step list");
    assert.equal(long.rows, 40, "every step is listed");
    assert.deepEqual(long.chapters.slice(0, 2), ["Page 1", "Page 2"]);
    assert.equal(long.chapters.length, 20);
    assert.ok(long.listScroll > long.listHeight, "a long list scrolls inside its pane");
    assert.ok(long.listHeight < long.viewport, "and the pane is shorter than the window");

    await page.locator('[data-open-run="short"]').click();
    await page.waitForFunction(() => document.querySelectorAll(".receipt-list li[data-step]").length === 3);
    const short = await page.locator(".receipt-list").evaluate((list) => ({ height: list.clientHeight, scroll: list.scrollHeight }));
    assert.equal(short.scroll, short.height, "a short list shows whole, with no scrolling");
  } finally {
    await browser.close(); await app.close();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("an open receipt stays in place when another run changes the state", { timeout: scaledMs(60_000) }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-receipt-keep-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const statePolls = async (count: number) => {
    for (let n = 0; n < count; n++) await page.waitForResponse((response) => new URL(response.url()).pathname === "/api/state");
  };
  try {
    app.library.saveRun(recorded("open", 40) as never);
    await page.goto(`http://127.0.0.1:${app.port}/`);
    await page.locator('[data-open-run="open"]').click();
    await page.locator("#run-receipt").waitFor();
    await statePolls(2);
    await page.evaluate(() => {
      document.getElementById("run-receipt")!.dataset.kept = "yes";
      document.getElementById("content")!.scrollTop = 600;
      document.querySelector(".receipt-list")!.scrollTop = 300;
    });

    app.library.saveRun(recorded("another", 2) as never);
    await page.locator('[data-open-run="another"]').waitFor();
    await statePolls(2);
    assert.deepEqual(await page.evaluate(() => ({
      kept: document.getElementById("run-receipt")?.dataset.kept,
      page: document.getElementById("content")!.scrollTop,
      list: document.querySelector(".receipt-list")?.scrollTop,
    })), { kept: "yes", page: 600, list: 300 }, "a new run in the list does not rebuild the open receipt or move its scrolling");

    const open = app.library.readRun("open");
    app.library.saveRun({ ...open, status: "failed", failure: { reason: "The page stopped." } });
    await page.locator("#run-receipt .receipt-recorded-status").filter({ hasText: "Recorded as failed" }).waitFor();
    assert.equal(await page.locator("#run-receipt").getAttribute("data-kept"), null, "a change to the open run itself still redraws it");
  } finally {
    await browser.close(); await app.close();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
