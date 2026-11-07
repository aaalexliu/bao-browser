import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { rail, runAttention, runsList, runWaitLeft, shellAttentionCount, shellList } from "../../src/app/views";
import { testChromium } from "../../src/test-browser";
import type { WorkflowV2 } from "../../src/v1/schema";
import type { inspectRunView } from "../../src/mcp/run-view";
import { makeAsk } from "../../src/v1/human-ask";

test("Runs shows stored step reasons after workflow edits or deletion in both themes", { timeout: 30_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-runs-evidence-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const page = await browser.newPage();
  const workflow: WorkflowV2 = {
    schema: "bao.workflow/v2", version: 2, id: "edited", createdAt: 1, name: "Review report", startUrl: "/fixture", inputs: [],
    steps: [{ id: "review", index: 0, action: "click", label: "Review report", sensitive: true, surface: "dom", timeoutMs: 1000 }],
  };
  try {
    app.library.save(workflow);
    app.library.saveRun({ id: "historical", workflowId: workflow.id, status: "paused", at: Date.now() - 1000, heals: [],
      steps: [{ id: "review", status: "paused", reason: "The saved report needs review." }],
      envelope: { status: "needs_human", step: "review", ask: "Review the report total.", reason: "Waiting for your review." } });
    app.library.rename(workflow.id, "Review report after editing");
    for (const theme of ["light", "dark"]) {
      await page.goto(`http://127.0.0.1:${app.port}/`);
      await page.evaluate((value) => localStorage.setItem("bao-theme", value), theme);
      await page.reload();
      await page.locator('[data-open-run="historical"]').first().click();
      await page.locator("#run-receipt").waitFor();
      assert.match(await page.locator(".receipt-steps").innerText(), /The saved report needs review/);
      assert.match(await page.locator(".receipt-handoff").innerText(), /Review the report total/);
      assert.match(await page.locator("#run-receipt").innerText(), /Waiting for your review/);
      assert.doesNotMatch(await page.locator("#run-receipt").innerText(), /Details are hidden/);
    }
    app.library.remove(workflow.id);
    await page.reload();
    await page.locator('[data-open-run="historical"]').first().click();
    await page.locator("#run-receipt").waitFor();
    assert.match(await page.locator(".receipt-steps").innerText(), /The saved report needs review/);
  } finally {
    await browser.close(); await app.close();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
const reviewRuns = [1, 2, 3].map((at) => ({
  id: `review-${at}`, workflowId: "wf", status: "passed", at,
  heals: [{ id: `heal-${at}`, failedStep: { id: "step", label: "Read account" } }],
  decisions: [{ ts: at, healId: `heal-${at}`, decision: "keep" as const }],
}));

test("Runs counts waiting runs, undecided heals and failures without changing records", () => {
  const runs = [
    { id: "waiting", workflowId: "wf", status: "paused", heals: [] },
    { id: "healed", workflowId: "wf", status: "passed", heals: [{ id: "keep" }, { id: "decided" }], decisions: [{ ts: 1, healId: "decided", decision: "keep" as const }] },
    { id: "failed", workflowId: "wf", status: "failed", heals: [] },
  ];
  const saved = JSON.stringify(runs);
  assert.deepEqual(runAttention(runs).map((item) => item.label), ["Needs you", "Heal to keep", "Failed"]);
  assert.equal(JSON.stringify(runs), saved);
});

test("Runs rows use filled glyphs, stop reasons and elapsed time without invented metrics", () => {
  const html = runsList([
    { id: "pass", workflowId: "wf", status: "passed", steps: [{ id: "step", status: "passed", startedAt: 1000, endedAt: 42000 }] },
    { id: "fail", workflowId: "wf", status: "failed", failure: { index: 4, reason: "The Download PDF button is gone." } },
    { id: "unknown", workflowId: "wf", status: "passed" },
  ], [{ id: "wf", name: "Download bill", steps: 7 }]);
  assert.match(html, /<circle cx="7" cy="7" r="7"/);
  assert.match(html, />Passed<\/span> · 41 s/);
  assert.match(html, /Stopped at step 5\./);
  assert.match(html, /Stopped at step 5 of 7/);
  assert.match(html, /The Download PDF button is gone/);
  assert.doesNotMatch(html, /model calls|0 s/);
  const side = rail({ runs: [{ id: "fail", workflowId: "wf", status: "failed" }], damagedWorkflows: [{ file: "damaged-workflow.json", reason: "Invalid workflow" }], helper: { label: "helper available", platform: "darwin", accessibility: false, screenCapture: false } });
  assert.match(side, /data-count="1"/);
  assert.match(side, /Nothing running/);
  assert.match(side, /One workflow can’t open/);
  assert.doesNotMatch(side, /Optional Mac permissions not granted/);
});

test("active asks share attention counts, open Live and use numeric deadlines only", () => {
  const now = Date.UTC(2026, 10, 6, 12);
  const ask = { ...makeAsk({ kind: "confirm", workflowId: "wf", workflowName: "Reserve", stepId: "s", stepIndex: 1, stepCount: 1, label: "Reserve", timeoutMs: 120_000, now }), runId: "active" };
  const runs = [{ id: "failed", workflowId: "wf", status: "failed" }];
  assert.equal(runAttention(runs, ask).length, 2);
  assert.match(rail({ runs, activeAsk: ask }), /data-count="2"/);
  const projected = runsList(runs, [], "", now, ask);
  assert.match(projected, /data-screen="live" aria-label="Reserve"/);
  assert.doesNotMatch(projected, /data-open-run="active"/);
  assert.match(projected, /2 min left/);
  assert.match(rail({ replaying: true }), />Running</);
  assert.match(rail({ recording: true }), />Recording</);
  const waiting = { id: "active", workflowId: "wf", status: "paused", at: now, envelope: { status: "needs_human", ask: "Press Reserve", deadline: "Nov 6, 12:30 PM UTC" } };
  assert.equal(runAttention([waiting], ask).length, 1);
  assert.equal(runAttention([], { ...ask, runId: undefined }).length, 1);
  assert.match(runsList([waiting], [], "", now, ask), /2 min left/);
  const stored = runsList([waiting], [], "", now);
  assert.match(stored, /Waits until Nov 6, 12:30 PM UTC/);
  assert.doesNotMatch(stored, /min left|data-run-deadline|datetime=/);
  assert.match(stored, /<time[^>]*>\d{1,2}:\d{2} [AP]M (?:[A-Z]{2,5}|GMT[+-][\d:]+)</);
  assert.match(runsList([waiting], [], "", now, { ...ask, runId: "other" }), /Nov 6, 12:30 PM UTC/);
  assert.equal(runWaitLeft(now + 120_000, now + 60_000), "1 min left");
  assert.equal(runWaitLeft(now, now + 60_000), "0 min left");
  for (const status of ["timed-out", "stopped", "failed"]) {
    const ended = runsList([{ ...waiting, status, envelope: { ...waiting.envelope, status, reason: "Owner wait ended." } }], [], "", now);
    assert.match(ended, /Owner wait ended\./);
    assert.doesNotMatch(ended, /Press Reserve|Nov 6, 12:30 PM UTC|data-run-deadline/);
  }
});

test("attention separates waiting runs from items and keeps import and step reviews", () => {
  const runs = [
    { id: "wait", workflowId: "wf", status: "paused", heals: [{ id: "repair" }] },
    { id: "failed", workflowId: "wf", status: "failed" },
    ...reviewRuns,
  ];
  const state = { runs, pendingImport: { phase: "confirm" } };
  assert.equal(shellAttentionCount(state), 5);
  for (const phase of ["confirm", "pick", "running", "error"]) {
    assert.equal(shellAttentionCount({ pendingImport: { phase } }), 1, phase);
    assert.match(rail({ pendingImport: { phase } }), /Sign-in needs you/);
  }
  for (const phase of ["cancelled", "done"]) assert.equal(shellAttentionCount({ pendingImport: { phase } }), 0, phase);
  const side = rail(state);
  assert.match(side, /data-count="5" aria-label="5 need you"/);
  assert.match(side, /1 run is waiting for you · Sign-in needs you · 1 step needs review/);
  assert.doesNotMatch(side, /5 runs/);
  assert.match(shellList("runs", state), />5 need you</);
  const list = runsList(runs, [], "", Date.now(), undefined, "confirm");
  assert.match(list, /aria-label="5 items">5</);
  assert.match(list, /Sign-in needs you/);
  assert.match(list, /Step needs review after 3 heals/);
  assert.match(shellList("runs", {}), />No runs yet</);
  assert.match(rail({}), /aria-label="No runs yet"/);
  assert.match(shellList("runs", { runs: [runs[1]!] }), />1 needs you</);
  assert.match(rail({ runs: [runs[1]!] }), /aria-label="1 needs you"/);
  assert.match(shellList("runs", { runs: [{ id: "done", workflowId: "wf", status: "passed" }] }), />Nothing needs you</);
});

test("footer follows replay start and end when no other state changes", { timeout: 30_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-runs-replay-footer-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(8_000);
    const url = `http://127.0.0.1:${app.port}`;
    const state = await (await fetch(`${url}/api/state`)).json() as Record<string, unknown>;
    let replaying = false;
    let extra: Record<string, unknown> = {};
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "setAppBadge", { value: async (count: number) => { document.documentElement.dataset.badge = String(count); } });
    });
    await page.route("**/api/state", (route) => route.fulfill({ json: { ...state, ...extra, replaying } }));
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector("#attention-label")?.textContent === "Nothing running");
    replaying = true;
    await page.waitForFunction(() => document.querySelector("#attention-label")?.textContent === "Running");
    assert.equal(await page.locator("#attention").getAttribute("data-count"), "0");
    replaying = false;
    await page.waitForFunction(() => document.querySelector("#attention-label")?.textContent === "Nothing running");
    assert.equal(await page.locator("#attention").getAttribute("data-count"), "0");
    for (const run of reviewRuns) app.library.saveRun({ ...run, steps: [] });
    extra = { runs: reviewRuns, pendingImport: { id: "consent", phase: "confirm", domain: "example.com", message: "Review the import" } };
    await page.waitForFunction(() => document.querySelector("#attention")?.getAttribute("data-count") === "2");
    assert.equal(await page.locator(".pane-title p").innerText(), "2 need you");
    assert.equal(await page.locator("#attention-label").innerText(), "Sign-in needs you · 1 step needs review");
    assert.equal(await page.locator("#needs-you-heading .run-count").innerText(), "2");
    assert.equal(await page.locator("html").getAttribute("data-badge"), "2");
    for (const width of [1280, 720, 320]) {
      await page.setViewportSize({ width, height: 820 });
      const names = await page.locator('#runs ul[aria-label="Needs you"] .run-name').evaluateAll((nodes) => nodes.map((node) => {
        const glyph = node.parentElement!.querySelector(".run-glyph")!;
        return { text: node.textContent, fits: node.scrollWidth <= node.clientWidth, beside: node.getBoundingClientRect().left >= glyph.getBoundingClientRect().right };
      }));
      assert.deepEqual(names, [
        { text: "Sign-in needs you", fits: true, beside: true },
        { text: "Read account", fits: true, beside: true },
      ], `attention names fit beside glyphs at ${width}px`);
    }
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.locator(".rail-foot").click();
    await page.locator("#login-site").waitFor();
  } finally {
    await browser.close(); await app.close();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("Runs first load opens the top Needs-you run, else newest, without replacing a chosen run", { timeout: 60_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-runs-first-load-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(8_000);
  const url = `http://127.0.0.1:${app.port}`;
  try {
    app.library.saveRun({ id: "newest", workflowId: "agent-browser", status: "passed", at: 300, steps: [], heals: [] });
    app.library.saveRun({ id: "waiting", workflowId: "agent-browser", status: "paused", at: 200, steps: [], heals: [], envelope: { status: "needs_human", ask: "Press Reserve yourself." } });
    await page.goto(url);
    await page.locator('#run-receipt').waitFor();
    assert.equal(await page.locator('#runs [aria-current=true]').count(), 1, "only the pinned copy carries the selection");
    assert.equal(await page.locator('#runs [aria-current=true]').getAttribute("data-open-run"), "waiting");
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "BODY", "first load does not draw a keyboard focus ring around the receipt");
    assert.equal(await page.locator("#attention-label").innerText(), "1 run is waiting for you");
    assert.equal(await page.locator(".pane-title p").innerText(), "1 needs you");
    await page.locator('#rail [data-place=workflows]').click();
    await page.locator('#rail [data-place=runs]').click();
    await page.locator('#run-receipt').waitFor();
    assert.equal(await page.locator('#runs [aria-current=true]').getAttribute("data-open-run"), "waiting");
    await page.locator('#screen-list [data-screen=runs]').click();
    await page.locator('#run-receipt').waitFor();
    assert.equal(await page.locator('#runs [aria-current=true]').getAttribute("data-open-run"), "waiting");
    await page.locator('#runs [data-open-run=newest]').click();
    app.library.saveRun({ id: "another", workflowId: "agent-browser", status: "paused", at: 400, steps: [], heals: [] });
    await page.waitForFunction(() => document.querySelector('#attention')?.getAttribute('data-count') === '2');
    assert.equal(await page.locator('#runs [aria-current=true]').first().getAttribute("data-open-run"), "newest");
    await page.setViewportSize({ width: 720, height: 820 });
    await page.locator('#sidebar-toggle').click();
    await page.locator('.rail-foot').click();
    assert.equal(await page.locator('#sidebar-dialog').evaluate((dialog) => (dialog as HTMLDialogElement).open), false);
    assert.equal(await page.locator('#runs [aria-current=true]').getAttribute("data-open-run"), "another");
    await page.waitForFunction(() => document.activeElement?.id === "main");
    await page.locator('.runs-record').click();
    await page.locator('#start').waitFor();
    assert.equal(await page.locator('#runs-welcome').count(), 0);
    for (const id of ["waiting", "another"]) {
      const run = app.library.readRun(id);
      app.library.saveRun({ ...run, status: "passed", envelope: undefined });
    }
    await page.goto(url);
    await page.locator('#run-receipt').waitFor();
    assert.equal(await page.locator('#runs [aria-current=true]').getAttribute("data-open-run"), "another");
    await page.goto(url + '/?screen=live');
    await page.locator('#live-session').waitFor();
    assert.equal(await page.locator('#run-receipt').count(), 0, "explicit launch screen wins over the default run");
  } finally {
    await browser.close(); await app.close();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("Runs keeps current owner waits actionable and ended asks informational", { timeout: 30_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-runs-waits-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(8_000);
  const cases = [
    { id: "signin", status: "paused", envelopeStatus: "needs_signin", waiting: true, ask: "Sign in in the Bao window." },
    { id: "human", status: "needs_human", envelopeStatus: "needs_human", waiting: true, ask: "Press Reserve in the Bao window." },
    { id: "timeout", status: "timed-out", envelopeStatus: "timed-out", waiting: false, ask: "Press Reserve in the Bao window." },
    { id: "cancelled", status: "stopped", envelopeStatus: "cancelled", waiting: false, ask: "Press Reserve in the Bao window." },
    { id: "stopped", status: "stopped", envelopeStatus: "stopped", waiting: false, ask: "Press Reserve in the Bao window." },
    { id: "ended-session", status: "failed", envelopeStatus: "failed", waiting: false, ask: "The Bao session ended before the owner wait completed. This session cannot continue." },
  ];
  try {
    for (const item of cases) app.library.saveRun({
      id: item.id, workflowId: "agent-browser", kind: item.id === "ended-session" ? "capture" : "replay", status: item.status,
      at: Date.now(), steps: [], heals: [],
      envelope: { status: item.envelopeStatus, ask: item.ask, deadline: "Nov 6, 12:30 PM UTC" },
    });
    await page.goto(`http://127.0.0.1:${app.port}/`);
    await page.locator("#runs").waitFor();
    assert.deepEqual(await page.locator('#runs ul[aria-label="Needs you"] button:has(.run-state.paused)').evaluateAll((rows) => rows.map((row) => row.getAttribute("data-open-run")).sort()), ["human", "signin"], "only current human and sign-in waits contribute waiting rows");
    assert.equal(await page.locator("#needs-you-heading .run-count").innerText(), "4", "two waits, one timeout and one failure need attention");
    for (const item of cases) {
      await page.locator(`#runs [data-open-run="${item.id}"]`).first().click();
      await page.locator("#run-receipt").waitFor();
      assert.equal((await page.locator("#run-receipt").innerText()).includes(item.ask), true, "ended runs retain the original ask as information");
      assert.equal(await page.locator(".receipt-handoff").count(), item.waiting ? 1 : 0, item.id);
      assert.equal((await page.locator("#run-receipt").innerText()).includes("Deadline:"), item.waiting, item.id);
      assert.equal(await page.locator(".receipt-kicker .run-state").innerText(), item.waiting ? "needs you" : item.status === "timed-out" ? "stopped, timed out" : item.status);
      await page.getByText("Detailed evidence", { exact: true }).click();
      assert.equal(await page.locator("#run-viewer").isVisible(), true);
    }
  } finally {
    await browser.close(); await app.close();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("running Runs groups history, opens shared receipts, survives polling and recovers failed loads", { timeout: 60_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-runs-place-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" });
  const workflow: WorkflowV2 = {
    schema: "bao.workflow/v2", version: 2, id: "wf-runs", createdAt: 1, name: "Download the electricity bill and save the PDF to the monthly household records folder", startUrl: "/fixture", inputs: [],
    steps: [{ id: "open", index: 0, label: "Open account", action: "click", surface: "dom", identity: { surface: "dom", role: "button", name: "Open account", path: [] }, timeoutMs: 1000 }],
  };
  app.library.save(workflow);
  const now = +new Date(2026, 10, 6, 12);
  await page.clock.setFixedTime(new Date(now));
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const older = new Date(now); older.setDate(older.getDate() - 4);
  const url = `http://127.0.0.1:${app.port}`;
  let failState = true;
  let failReceipt = false;
  let dropReceipt = false;
  await page.route("**/api/state", (route) => failState ? route.fulfill({ status: 503, json: { error: "fixture disconnected" } }) : route.continue());
  await page.route("**/api/runs/*/receipt?*", (route) => dropReceipt ? route.abort() : failReceipt ? route.fulfill({ status: 503, json: { error: "fixture unavailable" } }) : route.continue());
  try {
    await page.goto(url);
    await page.locator("#connection-error").waitFor();
    assert.equal(await page.locator("#runs").count(), 0, "a failed first read must not claim history is empty");
    assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).isVisible(), true);
    failState = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.locator("#runs-welcome").waitFor();
    assert.equal(await page.locator("#needs-you-heading .run-count").innerText(), "0");
    await page.getByRole("button", { name: "Open Workflows", exact: true }).click();
    await page.locator("#library").waitFor();
    app.library.saveRun({ id: "raw-old", workflowId: workflow.id, status: "passed", at: +older, steps: [], heals: [], modelCalls: 0 });
    app.library.saveRun({ id: "raw-yesterday", workflowId: workflow.id, status: "passed", at: +yesterday, steps: [], heals: [] });
    app.library.saveRun({ id: "raw-failed", workflowId: workflow.id, status: "failed", at: now - 1, steps: [{ id: "open", label: "Open account", status: "failed" }], heals: [], failure: { reason: "The Download PDF button is gone." } });
    app.library.saveRun({ id: "raw-paused", workflowId: workflow.id, status: "paused", at: now, steps: [], heals: [], envelope: { status: "needs_human", ask: "Press Reserve in the Bao window." } });
    app.library.saveRun({ id: "raw-heal", workflowId: workflow.id, status: "passed", at: now - 2, steps: [], heals: [{ id: "proposal" }], modelCalls: 1 });
    app.library.saveRun({ id: "raw-browser", workflowId: "agent-browser", kind: "capture", status: "passed", at: now - 3, steps: Array.from({ length: 21 }, (_, index) => ({ id: `command-${index}`, label: "Read fixture", status: "passed" })), heals: [] });
    await page.locator("#rail [data-place=runs]").click();
    await page.locator("#needs-you-heading .run-count").filter({ hasText: "3" }).waitFor();
    const history = page.locator('#runs section[aria-label="Today"]');
    assert.deepEqual(await history.locator("button").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-open-run"))), ["raw-failed", "raw-heal", "raw-browser"]);
    assert.equal(await page.locator('#runs section[aria-label="Yesterday"]').count(), 1);
    assert.doesNotMatch(await page.locator("#runs").innerText(), /raw-/);
    assert.doesNotMatch(await history.locator("[data-open-run=raw-failed]").innerText(), /model calls/);
    assert.equal(await page.locator('#runs section[aria-label="Now"] [data-open-run=raw-paused]').count(), 1);
    assert.match(await page.locator("#runs [data-open-run=raw-old]").innerText(), /Passed/);
    assert.equal(await history.getByRole("button", { name: workflow.name, exact: true }).count(), 2);
    const row = history.locator("[data-open-run=raw-failed]");
    await row.focus();
    app.library.appendDecision("raw-heal", { ts: now, healId: "proposal", decision: "keep" });
    await page.waitForFunction(() => document.querySelector("#needs-you-heading .run-count")?.textContent === "2");
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.openRun), "raw-failed", "polling keeps focus on the same workflow row");
    assert.equal(await page.evaluate(() => document.activeElement?.closest("section")?.getAttribute("aria-label")), "Today", "polling does not move a history-row focus to its pinned copy");
    await page.keyboard.press("Enter");
    await page.locator("#run-receipt").waitFor();
    assert.equal(await page.locator("#run-receipt h2").innerText(), workflow.name);
    assert.match(await page.locator("#run-receipt").innerText(), /Download PDF button is gone/);
    assert.equal(await page.locator("#main").evaluate((node) => document.activeElement === node), true);
    const receipt = await (await fetch(`${url}/api/runs/raw-failed/receipt`)).json() as ReturnType<typeof inspectRunView>;
    assert.equal(receipt.run.name, workflow.name);
    assert.equal(receipt.run.modelCalls, null);
    await page.getByText("Detailed evidence", { exact: true }).click();
    assert.equal(await page.locator("#run-viewer").isVisible(), true);
    await page.locator("#runs [data-open-run=raw-browser]").click();
    await page.getByRole("button", { name: "Next steps", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".receipt-steps")?.getAttribute("start") === "21");
    assert.equal(await page.locator(".receipt-steps li").count(), 1);
    assert.equal(await page.locator("#receipt-step-heading").evaluate((node) => node === document.activeElement), true);
    await page.getByRole("button", { name: "Previous steps", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".receipt-steps")?.getAttribute("start") === "1");
    await page.getByRole("button", { name: "Next steps", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".receipt-steps")?.getAttribute("start") === "21");
    await page.waitForResponse((response) => response.url() === `${url}/api/state`);
    await page.waitForResponse((response) => response.url() === `${url}/api/state`);
    await page.locator("#run-receipt").waitFor();
    await page.getByText("Detailed evidence", { exact: true }).click();
    await page.locator("#run-evidence").evaluate((node) => { node.dataset.retained = "yes"; });
    const capture = app.library.readRun("raw-browser");
    app.library.saveRun({ ...capture, steps: [...capture.steps, { id: "command-21", label: "Another read", status: "passed", startedAt: now + 1000, endedAt: now + 1100 }] });
    await page.waitForResponse((response) => response.url() === `${url}/api/state`);
    await page.waitForResponse((response) => response.url() === `${url}/api/state`);
    assert.equal(await page.locator("#run-evidence").getAttribute("data-retained"), "yes", "command evidence does not rebuild the open viewer");
    assert.equal(await page.locator("#run-evidence").getAttribute("open"), "");
    await page.locator(".runs-record").click();
    await page.waitForResponse((response) => response.url() === `${url}/api/state`);
    await page.waitForResponse((response) => response.url() === `${url}/api/state`);
    await page.locator("#start-url").fill("/fixture?draft=keep");
    const draftInput = await page.locator("#start-url").elementHandle();
    assert.ok(draftInput);
    const inProgress = app.library.readRun("raw-browser");
    const command = { id: "command-22", label: "Read fixture", status: "pending", startedAt: now + 2000 };
    app.library.saveRun({ ...inProgress, steps: [...inProgress.steps, command] });
    await page.waitForResponse((response) => response.url() === `${url}/api/state`);
    await page.waitForResponse((response) => response.url() === `${url}/api/state`);
    assert.equal(await page.locator("#start-url").inputValue(), "/fixture?draft=keep", "command start preserves the Capture draft");
    assert.equal(await page.locator("#start-url").evaluate((node, original) => node === original, draftInput), true, "command start retains the input element");
    app.library.saveRun({ ...inProgress, steps: [...inProgress.steps, { ...command, status: "passed", endedAt: now + 2100 }] });
    await page.waitForResponse((response) => response.url() === `${url}/api/state`);
    await page.waitForResponse((response) => response.url() === `${url}/api/state`);
    assert.equal(await page.locator("#start-url").inputValue(), "/fixture?draft=keep", "command completion preserves the Capture draft");
    assert.equal(await page.locator("#start-url").evaluate((node, original) => node === original, draftInput), true, "command completion retains the input element");
    await page.route("**/api/replay", (route) => route.fulfill({ json: { id: "raw-failed" } }));
    await page.locator("#rail [data-place=workflows]").click();
    await page.locator(`[data-open-workflow="${workflow.id}"]`).click();
    await page.locator(`#main [data-screen=replay][data-workflow="${workflow.id}"]`).click();
    await page.locator("#wf").selectOption(workflow.id);
    await page.locator("#run").click();
    await page.locator("#run-receipt").waitFor();
    assert.equal(await page.locator(".receipt-steps").getAttribute("start"), "1", "a replay result cannot inherit another run's receipt page");
    assert.equal(await page.locator("#run-evidence").getAttribute("open"), null, "ordinary replay opens receipt-first");
    await page.getByText("Detailed evidence", { exact: true }).click();
    await page.locator("#debug-step").click();
    await page.locator("#run").click();
    await page.locator("#run-receipt").waitFor();
    assert.equal(await page.locator("#run-viewer").isVisible(), true, "debug results expose the selected step without an extra click");
    assert.equal(await page.locator(".receipt-steps").getAttribute("start"), "1");
    failReceipt = true;
    await row.click();
    await page.getByRole("heading", { name: "Can’t open this receipt" }).waitFor();
    await page.getByText("Detailed evidence", { exact: true }).click();
    assert.equal(await page.locator("#run-viewer").isVisible(), true, "a bounded receipt read failure must not hide local evidence");
    failReceipt = false;
    dropReceipt = true;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.id === "main");
    assert.equal(await page.locator("#run-viewer").isVisible(), true, "a receipt network failure must not hide local evidence");
    dropReceipt = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.locator("#run-receipt").waitFor();
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => localStorage.setItem("bao-theme", value), theme);
      for (const width of [1280, 720, 320]) {
        await page.setViewportSize({ width, height: 860 });
        await page.reload();
        await page.locator("#runs").waitFor();
        assert.equal(await page.locator("#runs .run-name").first().evaluate((node) => getComputedStyle(node.parentElement!).textAlign), "start");
        await page.locator("#runs [data-open-run=raw-failed]").first().focus();
        assert.notEqual(await page.locator("#runs [data-open-run=raw-failed]").first().evaluate((node) => getComputedStyle(node).outlineStyle), "none");
        await page.keyboard.press("Enter");
        await page.locator("#run-receipt").waitFor();
        assert.equal(await page.locator("#content").evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, `${theme} ${width}px`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
    }
    await page.setViewportSize({ width: 640, height: 430 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "a 1280×860 window at 200% must reflow within its 640×430 CSS viewport");
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.locator("#screen-list [data-screen=heals]").click();
    await page.locator("#heal-inbox").waitFor();
    await page.locator("#screen-list [data-screen=live]").click();
    await page.locator("#live-session").waitFor();
  } finally {
    await browser.close(); await app.close();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
