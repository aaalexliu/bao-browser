import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { MacOsHelper } from "../../src/proxy/os-macos";
import { testChromium } from "../../src/test-browser";

test("Settings technical details names Running Chrome as the default route", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-settings-route-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.mock.method(MacOsHelper.prototype, "exec", async () => ({ ok: false, accessibility: false }));
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  t.after(async () => {
    await browser.close();
    await app.close();
    process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${app.port}`, { waitUntil: "networkidle" });
  await page.locator('#rail [data-place="settings"]').evaluate((button) => (button as HTMLButtonElement).click());
  const summary = page.locator("#settings-advanced > summary");
  await summary.waitFor();
  if (!(await page.locator("#settings-advanced").evaluate((el) => (el as HTMLDetailsElement).open))) await summary.click();
  const route = page.locator("#agent-browser-route");
  await route.waitFor();
  const text = (await route.innerText()).replace(/\s+/g, " ").trim();
  const expected = [
    "The default route is Running Chrome. An agent-browser run uses your own Google Chrome in a new task tab, unless the agent names Bao profile or Fresh Chrome copy. Running Chrome needs the helper's Accessibility permission, not Automation or Screen Recording.",
    "A Fresh Chrome copy run leaves your original Chrome untouched, turns sync off in the copy, and deletes the copy when the session ends unless you keep the window open after the agent disconnects or Bao MCP stops. A kept copy stays on disk until the next agent session cleans it up, even if you close its window by hand.",
    "A Fresh Chrome copy needs no remote-debugging switch, Accessibility, or Automation.",
    "When no browser is named and Running Chrome cannot be used, for example without the Accessibility permission, the run uses the Bao profile.",
  ].join(" ");
  assert.equal(text, expected, "a paragraph that calls every run a fresh copy, or that drops the copy lifecycle or the Bao profile fallback, would fail");
  assert.equal(await page.locator("#page-engine-settings").locator("#agent-browser-route").count(), 1);
});
