import assert from "node:assert/strict";
import test from "node:test";
import type { Browser, Page } from "playwright";
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

const finish = { outcome: "passed", reason: "", done: [] as string[], steps: 0, pageLoads: 0, reads: 0, clicks: 0, typed: 0, failedSteps: 0 };

function receipt(name: string) {
  return {
    view: "receipt", run: { id: "run-fixture", workflowId: "fixture", name, at: 1, kind: "replay", status: "passed", stepCount: 0, modelCalls: 0, healCount: 0 },
    live: false, latest: null, finish, steps: [], workflow: null, handoff: null, stepOffset: 0, nextStepOffset: null,
  };
}

const history = { view: "history", runs: [], offset: 0, nextOffset: null, skipped: 0, order: "recently updated" };
const result = (baoViewer: unknown) => ({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { baoViewer } } });

async function mount(browser: Browser, hostContext: object, clock = false): Promise<Page> {
  const page = await browser.newPage();
  if (clock) await page.clock.install();
  await page.addInitScript((context) => {
    const host = window as unknown as HostWindow;
    host.baoCalls = [];
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const message: unknown = event.data;
      if (typeof message !== "object" || message === null || !("method" in message) || !("id" in message)) return;
      // Requests the app sends stop here; a host-to-app request such as teardown goes on to the app.
      if (message.method && message.id !== undefined && message.method !== "ui/resource-teardown") event.stopImmediatePropagation();
      if (message.method === "ui/initialize") window.postMessage({ jsonrpc: "2.0", id: message.id, result: { hostCapabilities: { serverTools: {} }, hostContext: context } }, "*");
      if (message.method === "tools/call" && typeof message.id === "number" && "params" in message &&
          typeof message.params === "object" && message.params !== null && "name" in message.params &&
          typeof message.params.name === "string") {
        host.baoCalls.push({ ...message, id: message.id, params: { ...message.params, name: message.params.name } });
      }
    });
  }, hostContext);
  await page.goto(`data:text/html;base64,${Buffer.from(viewerHtml()).toString("base64")}`);
  await page.waitForFunction(() => document.documentElement.dataset.theme !== undefined);
  return page;
}

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
      if (message.method === "ui/initialize") window.postMessage({ jsonrpc: "2.0", id: message.id, result: { hostCapabilities: { serverTools: {} }, hostContext: { toolInfo: { tool: { name: "list_runs" } } } } }, "*");
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
  await deliver(page, { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { baoViewer: { ...pictureView, steps: [] } } } });
  assert.equal(await page.locator("img").count(), 0);
  assert.equal(await page.getByText("No step results recorded.", { exact: true }).count(), 1);

  const message = "Bao viewer data unavailable: invalid request, missing, linked, or oversized record. Open Bao desktop for local details.";
  await page.getByRole("button", { name: "History", exact: true }).click();
  const failedHistory = (await calls(page, 10))[9]!;
  assert.equal(failedHistory.params.name, "list_runs");
  await deliver(page, { jsonrpc: "2.0", id: failedHistory.id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: message, library: { active: { path: "/synthetic/library" }, inactive: [] } }) }] } });
  assert.equal(await page.getByRole("alert").textContent(), message);
  assert.equal(await page.locator("h1").textContent(), "Picture receipt");

  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const failedReceipt = (await calls(page, 11))[10]!;
  assert.equal(failedReceipt.params.name, "inspect_run");
  await deliver(page, { jsonrpc: "2.0", id: failedReceipt.id, result: { isError: true, content: [{ type: "text", text: message }] } });
  assert.equal(await page.getByRole("alert").textContent(), message);
  assert.equal(await page.locator("h1").textContent(), "Picture receipt");
});

