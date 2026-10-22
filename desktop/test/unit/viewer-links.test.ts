// One click from the library, the runs grid, and the act notice. Fixture data only.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { startApp } from "../../src/app/server";
import { makeAsk } from "../../src/v1/human-ask";
import { writePendingPrompt } from "../../src/v1/pending-prompt";
import type { WorkflowV2 } from "../../src/v1/schema";

test("the runs grid, the library, and the act notice open the failed step", { timeout: 60000 }, async () => {
  process.env.BAO_HEAL_CURSOR_ACCOUNT = "0";
  delete process.env.BAO_HEAL_FIXTURE;
  const home = mkdtempSync(path.join(tmpdir(), "bao-links-"));
  process.env.BAO_CHROME_USER_DATA = path.join(home, "no-chrome");
  const origin = 1_700_000_000_000;
  const app = await startApp({ home, port: 0 });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    const doc: WorkflowV2 = {
      schema: "bao.workflow/v2",
      version: 2,
      id: "wf-note",
      name: "upload note",
      startUrl: "http://127.0.0.1/fixture",
      createdAt: 1,
      inputs: [
        { name: "note", type: "text", label: "Note" },
        { name: "password", type: "secret", label: "Password" },
      ],
      steps: [
        { id: "login", index: 0, action: "login", human: true, label: "Sign in", surface: "dom", timeoutMs: 0 },
        { id: "save", index: 1, action: "click", label: "Save", surface: "dom", timeoutMs: 0 },
        { id: "note", index: 2, action: "type", label: "Type the note", surface: "dom", timeoutMs: 0, input: "note" },
      ],
    };
    app.library.save(doc);
    app.library.saveRun({
      id: "run-fail",
      workflowId: "wf-note",
      status: "failed",
      at: origin + 50_000,
      heals: [],
      failure: { stepId: "save", reason: "the Save control was gone" },
      inputs: { note: "alpha note", password: "••••" },
      videoStartedAt: origin,
      steps: [
        { id: "login", action: "login", status: "passed", label: "Sign in", startedAt: origin, endedAt: origin + 15_000 },
        { id: "save", action: "click", status: "failed", label: "Save", startedAt: origin + 15_400, endedAt: origin + 15_900 },
        { id: "note", action: "type", status: "passed", label: "Type the note", startedAt: origin + 16_000, endedAt: origin + 24_000 },
      ],
      trail: [
        { kind: "handoff", phase: "start", stepId: "note", ts: origin + 16_200 },
        { kind: "handoff", phase: "end", stepId: "note", ts: origin + 23_800 },
      ],
    });
    app.library.saveRun({
      id: "run-ok",
      workflowId: "wf-note",
      status: "passed",
      at: origin,
      heals: [],
      inputs: { note: "earlier note", password: "••••" },
      steps: [
        { id: "login", status: "passed", label: "Sign in" },
        { id: "save", status: "passed", label: "Save" },
        { id: "note", status: "passed", label: "Type the note" },
      ],
    });
    app.notices.unshift({
      id: "fail-run-fail",
      at: origin,
      title: "Run failed",
      body: "upload note stopped at Save.",
      workflowId: "wf-note",
      runId: "run-fail",
      stepId: "save",
    });
    writePendingPrompt(home, {
      runId: "run-fail",
      ask: makeAsk({
        kind: "login",
        workflowId: "wf-note",
        workflowName: "upload note",
        stepId: "login",
        stepIndex: 1,
        stepCount: 3,
        label: "Sign in",
        site: "127.0.0.1",
        timeoutMs: 0,
        now: origin,
        runId: "run-fail",
      }),
    });
    await page.addInitScript(() => {
      localStorage.setItem("bao-onboarded", "1");
      localStorage.setItem("bao-theme", "light");
    });
    await page.goto(`http://127.0.0.1:${app.port}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#act-open-step");
    await page.waitForSelector("#toasts [data-open-step=save]");
    await page.locator("article.wf-card button.status.failed").click();
    await page.waitForSelector("#run-viewer .step.on[data-select-step=save]");
    const drift = await page.locator("#video-bar").evaluate((bar) => {
      const originMs = Number((bar as HTMLElement).dataset.origin || 0);
      const span = Number((bar as HTMLElement).dataset.span || 1);
      let worst = 0;
      bar.querySelectorAll<HTMLElement>("[data-marker]").forEach((marker) => {
        const at = Number(marker.dataset.at || 0);
        const left = Number.parseFloat(marker.style.left || "0");
        const placed = (left / 100) * (span / 1000);
        worst = Math.max(worst, Math.abs(placed - (at - originMs) / 1000));
      });
      return worst;
    });
    assert.ok(drift <= 0.5, `marker drift ${drift}s`);
    assert.equal(await page.locator(".idle-shade[data-idle=login]").count(), 1);
    assert.equal(await page.locator(".idle-shade[data-idle=handoff]").count(), 1);
    await page.locator("#step-list [data-select-step=login]").click();
    await page.waitForSelector("#run-viewer .step.on[data-select-step=login]");
    await page.locator("#pass-grid button.cell.failed").click();
    await page.waitForSelector("#run-viewer .step.on[data-select-step=save]");
    await page.locator("#act-open-step").click();
    await page.waitForSelector("#run-viewer .step.on[data-select-step=login]");
    await page.locator("#toasts [data-open-step=save]").click();
    await page.waitForSelector("#run-viewer .step.on[data-select-step=save]");
    await page.locator("button[data-screen=runs]").click();
    await page.locator("tr button.status.failed").click();
    await page.waitForSelector("#run-viewer .step.on[data-select-step=save]");
    await page.locator("button[data-screen=runs]").click();
    await page.locator("[data-rerun=run-ok]").click();
    await page.waitForSelector("#args textarea[name=note]");
    assert.equal(await page.locator("#args textarea[name=note]").inputValue(), "earlier note");
    assert.equal(await page.locator("#args input[name=password]").inputValue(), "");
    assert.match(await page.locator("#args input[name=password]").getAttribute("placeholder") || "", /Last run used a secret/);
    const html = await page.content();
    assert.equal(html.includes("BaoSecretFixture9kQ7m"), false);
    assert.equal(html.includes('value="••••"'), false);
  } finally {
    await page.close();
    await browser.close();
    await app.close();
  }
});
