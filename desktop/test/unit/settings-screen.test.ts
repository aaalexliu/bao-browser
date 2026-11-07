import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { MacOsHelper } from "../../src/proxy/os-macos";
import { testChromium } from "../../src/test-browser";

async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(check(), "saved setting did not reach the Library");
}

test("grouped Settings saves live controls, preserves secondary settings, opens Logins", { timeout: 60_000 }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-settings-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.mock.method(MacOsHelper.prototype, "exec", async () => ({ ok: true, accessibility: false }));
  const app = await startApp({ home: path.join(home, "library"), extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  try {
    const site = { origin: "https://example.test", probeUrl: "https://example.test/account", signedInSelector: "", signedInText: "", botCookies: "skip", origins: [], signedIn: false };
    await writeFile(path.join(home, "library", "login-sites.json"), JSON.stringify({ sites: [site] }));
    app.library.updateSettings({ siteTrust: { "https://example.test": "allow" } });
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${app.port}`);
    await page.locator('#rail [data-place="settings"]').click();
    await page.locator("#set-runs").waitFor();
    assert.deepEqual(await page.locator(".settings-heading").allTextContents(), ["Runs and heals", "Mac permissions", "Remote access", "Logins", "AI help"]);
    assert.equal(await page.getByText("Before each run", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).count(), 0);
    assert.equal(await page.getByRole("combobox", { name: "Use AI to suggest heals" }).count(), 0);
    assert.equal(await page.locator("#settings-model").innerText(), "None");
    assert.equal(await page.locator("#save-settings").count(), 0);
    await page.locator('label[for="heal-approve"]').click();
    await eventually(() => app.library.settings().heal === "approve");
    await page.locator("#promote-after").fill("5");
    await page.locator("#promote-after").press("Tab");
    await eventually(() => app.library.settings().promoteAfter === 5);
    await page.locator("#act-minutes").selectOption("60");
    await eventually(() => app.library.settings().actTimeoutMs === 3_600_000);
    await page.locator("#act-minutes").selectOption("custom");
    await page.locator("#act-custom").fill("75");
    await page.locator("#act-custom").press("Tab");
    await eventually(() => app.library.settings().actTimeoutMs === 4_500_000);
    for (const selector of ["#promote-after", "#act-custom"]) {
      if (selector === "#act-custom") await page.locator("#act-minutes").selectOption("custom");
      const input = page.locator(selector);
      const previous = await input.inputValue();
      await input.fill("");
      await input.press("Tab");
      assert.equal(await input.evaluate((el) => (el as HTMLInputElement).validity.valueMissing), true);
      assert.equal(app.library.settings().promoteAfter, 5);
      assert.equal(app.library.settings().actTimeoutMs, 4_500_000);
      await input.fill(previous);
      await input.press("Tab");
      await page.waitForFunction(() => document.getElementById("settings-feedback")?.textContent === "Saved.");
    }
    await page.locator("#remote-mcp").check();
    await eventually(() => app.library.settings().remoteMcp === true);
    await page.waitForFunction(() => document.getElementById("remote-state")?.textContent === "On, not paired");
    assert.match(await page.locator('[data-settings-jump="remote"]').innerText(), /On, not paired/);
    assert.equal(await page.locator("#relay-code").isVisible(), true);
    await page.locator("#remote-mcp").uncheck();
    await eventually(() => app.library.settings().remoteMcp === false);
    await page.locator('[data-settings-jump="ai"]').click();
    assert.equal(await page.evaluate(() => document.activeElement?.id), "set-ai");
    await page.locator("#settings-advanced > summary").click();
    await page.locator("#circuit-limit").fill("7");
    await page.locator("#circuit-limit").press("Tab");
    await eventually(() => app.library.settings().circuitLimit === 7);
    await page.locator("#remote-permission").selectOption("deny");
    await eventually(() => app.library.settings().remotePermission === "deny");
    await page.locator("[data-site-trust]").selectOption("ask");
    await eventually(() => app.library.settings().siteTrust?.["https://example.test"] === "ask");
    await page.locator("#sync-server").fill("http://127.0.0.1:12345");
    await page.locator("#sync-server").press("Tab");
    await eventually(() => app.library.settings().syncServer === "http://127.0.0.1:12345");
    await page.locator("#keep-agent-browser-open").check();
    await page.locator("#save-agent-browser-lifetime").click();
    await eventually(() => app.library.settings().keepAgentBrowserOpen === true);
    assert.equal(await page.locator("#settings-advanced").evaluate((el) => (el as HTMLDetailsElement).open), true);
    await page.locator("#theme").selectOption("dark");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    for (const width of [1280, 720, 390, 320]) {
      await page.setViewportSize({ width, height: 820 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `page overflows at ${width}`);
      assert.ok(await page.locator("#content").evaluate((el) => el.scrollWidth <= el.clientWidth), `Settings overflows at ${width}`);
    }
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.evaluate(() => { document.documentElement.dataset.baoNative = "true"; });
    for (const width of [1200, 1060, 720]) {
      await page.setViewportSize({ width, height: 820 });
      const fits = await page.locator("#screen-list > .pane-bar").evaluate((bar) => {
        const bounds = bar.getBoundingClientRect();
        return [...bar.querySelectorAll("h1, p")].every((el) => {
          const text = el.getBoundingClientRect();
          return text.top >= bounds.top && text.bottom <= bounds.bottom;
        });
      });
      assert.equal(fits, true, `native Settings header spills at ${width}px`);
    }
    await page.evaluate(() => { delete document.documentElement.dataset.baoNative; });
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.locator('#rail [data-place="runs"]').click();
    await page.locator('#rail [data-place="settings"]').click();
    await page.locator("#set-runs").waitFor();
    assert.equal(await page.locator('[data-settings-jump="runs"]').getAttribute("aria-current"), "true");
    assert.equal(await page.locator("#settings-feedback").innerText(), "");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.locator('#settings [data-remove]').click();
    assert.equal(await page.locator('#settings [data-remove]').count(), 1);
    await page.locator('#settings [data-screen="logins"]').click();
    await page.locator("#login-site").waitFor();
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator('[data-remove]').click();
    await page.waitForFunction(() => (document.getElementById("saved-logins")?.textContent || "").includes("No sites yet"));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await app.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
