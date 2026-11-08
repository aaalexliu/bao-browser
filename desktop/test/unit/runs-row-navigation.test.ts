import { targetOf, testWorkflow,  } from "../support/workflow";
import { targetQuery } from "../../src/v1/identity";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { testChromium } from "../../src/test-browser";
import type { WorkflowV2 } from "../../src/v1/schema";
import { formatClock } from "../../src/v1/time";

const workflow: WorkflowV2 = testWorkflow({
  schema: "bao.workflow/v4", id: "statements", name: "Download statement", createdAt: 1,
  startUrl: "/fixture", inputs: [], steps: [{
    id: "open",
    index: 0,
    timeoutMs: 1000,
    caption: { text: "Open statements", citation: { text: "Statements", source: "name" } },
    action: "click",
    target: {
      locators: [{ kind: "role", role: "button", name: "Statements" }, { kind: "text", value: "Statements" }],
      hint: { role: "button", surface: "dom" },
    },
  }],
});

test("Runs rows open the exact target proposal, preserve receipts, keep keyboard selection through polling", { timeout: 60_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-runs-rows-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  try {
    app.library.save(workflow);
    const heal = { id: "first", intent: "Open statements", failedStep: { ...workflow.steps[0]!, index: 2 }, proposedPatch: { identity: { ...targetQuery(targetOf(workflow.steps[0])!), name: "New statements" } } };
    app.library.saveRun({ id: "run-targets", workflowId: workflow.id, status: "passed", at: 2, steps: [], heals: [heal, { ...heal, id: "second", failedStep: workflow.steps[0]! }] });
    app.library.saveRun({ id: "run-other", workflowId: workflow.id, status: "passed", at: 1, steps: [], heals: [heal] });
    const promotion = { workflowId: workflow.id, healId: "first", status: "provisional", drift: "passed", replays: 1, need: 3 };
    app.library.savePromotion(promotion);
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const url = `http://127.0.0.1:${app.port}`;
    const row = (run: string, id: string) => page.locator(`#runs [data-run="${run}"][data-heal="${id}"]`);
    for (const theme of ["light", "dark"]) {
      await page.goto(url);
      await page.evaluate((value) => localStorage.setItem("bao-theme", value), theme);
      await page.reload();
      await page.locator('#heal-detail[data-heal="first"][data-run="run-targets"]').waitFor();
      assert.equal(await row("run-targets", "first").getAttribute("aria-current"), "true");
      assert.match(await row("run-targets", "first").innerText(), /Heal to keep · Step 3 moved\./);
      assert.match(await row("run-targets", "second").innerText(), /Heal to keep · Step 1 moved\./);
      assert.doesNotMatch(await row("run-targets", "first").innerText(), /Open statements/);
      assert.match(await row("run-targets", "first").innerText(), /Kept after 2 more clean runs/);
      assert.equal(await page.locator('#screen-list > nav[aria-label="Runs screens"]').count(), 0);
      for (const width of [1280, 720, 320]) {
        await page.setViewportSize({ width, height: 820 });
        await page.keyboard.press("Tab");
        await row("run-targets", "second").focus();
        assert.notEqual(await row("run-targets", "second").evaluate((element) => getComputedStyle(element).outlineStyle), "none");
        await page.keyboard.press("Enter");
        await page.locator('#heal-detail[data-heal="second"][data-run="run-targets"]').waitFor();
        assert.equal(await page.locator("#main").evaluate((element) => element === document.activeElement), true);
        assert.equal(await page.locator("#runs [aria-current=true]").count(), 1);
        assert.equal(await row("run-targets", "second").getAttribute("aria-current"), "true");
        await row("run-other", "first").click();
        await page.locator('#heal-detail[data-heal="first"][data-run="run-other"]').waitFor();
        assert.equal(await row("run-other", "first").getAttribute("aria-current"), "true");
        assert.equal(await row("run-targets", "first").getAttribute("aria-current"), null);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      await page.setViewportSize({ width: 1280, height: 820 });
      await row("run-targets", "second").focus();
      const before = await row("run-targets", "second").elementHandle();
      app.library.saveRun({ id: `new-history-${theme}`, workflowId: workflow.id, status: "passed", at: 3, steps: [], heals: [] });
      await page.waitForFunction((element) => !element?.isConnected, before);
      assert.equal(await row("run-targets", "second").evaluate((element) => element === document.activeElement), true);
      await page.locator('#runs [data-open-run="run-targets"]').click();
      await page.locator("#run-receipt").waitFor();
      assert.equal(await page.locator('#runs [data-open-run="run-targets"]').getAttribute("aria-current"), "true");
      assert.equal(await row("run-targets", "first").getAttribute("aria-current"), null);
    }
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const requested = new Promise<void>((resolve) => { started = resolve; });
    await page.route("**/api/runs/run-targets", async (route) => {
      const response = await route.fetch();
      started();
      await held;
      await route.fulfill({ response });
    });
    await row("run-targets", "second").click();
    await requested;
    await row("run-other", "first").click();
    await page.locator('#heal-detail[data-heal="first"][data-run="run-other"]').waitFor();
    const finished = page.waitForResponse((response) => response.url().endsWith("/api/runs/run-targets"));
    release();
    await finished;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await page.locator('#heal-detail[data-run="run-other"][data-heal="first"]').count(), 1);
    await page.unroute("**/api/runs/run-targets");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close(); await app.close();
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("historical live sessions create no rows or attention, and stored waits keep their clock text", { timeout: 30_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-live-row-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  try {
    const file = path.join(home, "live-session", "session.json");
    await mkdir(path.dirname(file), { recursive: true });
    const session = { id: "live-row", status: "needs_human", intent: "Review the class schedule", host: "fixture.test", updatedAt: 1000, note: "Press Reserve yourself.", steps: [], audit: [] };
    await writeFile(file, JSON.stringify(session));
    const page = await browser.newPage({ viewport: { width: 720, height: 820 } });
    await page.goto(`http://127.0.0.1:${app.port}`);
    await page.locator('#runs-welcome').waitFor();
    const row = page.locator('#runs [data-screen="live"]');
    assert.equal(await row.count(), 0);
    assert.equal(await page.locator('#needs-you-heading .run-count').innerText(), "0");
    assert.equal(await page.locator('#runs [aria-current="true"]').count(), 0);
    assert.equal(await page.locator('#attention').getAttribute('data-count'), "0");
    assert.equal(await page.locator('#attention-label').innerText(), "Nothing running");
    await page.locator(".runs-record").click();
    await page.locator("#start-url").waitFor();
    await page.getByRole("button", { name: "Back to Workflows", exact: true }).click();
    await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
    await page.locator('#rail [data-place="runs"]').click();
    await page.locator('#runs-welcome').waitFor();
    await writeFile(file, JSON.stringify({ ...session, status: "running", updatedAt: 2000 }));
    await page.reload();
    await page.locator('#runs-welcome').waitFor();
    assert.equal(await row.count(), 0);
    assert.equal(await page.locator('#runs section[aria-label="Now"]').count(), 0);
    assert.equal(await page.locator('#needs-you-heading .run-count').innerText(), "0");
    const deadline = formatClock(Date.now() + 112 * 60_000);
    app.library.saveRun({ id: "waiting-replay", workflowId: "agent-browser", status: "paused", at: 3000, steps: [], heals: [], envelope: { status: "needs_human", ask: "Press Reserve", deadline } });
    const waiting = page.locator('#runs [data-open-run="waiting-replay"]').first();
    await waiting.waitFor();
    assert.ok((await waiting.innerText()).includes(`Waits until ${deadline}`));
    assert.equal(await waiting.locator('[data-run-deadline]').count(), 0);
  } finally {
    await browser.close(); await app.close();
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});
