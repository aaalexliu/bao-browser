import { testWorkflow } from "../support/workflow";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { testChromium } from "../../src/test-browser";
import { scaledMs } from "../runtime";

test("Workflows list keeps long names, search recovery, warnings and actions reachable", { timeout: scaledMs(60_000) }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-workflows-list-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const longName = "Create production Google OAuth client for 五秒 in the Chinglish AI project using the shared sign-in screen";
  for (const [id, name] of [["long", longName], ["short", "Read fixture"], ["unused", "Not run"]] as const) {
    app.library.save(testWorkflow({ schema: "bao.workflow/v4", id, name, createdAt: 1, startUrl: "/fixture", inputs: Array.from({ length: 13 }, (_, n) => ({ name: `text${n}`, type: "text" as const, label: `text${n}`, supply: "must" as const })), steps: [] }));
  }
  app.library.saveRun({ id: "old", workflowId: "long", status: "passed", at: 1, steps: [], heals: [] });
  app.library.saveRun({ id: "latest", workflowId: "long", status: "failed", at: 20, steps: [], heals: [] });
  app.library.saveRun({ id: "other", workflowId: "short", status: "passed", at: 10, steps: [], heals: [] });
  const damaged = path.join(home, "workflows", "damaged.json");
  await writeFile(damaged, "{");
  let page = await browser.newPage({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" });
  try {
    for (const theme of ["light", "dark"]) {
      if (theme === "dark") {
        await page.close();
        page = await browser.newPage({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" });
      }
      await page.addInitScript((value) => localStorage.setItem("bao-theme", value), theme);
      await page.goto(`http://127.0.0.1:${app.port}`);
      await page.locator("#rail [data-place=workflows]").click();
      await page.locator("#workflow-list").waitFor();
      assert.equal(await page.locator("#rail [data-place=workflows]").getAttribute("aria-describedby"), "workflow-warning-description");
      assert.match(await page.locator("#workflow-warning-description").textContent() || "", /One workflow can’t open/);
      assert.equal(await page.locator(".workflow-warning svg").count(), 1);
      assert.equal(await page.locator(".workflow-warning svg").evaluate((element) => getComputedStyle(element).color), theme === "light" ? "rgb(215, 0, 21)" : "rgb(255, 105, 97)");
      assert.equal(await page.locator("#workflow-list .status.passed").first().evaluate((element) => getComputedStyle(element).color), theme === "light" ? "rgb(30, 123, 52)" : "rgb(48, 209, 88)");
      assert.deepEqual(await page.locator(".workflow-row:not(.damaged-workflow-row)").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-workflow"))), ["long", "short", "unused"]);
      assert.match(await page.locator(".workflow-row").first().locator(".status").innerText(), /Failed$/);
      assert.equal(await page.locator("#library .chip, #library .thumb, #library img").count(), 0);
      for (const width of [1280, 720, 320, 640]) {
        await page.setViewportSize({ width, height: width === 640 ? 430 : 860 });
        const title = page.getByRole("button", { name: longName, exact: true });
        assert.equal(await title.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
        assert.equal(await title.evaluate((element) => getComputedStyle(element).whiteSpace), "normal");
        await title.focus();
        await page.keyboard.press("Tab");
        const next = page.getByRole("button", { name: "Read fixture", exact: true });
        assert.equal(await next.evaluate((element) => element === document.activeElement), true);
        assert.notEqual(await next.evaluate((element) => getComputedStyle(element).outlineStyle), "none");
        const bounds = await page.locator("#content").evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
        assert.ok(bounds.scroll <= bounds.width + 1, `${theme} ${width}px: ${JSON.stringify(bounds)}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      await page.getByRole("button", { name: "Search workflows", exact: true }).click();
      const search = page.getByRole("searchbox", { name: "Search workflows" });
      await search.fill("no such name");
      await page.locator("#library-no-results:not([hidden])").waitFor();
      assert.equal(await page.locator("#workflow-list").isHidden(), true);
      assert.match(await page.locator("#library-search-status").innerText(), /0 matching workflows/);
      await page.getByRole("button", { name: "Clear search", exact: true }).click();
      assert.equal(await search.inputValue(), "");
      assert.equal(await search.evaluate((element) => element === document.activeElement), true);
      assert.equal(await page.locator(".workflow-row:visible").count(), 4);
      await page.getByRole("button", { name: "damaged.json", exact: true }).click();
      assert.equal(await page.locator("#library-damaged summary").evaluate((element) => element === document.activeElement), true);
      assert.match(await page.locator("#library-damaged").innerText(), /damaged.json/);
      assert.match(await page.locator("#library-damaged").innerText(), /Go to Folder/);
      await page.getByRole("button", { name: "Record", exact: true }).click();
      await page.getByRole("button", { name: "Back to Workflows", exact: true }).click();
      assert.equal(await page.locator("#library-damaged details").isHidden(), true);
      await page.route("**/api/workflows/reveal", (route) => route.fulfill({ status: 500, json: { error: "Could not open the workflow folder." } }));
      await page.getByRole("button", { name: "Show in Finder", exact: true }).click();
      await page.getByText("Could not open the workflow folder. Open File details and recovery to find its path.", { exact: true }).waitFor();
      assert.equal(await page.locator("#library-damaged details").isVisible(), true);
      await page.unroute("**/api/workflows/reveal");
      await page.getByRole("button", { name: longName, exact: true }).focus();
      await page.keyboard.press("Enter");
      await page.locator("#workflow-detail").waitFor();
      assert.equal(await page.locator("#workflow-detail h2").innerText(), longName);
      await page.getByRole("button", { name: "Run…", exact: true }).click();
      await page.locator("#run").waitFor();
      assert.equal(await page.locator("#wf").inputValue(), "long");
      await page.setViewportSize({ width: 1280, height: 860 });
    }
    for (const id of ["long", "short", "unused"]) await rm(path.join(home, "workflows", `${id}.json`));
    await page.locator("#screen-list [data-screen=library]").click();
    await page.getByText("No workflows can open", { exact: true }).waitFor();
    await rm(damaged);
    await page.getByText("No workflows yet", { exact: true }).waitFor();
    assert.equal(await page.locator(".workflow-warning").count(), 0);
    await page.getByRole("button", { name: "Record a task", exact: true }).click();
    await page.getByRole("button", { name: "Start capture", exact: true }).waitFor();
  } finally {
    await browser.close();
    await app.close();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});
