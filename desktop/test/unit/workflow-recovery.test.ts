import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { testChromium } from "../../src/test-browser.js";
import { applyHermeticApp } from "../runtime";

test("workflow recovery keeps user choices, results and focus across state polls", { timeout: 60_000 }, async () => {
  const dirs = applyHermeticApp("workflow-recovery");
  const app = await startApp({ home: dirs.home, port: 0, extensionHost: false, chromeProfilesRoot: path.join(dirs.home, "profiles") });
  let browser: Awaited<ReturnType<typeof testChromium.launch>> | undefined;
  try {
    app.library.save({ schema: "bao.workflow/v2", version: 2, id: "good", name: "Good workflow", createdAt: 1, startUrl: "https://example.test/", inputs: [], steps: [] });
    mkdirSync(path.join(dirs.home, "workflows"), { recursive: true });
    writeFileSync(path.join(dirs.home, "workflows", "damaged.json"), "{");
    browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${app.port}/`);
    await page.locator("#rail [data-place=workflows]").click();
    const details = page.locator("#library-damaged details");
    const summary = details.locator("summary");
    const status = page.locator("#library-reveal-status");
    await page.locator("#library-damaged").waitFor();
    assert.equal(await details.isHidden(), true);
    const emptyStatus = await status.evaluate((node) => ({ display: getComputedStyle(node).display, height: node.getBoundingClientRect().height }));
    assert.notEqual(emptyStatus.display, "none");
    assert.equal(emptyStatus.height, 0);
    const bannerHeight = await status.evaluate((node) => {
      const before = node.parentElement!.getBoundingClientRect().height;
      node.setAttribute("hidden", "");
      const withoutStatus = node.parentElement!.getBoundingClientRect().height;
      node.removeAttribute("hidden");
      return { before, withoutStatus };
    });
    assert.equal(bannerHeight.before, bannerHeight.withoutStatus, "an empty result adds no blank banner row");

    let revision = 0;
    const poll = async () => {
      const previous = await page.locator("#library").elementHandle();
      app.library.saveRun({ id: "background", workflowId: "good", status: "passed", at: ++revision, steps: [], heals: [] });
      await page.waitForFunction((node) => !node?.isConnected, previous);
      await previous?.dispose();
    };
    await poll();
    assert.equal(await details.isHidden(), true, "polls do not reveal recovery before a request");
    await page.locator("[data-damaged-file]").click();
    await poll();
    assert.equal(await details.isVisible(), true);
    assert.equal(await details.getAttribute("open"), "");
    assert.equal(await summary.evaluate((node) => node === document.activeElement), true);
    await summary.click();
    await poll();
    assert.equal(await details.isVisible(), true);
    assert.equal(await details.getAttribute("open"), null, "polls retain a manual collapse");
    assert.equal(await summary.evaluate((node) => node === document.activeElement), true);

    const returnFromRecord = async () => {
      await page.getByRole("button", { name: "Record", exact: true }).click();
      await page.getByRole("button", { name: "Back to Workflows", exact: true }).click();
      assert.equal(await details.isHidden(), true);
      assert.equal(await details.getAttribute("open"), null);
      assert.equal(await status.innerText(), "");
    };
    await returnFromRecord();
    await page.route("**/api/workflows/reveal", (route) => route.fulfill({ status: 500, json: { error: "fixture folder failure" } }));
    await page.locator("#library-reveal").click();
    const failure = "Could not open the workflow folder. Open File details and recovery to find its path.";
    await page.getByRole("status").filter({ hasText: failure }).waitFor();
    assert.equal(await details.isVisible(), true);
    assert.equal(await details.getAttribute("open"), null);
    await poll();
    assert.equal(await status.innerText(), failure);
    assert.equal(await details.isVisible(), true, "failed folder opens leave recovery available after a poll");
    await summary.click();
    await poll();
    assert.equal(await details.getAttribute("open"), "");
    assert.equal(await summary.evaluate((node) => node === document.activeElement), true);
    assert.equal(await status.innerText(), failure);

    await page.route("**/api/workflows/reveal", (route) => route.fulfill({ json: { ok: true } }));
    await page.locator("#library-reveal").click();
    await page.getByRole("status").filter({ hasText: "Workflow folder opened in Finder." }).waitFor();
    await poll();
    assert.equal(await status.innerText(), "Workflow folder opened in Finder.");
    await page.locator("[data-open-workflow=good]").click();
    await page.locator("#workflow-detail [data-screen=library]").click();
    assert.equal(await details.isHidden(), true);
    assert.equal(await status.innerText(), "");
    await page.locator("#rail [data-place=settings]").click();
    await page.locator("#rail [data-place=workflows]").click();
    assert.equal(await details.isHidden(), true);
    assert.equal(await status.innerText(), "");

    for (const scenario of [
      { outcome: 200, boundary: "visit" }, { outcome: 500, boundary: "visit" },
      { outcome: 200, boundary: "damage" }, { outcome: 500, boundary: "damage" },
    ]) {
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => { finish = resolve; });
      let requested!: () => void;
      const started = new Promise<void>((resolve) => { requested = resolve; });
      await page.route("**/api/workflows/reveal", async (route) => {
        requested();
        await pending;
        await route.fulfill({ status: scenario.outcome, json: { ok: scenario.outcome === 200 } });
      });
      await page.locator("#library-reveal").click();
      await started;
      if (scenario.boundary === "visit") await returnFromRecord();
      else {
        writeFileSync(path.join(dirs.home, "workflows", "extra.json"), "{");
        await page.getByRole("button", { name: "extra.json", exact: true }).waitFor();
      }
      const replied = page.waitForResponse((response) => response.url().endsWith("/api/workflows/reveal"));
      finish();
      await replied;
      await poll();
      assert.equal(await details.isHidden(), true, "late folder replies cannot change a later recovery scope");
      assert.equal(await status.innerText(), "");
      await page.unroute("**/api/workflows/reveal");
      if (scenario.boundary === "damage") {
        rmSync(path.join(dirs.home, "workflows", "extra.json"));
        await page.getByRole("button", { name: "extra.json", exact: true }).waitFor({ state: "detached" });
      }
    }

    await page.route("**/api/workflows/reveal", (route) => route.fulfill({ json: { ok: true } }));
    await page.locator("[data-damaged-file]").click();
    await page.locator("#library-reveal").click();
    await page.getByRole("status").filter({ hasText: "Workflow folder opened in Finder." }).waitFor();
    rmSync(path.join(dirs.home, "workflows", "damaged.json"));
    writeFileSync(path.join(dirs.home, "workflows", "other.json"), "{");
    await page.getByRole("button", { name: "other.json", exact: true }).waitFor();
    assert.equal(await details.isHidden(), true, "a changed damaged set starts with recovery closed");
    assert.equal(await details.getAttribute("open"), null);
    assert.equal(await status.innerText(), "");
    await page.locator("#library-search-open").click();
    await page.locator("#library-search").fill("Good");
    await poll();
    assert.equal(await page.locator("#library-tools").isVisible(), true);
    assert.equal(await page.locator("#library-search").inputValue(), "Good");
    assert.equal(await page.locator("#library-search").evaluate((node) => node === document.activeElement), true);
    await page.getByRole("button", { name: "Record", exact: true }).click();
    await page.locator("#start").waitFor();
    assert.equal(await page.locator("#main").evaluate((node) => node === document.activeElement), true);
  } finally {
    await browser?.close();
    await app.close();
    rmSync(path.dirname(dirs.home), { recursive: true, force: true });
  }
});
