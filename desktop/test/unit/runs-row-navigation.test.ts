import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { testChromium } from "../../src/test-browser";
import { formatClock } from "../../src/v1/time";
import { scaledMs } from "../runtime";

test("historical live sessions create no rows or attention, and stored waits keep their clock text", { timeout: scaledMs(30_000) }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-live-row-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  try {
    const file = path.join(home, "live-session", "session.json");
    await mkdir(path.dirname(file), { recursive: true });
    const session = { id: "live-row", status: "needs_human", intent: "Review the class schedule", host: "fixture.test", updatedAt: 1000, note: "Press Reserve yourself.", steps: [], audit: [] };
    await writeFile(file, JSON.stringify(session));
    const page = await browser.newPage({ viewport: { width: 720, height: 820 } });
    await page.goto(`http://127.0.0.1:${app.port}`);
    await page.locator('#runs-welcome').waitFor();
    const row = page.locator('#runs [data-screen="live"]');
    assert.equal(await row.count(), 0);
    assert.equal(await page.locator('#needs-you-heading .run-count').innerText(), "0");
    assert.equal(await page.locator('#runs [aria-current="true"]').count(), 0);
    assert.equal(await page.locator('#attention').getAttribute('data-count'), "0");
    assert.equal(await page.locator('#attention-label').innerText(), "Nothing running");
    await page.locator(".runs-record").click();
    await page.locator("#start-url").waitFor();
    await page.getByRole("button", { name: "Back to Workflows", exact: true }).click();
    await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
    await page.locator('#rail [data-place="runs"]').click();
    await page.locator('#runs-welcome').waitFor();
    await writeFile(file, JSON.stringify({ ...session, status: "running", updatedAt: 2000 }));
    await page.reload();
    await page.locator('#runs-welcome').waitFor();
    assert.equal(await row.count(), 0);
    assert.equal(await page.locator('#runs section[aria-label="Now"]').count(), 0);
    assert.equal(await page.locator('#needs-you-heading .run-count').innerText(), "0");
    const deadline = formatClock(Date.now() + 112 * 60_000);
    app.library.saveRun({ id: "waiting-replay", workflowId: "agent-browser", status: "paused", at: 3000, steps: [], heals: [], envelope: { status: "needs_human", ask: "Press Reserve", deadline } });
    const waiting = page.locator('#runs [data-open-run="waiting-replay"]').first();
    await waiting.waitFor();
    assert.ok((await waiting.innerText()).includes(`Waits until ${deadline}`));
    assert.equal(await waiting.locator('[data-run-deadline]').count(), 0);
  } finally {
    await browser.close(); await app.close();
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});
