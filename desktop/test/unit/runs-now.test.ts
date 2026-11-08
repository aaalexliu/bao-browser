import { fixtureDoc, fixtureStep } from "../support/fixture-step";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import type { ShellState } from "../../src/app/views";
import { testChromium } from "../../src/test-browser";
import { makeAsk } from "../../src/v1/human-ask";
import { writePendingPrompt } from "../../src/v1/pending-prompt";
import type { WorkflowV2 } from "../../src/v1/schema";
import { applyHermeticApp } from "../runtime";

function workflow(id: string, name: string, startUrl: string, steps: WorkflowV2["steps"]): WorkflowV2 {
  return fixtureDoc({ schema: "bao.workflow/v4", version: 2, id, name, createdAt: 1, startUrl, inputs: [], steps });
}

function confirmStep(postcondition: boolean): WorkflowV2["steps"][number] {
  return fixtureStep({
    id: "reserve", index: 0, action: "confirm", human: true, label: "Press Reserve", surface: "dom", timeoutMs: 60_000,
    ...(postcondition ? { postcondition: { kind: "text" as const, match: "Applied", timeoutMs: 60_000 } } : {}),
  });
}

async function stateOf(base: string): Promise<ShellState> {
  return await (await fetch(`${base}/api/state`)).json() as ShellState;
}

async function until(read: () => Promise<boolean>, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(label);
}

