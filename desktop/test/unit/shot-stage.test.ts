import { testWorkflow } from "../support/workflow";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { testChromium as chromium } from "../../src/test-browser.js";
import { startApp } from "../../src/app/server";
import { applyHermeticApp } from "../runtime";

test("Library step frame fits the captured viewport without letterboxing or cropping", { timeout: 30_000 }, async () => {
  const previousHome = process.env.BAO_HOME;
  const dirs = applyHermeticApp("shot-stage");
  const app = await startApp({ home: dirs.home });
  const browser = await chromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true, args: ["--use-mock-keychain", "--password-store=basic"] });
  const page = await browser.newPage();
  const runId = "run-shot-stage";
  const shots = path.join(dirs.home, "shots", "runs", runId);
  mkdirSync(shots, { recursive: true });
  try {
    await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    for (const [name, viewport] of [
      ["before.png", { width: 1280, height: 720 }],
      ["after.png", { width: 320, height: 720 }],
    ] as const) {
      await page.setViewportSize(viewport);
      await page.goto(`http://127.0.0.1:${app.port}/fixture`);
      await page.screenshot({ path: path.join(shots, name) });
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.screenshot({ path: path.join(shots, "crop.png"), clip: { x: 0, y: 0, width: 1280, height: 80 } });
    await page.screenshot({ path: path.join(shots, "after.jpg"), type: "jpeg" });
    const jpeg = await fetch(`http://127.0.0.1:${app.port}/api/runs/${runId}/shots/after.jpg`);
    assert.equal(jpeg.status, 200);
    assert.equal(jpeg.headers.get("content-type"), "image/jpeg");
    app.library.save(testWorkflow({ schema: "bao.workflow/v4", id: "wf-shot-stage", name: "Step screenshot fixture",
      startUrl: `http://127.0.0.1:${app.port}/fixture`, inputs: [], createdAt: 1,
      steps: [
        {
          id: "shot",
          index: 0,
          timeoutMs: 1000,
          caption: { text: "Fixture page" },
          action: "note",
          text: "Fixture page",
        },
        { id: "crop", index: 1, timeoutMs: 1000, caption: { text: "Target crop" }, action: "note", text: "Target crop" },
        {
          id: "jpeg",
          index: 2,
          timeoutMs: 1000,
          caption: { text: "Extension page" },
          action: "note",
          text: "Extension page",
        },
        { id: "missing", index: 3, timeoutMs: 1000, caption: { text: "No shot" }, action: "note", text: "No shot" },
        {
          id: "gone",
          index: 4,
          timeoutMs: 1000,
          caption: { text: "Deleted picture" },
          action: "note",
          text: "Deleted picture",
        },
      ] }));
    app.library.saveRun({ id: runId, workflowId: "wf-shot-stage", at: 1, status: "passed", modelCalls: 0, heals: [],
      steps: [
        { id: "shot", status: "passed", beforeShot: "before.png", afterShot: "after.png" },
        { id: "crop", status: "passed", afterShot: "crop.png" },
        { id: "jpeg", status: "passed", beforeShot: "after.jpg", afterShot: "after.jpg" },
        { id: "missing", status: "passed", beforeShot: "before.png", afterShotError: "Chrome timed out taking this picture." },
        { id: "gone", status: "passed", afterShot: "gone.jpg" },
      ] });
    await page.addInitScript(() => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "onload")!;
      Object.defineProperty(HTMLImageElement.prototype, "onload", {
        get() { return descriptor.get!.call(this); },
        set(handler) {
          descriptor.set!.call(this, function (this: HTMLImageElement, event: Event) {
            if (this.closest("#shot-stage")) {
              console.log("shot-ready-gap", JSON.stringify({ complete: this.complete, width: this.naturalWidth, height: this.naturalHeight, ready: this.parentElement!.classList.contains("has-shot"), frame: this.parentElement!.getBoundingClientRect().height }));
              setTimeout(() => handler.call(this, event), 250);
            } else handler.call(this, event);
          });
        },
      });
    });
    const gaps: { complete: boolean; ready: boolean; frame: number }[] = [];
    page.on("console", (message) => {
      if (!message.text().startsWith("shot-ready-gap ")) return;
      console.log(message.text());
      gaps.push(JSON.parse(message.text().slice("shot-ready-gap ".length)));
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    // Load the saved state once. Background polling can rebuild the viewer and reset the selected frame.
    let stateLoaded = false;
    await page.route("**/api/state", (route) => {
      if (stateLoaded) return route.abort();
      stateLoaded = true;
      return route.continue();
    });
    await page.goto(`http://127.0.0.1:${app.port}/`);
    await page.click(`[data-open-run=${runId}]`);
    await page.getByText("Detailed evidence", { exact: true }).click();
    await page.waitForSelector("#step-list [data-select-step=shot]");
    for (const [step, which, width, height] of [
      ["shot", "after", 320, 720], ["shot", "before", 1280, 720], ["shot", "after", 320, 720], ["crop", "after", 1280, 80], ["jpeg", "after", 1280, 720], ["jpeg", "before", 1280, 720],
    ] as const) {
      const selected = `#step-list [data-select-step=${step}].on`;
      if (await page.locator(selected).count() === 0) {
        await page.click(`#step-list [data-select-step=${step}]`);
        await page.waitForSelector(selected);
      }
      await page.click(`[data-frame=${which}]`);
      const fitHandle = await page.waitForFunction(([w, h]) => {
        const image = document.querySelector<HTMLImageElement>("#shot-stage.has-shot img");
        if (!image?.isConnected || !image.complete || image.naturalWidth !== w || image.naturalHeight !== h) return null;
        const stage = image.parentElement!;
        const rect = stage.getBoundingClientRect();
        const style = getComputedStyle(stage);
        const fit = { width: rect.width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth),
          height: rect.height - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth),
          ratio: image.naturalWidth / image.naturalHeight, objectFit: getComputedStyle(image).objectFit };
        return Number.isFinite(fit.width) && fit.width > 0 && Number.isFinite(fit.height) && fit.height > 0 ? fit : null;
      }, [width, height]);
      const fit = await fitHandle.jsonValue();
      await fitHandle.dispose();
      assert.ok(fit);
      assert.ok(Math.abs(fit.width - fit.height * fit.ratio) < 2, `${which}: frame ${fit.width}x${fit.height} does not match captured ratio ${fit.ratio}`);
      assert.equal(fit.objectFit, "contain", "keep every part of the captured page visible");
    }
    assert.ok(gaps.some((gap) => gap.complete && !gap.ready && gap.frame === 220), "exercise a loaded image before the app leaves its placeholder state");
    await page.click("#step-list [data-select-step=missing]");
    await page.waitForSelector("#step-list [data-select-step=missing].on");
    await page.waitForSelector("#shot-stage:not(.has-shot)");
    assert.equal(await page.locator("#shot-stage img").count(), 0);
    assert.ok((await page.locator("#shot-stage").boundingBox())!.height >= 200, "missing-image message keeps its height");
    assert.equal(await page.locator("[data-shot-error]").innerText(), "Chrome timed out taking this picture.");
    assert.equal(await page.locator("#shot-stage .ph").isVisible(), false);
    await page.click("[data-frame=before]");
    await page.waitForSelector("#shot-stage.has-shot");
    assert.equal(await page.locator("[data-shot-error]").isVisible(), false);
    await page.click("[data-frame=after]");
    assert.equal(await page.locator("#shot-stage img").count(), 0, "a missing after must not show the before picture");
    assert.equal(await page.locator("[data-shot-error]").innerText(), "Chrome timed out taking this picture.");
    await page.click("#step-list [data-select-step=gone]");
    await page.waitForSelector("#step-list [data-select-step=gone].on");
    await page.waitForFunction(() => document.querySelector("[data-shot-error]")?.textContent === "The saved picture could not be loaded.");
  } finally {
    await browser.close();
    await app.close();
    rmSync(path.dirname(dirs.home), { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.BAO_HOME; else process.env.BAO_HOME = previousHome;
  }
});
