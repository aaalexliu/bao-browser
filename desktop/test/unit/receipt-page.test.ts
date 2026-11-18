import assert from "node:assert/strict";
import { copyFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { testChromium } from "../../src/test-browser";
import { scaledMs } from "../runtime";

/** A recorded run of `count` steps, two to a page. Each step has the picture `picture` names for it, by default one shared file. */
function recorded(id: string, count: number, picture: (step: number) => string | undefined = () => "page.png") {
  return {
    id, workflowId: "agent-browser", kind: "capture" as const, pageEngine: "agent-browser" as const, status: "passed", at: 1_000, heals: [], task: `Run of ${count}`,
    steps: Array.from({ length: count }, (_, index) => {
      const pageNumber = Math.floor(index / 2) + 1;
      return {
        id: `command-${index + 1}`, status: "passed" as const, label: `Click "Row ${index + 1}"`,
        startedAt: 1_000 + index * 1_000, endedAt: 1_500 + index * 1_000, afterShot: picture(index + 1),
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
  // Reduced motion keeps the step player still, so the list's scrolling stays where the test put it.
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" });
  const statePolls = async (count: number) => {
    for (let n = 0; n < count; n++) await page.waitForResponse((response) => new URL(response.url()).pathname === "/api/state");
  };
  try {
    app.library.saveRun(recorded("open", 40) as never);
    await page.goto(`http://127.0.0.1:${app.port}/`);
    await page.locator('[data-open-run="open"]').click();
    await page.locator("#run-receipt").waitFor();
    await statePolls(2);
    assert.equal(await page.locator("#run-evidence #pass-grid thead time").count(), 1);
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
    assert.equal(await page.locator("#run-evidence #pass-grid thead time").count(), 2, "Detailed evidence still gains the new run in Recent runs");

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

/** What the player shows now, read in one pass so the parts belong to the same step. */
async function playerNow(page: import("playwright-core").Page) {
  return page.evaluate(() => {
    const list = document.querySelector<HTMLElement>(".receipt-list")!;
    const current = [...list.querySelectorAll<HTMLElement>("li.current")];
    const row = current[0]?.getBoundingClientRect();
    const pane = list.getBoundingClientRect();
    const picture = document.querySelector<HTMLImageElement>("#player-picture")!;
    return {
      count: document.querySelector("#player-count")!.textContent,
      toggle: document.querySelector("#player-toggle")!.getAttribute("aria-label"),
      picture: picture.hidden ? "" : (picture.getAttribute("src") || "").split("/").pop(),
      empty: document.querySelector<HTMLElement>("#player-empty")!.hidden ? "" : document.querySelector("#player-empty")!.textContent,
      chapter: document.querySelector("#player-chapter")!.textContent,
      line: document.querySelector("#player-line")!.textContent,
      current: current.map((item) => Number(item.dataset.step)),
      rowInPane: Boolean(row) && row!.top >= pane.top && row!.bottom <= pane.bottom,
      listScroll: list.scrollTop,
      pageScroll: document.getElementById("content")!.scrollTop,
    };
  });
}

test("the player steps through a run by itself, and the step list follows it", { timeout: scaledMs(90_000) }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-receipt-player-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const step = (count: string) => Number(count.split(" / ")[0]);
  const reach = (count: string) => page.waitForFunction((text) => document.querySelector("#player-count")?.textContent === text, count);
  try {
    const shots = path.join(home, "shots", "runs", "long");
    mkdirSync(shots, { recursive: true });
    await page.goto(`http://127.0.0.1:${app.port}/fixture`);
    await page.screenshot({ path: path.join(shots, "shot-1.png") });
    for (let n = 2; n <= 40; n++) copyFileSync(path.join(shots, "shot-1.png"), path.join(shots, `shot-${n}.png`));
    app.library.saveRun(recorded("long", 40, (n) => n === 5 ? undefined : `shot-${n}.png`) as never);
    await page.goto(`http://127.0.0.1:${app.port}/`);
    await page.locator('[data-open-run="long"]').click();
    await page.locator("#receipt-player").waitFor();
    await page.waitForFunction(() => (document.querySelector(".receipt-proof img") as HTMLImageElement | null)?.naturalWidth);

    await page.waitForTimeout(scaledMs(1_600));
    const waiting = await playerNow(page);
    assert.deepEqual([waiting.count, waiting.toggle, waiting.picture], ["1 / 40", "Play", "shot-1.png"], "below the fold, the player waits on the first step");

    await page.locator("#player-speed").click();
    await page.locator("#player-speed").click();
    assert.equal(await page.locator("#player-speed").innerText(), "4×");
    await page.locator("#receipt-player").evaluate((node) => node.scrollIntoView());
    const pageScroll = (await playerNow(page)).pageScroll;
    assert.ok(pageScroll > 0);
    await page.waitForFunction(() => Number(document.querySelector("#player-count")!.textContent!.split(" / ")[0]) >= 3);
    const early = await playerNow(page);
    const at = step(early.count!);
    assert.equal(early.toggle, "Pause", "in view, it plays by itself");
    assert.deepEqual([early.picture, early.current, early.chapter, early.line], [at === 5 ? "" : `shot-${at}.png`, [at], `Page ${Math.ceil(at / 2)}`, `Clicked "Row ${at}"`], "the picture, the caption and the one highlighted row are the same step");

    await page.waitForFunction(() => Number(document.querySelector("#player-count")!.textContent!.split(" / ")[0]) >= 14);
    await page.waitForTimeout(scaledMs(250));
    const later = await playerNow(page);
    assert.ok(later.listScroll > 0, "the list scrolled with the player");
    assert.equal(later.rowInPane, true, "and the highlighted row is in view in its pane");
    assert.equal(later.pageScroll, pageScroll, "the page itself did not move");

    await page.locator(".receipt-list").hover();
    await page.mouse.wheel(0, -150);
    await page.waitForTimeout(scaledMs(500));
    const browsing = await playerNow(page);
    await page.waitForFunction((from) => Number(document.querySelector("#player-count")!.textContent!.split(" / ")[0]) >= from + 3, step(browsing.count!));
    assert.equal((await playerNow(page)).listScroll, browsing.listScroll, "the reader's own scrolling of the list stops it from following");

    await page.locator("#player-toggle").click();
    const paused = await playerNow(page);
    assert.equal(paused.toggle, "Play");
    await page.waitForTimeout(scaledMs(900));
    assert.equal((await playerNow(page)).count, paused.count, "paused, it stays on its step");

    await page.locator('.player-mark[data-receipt-step="29"]').click();
    await reach("29 / 40");
    const jumped = await playerNow(page);
    assert.deepEqual([jumped.chapter, jumped.current, jumped.picture, jumped.toggle], ["Page 15", [29], "shot-29.png", "Play"], "a chapter mark jumps to that chapter's first step");
    await page.waitForFunction(() => { const list = document.querySelector(".receipt-list")!.getBoundingClientRect(); const row = document.querySelector(".receipt-list li.current")!.getBoundingClientRect(); return row.top >= list.top && row.bottom <= list.bottom; }, undefined, { timeout: scaledMs(5_000) });
    assert.equal(await page.locator('.player-mark[data-receipt-step="29"]').getAttribute("title"), "Page 15");

    await page.locator('.receipt-list li[data-step="4"] button').click();
    await reach("4 / 40");
    assert.deepEqual([(await playerNow(page)).picture, (await playerNow(page)).current], ["shot-4.png", [4]], "a step row seeks the player to that step");

    await page.locator('.receipt-list li[data-step="5"] button').click();
    await reach("5 / 40");
    const blind = await playerNow(page);
    assert.deepEqual([blind.picture, blind.empty], ["", "No picture was recorded for this step."], "a step with no picture says so");

    await page.locator('.receipt-chapter-head[data-receipt-step="11"]').click();
    await reach("11 / 40");

    await page.locator("#player-seek").fill("38");
    await reach("38 / 40");
    await page.locator("#player-toggle").click();
    await reach("40 / 40");
    await page.waitForFunction(() => document.querySelector("#player-toggle")?.getAttribute("aria-label") === "Play");
    await page.waitForTimeout(scaledMs(700));
    assert.equal((await playerNow(page)).count, "40 / 40", "it stops on the last step");

    await page.locator("#player-toggle").click();
    await page.waitForFunction(() => { const n = Number(document.querySelector("#player-count")!.textContent!.split(" / ")[0]); return n >= 2 && n < 10; });
    assert.equal((await playerNow(page)).toggle, "Pause", "Play on the last step starts again from the first");

    await page.locator("#player-toggle").click();
    const held = await playerNow(page);
    const open = app.library.readRun("long");
    app.library.saveRun({ ...open, status: "failed", failure: { reason: "The page stopped." } });
    await page.locator("#run-receipt .receipt-recorded-status").filter({ hasText: "Recorded as failed" }).waitFor();
    assert.deepEqual([(await playerNow(page)).count, (await playerNow(page)).toggle], [held.count, "Play"], "a redraw of the open receipt keeps the player on its step");

    app.library.saveRun(recorded("other", 2) as never);
    await page.locator('[data-open-run="other"]').click();
    await page.locator("#run-receipt h2").filter({ hasText: "Run of 2" }).waitFor();
    await page.locator('[data-open-run="long"]').click();
    await reach("1 / 40");
  } finally {
    await browser.close(); await app.close();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("with reduced motion the player does not start by itself", { timeout: scaledMs(60_000) }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-receipt-calm-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, reducedMotion: "reduce" });
  try {
    const shots = path.join(home, "shots", "runs", "calm");
    mkdirSync(shots, { recursive: true });
    await page.goto(`http://127.0.0.1:${app.port}/fixture`);
    await page.screenshot({ path: path.join(shots, "page.png") });
    app.library.saveRun(recorded("calm", 6) as never);
    await page.goto(`http://127.0.0.1:${app.port}/`);
    await page.locator('[data-open-run="calm"]').click();
    await page.locator("#receipt-player").evaluate((node) => node.scrollIntoView());
    await page.waitForTimeout(scaledMs(2_600));
    assert.deepEqual([(await playerNow(page)).count, (await playerNow(page)).toggle], ["1 / 6", "Play"]);
    await page.locator("#player-toggle").click();
    await page.waitForFunction(() => document.querySelector("#player-count")?.textContent === "2 / 6");
  } finally {
    await browser.close(); await app.close();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
