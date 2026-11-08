import assert from "node:assert/strict";
import test from "node:test";
import { BrowserDriver } from "../../src/v1/browser-driver";
import { interpret, type TrailEvent } from "../../src/v1/interpret";
import { recorderSource } from "../../src/v1/recorder";
import { replay } from "../../src/v1/replay";

test("a placeholder-only field replays into the input, not the nearby button", { timeout: 30_000 }, async () => {
  const { testChromium } = await import("../../src/test-browser.js");
  const browser = await testChromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const events: TrailEvent[] = [];
    let received: (() => void) | undefined;
    await context.exposeBinding("__baoRecord", async (_source, payload: TrailEvent) => {
      events.push(payload);
      received?.();
    });
    await context.addInitScript(recorderSource());
    const page = await context.newPage();
    const html = "<!doctype html><input name=\"q\" placeholder=\"Search\"><button type=\"button\">Search</button>";
    await page.goto(`data:text/html,${encodeURIComponent(html)}`);
    const recorded = new Promise<void>((resolve) => { received = resolve; });
    await page.locator("input[name=q]").fill("ada");
    await recorded;
    const doc = interpret(events, { id: "search", name: "Search", startUrl: "https://example.test/search" });
    const step = doc.steps.find((item) => item.action === "type");
    assert.ok(step);
    assert.equal(step.caption.citation?.source, "placeholder");
    assert.equal(step.caption.citation?.text, "Search");
    await page.locator("input[name=q]").fill("");
    const run = await replay(doc, {}, new BrowserDriver(page), { now: () => 1 });
    assert.equal(run.status, "passed", run.failure?.reason);
    assert.equal(await page.locator("input[name=q]").inputValue(), "ada");
    assert.equal(await page.locator("button").innerText(), "Search");
  } finally {
    await browser.close();
  }
});
