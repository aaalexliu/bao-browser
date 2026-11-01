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
  const browser = await chromium.launch({ headless: true, args: ["--use-mock-keychain", "--password-store=basic"] });
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
    app.library.save({ schema: "bao.workflow/v2", version: 2, id: "wf-shot-stage", name: "Step screenshot fixture",
      startUrl: `http://127.0.0.1:${app.port}/fixture`, inputs: [], createdAt: 1,
      steps: [
        { id: "shot", index: 0, action: "note", label: "Fixture page", surface: "dom", timeoutMs: 1000 },
        { id: "crop", index: 1, action: "note", label: "Target crop", surface: "dom", timeoutMs: 1000 },
        { id: "jpeg", index: 2, action: "note", label: "Extension page", surface: "dom", timeoutMs: 1000 },
        { id: "missing", index: 3, action: "note", label: "No shot", surface: "dom", timeoutMs: 1000 },
        { id: "gone", index: 4, action: "note", label: "Deleted picture", surface: "dom", timeoutMs: 1000 },
      ] });
    app.library.saveRun({ id: runId, workflowId: "wf-shot-stage", at: 1, status: "passed", modelCalls: 0, heals: [],
      steps: [
        { id: "shot", status: "passed", beforeShot: "before.png", afterShot: "after.png" },
        { id: "crop", status: "passed", afterShot: "crop.png" },
        { id: "jpeg", status: "passed", beforeShot: "after.jpg", afterShot: "after.jpg" },
        { id: "missing", status: "passed", beforeShot: "before.png", afterShotError: "Chrome timed out taking this picture." },
        { id: "gone", status: "passed", afterShot: "gone.jpg" },
      ] });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`http://127.0.0.1:${app.port}/`);
    await page.click("[data-screen=runs]");
    await page.click(`[data-open-run=${runId}]`);
    for (const [step, which, width, height] of [
      ["shot", "after", 320, 720], ["shot", "before", 1280, 720], ["shot", "after", 320, 720], ["crop", "after", 1280, 80], ["jpeg", "after", 1280, 720], ["jpeg", "before", 1280, 720],
    ] as const) {
      await page.click(`#step-list [data-select-step=${step}]`);
      await page.click(`[data-frame=${which}]`);
      await page.waitForFunction(([w, h]) => {
        const image = document.querySelector<HTMLImageElement>("#shot-stage img");
        return !!image && image.naturalWidth === w && image.naturalHeight === h;
      }, [width, height]);
      const fit = await page.locator("#shot-stage").evaluate((stage) => {
        const image = stage.querySelector<HTMLImageElement>("img")!;
        const rect = stage.getBoundingClientRect();
        const style = getComputedStyle(stage);
        return { width: rect.width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth),
          height: rect.height - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth),
          ratio: image.naturalWidth / image.naturalHeight, objectFit: getComputedStyle(image).objectFit };
      });
      assert.ok(Math.abs(fit.width - fit.height * fit.ratio) < 2, `${which}: frame ${fit.width}x${fit.height} does not match captured ratio ${fit.ratio}`);
      assert.equal(fit.objectFit, "contain", "keep every part of the captured page visible");
    }
    await page.click("#step-list [data-select-step=missing]");
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
    await page.waitForFunction(() => document.querySelector("[data-shot-error]")?.textContent === "The saved picture could not be loaded.");
  } finally {
    await browser.close();
    await app.close();
    rmSync(path.dirname(dirs.home), { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.BAO_HOME; else process.env.BAO_HOME = previousHome;
  }
});
