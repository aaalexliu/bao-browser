import assert from "node:assert/strict";
import test from "node:test";
import type { Browser, Page } from "playwright";
import { pinTestBrowser } from "../../src/launch";
import { viewerHtml } from "../../src/mcp/viewer";
import { testChromium } from "../../src/test-browser";

type HostWindow = Window & { viewerCalls: { id: number; params: { name: string } }[] };

async function deliver(page: Page, data: unknown): Promise<void> {
  await page.evaluate((message) => window.dispatchEvent(new MessageEvent("message", { source: window, data: message })), data);
}

async function mount(browser: Browser, hostContext: object = {}): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 560, height: 900 } });
  await page.addInitScript((context) => {
    const host = window as unknown as HostWindow;
    host.viewerCalls = [];
    window.addEventListener("message", (event) => {
      const message: unknown = event.data;
      if (event.source !== window || typeof message !== "object" || message === null || !("method" in message) || !("id" in message)) return;
      event.stopImmediatePropagation();
      if (message.method === "ui/initialize") window.postMessage({ jsonrpc: "2.0", id: message.id, result: { hostContext: context, hostCapabilities: { serverTools: {} } } }, "*");
      if (message.method === "tools/call" && typeof message.id === "number" && "params" in message &&
          typeof message.params === "object" && message.params !== null && "name" in message.params && typeof message.params.name === "string") {
        host.viewerCalls.push({ id: message.id, params: { name: message.params.name } });
      }
    });
  }, hostContext);
  await page.goto(`data:text/html;base64,${Buffer.from(viewerHtml()).toString("base64")}`);
  await page.waitForFunction(() => document.documentElement.dataset.theme !== undefined);
  return page;
}

const run = { id: "run-design", workflowId: "design", name: "Weekly report", at: 1, kind: "replay", status: "passed", stepCount: 1, modelCalls: 0, healCount: 0 };
const receipt = { view: "receipt", run, steps: [{ id: "project", index: 1, label: "Enter project name", status: "passed", picturesAllowed: true }], workflow: null, handoff: null, stepOffset: 0, nextStepOffset: null };
const history = { view: "history", runs: [run], offset: 0, nextOffset: null, skipped: 0 };
const view = (baoViewer: unknown) => ({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { baoViewer } } });
const context = (params: object) => ({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params });

async function lastCall(page: Page, count = 1): Promise<number> {
  await page.waitForFunction((size) => (window as unknown as HostWindow).viewerCalls.length >= size, count);
  return page.evaluate(() => (window as unknown as HostWindow).viewerCalls.at(-1)!.id);
}

