import { fixtureDoc, fixtureStep } from "../support/fixture-step";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import type { LiveSessionRecord } from "../../src/cdp-live/live-record";
import { testChromium as chromium } from "../../src/test-browser.js";
import type { WorkflowV2 } from "../../src/v1/schema";
import { applyHermeticApp } from "../runtime";

test("historical sessions, Runs and Capture keep their content aligned in the app", { timeout: 60_000 }, async () => {
  const dirs = applyHermeticApp("ui-polish");
  const app = await startApp({ home: dirs.home, port: 0, chromeProfilesRoot: path.join(dirs.home, "profiles") });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BAO_TEST_BROWSER });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    await page.goto(`${base}/fixture`);
    const png = await page.screenshot();
    const liveSteps = Array.from({ length: 41 }, (_, index) => ({ name: index === 0 ? "start" : `click-${index}`, status: "passed", ms: 100 }));
    const audit: LiveSessionRecord["audit"] = [
      { action: "start", label: "http://127.0.0.1:47811/member", path: "/member", isTrusted: null, ms: 0, at: 1, shot: "shot-001.png", via: "cdp" },
      { action: "start", label: "Member report", path: "/member", isTrusted: null, ms: 100, at: 2, shot: "", via: "cdp" },
    ];
    for (let index = 1; index < liveSteps.length; index += 1) {
      audit.push({ action: "click", label: `Control ${index}`, path: "/member", isTrusted: true, ms: 0, at: index * 2 + 1, shot: "", via: "cdp" });
      audit.push({ action: "click", label: "Member report", path: "/member", isTrusted: null, ms: 100, at: index * 2 + 2, shot: index === liveSteps.length - 1 ? "shot-002.png" : "", via: "cdp" });
    }
    const sessionDir = path.join(dirs.home, "live-session");
    mkdirSync(path.join(sessionDir, "shots"), { recursive: true });
    for (const name of ["shot-001.png", "shot-002.png"]) writeFileSync(path.join(sessionDir, "shots", name), png);
    writeFileSync(path.join(sessionDir, "session.json"), JSON.stringify({ id: "live", intent: "Read member report", status: "passed", host: "", updatedAt: 1, steps: liveSteps, audit, note: "" }));
    const label = 'Click "View full credit report"';
    const workflow: WorkflowV2 = fixtureDoc({
      schema: "bao.workflow/v4", version: 2, id: "wf-ui-polish", name: "Read member report", createdAt: 1,
      startUrl: `${base}/fixture`, inputs: [],
      steps: [fixtureStep({ id: "s1", index: 0, action: "click", label, surface: "dom", timeoutMs: 1000, identity: { surface: "dom", role: "link", name: "View full credit report", path: [] } })],
    });
    app.library.save(workflow);
    const steps = [{ id: "s1", label, action: "click", status: "passed", startedAt: 1000, endedAt: 1100 }];
    app.library.saveRun({ id: "run-ui-polish", workflowId: workflow.id, at: 1, status: "passed", steps, heals: [] });
    app.library.saveRun({ id: "run-ui-paused", workflowId: workflow.id, at: 2, status: "paused", steps: [{ ...steps[0], status: "paused" }], heals: [], pageClasses: [
      { stepId: "s1", class: "changed", reason: "page changed", evidence: [] },
      { stepId: "s1", class: "changed", reason: "The upload control moved", evidence: [] },
      { stepId: "s1", class: "changed", reason: "page changed", evidence: [{ source: "dom", detail: "A new form appeared" }] },
    ] });

    for (const width of [1280, 900, 760]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${base}/?screen=live`);
      await page.locator("#live-shots img").waitFor();
      assert.equal(await page.getByRole("columnheader", { name: "View time", exact: true }).count(), 1);
      assert.doesNotMatch(await page.locator("#main").innerText(), /Page text is blurred/);
      await page.locator("#live-shots img").evaluate((img: HTMLImageElement) => img.decode());
      assert.match(await page.locator("#live-audit").innerText(), /http:\/\/127\.0\.0\.1:47811\/member/);
      const shot = await page.locator("#live-shots img").boundingBox();
      const main = await page.locator("#main").boundingBox();
      assert.ok(shot && main);
      assert.ok(shot.x >= main.x && shot.x + shot.width <= main.x + main.width, `shot fits at ${width}px`);
      assert.ok(shot.width < 1440 && Math.abs(shot.width / shot.height - 1440 / 900) < 0.01, "shot scales without cropping");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const pager = await page.locator("#live-pager a").first().evaluate((a) => {
        const css = getComputedStyle(a);
        return { decoration: css.textDecorationLine, border: css.borderStyle, height: a.getBoundingClientRect().height };
      });
      assert.deepEqual(pager, { decoration: "none", border: "solid", height: 32 });
      const shownSteps = () => page.locator("#live-steps li strong").allTextContents();
      assert.deepEqual(await shownSteps(), liveSteps.map((step) => step.name));
      assert.equal(await page.locator("#live-audit tbody tr").count(), 40);
      assert.match(await page.locator("#live-shots img").getAttribute("src") || "", /shot-001\.png$/);
      await page.getByRole("link", { name: "Next", exact: true }).click();
      await page.waitForURL(/screen=live&page=1/);
      await page.locator('#live-audit-page[data-page="2"]').waitFor();
      assert.deepEqual(await shownSteps(), liveSteps.map((step) => step.name));
      assert.equal(await page.locator("#live-audit tbody tr").count(), 40);
      assert.equal(await page.locator("#live-shots img").count(), 0);
      await page.getByRole("link", { name: "Next", exact: true }).click();
      await page.locator('#live-audit-page[data-page="3"]').waitFor();
      assert.deepEqual(await shownSteps(), liveSteps.map((step) => step.name));
      assert.equal(await page.locator("#live-audit tbody tr").count(), 2);
      assert.match(await page.locator("#live-shots img").getAttribute("src") || "", /shot-002\.png$/);
      await page.getByRole("link", { name: "Previous", exact: true }).click();
      await page.locator('#live-audit-page[data-page="2"]').waitFor();
      assert.deepEqual(await shownSteps(), liveSteps.map((step) => step.name));
      await page.getByRole("link", { name: "Previous", exact: true }).click();
      await page.locator('#live-audit-page[data-page="1"]').waitFor();
      assert.deepEqual(await shownSteps(), liveSteps.map((step) => step.name));
      assert.equal(await page.locator("#live-audit tbody tr").count(), 40);

      if (await page.getByRole("button", { name: "Show sidebar", exact: true }).isVisible()) {
        await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
      }
      await page.locator('#rail button[data-place="runs"]').click();
      await page.locator('#runs [data-open-run="run-ui-polish"]').first().click();
      await page.getByText("Detailed evidence", { exact: true }).click();
      await page.locator("#step-list .step-duration").waitFor();
      const timing = await page.locator("#step-list .step").evaluate((row) => {
        const label = row.querySelector(".step-label")!.getBoundingClientRect();
        const duration = row.querySelector(".step-duration")!;
        const range = document.createRange();
        range.selectNodeContents(duration);
        const rects = [...range.getClientRects()];
        return { lines: rects.length, within: rects.every((rect) => rect.bottom < row.getBoundingClientRect().bottom), beside: label.right <= duration.getBoundingClientRect().left };
      });
      assert.deepEqual(timing, { lines: 1, within: true, beside: true }, `duration has its own column at ${width}px`);

    }

    if (await page.getByRole("button", { name: "Show sidebar", exact: true }).isVisible()) {
      await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
    }
    await page.locator('#rail button[data-place="runs"]').click();
    await page.locator('#runs [data-open-run="run-ui-paused"]').first().click();
    await page.getByText("Detailed evidence", { exact: true }).click();
    await page.locator("#page-class-list").waitFor();
    assert.deepEqual(await page.locator("#page-class-list li").allTextContents(), [
      "page changed", "page changed The upload control moved", "page changed dom: A new form appeared",
    ], "hide only a repeated class label, not a distinct reason or evidence");
    await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
    await page.locator('#rail button[data-place="workflows"]').click();
    await page.getByRole('button', { name: 'Record', exact: true }).click();
    const mcp = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Agent and MCP" }) });
    assert.match(await mcp.innerText(), /agent_browser/);
    assert.match(await mcp.innerText(), /Supported single-page tasks save replayable workflows when the session ends/);
    assert.match(await mcp.innerText(), /Watch.*Runs/);
  } finally {
    await browser.close();
    await app.close();
    rmSync(path.dirname(dirs.home), { recursive: true, force: true });
  }
});
