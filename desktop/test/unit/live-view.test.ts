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
    const continuationRequests: string[] = [];
    page.on("request", (request) => { if (request.url() === `${base}/api/prompt/continue`) continuationRequests.push(request.method()); });
    await page.getByRole("button", { name: "I pressed Reserve" }).click();
    await page.waitForFunction(() => document.getElementById("live-action-status")?.textContent?.includes("checking"));
    assert.deepEqual(continuationRequests, [], "a confirmation check must not authorize a login");
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

test("leaving a live run cannot attach its ask or Stop to the next replay", { timeout: 60000 }, async () => {
  const dirs = applyHermeticApp("live-run-identity");
  const app = await startApp({ home: dirs.home, port: 0 });
  const browser = await testChromium.launch();
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const wf = workflow(`${base}/fixture`);
    app.library.save(wf);
    app.library.saveRun({ id: "run-detail", workflowId: wf.id, status: "paused", at: Date.now(), heals: [], steps: [{ id: "reserve", status: "paused" }] });
    writePendingPrompt(dirs.home, { ask: ask(), runId: "run-detail" });
    let snapshot = await (await fetch(`${base}/api/state`)).json() as ShellState;
    snapshot.replaying = true;
    await page.route("**/api/state", (route) => route.fulfill({ json: snapshot }));
    const cancellations: string[] = [];
    page.on("request", (request) => { if (request.url() === `${base}/api/replay/cancel`) cancellations.push(request.method()); });
    await page.goto(base);
    await page.getByRole("button", { name: "I pressed Reserve" }).waitFor();
    await page.getByRole("button", { name: "Open workflow", exact: true }).click();
    await page.waitForSelector("#workflow-detail");
    snapshot = { ...snapshot, activeAsk: null, runs: [{ id: "run-detail", workflowId: wf.id, status: "passed", at: Date.now(), steps: [] }] };
    await page.waitForFunction(() => document.getElementById("attention-label")?.textContent === "Running");
    await page.locator("#rail .rail-foot").click();
    await page.waitForSelector("#live-session");
    await page.waitForResponse((response) => response.url() === `${base}/api/state`);
    assert.equal(await page.locator("#live-run, #live-stop, #run-receipt").count(), 0, "R2 without an ask must not inherit R1's view or Stop");
    assert.deepEqual(cancellations, []);
    app.library.saveRun({ id: "run-next", workflowId: wf.id, status: "paused", at: Date.now(), heals: [], steps: [{ id: "reserve", status: "paused" }] });
    snapshot = { ...snapshot, activeAsk: { ...ask(), runId: "run-next" }, runs: app.library.listRuns() as RunSummary[] };
    await page.waitForFunction(() => document.getElementById("live-run")?.dataset.run === "run-next");
    await page.getByRole("button", { name: "Stop run…" }).click();
    const cancelled = page.waitForResponse((response) => response.url() === `${base}/api/replay/cancel`);
    await page.getByRole("button", { name: "Stop run", exact: true }).click();
    await cancelled;
    assert.deepEqual(cancellations, ["POST"]);
    snapshot = { ...snapshot, activeAsk: null, replaying: false, runs: snapshot.runs?.map((run) => ({ ...run, status: "passed" })) };
    await page.waitForSelector("#run-receipt");
    await page.waitForFunction(() => document.getElementById("attention-label")?.textContent === "Nothing running");
    await page.locator("#rail .rail-foot").click();
    await page.waitForSelector("#live-session");
    await page.waitForResponse((response) => response.url() === `${base}/api/state`);
    assert.equal(await page.locator("#run-receipt, #live-stop").count(), 0, "idle footer navigation must not reopen a completed run");
  } finally {
    await browser.close(); await app.close();
    rmSync(dirs.home, { recursive: true, force: true });
  }
});

