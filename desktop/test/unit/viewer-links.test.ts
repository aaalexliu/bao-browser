// The failed run still opens on the failed step. The act bar is the login ask.

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

test("the runs list opens the failed step, and the act bar is the login ask", { timeout: 60000 }, async () => {
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
    await page.waitForSelector("#act-bar[data-ask=login]");
    const bar = page.locator("#act-bar");
    assert.equal(await bar.getAttribute("data-step"), "login");
    assert.match(await bar.locator(".kicker").innerText(), /upload note/);
    assert.match(await bar.locator(".kicker").innerText(), /step 1 of 3/);
    assert.match(await bar.locator(".instruction").innerText(), /Sign in to the fixture in the Bao window/);
    assert.equal(await page.locator("#act-show").innerText(), "Show window");
    assert.equal(await page.locator("#act-continue").innerText(), "I'm signed in, continue");
    assert.equal(await page.locator("#act-cancel").innerText(), "Cancel run");
    assert.equal(await page.locator("#act-open-step").count(), 0);
    await page.waitForSelector("#toasts .toast");
    const toast = await page.locator("#toasts").innerText();
    assert.match(toast, /Run failed/);
    assert.match(toast, /stopped at Save/);
    assert.equal(await page.locator("#toasts [data-open-step]").count(), 0);
    assert.match(await page.locator("article.wf-card .status").innerText(), /failed/);
    await page.locator("button[data-screen=runs]").click();
    await page.locator("[data-open-run=run-fail]").click();
    await page.waitForSelector("#run-viewer .step.on[data-select-step=save]");
    assert.ok(await page.locator("#pass-grid span.cell.failed").count() >= 1);
    await page.locator("#step-list [data-select-step=login]").click();
    await page.waitForSelector("#run-viewer .step.on[data-select-step=login]");
    await page.locator("#open-failed-step").click();
    await page.waitForSelector("#run-viewer .step.on[data-select-step=save]");
    assert.equal(await page.locator("#act-bar").getAttribute("data-ask"), "login");
    assert.equal(await page.locator("#act-show").count(), 1);
    await page.locator("button[data-screen=runs]").click();
    await page.locator("[data-open-run=run-ok]").click();
    await page.waitForSelector("#rerun-run");
    await page.locator("#rerun-run").click();
    await page.waitForSelector("#args textarea[name=note]");
    assert.equal(await page.locator("#args textarea[name=note]").inputValue(), "earlier note");
    assert.equal(await page.locator("#args input[name=password]").inputValue(), "");
    const html = await page.content();
    assert.equal(html.includes("BaoSecretFixture9kQ7m"), false);
    assert.equal(html.includes('value="••••"'), false);
  } finally {
    await page.close();
    await browser.close();
    await app.close();
  }
});