test("a recording run's card leads with its task and latest step, reads the run again by itself, and stops when the run ends", async (t) => {
  pinTestBrowser();
  const browser = await testChromium.launch({ headless: true, executablePath: process.env.BAO_TEST_BROWSER });
  t.after(() => browser.close());
  const recording = (index: number, parts: unknown[]) => ({
    ...receipt("Life Time Sep–Nov 2026 receipts"),
    run: { ...receipt("").run, name: "Life Time Sep–Nov 2026 receipts", kind: "capture", status: "recording", stepCount: index, modelCalls: null },
    live: true, latest: { index, status: "passed", parts }, finish: { ...finish, outcome: "recording", steps: index, duration: "7 min 9 s" },
  });
  const page = await mount(browser, {}, true);
  await deliver(page, result(recording(29, ["Read the page ", { cite: "Transaction Details" }])));
  assert.equal(await page.locator("h1").textContent(), "Life Time Sep–Nov 2026 receipts");
  assert.equal(await page.locator("header .status").textContent(), "Recording");
  assert.equal(await page.locator(".browser-caption").textContent(), "Read the page Transaction Details");
  assert.equal(await page.getByText("29 steps so far · 7 min 9 s", { exact: true }).count(), 1);
  const body = await page.locator("body").innerText();
  for (const gone of ["Model calls", "run-fixture", "Read-only run viewer", "Reads the same Library", "Browser capture"]) assert.ok(!body.includes(gone), gone);
  for (const name of ["History", "Refresh", "Recent runs"]) assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0, name);

  await page.getByRole("button", { name: "Inspect receipt", exact: true }).focus();
  await page.clock.runFor(2_900);
  assert.equal(await page.evaluate(() => (window as unknown as HostWindow).baoCalls.length), 0);
  await page.clock.runFor(200);
  const first = (await calls(page, 1))[0]!;
  assert.equal(first.params.name, "inspect_run");
  assert.deepEqual((first.params as unknown as { arguments: unknown }).arguments, { run_id: "run-fixture", step_offset: 0, workflow_offset: 0 });
  await deliver(page, { jsonrpc: "2.0", id: first.id, result: { _meta: { baoViewer: recording(30, ["Clicked ", { cite: "Download" }, " (button)"]) } } });
  assert.equal(await page.locator(".browser-caption").textContent(), "Clicked Download (button)");
  assert.equal(await page.getByText("30 steps so far · 7 min 9 s", { exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "Inspect receipt", exact: true }).evaluate((node) => node === document.activeElement), true, "a live redraw keeps focus");

  await page.clock.runFor(3_000);
  const failed = (await calls(page, 2))[1]!;
  await deliver(page, { jsonrpc: "2.0", id: failed.id, error: { message: "Bao did not answer." } });
  assert.equal(await page.getByRole("alert").textContent(), "Bao did not answer.");
  assert.match(await page.locator("#error .muted").textContent() || "", /^Bao reads the run again in a few seconds\./);
  assert.equal(await page.locator(".browser-caption").textContent(), "Clicked Download (button)");

  await page.clock.runFor(3_000);
  const ended = (await calls(page, 3))[2]!;
  await deliver(page, { jsonrpc: "2.0", id: ended.id, result: { _meta: { baoViewer: {
    ...recording(59, ["Took a screenshot"]), run: { ...recording(59, []).run, status: "passed" }, live: false,
    reason: "Saved three receipt PDFs.", finish: { ...finish, steps: 59, duration: "8 min 54 s", done: ["September receipt", "October receipt", "November receipt"] },
  } } } });
  assert.equal(await page.getByRole("alert").textContent(), "");
  assert.equal(await page.locator("header .status").textContent(), "Passed");
  assert.equal(await page.locator(".browser-caption").textContent(), "Passed: Saved three receipt PDFs");
  assert.deepEqual(await page.locator(".browser-done li").allTextContents(), ["September receipt", "October receipt", "November receipt"]);
  await page.clock.runFor(30_000);
  assert.equal(await page.evaluate(() => (window as unknown as HostWindow).baoCalls.length), 3, "a finished run is not read again");
  await page.close();

  const closing = await mount(browser, {}, true);
  await deliver(closing, result(recording(3, ["Went to ", { cite: "Example" }])));
  await deliver(closing, { jsonrpc: "2.0", id: "teardown-1", method: "ui/resource-teardown", params: {} });
  await closing.clock.runFor(30_000);
  assert.equal(await closing.evaluate(() => (window as unknown as HostWindow).baoCalls.length), 0, "a card the host took down stops reading");
});