function contrast(a: string, b: string): number {
  const luminance = (color: string) => {
    const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((n) => n / 255).map((n) => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test("viewer design survives long labels, host updates, errors and text resize", async (t) => {
  pinTestBrowser();
  const browser = await testChromium.launch({ headless: true, executablePath: process.env.BAO_TEST_BROWSER });
  t.after(() => browser.close());

  await t.test("long run and step headings reflow at 320px and 200% text size", async () => {
    const page = await mount(browser);
    try {
      await page.setViewportSize({ width: 320, height: 900 });
      const name = "WeeklyReportForNorthAmerica".repeat(5);
      for (const [fontSize, zoom, width] of [[16, 1, 320], [32, 1, 320], [16, 2, 640]] as const) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(({ size, scale }) => { document.documentElement.style.fontSize = `${size}px`; document.body.style.zoom = String(scale); }, { size: fontSize, scale: zoom });
        for (const data of [{ ...history, runs: [{ ...run, name }] }, { ...receipt, run: { ...run, name }, steps: [{ ...receipt.steps[0], label: name }] }]) {
          await deliver(page, view(data));
          const expand = page.getByRole("button", { name: "Inspect receipt", exact: true });
          if ("steps" in data && await expand.count()) await expand.click();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${fontSize}px root text`);
          for (const heading of await page.locator("h1,h2,h3").all()) {
            assert.equal(await heading.evaluate((node) => node.scrollWidth <= node.clientWidth), true, await heading.textContent() ?? "heading");
          }
        }
        assert.equal(await page.locator("body").evaluate((node) => getComputedStyle(node).fontSize), `${fontSize * 0.875}px`);
      }
    } finally { await page.close(); }
  });

  await t.test("size and theme updates keep errors, keyboard focus and disclosure state", async () => {
    const page = await mount(browser);
    try {
      await deliver(page, view(receipt));
      await page.getByRole("button", { name: "Inspect receipt", exact: true }).click();
      await page.locator("summary").click();
      await page.getByRole("button", { name: "Refresh", exact: true }).focus();
      await deliver(page, context({ theme: "dark", containerDimensions: { width: 360 } }));
      assert.equal(await page.getByRole("button", { name: "Refresh", exact: true }).evaluate((node) => node === document.activeElement), true);
      assert.equal(await page.locator("details").evaluate((node) => node instanceof HTMLDetailsElement && node.open), false);
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await deliver(page, { jsonrpc: "2.0", id: await lastCall(page), error: { message: "Read failed" } });
      assert.equal(await page.getByRole("alert").textContent(), "Read failed");
      assert.equal(await page.getByRole("button", { name: "Refresh", exact: true }).evaluate((node) => node === document.activeElement), true);
      await deliver(page, context({ containerDimensions: { width: 560 } }));
      assert.equal(await page.getByRole("alert").textContent(), "Read failed");
      await deliver(page, context({ locale: "en-GB" }));
      assert.equal(await page.getByRole("alert").textContent(), "Read failed");
      assert.equal(await page.getByText(/Try Refresh/).count(), 1);
      await deliver(page, view(history));
      assert.equal(await page.getByRole("alert").textContent(), "");
    } finally { await page.close(); }
  });

  await t.test("a failed Refresh keeps focus on History when the reader moved it while waiting", async () => {
    const page = await mount(browser);
    try {
      await deliver(page, view(history));
      await page.getByRole("button", { name: "Refresh", exact: true }).focus();
      await page.keyboard.press("Enter");
      const pending = await lastCall(page);
      await page.getByRole("button", { name: "History", exact: true }).focus();
      await deliver(page, { jsonrpc: "2.0", id: pending, error: { message: "Read failed" } });
      await page.waitForFunction(() => [...document.querySelectorAll("button")].some((node) => node.textContent === "Refresh" && !node.disabled));
      assert.equal(await page.getByRole("button", { name: "History", exact: true }).evaluate((node) => node === document.activeElement), true);
      assert.equal(await page.getByRole("alert").textContent(), "Read failed");
    } finally { await page.close(); }
  });

  await t.test("fallback and host text pairs pass AA in both themes", async () => {
    for (const theme of ["light", "dark"]) {
      for (const variables of [{}, {
        "--color-background-primary": "light-dark(#ffffff, #1a1a1a)",
        "--color-text-primary": "light-dark(#1f2937, #f3f4f6)",
        "--color-text-secondary": "light-dark(#6b7280, #9ca3af)",
        "--color-text-danger": "light-dark(#b91c1c, #f87171)",
      }]) {
        const page = await mount(browser, { theme, styles: { variables } });
        try {
          await deliver(page, view(receipt));
          await page.getByRole("button", { name: "Refresh", exact: true }).click();
          await deliver(page, { jsonrpc: "2.0", id: await lastCall(page), error: { message: "Read failed" } });
          for (const selector of ["h1", ".muted", ".mono", ".status", "button", "[role=alert]"]) {
            const pair = await page.locator(selector).first().evaluate((node) => {
              const style = getComputedStyle(node);
              let parent: Element | null = node;
              let background = "rgba(0, 0, 0, 0)";
              while (parent && background === "rgba(0, 0, 0, 0)") { background = getComputedStyle(parent).backgroundColor; parent = parent.parentElement; }
              return { foreground: style.color, background };
            });
            const ratio = contrast(pair.foreground, pair.background);
            assert.ok(ratio >= 4.5, `${theme} ${selector}: ${JSON.stringify(pair)} = ${ratio.toFixed(2)}:1`);
          }
        } finally { await page.close(); }
      }
    }
  });

  await t.test("navigation and picture reads leave focus at the changed content", async () => {
    const page = await mount(browser);
    try {
      await deliver(page, view(history));
      await page.getByRole("button", { name: "Inspect run", exact: true }).focus();
      await page.keyboard.press("Enter");
      await deliver(page, { jsonrpc: "2.0", id: await lastCall(page), result: { _meta: { baoViewer: receipt } } });
      assert.equal(await page.locator("h1").evaluate((node) => node === document.activeElement), true);
      await page.getByRole("button", { name: "Inspect receipt", exact: true }).click();
      await page.getByRole("button", { name: "Open step pictures", exact: true }).click();
      await deliver(page, { jsonrpc: "2.0", id: await lastCall(page, 2), result: { _meta: { baoPictures: { runId: run.id, stepId: "project", pictures: [] } } } });
      assert.equal(await page.locator("h3").evaluate((node) => node === document.activeElement), true);
      assert.equal(await page.getByText(/No shareable pictures/).count(), 1);
      let count = 2;
      for (const reply of [{ result: { _meta: { baoPictures: { runId: "run-other", stepId: "project", pictures: [] } } } }, { error: { message: "Stale picture read failed" } }]) {
        await deliver(page, view({ ...receipt, run: { ...run, id: "run-other" } }));
        await page.getByRole("button", { name: "Open step pictures", exact: true }).click();
        const stale = await lastCall(page, ++count);
        await deliver(page, view(history));
        await page.getByRole("button", { name: "History", exact: true }).focus();
        await deliver(page, { jsonrpc: "2.0", id: stale, ...reply });
        assert.equal(await page.locator("h1").textContent(), "Run history");
        assert.equal(await page.getByRole("button", { name: "History", exact: true }).evaluate((node) => node === document.activeElement), true);
        assert.equal(await page.getByRole("alert").textContent(), "");
      }
    } finally { await page.close(); }
  });
});
