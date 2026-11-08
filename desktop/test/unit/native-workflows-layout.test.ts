import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { testChromium } from "../../src/test-browser.js";
import { applyHermeticApp } from "../runtime";

test("Workflows reserves native titlebar space and keeps narrow navigation above scrolling rows", { timeout: 60_000 }, async () => {
  const dirs = applyHermeticApp("native-workflows-layout");
  const app = await startApp({ home: dirs.home, extensionHost: false, chromeProfilesRoot: path.join(dirs.home, "profiles") });
  let browser: Awaited<ReturnType<typeof testChromium.launch>> | undefined;
  try {
    for (let index = 0; index < 60; index++) app.library.save({
      schema: "bao.workflow/v4", version: 2, id: `wf-${index}`, name: `Read statement ${index}`,
      createdAt: index, startUrl: "https://example.test/", inputs: [], steps: [],
    });
    browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
    for (const native of [false, true]) for (const width of [720, 1060, 1061]) for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({ viewport: { width, height: 860 } });
      await page.addInitScript((theme) => { localStorage.setItem("bao-theme", theme); }, theme);
      await page.goto(`http://127.0.0.1:${app.port}/`);
      if (native) await page.evaluate(() => { document.documentElement.dataset.baoNative = "true"; });
      if (width <= 1060) await page.locator("#sidebar-toggle").click();
      await page.locator("#rail [data-place=workflows]").click();
      await page.locator("#workflow-list").waitFor();
      const content = page.locator("#content");
      const contentTop = await content.evaluate((node) => node.getBoundingClientRect().top);
      const clearance = native && width <= 1060 ? 52 : 0;
      assert.equal(contentTop, clearance, `${native ? "native" : "browser"} ${width}px ${theme}`);
      if (width <= 1060) {
        const toggle = page.locator("#sidebar-toggle");
        const initial = await toggle.boundingBox();
        assert.ok(initial && initial.y >= clearance);
        await content.evaluate((node) => { node.scrollTop = 700; });
        const scrolled = await toggle.boundingBox();
        assert.ok(scrolled && scrolled.y >= clearance && scrolled.y < clearance + 52);
        assert.equal(await toggle.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        }), true, "rows cannot cover the sticky sidebar control");
        assert.equal(await page.locator(".library-heading").evaluate((node) => getComputedStyle(node).backgroundColor), await content.evaluate((node) => getComputedStyle(node).backgroundColor));
        await toggle.click();
        assert.equal(await page.locator("#sidebar-dialog").evaluate((node) => (node as HTMLDialogElement).open), true);
        await page.locator("#sidebar-close").click();
      } else {
        assert.equal(await page.locator("#rail").isVisible(), true);
        assert.ok((await page.locator(".library-heading").boundingBox())!.x >= 212);
      }
      await page.close();
    }
    for (let index = 1; index <= 3; index++) app.library.saveRun({
      id: `review-${index}`, workflowId: "wf-0", at: index, status: "passed",
      steps: [{ id: "read", status: "passed" }],
      heals: [{ id: `heal-${index}`, failedStep: { id: "read", label: "Read statement" } }],
    });
    for (const width of [720, 1060]) {
      const page = await browser.newPage({ viewport: { width, height: 860 } });
      await page.goto(`http://127.0.0.1:${app.port}/`);
      await page.evaluate(() => { document.documentElement.dataset.baoNative = "true"; });
      await page.locator("#sidebar-toggle").click();
      await page.locator("#rail [data-place=workflows]").click();
      await page.locator("#act-review").waitFor();
      assert.ok((await page.locator("#act-bar").boundingBox())!.y >= 52);
      assert.ok((await page.locator("#act-review").boundingBox())!.y >= 52);
      await page.locator("#content").evaluate((node) => { node.scrollTop = 700; });
      const toggle = (await page.locator("#sidebar-toggle").boundingBox())!;
      assert.ok(toggle.y >= 52 && toggle.y < 104);
      await page.close();
    }
  } finally {
    await browser?.close();
    await app.close();
    rmSync(path.dirname(dirs.home), { recursive: true, force: true });
  }
});