test("live detail stays on its run between asks and until the final receipt", { timeout: 60000 }, async () => {
  const dirs = applyHermeticApp("live-continuation");
  process.env.BAO_DRIVE = "1";
  const app = await startApp({ home: dirs.home, port: 0 });
  const browser = await testChromium.launch();
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${app.port}`;
  let replay: Promise<{ status: string; runId: string }> | undefined;
  try {
    const wf = workflow(`${base}/fixture`);
    wf.steps = [
      { id: "reserve", index: 0, action: "confirm", human: true, label: 'Press "Apply"', surface: "dom", timeoutMs: 60000, postcondition: { kind: "text", match: "Applied", timeoutMs: 60000 } },
      { id: "working", index: 1, action: "verify", label: "Wait for the note", surface: "dom", timeoutMs: 60000, expect: { kind: "text", match: "Go to login", timeoutMs: 60000 } },
      { id: "login", index: 2, action: "login", human: true, label: "Sign in", surface: "dom", timeoutMs: 60000, postcondition: { kind: "text", match: "Owner signed in", timeoutMs: 60000 } },
      { id: "finish", index: 3, action: "verify", label: "Check the final note", surface: "dom", timeoutMs: 60000, expect: { kind: "text", match: "Finish the run", timeoutMs: 60000 } },
    ];
    app.library.save(wf);
    mkdirSync(path.join(dirs.home, "live-session"), { recursive: true });
    writeFileSync(path.join(dirs.home, "live-session/session.json"), JSON.stringify({ id: "past", intent: "Historical unrelated task", status: "passed", host: "past.test", updatedAt: 1, audit: [], steps: [], note: "" }));
    replay = post(`${base}/api/replay`, { id: wf.id, args: {} });
    await page.goto(`${base}/?screen=live`);
    await page.getByRole("button", { name: "I pressed Apply" }).waitFor();
    await page.waitForSelector("#live-film img");
    const mounted = await page.locator("#live-run").elementHandle();
    const runId = await page.locator("#live-run").getAttribute("data-run");
    const continuations: string[] = [];
    page.on("request", (request) => { if (request.url() === `${base}/api/prompt/continue`) continuations.push(request.method()); });
    await post(`${base}/api/replay/press`, { name: "Apply" });
    await page.waitForFunction(() => document.getElementById("live-action-status")?.textContent === "Bao is continuing this run");
    assert.equal(await mounted!.evaluate((el) => el === document.getElementById("live-run")), true);
    assert.equal(await page.locator('#live-steps [aria-current="step"], #live-steps [data-status="paused"], #live-film [data-status="paused"]').count(), 0);
    assert.doesNotMatch(await page.locator("#live-steps").innerText(), /Needs you|Wait for you/);
    assert.equal(await page.locator(".live-state.paused").count(), 0);
    assert.equal(await page.locator(".live-state svg").count(), 1);
    assert.equal(await page.locator(".live-deadline").isVisible(), false);
    assert.equal(await page.locator("#live-run").getAttribute("data-run"), runId);
    assert.equal(await page.getByText("Historical unrelated task").count(), 0);
    assert.equal(await page.locator("#live-session, #act-bar").count(), 0);
    assert.equal(await page.locator("#app").getAttribute("data-live-detail"), "true");
    assert.equal(await page.getByRole("button", { name: "Open workflow", exact: true }).isVisible(), true);
    assert.equal(await page.locator(`#runs [data-open-run="${runId}"][aria-current="true"]`).count(), 1);
    assert.equal(await page.locator("#act-continue").isDisabled(), true);
    await page.locator("#act-continue").dispatchEvent("click");
    await page.waitForResponse((response) => response.url() === `${base}/api/state`);
    assert.deepEqual(continuations, [], "the old confirmation control must not continue a later login");
    await post(`${base}/api/replay/press`, { fill: { selector: "#note-input", value: "Go to login" }, name: "Save note" });
    await page.getByRole("button", { name: "I’m signed in, continue" }).waitFor();
    assert.equal(await page.locator("#live-run").getAttribute("data-run"), runId);
    assert.equal(await page.locator("#act-continue").isEnabled(), true);
    await page.getByRole("button", { name: "I’m signed in, continue" }).click();
    await page.waitForFunction(() => document.getElementById("live-action-status")?.textContent === "Bao is continuing this run");
    assert.deepEqual(continuations, ["POST"]);
    assert.equal(await page.locator("#live-session, #run-receipt").count(), 0);
    assert.equal(await page.locator("#live-run").getAttribute("data-run"), runId);
    await post(`${base}/api/replay/press`, { fill: { selector: "#note-input", value: "Finish the run" }, name: "Save note" });
    const result = await replay;
    assert.equal(result.status, "passed");
    await page.waitForSelector("#run-receipt");
    assert.equal(result.runId, runId);
  } finally {
    await post(`${base}/api/replay/cancel`).catch(() => undefined);
    await replay?.catch(() => undefined);
    await browser.close(); await app.close();
    delete process.env.BAO_DRIVE;
    rmSync(dirs.home, { recursive: true, force: true });
  }
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
    wf.inputs = [{ name: "class", type: "text", required: true }];
    wf.steps = [
      { id: "open", index: 0, action: "verify", label: "Read the fixture", surface: "dom", timeoutMs: 1000, expect: { kind: "text", match: "Bao fixture", timeoutMs: 1000 } },
      { id: "reserve", index: 1, action: "confirm", human: true, label: 'Press "Apply"', surface: "dom", identity: { surface: "dom", role: "button", name: "Apply", path: [] }, timeoutMs: 60000, postcondition: { kind: "text", match: "Applied", timeoutMs: 60000 } },
      { id: "login", index: 2, action: "login", human: true, label: "Sign in", surface: "dom", timeoutMs: 60000, postcondition: { kind: "text", match: "Owner signed in", timeoutMs: 60000 } },
      { id: "check", index: 3, action: "verify", label: "Check the result", surface: "dom", timeoutMs: 1000, expect: { kind: "text", match: "Applied", timeoutMs: 1000 } },
    ];
    app.library.save(wf);
    replay = post(`${base}/api/replay`, { id: wf.id, args: { class: "Morning class" } });
    await page.goto(`${base}/?screen=live`);
    await page.getByRole("button", { name: "I pressed Apply" }).waitFor();
    await page.locator('#live-steps [data-status="passed"]').waitFor();
    const pausedState = await (await fetch(`${base}/api/state`)).json() as ShellState;
    const pausedRun = app.library.readRun(pausedState.activeAsk!.runId!) as RunSummary;
    assert.ok(pausedRun.steps);
    assert.equal(pausedRun.steps[0]?.status, "passed");
    assert.equal(pausedRun.steps[1]?.status, "paused");
    assert.equal(pausedRun.steps[2]?.status, "pending");
    assert.equal(pausedRun.inputs?.class, "Morning class");
    assert.ok(pausedRun.steps[0]?.startedAt! <= pausedState.activeAsk!.startedAt);
    assert.ok(pausedRun.steps[0]?.afterShot, "the earlier completed step must retain its screen");
    assert.equal(await page.locator('#live-steps [data-status="passed"]').count(), 1);
    assert.ok(await page.locator("#live-film img").count() >= 1);
    const shot = await page.locator("#live-film img").first().getAttribute("src");
    assert.equal((await fetch(`${base}${shot}`)).status, 200);
    await page.getByRole("button", { name: "I pressed Apply" }).click();
    await page.waitForFunction(() => document.getElementById("live-action-status")?.textContent?.includes("checking"));
    const waiting = await (await fetch(`${base}/api/state`)).json() as ShellState;
    assert.equal(waiting.activeAsk?.kind, "confirm");
    assert.equal(waiting.replaying, true, "checking must not perform the final click or complete the run");
    await post(`${base}/api/replay/press`, { name: "Apply" });
    await page.waitForResponse(async (response) => response.url() === `${base}/api/state` && ((await response.json()) as ShellState).activeAsk?.kind === "login");
    const loginState = await (await fetch(`${base}/api/state`)).json() as ShellState;
    assert.equal(loginState.activeAsk?.stepId, "login", JSON.stringify(loginState.activeAsk));
    const loginRun = app.library.readRun(loginState.activeAsk!.runId!) as RunSummary;
    assert.ok(loginRun.steps);
    assert.deepEqual(loginRun.steps.map((step) => step.status), ["passed", "passed", "paused", "pending"]);
    await page.waitForResponse((response) => response.url() === `${base}/api/state`);
    const stillWaiting = await (await fetch(`${base}/api/state`)).json() as ShellState;
    assert.equal(stillWaiting.activeAsk?.kind, "login", "a prior confirm check must not skip the later login wait");
    assert.equal(stillWaiting.replaying, true);
    await page.goto(`${base}/?screen=live`);
    const continued = page.waitForRequest((request) => request.url() === `${base}/api/prompt/continue` && request.method() === "POST");
    await page.getByRole("button", { name: "I’m signed in, continue" }).click();
    await continued;
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
