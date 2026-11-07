import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { liveRunView } from "../../src/app/live-view";
import { startApp } from "../../src/app/server";
import type { RunSummary, ShellState } from "../../src/app/views";
import { testChromium } from "../../src/test-browser";
import { makeAsk } from "../../src/v1/human-ask";
import { writePendingPrompt } from "../../src/v1/pending-prompt";
import type { WorkflowV2 } from "../../src/v1/schema";
import { blankPng } from "../../src/v1/redacted-png";
import { applyHermeticApp } from "../runtime";

function workflow(startUrl: string): WorkflowV2 {
  return {
    schema: "bao.workflow/v2", version: 2, id: "wf-live-detail", name: "Book a class",
    startUrl, createdAt: 1, inputs: [],
    steps: [
      { id: "open", index: 0, label: "Open the schedule", action: "click", surface: "dom", identity: { surface: "dom", role: "button", name: "Apply", path: [] }, timeoutMs: 1000 },
      { id: "reserve", index: 1, label: "Press Reserve", action: "confirm", human: true, surface: "dom", postcondition: { kind: "text", match: "Booked", timeoutMs: 60000 }, timeoutMs: 60000 },
      { id: "check", index: 2, label: "Check the booking", action: "verify", surface: "dom", expect: { kind: "text", match: "Booked", timeoutMs: 1000 }, timeoutMs: 1000 },
    ],
  };
}

function ask(now = Date.now()) {
  return makeAsk({ kind: "confirm", workflowId: "wf-live-detail", workflowName: "Book a class", stepId: "reserve", stepIndex: 2, stepCount: 3, label: "Press Reserve", button: "Reserve", site: "example.test", timeoutMs: 7200000, now, runId: "run-detail" });
}

async function post(url: string, body?: unknown) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const value = await response.json() as { status: string; runId: string; error?: string };
  assert.equal(response.ok, true, JSON.stringify(value));
  return value;
}

test("live-run output shows recorded progress, local screens and an honest missing-screen state", async () => {
  const browser = await testChromium.launch();
  const page = await browser.newPage();
  try {
    const wf = workflow("https://example.test/classes");
    const prompt = ask(1000);
    const run: RunSummary = { id: "run-detail", workflowId: wf.id, status: "paused", at: 500, modelCalls: 0, steps: [
      { id: "open", status: "passed", startedAt: 500, endedAt: 1300, afterShot: "open.png" },
      { id: "reserve", status: "paused", beforeShot: "reserve.png" },
    ] };
    await page.setContent(liveRunView(prompt, run, wf, 1000));
    assert.equal(await page.getByRole("heading", { name: "Book a class" }).count(), 1);
    assert.equal(await page.locator("#live-steps li").count(), 3);
    assert.equal(await page.locator('#live-steps [data-status="passed"]').count(), 1);
    assert.match(await page.locator('#live-steps [aria-current="step"]').innerText(), /Wait for you: press Reserve, Needs you/);
    assert.equal(await page.locator('#live-steps [data-status="pending"]').count(), 1);
    assert.equal(await page.locator("#live-film li").count(), 2);
    assert.equal(await page.locator(".live-preview img").getAttribute("src"), "/api/runs/run-detail/shots/reserve.png");
    assert.equal(await page.locator("#live-run-details").getAttribute("open"), null);
    assert.equal(await page.getByRole("button", { name: "I pressed Reserve" }).count(), 1);
    assert.equal(await page.locator("#live-wait-left").innerText(), "2 h 0 min left");
    await page.setContent(liveRunView({ ...prompt, kind: "login", deadline: null }, { ...run, steps: [] }, wf, 1000));
    assert.equal(await page.locator(".live-preview img").count(), 0);
    assert.equal(await page.locator(".live-no-shot").innerText(), "No screen captured yet.");
    assert.equal(await page.locator("#live-film li").count(), 0);
    assert.equal(await page.getByRole("button", { name: "I’m signed in, continue" }).count(), 1);
    assert.match(await page.getByRole("timer").innerText(), /no timeout/);
    assert.equal(await page.locator('#live-steps [data-status="passed"]').count(), 0, "missing earlier results must not claim success");
    await page.setContent(liveRunView({ ...prompt, kind: "wall" }, null, null));
    assert.equal(await page.getByRole("button", { name: "Continue", exact: true }).count(), 1);
    assert.match(await page.locator("#live-steps").innerText(), /unavailable/);
  } finally { await browser.close(); }
});

