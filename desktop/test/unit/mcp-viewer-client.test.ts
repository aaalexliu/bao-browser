import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { pinTestBrowser } from "../../src/launch";
import { viewerHtml } from "../../src/mcp/viewer";
import { testChromium } from "../../src/test-browser";

type Call = { id: number; params: { name: string } };
type HostWindow = Window & { baoCalls: Call[] };

async function calls(page: Page, count: number): Promise<Call[]> {
  await page.waitForFunction((size) => (window as unknown as HostWindow).baoCalls.length >= size, count);
  return page.evaluate(() => (window as unknown as HostWindow).baoCalls);
}

async function deliver(page: Page, message: unknown): Promise<void> {
  await page.evaluate(async (data) => {
    window.dispatchEvent(new MessageEvent("message", { source: window, data }));
    await Promise.resolve();
  }, message);
}

function receipt(name: string) {
  return {
    view: "receipt", run: { id: "run-fixture", workflowId: "fixture", name, at: 1, kind: "replay", status: "passed", stepCount: 0, modelCalls: 0, healCount: 0 },
    steps: [], workflow: null, handoff: null, stepOffset: 0, nextStepOffset: null,
  };
}

const history = { view: "history", runs: [], offset: 0, nextOffset: null, skipped: 0, order: "recently updated" };

test("viewer keeps the latest host view and user request when replies arrive out of order", async (t) => {
  pinTestBrowser();
  const browser = await testChromium.launch({ headless: true, executablePath: process.env.BAO_TEST_BROWSER });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const host = window as unknown as HostWindow;
    host.baoCalls = [];
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const message: unknown = event.data;
      if (typeof message !== "object" || message === null || !("method" in message) || !("id" in message)) return;
      if (message.method && message.id !== undefined) event.stopImmediatePropagation();
      if (message.method === "ui/initialize") window.postMessage({ jsonrpc: "2.0", id: message.id, result: { hostCapabilities: { serverTools: {} }, hostContext: {} } }, "*");
      if (message.method === "tools/call" && typeof message.id === "number" && "params" in message &&
          typeof message.params === "object" && message.params !== null && "name" in message.params &&
          typeof message.params.name === "string") {
        host.baoCalls.push({ ...message, id: message.id, params: { ...message.params, name: message.params.name } });
      }
    });
  });
  await page.goto(`data:text/html;base64,${Buffer.from(viewerHtml()).toString("base64")}`);
  const initial = (await calls(page, 1))[0]!;
  assert.equal(initial.params.name, "list_runs");
  await deliver(page, { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { baoViewer: receipt("Host receipt") } } });
  await deliver(page, { jsonrpc: "2.0", id: initial.id, result: { _meta: { baoViewer: history } } });
  assert.equal(await page.locator("h1").textContent(), "Host receipt");

  await page.getByRole("button", { name: "History", exact: true }).click();
  const older = (await calls(page, 2))[1]!;
  await deliver(page, { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { baoViewer: receipt("Late model receipt") } } });
  assert.equal(await page.locator("h1").textContent(), "Host receipt");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const latest = (await calls(page, 3))[2]!;
  assert.equal(latest.params.name, "inspect_run");
  await deliver(page, { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { baoViewer: receipt("Another late model receipt") } } });
  assert.equal(await page.locator("h1").textContent(), "Host receipt");
  await deliver(page, { jsonrpc: "2.0", id: latest.id, result: { _meta: { baoViewer: receipt("Refreshed receipt") } } });
  await deliver(page, { jsonrpc: "2.0", id: older.id, result: { _meta: { baoViewer: history } } });
  assert.equal(await page.locator("h1").textContent(), "Refreshed receipt");

  await page.getByRole("button", { name: "History", exact: true }).click();
  const staleError = (await calls(page, 4))[3]!;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const newer = (await calls(page, 5))[4]!;
  await deliver(page, { jsonrpc: "2.0", id: staleError.id, error: { message: "stale request failed" } });
  assert.equal(await page.getByRole("alert").textContent(), "");
  await deliver(page, { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { baoViewer: receipt("Late result after stale error") } } });
  assert.equal(await page.locator("h1").textContent(), "Refreshed receipt");
  await deliver(page, { jsonrpc: "2.0", id: newer.id, result: { _meta: { baoViewer: receipt("Latest receipt") } } });
  assert.equal(await page.locator("h1").textContent(), "Latest receipt");

  await page.getByRole("button", { name: "History", exact: true }).click();
  const ordinary = (await calls(page, 6))[5]!;
  await deliver(page, { jsonrpc: "2.0", id: ordinary.id, result: { _meta: { baoViewer: { ...history, runs: [receipt("Visible run").run] } } } });
  assert.equal(await page.locator("h1").textContent(), "Run history");
  await page.getByRole("button", { name: "Inspect run", exact: true }).click();
  const inspect = (await calls(page, 7))[6]!;
  assert.equal(inspect.params.name, "inspect_run");
  await deliver(page, { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { baoViewer: receipt("Old model navigation") } } });
  assert.equal(await page.locator("h1").textContent(), "Run history");
  await deliver(page, { jsonrpc: "2.0", id: inspect.id, result: { _meta: { baoViewer: receipt("User-selected run") } } });
  assert.equal(await page.locator("h1").textContent(), "User-selected run");
  await deliver(page, { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { baoViewer: receipt("New model navigation") } } });
  assert.equal(await page.locator("h1").textContent(), "New model navigation");

  await page.getByRole("button", { name: "History", exact: true }).click();
  const failed = (await calls(page, 8))[7]!;
  await deliver(page, { jsonrpc: "2.0", id: failed.id, error: { message: "current request failed" } });
  assert.equal(await page.getByRole("alert").textContent(), "current request failed");
  await deliver(page, { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { baoViewer: receipt("Model navigation after failure") } } });
  assert.equal(await page.locator("h1").textContent(), "Model navigation after failure");

  const step = { id: "preview", index: 1, label: "Preview", status: "passed", picturesAllowed: true };
  const pictureView = { ...receipt("Picture receipt"), steps: [step] };
  await deliver(page, { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { baoViewer: pictureView } } });
  await page.getByRole("button", { name: "Inspect receipt", exact: true }).click();
  await page.getByRole("button", { name: "Open step pictures", exact: true }).click();
  const picture = (await calls(page, 9))[8]!;
  await deliver(page, { jsonrpc: "2.0", id: picture.id, result: { _meta: { baoPictures: { runId: "run-fixture", stepId: "preview", pictures: [{ phase: "after", mimeType: "image/png", data: "iVBORw0KGgo=" }] } } } });
  assert.equal(await page.locator("img").count(), 1);
  const detailsHidden = "Details are hidden because the workflow changed after this run or could not be verified.";
  await deliver(page, { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { baoViewer: { ...pictureView, detailsHidden, steps: [{ ...step, picturesAllowed: false }] } } } });
  assert.equal(await page.locator("img").count(), 0);
  assert.equal(await page.getByText(detailsHidden, { exact: true }).count(), 1);
  assert.equal(await page.getByText("No separate read-back recorded. Status does not prove a durable page change.", { exact: true }).count(), 0);
});
