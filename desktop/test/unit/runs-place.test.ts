import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { runAttention } from "../../src/app/views";
import { testChromium } from "../../src/test-browser";
import type { WorkflowV2 } from "../../src/v1/schema";
import type { inspectRunView } from "../../src/mcp/run-view";

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

test("Runs keeps current owner waits actionable and ended asks informational", { timeout: 30_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-runs-waits-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const page = await browser.newPage();
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
      await page.locator(`[data-open-run="${item.id}"]`).first().click();
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
    assert.deepEqual(await history.locator("button").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-open-run"))), ["raw-paused", "raw-failed", "raw-heal", "raw-browser"]);
    assert.equal(await page.locator('#runs section[aria-label="Yesterday"]').count(), 1);
    assert.doesNotMatch(await page.locator("#runs").innerText(), /raw-/);
    assert.doesNotMatch(await history.locator("[data-open-run=raw-failed]").innerText(), /model calls/);
    assert.match(await page.locator("[data-open-run=raw-old]").innerText(), /0 model calls/);
    assert.equal(await history.getByRole("button", { name: workflow.name, exact: true }).count(), 3);
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
    await page.locator("[data-open-run=raw-browser]").click();
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
    app.library.saveRun({ ...capture, steps: [...capture.steps, { id: "command-21", label: "Another read", status: "passed" }] });
    await page.waitForResponse((response) => response.url() === `${url}/api/state`);
    await page.waitForResponse((response) => response.url() === `${url}/api/state`);
    assert.equal(await page.locator("#run-evidence").getAttribute("data-retained"), "yes", "command evidence does not rebuild the open viewer");
    assert.equal(await page.locator("#run-evidence").getAttribute("open"), "");
    await page.route("**/api/replay", (route) => route.fulfill({ json: { id: "raw-failed" } }));
    await page.locator("#rail [data-place=workflows]").click();
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
        await page.locator("[data-open-run=raw-failed]").first().focus();
        assert.notEqual(await page.locator("[data-open-run=raw-failed]").first().evaluate((node) => getComputedStyle(node).outlineStyle), "none");
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