test("Runs opens its exact active handoff, keeps progress stable, and confirms Stop", { timeout: 60000 }, async () => {
  const dirs = applyHermeticApp("live-detail");
  const app = await startApp({ home: dirs.home, port: 0 });
  const browser = await testChromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const wf = workflow(`${base}/fixture`);
    app.library.save(wf);
    app.library.saveRun({ id: "run-detail", workflowId: wf.id, status: "paused", at: Date.now() - 60000, heals: [], steps: [
      { id: "open", status: "passed", label: "Open the schedule", startedAt: 1, endedAt: 801, afterShot: "open.png" },
      { id: "reserve", status: "paused", label: "Press Reserve", beforeShot: "reserve.png" },
    ] });
    writePendingPrompt(dirs.home, { ask: ask(), runId: "run-detail" });
    const shots = path.join(dirs.home, "shots/runs/run-detail");
    mkdirSync(shots, { recursive: true });
    writeFileSync(path.join(shots, "open.png"), blankPng(400, 250));
    writeFileSync(path.join(shots, "reserve.png"), blankPng(400, 250));
    mkdirSync(path.join(dirs.home, "live-session"), { recursive: true });
    writeFileSync(path.join(dirs.home, "live-session/session.json"), JSON.stringify({ id: "past", intent: "Historical unrelated task", status: "passed", host: "past.test", updatedAt: 1, audit: [], steps: [], note: "" }));
    await page.goto(base);
    await page.waitForSelector("#live-film img");
    await page.getByRole("button", { name: "Open workflow", exact: true }).click();
    await page.waitForSelector("#workflow-detail");
    await page.locator('#rail button[data-place="runs"]').click();
    await page.locator('#runs [data-open-run="run-detail"]').first().click();
    await page.waitForSelector("#live-film img");
    assert.equal(await page.locator('#runs [data-open-run="run-detail"][aria-current="true"]').count(), 1);
    assert.equal(await page.locator("#act-bar").count(), 0, "the live detail owns the handoff, not a second banner");
    assert.equal(await page.getByText("Historical unrelated task").count(), 0);
    assert.equal(await page.locator("#live-film li").count(), 2);
    assert.equal(await page.locator('#live-steps [aria-current="step"]').count(), 1);
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>("#live-film img")].every((img) => img.complete && img.naturalWidth > 0));
    const show = page.waitForRequest((request) => request.url() === `${base}/api/replay/show` && request.method() === "POST");
    await page.getByRole("button", { name: "Show Bao’s Chrome" }).click();
    await show;
    const check = page.waitForRequest((request) => request.url() === `${base}/api/prompt/continue` && request.method() === "POST");
    await page.getByRole("button", { name: "I pressed Reserve" }).click();
    await check;
    await page.waitForFunction(() => document.getElementById("live-action-status")?.textContent?.includes("checking"));
    await page.locator("#live-run-details summary").click();
    await page.locator("#live-run-details summary").focus();
    await page.waitForResponse((response) => response.url() === `${base}/api/state`);
    assert.equal(await page.locator("#live-run-details").getAttribute("open"), "");
    assert.equal(await page.locator("#live-details-summary").evaluate((el) => el === document.activeElement), true);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => localStorage.setItem("bao-theme", theme), theme);
      await page.reload();
      await page.waitForSelector("#live-film img");
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      for (const width of [1280, 720]) {
        await page.setViewportSize({ width, height: 820 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.getElementById("content")!.scrollWidth <= document.getElementById("content")!.clientWidth), true);
        assert.equal(await page.getByRole("button", { name: "Stop run…" }).isVisible(), true);
      }
    }
    await page.getByRole("button", { name: "Stop run…" }).click();
    assert.equal(await page.getByRole("dialog").isVisible(), true);
    await page.getByRole("button", { name: "Keep waiting" }).click();
    assert.equal(await page.getByRole("dialog").isVisible(), false);
    assert.equal((await (await fetch(`${base}/api/state`)).json() as ShellState).activeAsk?.runId, "run-detail");
    await page.getByRole("button", { name: "Stop run…" }).click();
    await page.getByRole("button", { name: "Stop run", exact: true }).click();
    await page.waitForSelector("#run-receipt");
    assert.equal((await (await fetch(`${base}/api/state`)).json() as ShellState).activeAsk, null);
  } finally { await browser.close(); await app.close(); rmSync(dirs.home, { recursive: true, force: true }); }
});

test("live confirmation checks the site without pressing its final action", { timeout: 60000 }, async () => {
  const dirs = applyHermeticApp("live-handoff");
  process.env.BAO_DRIVE = "1";
  const app = await startApp({ home: dirs.home, port: 0 });
  const browser = await testChromium.launch();
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${app.port}`;
  let replay: Promise<{ status: string; runId: string }> | undefined;
  try {
    const wf = workflow(`${base}/fixture`);
    wf.steps = [{ id: "reserve", index: 0, action: "confirm", human: true, label: 'Press "Apply"', surface: "dom", identity: { surface: "dom", role: "button", name: "Apply", path: [] }, timeoutMs: 60000, postcondition: { kind: "text", match: "Applied", timeoutMs: 60000 } }];
    app.library.save(wf);
    replay = post(`${base}/api/replay`, { id: wf.id, args: {} });
    await page.goto(`${base}/?screen=live`);
    await page.getByRole("button", { name: "I pressed Apply" }).waitFor();
    await page.getByRole("button", { name: "I pressed Apply" }).click();
    await page.waitForFunction(() => document.getElementById("live-action-status")?.textContent?.includes("checking"));
    const waiting = await (await fetch(`${base}/api/state`)).json() as ShellState;
    assert.equal(waiting.activeAsk?.kind, "confirm");
    assert.equal(waiting.replaying, true, "checking must not perform the final click or complete the run");
    await post(`${base}/api/replay/press`, { name: "Apply" });
    const result = await replay;
    assert.equal(result.status, "passed");
    await page.waitForSelector("#run-receipt");
    assert.equal(app.library.readRun(result.runId).status, "passed");
  } finally {
    await post(`${base}/api/replay/cancel`).catch(() => undefined);
    await replay?.catch(() => undefined);
    await browser.close(); await app.close();
    delete process.env.BAO_DRIVE;
    rmSync(dirs.home, { recursive: true, force: true });
  }
});
