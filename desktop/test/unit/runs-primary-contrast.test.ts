import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { testChromium } from "../../src/test-browser";
import { scaledMs } from "../runtime";

function luminance(color: string): number {
  const channels = color.match(/[\d.]+/g)!.map(Number).slice(0, 3).map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

test("Runs primary Keep and Import controls retain AA contrast in both themes", { timeout: scaledMs(30_000) }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-primary-contrast-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem("bao-theme", new URL(location.href).searchParams.get("theme") || "light"));
  app.library.saveRun({ id: "contrast-run", workflowId: "contrast-workflow", status: "passed", at: 1, steps: [], heals: [{ id: "contrast-heal", proposedPatch: { identity: { surface: "dom", role: "button", name: "Continue" } } }] });
  await page.route("**/api/state", async (route) => {
    const response = await route.fetch();
    const state = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, json: { ...state, pendingImport: { id: "contrast-import", phase: "confirm", domain: "example.test", message: "Import the fixture sign-in." } } });
  });
  try {
    for (const theme of ["light", "dark"]) {
      await page.goto(`http://127.0.0.1:${app.port}/?theme=${theme}`);
      await page.locator("#runs").waitFor();
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      await page.locator('#runs [data-heal="contrast-heal"]').click();
      const controls = [page.locator("#import-yes"), page.locator("#heal-detail [data-keep]")];
      for (const control of controls) {
        await control.waitFor();
        assert.equal(await control.isEnabled(), true);
        const colors = await control.evaluate((node) => {
          const css = getComputedStyle(node);
          return { foreground: css.color, background: css.backgroundColor, border: css.borderTopColor, opacity: css.opacity };
        });
        assert.deepEqual(colors, { foreground: "rgb(255, 255, 255)", background: "rgb(185, 82, 10)", border: "rgb(185, 82, 10)", opacity: "1" }, `${theme}: mock primary fill and on-accent text`);
        const light = luminance(colors.foreground);
        const dark = luminance(colors.background);
        const contrast = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
        assert.ok(contrast >= 4.5, `${theme}: WCAG AA control text contrast is ${contrast}`);
        await page.keyboard.press("Tab");
        await control.focus();
        const focus = await control.evaluate((node) => {
          const css = getComputedStyle(node);
          return { style: css.outlineStyle, width: css.outlineWidth, color: css.outlineColor };
        });
        assert.deepEqual(focus, { style: "solid", width: "2px", color: theme === "dark" ? "rgb(242, 145, 63)" : "rgb(185, 82, 10)" });
      }
    }
  } finally {
    await browser.close(); await app.close();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
