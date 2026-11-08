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
  "schema": "bao.workflow/v4",
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

test("Share, guide, editor export, and import preserve saved evidence", { timeout: 60_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-share-download-"));
  const app = await startApp({ home, port: 0 });
  let browser: Awaited<ReturnType<typeof testChromium.launch>> | undefined;
  try {
    const doc = JSON.parse(fileBytes) as WorkflowV2;
    const password = "share-export-password-fixture";
    doc.inputs = [
      { name: "password", type: "secret", label: "Password", required: true, default: password },
      { name: "email", type: "text", label: "Email", default: "ada@example.test" },
      { name: "name", type: "text", label: "Name", default: "Ada Lovelace" },
      { name: "path", type: "text", label: "Path", default: "/Users/fixture/report.txt" },
      { name: "phone", type: "text", label: "Phone", default: "415-555-0123" },
      { name: "query", type: "text", label: "Query", default: "café notes" },
    ];
    doc.steps.push(
      { id: "password", index: 1, action: "type", label: "Password", surface: "dom", timeoutMs: 1000, input: "password", value: "{{password}}" },
      { id: "copy", index: 2, action: "type", label: "Copy", surface: "dom", timeoutMs: 1000, value: password },
    );
    app.library.save(doc);
    const base = `http://127.0.0.1:${app.port}`;
    const endpoint = `/api/workflows/${encodeURIComponent(doc.id)}`;
    const json = await fetch(base + endpoint);
    assert.equal(json.status, 200);
    const rawBytes = await json.text();
    assert.deepEqual(JSON.parse(rawBytes), doc);
    const released = await fetch(base + endpoint + "/export");
    assert.equal(released.status, 200);
    const releasedBytes = Buffer.from(await released.arrayBuffer());
    const releasedDoc = JSON.parse(releasedBytes.toString()) as WorkflowV2;
    assert.equal(releasedBytes.includes(password), true);
    assert.deepEqual(releasedDoc, doc);
    assert.equal(releasedDoc.inputs.some((input) => input.askOnImport), false);
    assert.equal(releasedDoc.steps[1]?.value, "{{password}}");
    assert.equal(releasedDoc.steps[2]?.value, password);
    const guide = await fetch(base + endpoint + "/guide");
    assert.equal(guide.status, 200);
    const guideBytes = Buffer.from(await guide.arrayBuffer());
    assert.match(guideBytes.toString(), /<!doctype html>/i);
    assert.equal(guideBytes.includes(password), true);

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
      { button: "share-export", endpoint: endpoint + "/export", name: "export-é.json", bytes: releasedBytes },
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
    await page.locator("#workflow-edit summary").click();
    assert.deepEqual(JSON.parse(await page.locator("#edit-json").inputValue()), doc);
    await page.locator("[data-export]").click();
    await page.waitForFunction(() => (document.getElementById("import-json") as HTMLTextAreaElement).value.length > 0);
    assert.deepEqual(JSON.parse(await page.locator("#import-json").inputValue()), doc);
    const imported = page.waitForResponse((response) => response.url() === base + "/api/workflows/import" && response.request().method() === "POST");
    await page.locator("#import").click();
    assert.equal((await imported).status(), 200);
    assert.equal(await (await fetch(base + endpoint)).text(), rawBytes);
    assert.deepEqual(app.library.read(doc.id), doc);
  } finally {
    await browser?.close();
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
