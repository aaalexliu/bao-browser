import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import type { HelperStatus } from "../../src/helper-capabilities";
import { MacOsHelper } from "../../src/proxy/os-macos";
import { testChromium } from "../../src/test-browser";

test("app status and UI never ask for retired Chrome helper permissions", { timeout: 60_000 }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-permissions-"));
  const previousHome = process.env.HOME;
  const previousHelper = process.env.BAO_OS_HELPER;
  process.env.HOME = home;
  process.env.BAO_OS_HELPER = __filename;
  const calls: string[][] = [];
  t.mock.method(MacOsHelper.prototype, "exec", async (args: string[]) => {
    calls.push(args);
    return { ok: true, accessibility: false };
  });
  const app = await startApp({ home, port: 0, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  try {
    const url = `http://127.0.0.1:${app.port}`;
    const state = await fetch(`${url}/api/state`).then((res) => res.json()) as { helper: HelperStatus };
    assert.equal(state.helper.label, process.platform === "darwin" ? "helper available" : "helper off");
    assert.equal(state.helper.accessibility, false);
    assert.equal(state.helper.screenCapture, false);
    assert.equal("automation" in state.helper, false);
    assert.deepEqual(state.helper.capabilities.map((row) => row.id), process.platform === "darwin" ? ["window-capture", "mcp-ax"] : []);
    const before = calls.length;
    const retired = await fetch(`${url}/api/helper/automation`, { method: "POST" });
    assert.equal(retired.status, 404);
    assert.equal(calls.length, before, "retired route must not invoke the helper");
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    await page.goto(url);
    await page.waitForSelector("#rail nav");
    for (const pageEngine of ["old", "agent-browser"] as const) {
      app.library.updateSettings({ pageEngine });
      await page.reload();
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => { localStorage.setItem("bao-theme", value); }, theme);
        await page.reload();
        await page.locator('#rail [data-place="workflows"]').click();
        await page.locator('#screen-list [data-screen="library"]').click();
        assert.equal(await page.locator("#onboarding, #perm-dot, #automation-ask").count(), 0);
        assert.doesNotMatch(await page.locator("#rail").innerText(), /needs permission|AX press|live Chrome|Accessibility|Automation|Screen Recording/);
        await page.locator('#rail [data-place="settings"]').click();
        const mac = page.locator(".card").filter({ has: page.locator("#settings-helper") });
        assert.match(await mac.innerText(), /Chrome agents need no Accessibility, Automation, or Screen Recording permission/);
        assert.doesNotMatch(await mac.innerText(), /bao mcp-ax|bao remote-debugging/);
        assert.equal(await mac.locator("button").count(), 0);
        assert.equal(await page.locator("#automation-ask, #perm-dot, #onboarding").count(), 0);
      }
    }
    assert.equal(calls.length > 0, process.platform === "darwin");
    assert.ok(calls.every((args) => args.length === 1 && args[0] === "permissions-ax"), JSON.stringify(calls));
  } finally {
    await browser.close();
    await app.close();
    if (previousHelper === undefined) delete process.env.BAO_OS_HELPER;
    else process.env.BAO_OS_HELPER = previousHelper;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
