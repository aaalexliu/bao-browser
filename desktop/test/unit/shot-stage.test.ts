import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
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
    app.library.save({ schema: "bao.workflow/v2", version: 2, id: "wf-shot-stage", name: "Step screenshot fixture",
      startUrl: `http://127.0.0.1:${app.port}/fixture`, inputs: [], createdAt: 1,
      steps: [{ id: "shot", index: 0, action: "note", label: "Fixture page", surface: "dom", timeoutMs: 1000 }] });
    app.library.saveRun({ id: runId, workflowId: "wf-shot-stage", at: 1, status: "passed", modelCalls: 0, heals: [],
      steps: [{ id: "shot", status: "passed", beforeShot: "before.png", afterShot: "after.png" }] });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`http://127.0.0.1:${app.port}/`);
    await page.click("[data-screen=runs]");
    await page.click(`[data-open-run=${runId}]`);
    for (const [which, width] of [["after", 320], ["before", 1280], ["after", 320]] as const) {
      await page.click(`[data-frame=${which}]`);
      await page.waitForFunction((expected) => {
        const image = document.querySelector<HTMLImageElement>("#shot-stage img");
        return image?.naturalWidth === expected;
      }, width);
      const fit = await page.locator("#shot-stage").evaluate((stage) => {
        const image = stage.querySelector<HTMLImageElement>("img")!;
        return { width: stage.clientWidth, height: stage.clientHeight, ratio: image.naturalWidth / image.naturalHeight,
          objectFit: getComputedStyle(image).objectFit };
      });
      assert.ok(Math.abs(fit.width - fit.height * fit.ratio) < 2, `${which}: frame ${fit.width}x${fit.height} does not match captured ratio ${fit.ratio}`);
      assert.equal(fit.objectFit, "contain", "keep every part of the captured page visible");
    }
  } finally {
    await browser.close();
    await app.close();
    rmSync(dirs.home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.BAO_HOME; else process.env.BAO_HOME = previousHome;
  }
});
