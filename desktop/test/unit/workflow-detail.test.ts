import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { testChromium } from "../../src/test-browser.js";
import { applyHermeticApp } from "../runtime";

test("Inbox workflow detail keeps selection, inputs, history, and existing actions reachable", { timeout: 60_000 }, async () => {
  const dirs = applyHermeticApp("workflow-detail");
  const app = await startApp({ home: dirs.home, extensionHost: false, chromeProfilesRoot: path.join(dirs.home, "profiles") });
  const name = `Set up the sign-in screen for 五秒 ${"A long workflow title ".repeat(12)}`;
  app.library.save({
    schema: "bao.workflow/v2", version: 2, id: "detail", name, createdAt: 1,
    startUrl: "https://example.test/", summary: "Sets up the sign-in screen.",
    inputs: [{ name: "appName", label: "App name", type: "text", default: "五秒", required: true }],
    steps: [
      { id: "open", index: 0, action: "navigate", surface: "dom", timeoutMs: 100, label: "Open the sign-in page", value: "https://example.test/" },
      { id: "name", index: 1, action: "type", surface: "dom", timeoutMs: 100, label: "Type the app name", input: "appName", identity: { surface: "dom", path: [], role: "textbox", name: "App name" }, expect: { kind: "text", match: "Saved", timeoutMs: 100 } },
    ],
  });
  app.library.save({ schema: "bao.workflow/v2", version: 2, id: "empty-detail", name: "Empty workflow", createdAt: 1, startUrl: "/fixture", inputs: [], steps: [] });
  app.library.saveRun({ id: "detail-run", workflowId: "detail", status: "passed", at: Date.now(), steps: [{ id: "open", status: "passed" }], heals: [] });
  let browser: Awaited<ReturnType<typeof testChromium.launch>> | undefined;
  try {
    browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
    const fixture = await browser.newPage();
    await fixture.goto(`http://127.0.0.1:${app.port}/fixture`);
    const shots = path.join(dirs.home, "shots", "workflows", "detail");
    mkdirSync(shots, { recursive: true });
    writeFileSync(path.join(shots, "name.png"), await fixture.screenshot());
    await fixture.close();
    for (const theme of ["light", "dark"]) for (const width of [1280, 720, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 860 } });
      await page.addInitScript((theme) => localStorage.setItem("bao-theme", theme), theme);
      await page.goto(`http://127.0.0.1:${app.port}/`);
      if (width <= 1060) await page.locator("#sidebar-toggle").click();
      await page.locator("#rail [data-place=workflows]").click();
      await page.locator('[data-open-workflow="detail"]').click();
      await page.locator("#workflow-detail").waitFor();
      assert.equal(await page.locator(".wf-head h2").innerText(), name.trim());
      assert.equal(await page.locator("#screen-list").isVisible(), false);
      assert.equal(await page.locator("#workflow-detail .ph").count(), 0);
      assert.equal(await page.locator("#workflow-detail .wf-picture:visible").count(), 0);
      assert.equal(await page.locator("#workflow-step-help").count(), 1);
      assert.equal(await page.locator(".wf-steps tbody tr").count(), 2);
      assert.equal(await page.locator("#workflow-inputs h3").innerText(), "Inputs · 1, asked before each run");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const title = (await page.locator(".wf-head h2").boundingBox())!;
      assert.ok(title.x >= 0 && title.x + title.width <= width);
      await page.locator('[data-workflow-step="name"]').click();
      assert.equal(await page.locator('[data-workflow-step="name"]').getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator('[data-step-panel="open"]').isVisible(), false);
      assert.equal(await page.locator('[data-step-panel="name"]').isVisible(), true);
      await page.locator('[data-step-panel="name"] .wf-picture img').waitFor();
      assert.equal(await page.locator('[data-step-panel="name"] .wf-picture img').evaluate((image) => (image as HTMLImageElement).naturalWidth > 96), true);
      assert.match(await page.locator('[data-step-panel="name"]').innerText(), /The page shows “Saved”/);
      assert.equal(await page.locator("[data-step-heal]:visible").count(), 1);
      await page.locator('[data-step-heal="name"]').selectOption("ask");
      await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('[data-step-heal="name"]')?.value === "ask");
      assert.equal(await page.locator('[data-workflow-step="name"]').getAttribute("aria-pressed"), "true");
      await page.locator("#workflow-edit-inputs").click();
      assert.equal(await page.locator("#workflow-inputs [data-edit-input]").evaluate((el) => el === document.activeElement), true);
      await page.locator("#workflow-inputs [data-edit-input]").click();
      await page.locator("#input-editor").waitFor();
      assert.equal(await page.locator('#input-editor [name="default"]').inputValue(), "五秒");
      await page.locator('#input-editor [name="default"]').fill("五秒 edited");
      await page.locator("[data-save-input]").click();
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('#workflow-inputs [data-edit-input]')?.dataset.default === "五秒 edited");
      assert.equal(app.library.read("detail").inputs[0]?.default, "五秒 edited");
      await page.locator("#workflow-inputs [data-edit-input]").click();
      await page.locator('#input-editor [name="default"]').fill("五秒");
      await page.locator("[data-save-input]").click();
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('#workflow-inputs [data-edit-input]')?.dataset.default === "五秒");
      await page.locator("#workflow-options > summary").click();
      await page.locator("#workflow-edit summary").click();
      assert.match(await page.locator("#edit-json").inputValue(), /Type the app name/);
      await page.locator('[data-testid="share-open"]').click();
      assert.equal(await page.locator('[data-testid="share-copy"]').isVisible(), true);
      await page.locator("#workflow-options > summary").click();
      assert.equal(await page.locator("[data-guide]").isVisible(), true);
      await page.locator('[data-step-panel="name"] [data-run-from]').click();
      await page.locator("#run-form").waitFor();
      assert.match(await page.locator("#run-form").innerText(), /Run from step 2/);
      await page.close();
    }
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    await page.goto(`http://127.0.0.1:${app.port}/`);
    await page.locator("#rail [data-place=workflows]").click();
    await page.route("**/api/workflows/detail", (route) => route.fulfill({ status: 404, body: "{}" }));
    await page.locator('[data-open-workflow="detail"]').click();
    await page.getByRole("heading", { name: "This workflow can’t open" }).waitFor();
    await page.unroute("**/api/workflows/detail");
    await page.locator("#workflow-retry").click();
    await page.locator("#workflow-detail").waitFor();
    await page.locator('.wf-recent [data-open-run="detail-run"]').click();
    await page.locator("#run-receipt").waitFor();
    await page.locator("#rail [data-place=workflows]").click();
    await page.locator('[data-open-workflow="empty-detail"]').click();
    await page.getByText("No steps yet", { exact: true }).waitFor();
    assert.match(await page.locator(".wf-recent").innerText(), /No runs yet/);
    assert.equal(await page.locator("#workflow-edit-inputs").isDisabled(), true);
    await page.getByRole("button", { name: "Back to all workflows" }).click();
    await page.locator("#workflow-list").waitFor();
    await page.setViewportSize({ width: 720, height: 860 });
    await page.evaluate(() => { document.documentElement.dataset.baoNative = "true"; });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      assert.equal(await page.locator("#app").evaluate((el) => getComputedStyle(el).backgroundColor), await page.locator("#content").evaluate((el) => getComputedStyle(el).backgroundColor));
    }
  } finally {
    await browser?.close();
    await app.close();
    rmSync(path.dirname(dirs.home), { recursive: true, force: true });
  }
});
