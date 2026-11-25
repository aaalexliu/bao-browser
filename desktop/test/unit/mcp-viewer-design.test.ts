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

async function mount(browser: Browser, hostContext: object = {}, serverTools = true): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 560, height: 900 } });
  await page.addInitScript(({ context, serverTools }) => {
    const host = window as unknown as HostWindow;
    host.viewerCalls = [];
    window.addEventListener("message", (event) => {
      const message: unknown = event.data;
      if (event.source !== window || typeof message !== "object" || message === null || !("method" in message) || !("id" in message)) return;
      event.stopImmediatePropagation();
      if (message.method === "ui/initialize") window.postMessage({ jsonrpc: "2.0", id: message.id, result: { hostContext: context, hostCapabilities: serverTools ? { serverTools: {} } : {} } }, "*");
      if (message.method === "ui/request-display-mode" && typeof message.id === "number") host.viewerCalls.push({ id: message.id, params: { name: "display-mode" } });
      if (message.method === "tools/call" && typeof message.id === "number" && "params" in message &&
          typeof message.params === "object" && message.params !== null && "name" in message.params && typeof message.params.name === "string") {
        host.viewerCalls.push({ id: message.id, params: { name: message.params.name } });
      }
    });
  }, { context: hostContext, serverTools });
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

  await t.test("display-mode retries clear errors and keep Inspect receipt in the Tab order", async () => {
    const page = await mount(browser, { displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] });
    try {
      await deliver(page, view(receipt));
      await page.getByRole("button", { name: "Inspect receipt", exact: true }).click();
      await deliver(page, { jsonrpc: "2.0", id: await lastCall(page), error: { message: "Mode request failed" } });
      assert.equal(await page.getByRole("alert").textContent(), "Mode request failed");
      await page.getByRole("button", { name: "Inspect receipt", exact: true }).click();
      assert.equal(await page.getByRole("alert").textContent(), "");
      await deliver(page, { jsonrpc: "2.0", id: await lastCall(page, 2), result: { mode: "fullscreen" } });
      assert.equal(await page.getByRole("heading", { name: "Step results", exact: true }).count(), 1);
      await page.getByRole("button", { name: "Back to conversation", exact: true }).click();
      await deliver(page, { jsonrpc: "2.0", id: await lastCall(page, 3), result: { mode: "inline" } });
      await deliver(page, context({ displayMode: "inline" }));
      const inspect = page.getByRole("button", { name: "Inspect receipt", exact: true });
      await page.getByRole("button", { name: "Refresh", exact: true }).focus();
      await page.keyboard.press("Tab");
      assert.equal(await inspect.evaluate((node) => node === document.activeElement), true);
    } finally { await page.close(); }
  });

  await t.test("capability and forwarding errors omit retry hints", async () => {
    for (const serverTools of [true, false]) {
      const page = await mount(browser, {}, serverTools);
      try {
        await deliver(page, view(receipt));
        await page.getByRole("button", { name: "Refresh", exact: true }).click();
        if (serverTools) await deliver(page, { jsonrpc: "2.0", id: await lastCall(page), result: {} });
        assert.equal(await page.getByRole("alert").textContent(), serverTools
          ? "This chat app did not pass on Bao's run. Open Bao to see it."
          : "This chat app cannot load more from Bao. Open Bao to see this run.");
        assert.equal(await page.locator("#error .muted").textContent(), "");
        await page.getByRole("button", { name: "Inspect receipt", exact: true }).click();
        assert.equal(await page.getByRole("alert").textContent(), "");
        await page.getByRole("button", { name: "Open step pictures", exact: true }).click();
        if (serverTools) await deliver(page, { jsonrpc: "2.0", id: await lastCall(page, 2), result: {} });
        assert.equal(await page.getByRole("alert").textContent(), serverTools
          ? "This chat app did not pass on the pictures."
          : "This chat app cannot load more from Bao. Open Bao to see this run.");
        assert.equal(await page.locator("#error .muted").textContent(), "");
      } finally { await page.close(); }
    }
  });

  await t.test("picture replies survive same-run updates without clearing newer errors", async () => {
    for (const update of ["refresh", "host"] as const) {
      const page = await mount(browser);
      try {
        await deliver(page, view(receipt));
        await page.getByRole("button", { name: "Inspect receipt", exact: true }).click();
        await page.getByRole("button", { name: "Open step pictures", exact: true }).click();
        const failedPicture = await lastCall(page);
        await deliver(page, view(receipt));
        await deliver(page, { jsonrpc: "2.0", id: failedPicture, error: { message: "Picture read failed" } });
        assert.equal(await page.getByRole("alert").textContent(), "Picture read failed");
        await page.getByRole("button", { name: "Open step pictures", exact: true }).click();
        const picture = await lastCall(page, 2);
        assert.equal(await page.getByRole("alert").textContent(), "");
        if (update === "refresh") {
          await page.getByRole("button", { name: "Refresh", exact: true }).click();
          await deliver(page, { jsonrpc: "2.0", id: await lastCall(page, 3), result: { _meta: { baoViewer: receipt } } });
        } else await deliver(page, view(receipt));
        await page.getByRole("button", { name: "History", exact: true }).click();
        await deliver(page, { jsonrpc: "2.0", id: await lastCall(page, update === "refresh" ? 4 : 3), error: { message: "Newer read failed" } });
        await deliver(page, { jsonrpc: "2.0", id: picture, result: { _meta: { baoPictures: { runId: run.id, stepId: "project", pictures: [{ phase: "after", mimeType: "image/png", data: "iVBORw0KGgo=" }] } } } });
        assert.equal(await page.locator("img").count(), 1);
        assert.equal(await page.getByRole("alert").textContent(), "Newer read failed");
        await deliver(page, view({ ...receipt, steps: [{ ...receipt.steps[0], picturesAllowed: false }] }));
        assert.equal(await page.locator("img").count(), 0);
      } finally { await page.close(); }
    }
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
          for (const selector of ["h1", ".muted", ".status", "button", "[role=alert]"]) {
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

  await t.test("cards take the host's fonts, colors and corners and show only words for the person", async () => {
    const variables = { "--font-sans": "Georgia, serif", "--color-background-primary": "rgb(1, 2, 3)", "--color-text-primary": "rgb(250, 250, 250)", "--border-radius-md": "3px" };
    const page = await mount(browser, { theme: "dark", styles: { variables } });
    try {
      const card = { command: "click", status: "complete", style: "frame", caption: "Clicked.", parts: ["Clicked ", { cite: "Print" }], runId: "run-card", stepId: "command-27",
        picture: { kind: "unavailable", reason: "Page screenshot unavailable: overlay timeout hide." } };
      await deliver(page, { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { _meta: { baoToolCard: card } } });
      const look = await page.evaluate(() => ({ font: getComputedStyle(document.body).fontFamily, background: getComputedStyle(document.body).backgroundColor,
        color: getComputedStyle(document.body).color, corner: getComputedStyle(document.querySelector("button")!).borderRadius }));
      assert.deepEqual(look, { font: "Georgia, serif", background: "rgb(1, 2, 3)", color: "rgb(250, 250, 250)", corner: "3px" });
      const words = await page.locator("#root").innerText();
      assert.match(words, /Step 27 · click/);
      assert.match(words, /No picture of this step/);
      assert.doesNotMatch(words, /\bBAO\b|overlay timeout|target picture/);

      await deliver(page, view({ ...receipt, run: { ...run, modelCalls: null } }));
      await page.getByRole("button", { name: "Inspect receipt", exact: true }).click();
      const receiptWords = await page.locator("#root").innerText();
      assert.doesNotMatch(receiptWords, /\bBAO\b|Read-only|read-back|Model calls|run-design|Library/);
    } finally { await page.close(); }
  });

  await t.test("a card drawn from the result text alone leaves out guidance for the model", async () => {
    const page = await mount(browser, {}, false);
    try {
      const content = [{ type: "text", text: "The owner took control of this tab and handed it back. Take a fresh snapshot before acting." }, { type: "text", text: '{"run_id":"run-card","step_id":"command-27"}' }];
      await deliver(page, { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content } });
      assert.equal(await page.locator(".browser-caption").innerText(), "You took over this tab and handed it back");
    } finally { await page.close(); }
  });

  await t.test("navigation renders receipts and picture reads ignore stale views", async () => {
    const page = await mount(browser);
    try {
      await deliver(page, view(history));
      await page.getByRole("button", { name: "Inspect run", exact: true }).focus();
      await page.keyboard.press("Enter");
      await deliver(page, { jsonrpc: "2.0", id: await lastCall(page), result: { _meta: { baoViewer: receipt } } });
      assert.equal(await page.locator("h1").textContent(), run.name);
      await page.getByRole("button", { name: "Inspect receipt", exact: true }).click();
      await page.getByRole("button", { name: "Open step pictures", exact: true }).click();
      await deliver(page, { jsonrpc: "2.0", id: await lastCall(page, 2), result: { _meta: { baoPictures: { runId: run.id, stepId: "project", pictures: [] } } } });
      assert.equal(await page.getByText("No pictures of this step.").count(), 1);
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
