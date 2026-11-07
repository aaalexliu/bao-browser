import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { testChromium } from "../../src/test-browser.js";
import type { WorkflowV2 } from "../../src/v1/schema";

const fileBytes = `{
  "createdAt": 1,
  "id": "export-é",
  "inputs": [],
  "name": "Café & notes",
  "schema": "bao.workflow/v2",
  "startUrl": "http://127.0.0.1:9/fixture",
  "steps": [
    {
      "action": "note",
      "id": "note",
      "index": 0,
      "label": "Read café notes",
      "surface": "dom"
    }
  ],
  "version": 2
}`;

test("Share opens exports that download the original bytes and names within the click", { timeout: 60_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-share-download-"));
  const app = await startApp({ home, port: 0 });
  let browser: Awaited<ReturnType<typeof testChromium.launch>> | undefined;
  try {
    const doc = JSON.parse(fileBytes) as WorkflowV2;
    app.library.save(doc);
    const base = `http://127.0.0.1:${app.port}`;
    const endpoint = `/api/workflows/${encodeURIComponent(doc.id)}`;
    const json = await fetch(base + endpoint);
    assert.equal(json.status, 200);
    assert.equal(await json.text(), fileBytes);
    const guide = await fetch(base + endpoint + "/guide");
    assert.equal(guide.status, 200);
    const guideBytes = Buffer.from(await guide.arrayBuffer());
    assert.match(guideBytes.toString(), /<!doctype html>/i);

    browser = await testChromium.launch({ headless: true, executablePath: process.env.BAO_TEST_BROWSER });
    const page = await browser.newPage({ acceptDownloads: true });
    await page.goto(base);
    await page.locator("#rail button[data-place=workflows]").click();
    await page.locator(`[data-open-workflow="${doc.id}"]`).click();
    await page.locator("#workflow-options > summary").click();
    const opener = page.getByTestId("share-open");
    const panel = page.getByTestId("share-panel");
    await opener.waitFor();
    assert.equal(await panel.isVisible(), false);
    await opener.click();
    assert.equal(await panel.isVisible(), true);
    assert.equal(await opener.getAttribute("aria-expanded"), "true");
    await opener.click();
    assert.equal(await panel.isVisible(), false);
    assert.equal(await opener.getAttribute("aria-expanded"), "false");
    await opener.click();

    await page.evaluate(() => {
      const observed: { connected: boolean; synchronous: boolean; href: string; name: string }[] = [];
      Object.assign(window, { observedDownloads: observed });
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        const target = window.event?.target;
        observed.push({
          connected: this.isConnected,
          synchronous: target instanceof Element && !!target.closest("[data-testid=share-export], [data-testid=share-guide]"),
          href: this.href,
          name: this.download,
        });
        click.call(this);
      };
    });

    for (const item of [
      { button: "share-export", endpoint, name: "export-é.json", bytes: Buffer.from(fileBytes) },
      { button: "share-guide", endpoint: endpoint + "/guide", name: "export-_-guide.html", bytes: guideBytes },
    ]) {
      const pending = page.waitForEvent("download");
      await page.getByTestId(item.button).click();
      const download = await pending;
      assert.equal(download.suggestedFilename(), item.name);
      assert.equal(download.url(), base + item.endpoint);
      assert.equal(await download.failure(), null);
      const saved = await download.path();
      assert.ok(saved);
      assert.deepEqual(readFileSync(saved), item.bytes);
      const observed = await page.evaluate(() => (window as unknown as { observedDownloads: unknown[] }).observedDownloads);
      assert.deepEqual(observed.at(-1), { connected: true, synchronous: true, href: base + item.endpoint, name: item.name });
      assert.equal(new URL(page.url()).pathname, "/");
    }
  } finally {
    await browser?.close();
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