test("an unsaved running replay is the only Now row and opens live", { timeout: 90_000 }, async () => {
  const previousHome = process.env.HOME;
  const dirs = applyHermeticApp("runs-now-running");
  process.env.HOME = dirs.home;
  const app = await startApp({ home: dirs.home, port: 0, extensionHost: false, chromeUserData: dirs.chromeUserData, chromeProfilesRoot: path.join(dirs.home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const base = `http://127.0.0.1:${app.port}`;
  let replay: Promise<unknown> | undefined;
  try {
    app.library.save(workflow("wf-old", "Pay the electricity bill", `${base}/fixture`, [confirmStep(false)]));
    app.library.save(workflow("wf-live", "Book a class", `${base}/fixture`, [
      fixtureStep({ id: "wait", index: 0, label: "Wait for the class note", action: "verify", surface: "dom", timeoutMs: 60_000, expect: { kind: "text", match: "Finish the unsaved run", timeoutMs: 60_000 } }),
    ]));
    app.library.saveRun({ id: "run-old", workflowId: "wf-old", status: "paused", at: Date.now() - 86_400_000, steps: [], heals: [], envelope: { status: "needs_human", ask: "Press Pay in the Bao window." } });
    await page.goto(base);
    await page.locator("#runs").waitFor();
    replay = fetch(`${base}/api/replay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "wf-live", args: {} }) });
    let runId = "";
    await until(async () => {
      const state = await stateOf(base);
      runId = state.activeRun?.id || "";
      return Boolean(state.runExecuting && state.activeRun?.phase === "running" && runId && !state.runs?.some((run) => run.id === runId));
    }, "running replay was saved or never started");
    const row = page.locator(`#runs section[aria-label="Now"] [data-open-run="${runId}"]`);
    await row.waitFor();
    assert.equal(await row.locator(".run-state").innerText(), "Running");
    assert.deepEqual(await page.locator('#runs section[aria-label="Now"] [data-open-run]').evaluateAll((rows) => rows.map((item) => item.getAttribute("data-open-run"))), [runId]);
    assert.equal(await page.locator(`#runs [data-open-run="${runId}"]`).count(), 1, "an unsaved run must not also appear in a day group");
    assert.equal(await page.locator('#runs ul[aria-label="Needs you"] [data-open-run="' + runId + '"]').count(), 0);
    assert.equal(await page.locator('#runs section[aria-label="Now"] [data-open-run="run-old"]').count(), 0);
    await row.click();
    await page.locator("#live-run").waitFor();
    await page.getByText("Steps appear when the run pauses or ends.").waitFor();
    assert.equal(await page.locator("#live-run").getAttribute("data-run"), runId);
    assert.equal(await page.locator("#run-receipt").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Continuing" }).count(), 0);
    assert.equal(await page.getByText("Bao is continuing this run").count(), 0);
    assert.equal(await page.getByText("Not yet").count(), 0);
    assert.equal(await page.getByText("No screen captured yet.").count(), 0);
    assert.equal(await page.getByText("No screens captured yet.").count(), 0);
    assert.equal(app.library.listRuns().some((run) => run.id === runId), false);
    await page.getByRole("button", { name: "Stop run…" }).click();
    assert.equal(await page.getByRole("button", { name: "Keep running" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Keep waiting" }).count(), 0);
  } finally {
    const current = await stateOf(base).catch(() => undefined);
    if (current?.activeRun) await fetch(`${base}/api/replay/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: current.activeRun.id }) }).catch(() => undefined);
    await replay?.catch(() => undefined);
    await browser.close();
    await app.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(path.dirname(dirs.home), { recursive: true, force: true });
  }
});

test("a replay waiting in this process is under Needs you and Now, and opens live", { timeout: 90_000 }, async () => {
  const previousHome = process.env.HOME;
  const dirs = applyHermeticApp("runs-now-waiting");
  process.env.HOME = dirs.home;
  const app = await startApp({ home: dirs.home, port: 0, extensionHost: false, chromeUserData: dirs.chromeUserData, chromeProfilesRoot: path.join(dirs.home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const base = `http://127.0.0.1:${app.port}`;
  let replay: Promise<unknown> | undefined;
  try {
    app.library.save(workflow("wf-live", "Book a class", `${base}/fixture`, [confirmStep(true)]));
    await page.goto(base);
    await page.locator("#runs").waitFor();
    replay = fetch(`${base}/api/replay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "wf-live", args: {} }) });
    let runId = "";
    await until(async () => {
      const state = await stateOf(base);
      runId = state.activeRun?.id || "";
      return Boolean(state.runExecuting && state.activeRun?.phase === "waiting" && runId);
    }, "replay did not wait inside the live process");
    const now = page.locator(`#runs section[aria-label="Now"] [data-open-run="${runId}"]`);
    await now.waitFor();
    await page.waitForFunction((id) => {
      const state = document.querySelector(`#runs section[aria-label="Now"] [data-open-run="${id}"] .run-state`);
      const needs = document.querySelector(`#runs ul[aria-label="Needs you"] [data-open-run="${id}"]`);
      return state?.textContent === "Needs you" && Boolean(needs);
    }, runId);
    assert.equal(await now.locator(".run-state").innerText(), "Needs you");
    assert.equal(await page.locator(`#runs ul[aria-label="Needs you"] [data-open-run="${runId}"]`).count(), 1);
    assert.equal(await page.locator(`#runs section[aria-label="Today"] [data-open-run="${runId}"]`).count(), 0);
    await now.click();
    await page.locator("#live-run").waitFor();
    assert.equal(await page.locator("#live-run").getAttribute("data-run"), runId);
    assert.equal(await page.locator("#run-receipt").count(), 0);
    await page.locator(`#runs ul[aria-label="Needs you"] [data-open-run="${runId}"]`).click();
    assert.equal(await page.locator("#live-run").getAttribute("data-run"), runId);
    assert.equal(await page.locator("#run-receipt").count(), 0);
  } finally {
    const current = await stateOf(base).catch(() => undefined);
    if (current?.activeRun) await fetch(`${base}/api/replay/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: current.activeRun.id }) }).catch(() => undefined);
    await replay?.catch(() => undefined);
    await browser.close();
    await app.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(path.dirname(dirs.home), { recursive: true, force: true });
  }
});

test("a returned paused run stays out of Now and opens live", { timeout: 90_000 }, async () => {
  const previousHome = process.env.HOME;
  const dirs = applyHermeticApp("runs-now-returned");
  process.env.HOME = dirs.home;
  const app = await startApp({ home: dirs.home, port: 0, extensionHost: false, chromeUserData: dirs.chromeUserData, chromeProfilesRoot: path.join(dirs.home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    app.library.save(workflow("wf-live", "Book a class", `${base}/fixture`, [confirmStep(false)]));
    await page.goto(base);
    await page.locator("#runs").waitFor();
    const result = await (await fetch(`${base}/api/replay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "wf-live", args: {} }) })).json() as { status?: string; runId?: string; error?: string };
    assert.equal(result.status, "paused", JSON.stringify(result));
    const runId = result.runId || "";
    await until(async () => {
      const state = await stateOf(base);
      if (!(state.activeRun?.id === runId && state.activeRun.phase === "waiting" && state.runExecuting === false && state.replaying === false)) return false;
      // The list follows /api/state on the next poll. Needs you is already true while the replay is still in this process, so it does not prove Now has dropped.
      return await page.locator('#runs section[aria-label="Now"]').count() === 0
        && await page.locator(`#runs section[aria-label="Today"] [data-open-run="${runId}"]`).count() === 1
        && await page.locator(`#runs ul[aria-label="Needs you"] [data-open-run="${runId}"]`).count() === 1;
    }, "returned pause still listed under Now");
    assert.equal(await page.locator('#runs section[aria-label="Now"]').count(), 0);
    assert.equal(await page.locator(`#runs section[aria-label="Today"] [data-open-run="${runId}"]`).count(), 1);
    await page.locator(`#runs section[aria-label="Today"] [data-open-run="${runId}"]`).click();
    await page.locator("#live-run").waitFor();
    assert.equal(await page.locator("#live-run").getAttribute("data-run"), runId);
    assert.equal(await page.locator("#run-receipt").count(), 0);
  } finally {
    const current = await stateOf(base).catch(() => undefined);
    if (current?.activeRun) await fetch(`${base}/api/replay/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: current.activeRun.id }) }).catch(() => undefined);
    await browser.close();
    await app.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(path.dirname(dirs.home), { recursive: true, force: true });
  }
});

test("a restored wait stays out of Now, in Needs you and its day group, and opens live", { timeout: 30_000 }, async () => {
  const previousHome = process.env.HOME;
  const dirs = applyHermeticApp("runs-now-restored");
  process.env.HOME = dirs.home;
  const clock = new Date(2026, 10, 6, 12);
  const now = +clock;
  const yesterday = new Date(clock);
  yesterday.setDate(yesterday.getDate() - 1);
  writePendingPrompt(dirs.home, {
    runId: "run-live",
    ask: makeAsk({
      kind: "confirm", workflowId: "wf-live", workflowName: "Book a class", stepId: "reserve",
      stepIndex: 1, stepCount: 2, label: "Press Reserve", button: "Reserve", site: "example.test",
      timeoutMs: 7_200_000, now: Date.now(), runId: "run-live",
    }),
  });
  const app = await startApp({ home: dirs.home, port: 0, extensionHost: false, chromeUserData: dirs.chromeUserData, chromeProfilesRoot: path.join(dirs.home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    app.library.save(workflow("wf-old", "Pay the electricity bill", "/fixture", [confirmStep(false)]));
    app.library.save(workflow("wf-live", "Book a class", "/fixture", [confirmStep(false)]));
    app.library.save(workflow("wf-guide", "File the permit", "/fixture", [confirmStep(false)]));
    app.library.saveRun({
      id: "run-old", workflowId: "wf-old", status: "paused", at: +yesterday, steps: [], heals: [],
      envelope: { status: "needs_human", ask: "Press Pay in the Bao window." },
    });
    app.library.saveRun({
      id: "run-live", workflowId: "wf-live", status: "paused", at: now, steps: [], heals: [],
      envelope: { status: "needs_human", ask: "Press Reserve in the Bao window." },
    });
    app.library.saveRun({
      id: "guide-permit", workflowId: "wf-guide", status: "paused", at: now - 1000, steps: [], heals: [],
      envelope: { status: "needs_human", ask: "Follow the highlighted control." },
    });
    await page.clock.setFixedTime(clock);
    await page.goto(base);
    await page.locator("#runs").waitFor();
    const state = await stateOf(base);
    assert.equal(state.activeRun?.id, "run-live");
    assert.equal(state.activeRun?.phase, "waiting");
    assert.equal(state.runExecuting, false);
    assert.equal(state.replaying, false);
    assert.equal(state.guide, null);
    assert.equal(await page.locator('#runs section[aria-label="Now"]').count(), 0);
    assert.equal(await page.locator('#runs ul[aria-label="Needs you"] [data-open-run="run-live"]').count(), 1);
    assert.equal(await page.locator('#runs ul[aria-label="Needs you"] [data-open-run="run-old"]').count(), 1);
    assert.equal(await page.locator('#runs section[aria-label="Today"] [data-open-run="run-live"]').count(), 1);
    assert.equal(await page.locator('#runs section[aria-label="Yesterday"] [data-open-run="run-old"]').count(), 1);
    assert.equal(await page.locator('#runs section[aria-label="Now"] [data-open-run="guide-permit"]').count(), 0);
    assert.equal(await page.locator('#runs section[aria-label="Today"] [data-open-run="guide-permit"]').count(), 1);
    await page.locator('#runs section[aria-label="Today"] [data-open-run="run-live"]').click();
    await page.locator("#live-run").waitFor();
    assert.equal(await page.locator("#live-run").getAttribute("data-run"), "run-live");
    assert.equal(await page.locator("#run-receipt").count(), 0);
  } finally {
    await browser.close();
    await app.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(path.dirname(dirs.home), { recursive: true, force: true });
  }
});
