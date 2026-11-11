import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { testChromium } from "../../src/test-browser";
import { scaledMs } from "../runtime";

test("capture list mapping and record controls stay reachable without scrolling the shell", { timeout: scaledMs(90_000) }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-capture-picker-"));
  const oldHome = process.env.HOME;
  const oldDrive = process.env.BAO_DRIVE;
  const oldAgentProfile = process.env.BAO_AGENT_BROWSER_PROFILE_ROOT;
  process.env.HOME = home;
  process.env.BAO_DRIVE = "1";
  process.env.BAO_AGENT_BROWSER_PROFILE_ROOT = path.join(home, "agent-profile");
  const columns = Array.from({ length: 12 }, (_, index) => index);
  const fixture = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><title>Local inventory</title><h1>Inventory</h1><table><tbody>${[1, 2, 3].map((row) => `<tr class="inventory-row">${columns.map((column) => `<td class="field-${column}">Row ${row} value ${column}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  assert.ok(address && typeof address !== "string");
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "source-profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true, args: ["--use-mock-keychain", "--password-store=basic"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const base = `http://127.0.0.1:${app.port}`;
    await page.goto(base);
    await page.locator("#rail [data-place=workflows]").click();
    await page.getByRole("button", { name: "Record", exact: true }).click();
    await page.locator("#start-url").fill(`http://127.0.0.1:${address.port}`);
    const started = page.waitForResponse((response) => response.url() === `${base}/api/sessions` && response.request().method() === "POST");
    await page.locator("#start").click();
    const session = await started;
    assert.equal(session.ok(), true, await session.text());
    await page.locator("#record-bar").waitFor();
    for (const viewport of [{ width: 1200, height: 800 }, { width: 720, height: 420 }, { width: 320, height: 480 }]) {
      await page.setViewportSize(viewport);
      const shell = await page.locator("#app").boundingBox();
      const armed = page.waitForResponse((response) => response.url().endsWith("/api/sessions/extract/arm"));
      await page.locator("#rec-extract").click();
      assert.equal((await armed).ok(), true);
      const picked = await page.request.post(`${base}/api/sessions/drive`, { data: { click: ".inventory-row:first-child .field-0" } });
      assert.equal(picked.ok(), true, await picked.text());
      await page.locator("#extract-picker").waitFor();
      assert.ok(await page.locator("[data-col-name]").count() > 1);
      const picker = await page.locator("#extract-picker").boundingBox();
      const bar = await page.locator("#record-bar").boundingBox();
      assert.ok(picker && bar);
      assert.ok(picker.x >= 0 && picker.y >= 0 && picker.x + picker.width <= viewport.width);
      assert.ok(picker.y + picker.height <= bar.y);
      assert.ok(bar.y + bar.height <= viewport.height);
      for (const id of ["rec-extract", "rec-pause", "rec-stop"]) {
        assert.equal(await page.locator(`#${id}`).evaluate((element) => {
          const box = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        }), true, `${id} is covered at ${viewport.width}px`);
      }
      await page.locator("#rec-pause").click();
      await page.locator('#record-bar[data-paused="true"]').waitFor();
      await page.locator("#rec-pause").click();
      await page.locator('#record-bar[data-paused="false"]').waitFor();
      await page.locator("[data-col-name]").first().fill("inventory_name");
      await page.locator("#extract-commit").scrollIntoViewIfNeeded();
      const commit = await page.locator("#extract-commit").boundingBox();
      assert.ok(commit && commit.y >= 0 && commit.y + commit.height <= bar.y);
      assert.deepEqual(await page.locator("#app").boundingBox(), shell);
      assert.deepEqual(await page.evaluate(() => ({ x: scrollX, y: scrollY, height: document.documentElement.scrollHeight, width: document.documentElement.scrollWidth })), { x: 0, y: 0, height: viewport.height, width: viewport.width });
      if (viewport.height < 800) {
        assert.ok(await page.locator("#extract-picker").evaluate((element) => element.scrollHeight > element.clientHeight));
      }
      const committed = page.waitForResponse((response) => response.url().endsWith("/api/sessions/extract/commit"));
      await page.locator("#extract-commit").click();
      const result = await committed;
      assert.equal(result.ok(), true);
      assert.ok(((await result.json()) as { columns: string[] }).columns.includes("inventory_name"));
      await page.locator("#extract-picker").waitFor({ state: "detached" });
      assert.equal(await page.evaluate(() => scrollY), 0);
    }
  } finally {
    await browser.close();
    await app.close();
    await new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()));
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldDrive === undefined) delete process.env.BAO_DRIVE;
    else process.env.BAO_DRIVE = oldDrive;
    if (oldAgentProfile === undefined) delete process.env.BAO_AGENT_BROWSER_PROFILE_ROOT;
    else process.env.BAO_AGENT_BROWSER_PROFILE_ROOT = oldAgentProfile;
    await rm(home, { recursive: true, force: true });
  }
});
