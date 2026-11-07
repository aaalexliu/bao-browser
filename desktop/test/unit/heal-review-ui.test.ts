import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { testChromium } from "../../src/test-browser";
import type { WorkflowV2 } from "../../src/v1/schema";

const workflow: WorkflowV2 = {
  schema: "bao.workflow/v2", version: 2, id: "statements", name: "Download statement", createdAt: 1,
  startUrl: "/fixture", inputs: [], steps: [{ id: "statements", index: 0, action: "click", label: "Open statements", surface: "dom", identity: { surface: "dom", role: "link", name: "Statements", path: [{ role: "navigation", name: "Main menu" }] }, timeoutMs: 1000 }],
};

test("target review matches the paired layout and keeps decisions on the exact existing record", { timeout: 60_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-heal-review-ui-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  try {
    app.library.save(workflow);
    const heal = {
      id: "target", ts: 1, intent: "Open statements", failedStep: workflow.steps[0]!,
      proposedPatch: { identity: { ...workflow.steps[0]!.identity!, role: "menuitem", path: [{ role: "menu", name: "Accounts" }] } },
      beforeShot: "missing-before.png", snapshot: { screenshotRef: "missing-now.png" }, postconditionPassed: true,
    };
    app.library.saveRun({ id: "review-run", workflowId: workflow.id, status: "passed", at: 2, steps: [], heals: [heal] });
    app.library.saveRun({ id: "other-run", workflowId: workflow.id, status: "passed", at: 1, steps: [], heals: [{ ...heal, id: "other-target" }] });
    const promotion = { workflowId: workflow.id, healId: heal.id, stepId: workflow.steps[0]!.id, patch: heal.proposedPatch, before: workflow.steps[0]!, status: "provisional", drift: "passed", replays: 1, need: 3 };
    app.library.savePromotion(promotion);
    const original = JSON.stringify(app.library.readRun("review-run").heals);
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const theme of ["light", "dark"]) {
      await page.goto(`http://127.0.0.1:${app.port}`);
      await page.evaluate((value) => localStorage.setItem("bao-theme", value), theme);
      await page.reload();
      await page.locator('#heal-detail[data-heal="target"]').waitFor();
      assert.equal(await page.locator("#heal-inbox").count(), 0);
      assert.equal(await page.locator("#shot-slider").count(), 0);
      assert.equal(await page.locator("#heal-detail h2").innerText(), "Step 1 moved");
      assert.match(await page.locator(".heal-lead").innerText(), /finished/);
      assert.match(await page.locator(".heal-facts").innerText(), /Statements.*Main menu/);
      assert.equal(await page.locator(".heal-count").innerText(), "1 of 3");
      assert.equal(await page.locator(".heal-segments i.passed").count(), 1);
      assert.equal(await page.locator(".heal-technical").getAttribute("open"), null);
      await page.getByText("Picture unavailable", { exact: true }).nth(1).waitFor({ state: "visible" });
      assert.equal(await page.locator(".heal-missing:visible").count(), 2);
      for (const width of [1280, 720, 320]) {
        await page.setViewportSize({ width, height: 820 });
        const figures = await page.locator(".heal-comparison figure").evaluateAll((elements) => elements.map((element) => {
          const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, right: rect.right };
        }));
        assert.equal(figures.length, 2);
        if (width > 820) assert.equal(figures[0]!.y, figures[1]!.y);
        else assert.ok(figures[1]!.y > figures[0]!.y);
        assert.ok(figures.every((figure) => figure.x >= 0 && figure.right <= width));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      await page.setViewportSize({ width: 1280, height: 820 });
      await page.locator(".heal-technical > summary").focus();
      await page.keyboard.press("Enter");
      assert.equal(await page.locator(".heal-technical").getAttribute("open"), "");
      assert.match(await page.locator(".heal-code").innerText(), /Recorded: link.*Statements/);
    }
    await page.route("**/api/heal/keep", (route) => route.fulfill({ status: 500, body: "failed" }));
    await page.locator("[data-keep]").click();
    await page.getByRole("status").filter({ hasText: "Could not keep this target. Try again." }).waitFor();
    assert.equal(app.library.readRun("review-run").decisions?.length || 0, 0);
    assert.equal(await page.locator("[data-keep]").isEnabled(), true);
    await page.unroute("**/api/heal/keep");
    await page.locator("[data-keep]").click();
    await page.getByText("Patch kept", { exact: true }).waitFor();
    assert.equal(app.library.readRun("review-run").decisions?.at(-1)?.decision, "keep");
    assert.equal(app.library.readRun("other-run").decisions?.length || 0, 0);
    assert.equal(app.library.read(workflow.id).steps[0]!.identity!.role, "link");
    await page.locator("[data-revert]").click();
    await page.getByRole("dialog", { name: "Revert step 1?" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Cancel", exact: true }).evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press("Escape");
    assert.equal(app.library.readRun("review-run").decisions?.length, 1);
    await page.locator("[data-revert]").click();
    await page.getByRole("button", { name: "Revert step 1", exact: true }).click();
    await page.getByText("Patch reverted", { exact: true }).waitFor();
    assert.deepEqual(app.library.readRun("review-run").decisions?.map((item) => item.decision), ["keep", "revert"]);
    assert.equal(JSON.stringify(app.library.readRun("review-run").heals), original);
    assert.equal(app.library.readRun("other-run").decisions?.length || 0, 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); await app.close();
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});
