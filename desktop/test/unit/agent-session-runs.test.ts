import { testWorkflow } from "../support/workflow";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { runAttention, runReceipt, runsList, runViewer, runWorkflowName, type RunSummary } from "../../src/app/views";
import { AgentBrowserRun } from "../../src/engines/agent-browser-record";
import { inspectRunView } from "../../src/mcp/run-view";
import { TOOLS } from "../../src/mcp/server";
import { testChromium } from "../../src/test-browser";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { scaledMs } from "../runtime";

const closed = "The session ended while Bao was waiting for you, so the agent could not go on.";
const idle = "The agent sent nothing for 10 minutes and never finished the task, so Bao ended the session.";

function session(partial: Partial<RunSummary> & Pick<RunSummary, "id" | "status">): RunSummary {
  return {
    workflowId: "agent-browser",
    kind: "capture",
    pageEngine: "agent-browser",
    heals: [],
    ...partial,
  };
}

test("finish_task stores a trimmed task name and ignores a blank one", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-agent-task-"));
  try {
    const library = new Library(root);
    const named = new AgentBrowserRun(root);
    named.finish({ outcome: "failed", reason: "The item was sold out.", task: "  Add milk  " });
    assert.equal(library.readRun(named.id).task, "Add milk");
    const blank = new AgentBrowserRun(root);
    blank.finish({ outcome: "passed", reason: "Done.", task: "   " });
    assert.equal(library.readRun(blank.id).task, undefined);
    const tool = TOOLS.find((item) => item.name === "finish_task")!;
    assert.ok("task" in tool.inputSchema.properties);
    assert.equal(tool.inputSchema.properties.task.type, "string");
    assert.ok("required" in tool.inputSchema);
    assert.deepEqual(tool.inputSchema.required, ["outcome", "reason"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent session names fall back from task to first site to Browser session", () => {
  const open = (url: string) => ({ id: "command-1", status: "passed" as const, native: { command: "open", args: [url] } });
  const later = { id: "command-2", status: "passed" as const, native: { command: "open", args: ["https://example.com"] } };
  assert.equal(runWorkflowName(session({ id: "task", status: "failed", task: " Add milk ", steps: [open("https://github.com/bao")] }), []), "Add milk");
  assert.equal(runWorkflowName(session({ id: "host", status: "failed", steps: [open("https://github.com/aaalexliu/bao-browser"), later] }), []), "github.com");
  assert.equal(runWorkflowName(session({ id: "bare", status: "passed", steps: [open("github.com/foo")] }), []), "github.com");
  assert.equal(runWorkflowName(session({ id: "blank", status: "passed", task: "  ", steps: [open("about:blank")] }), []), "Browser session");
  assert.equal(runWorkflowName(session({ id: "none", status: "passed", steps: [] }), []), "Browser session");
  assert.equal(runWorkflowName({ id: "replay", workflowId: "bill", status: "failed" }, [{ id: "bill", name: "Download the bill", steps: 1 }]), "Download the bill");
});

test("ended agent sessions show their reason and stay out of Needs you", () => {
  const now = Date.UTC(2026, 10, 6, 18);
  const runs = [
    session({
      id: "milk", status: "failed", at: now - 1000, task: "Add milk",
      steps: [{ id: "command-1", status: "passed", native: { command: "open", args: ["https://www.instacart.com/store"] } }],
      envelope: { status: "failed", reason: "The item was sold out." },
    }),
    session({
      id: "github", status: "failed", at: now - 2000,
      steps: [{ id: "command-1", status: "passed", native: { command: "open", args: ["https://github.com/aaalexliu/bao-browser"] } }],
      envelope: { status: "failed", reason: "session_closed", ask: closed },
    }),
    session({
      id: "idle", status: "failed", at: now - 3000,
      envelope: { status: "failed", reason: idle },
    }),
    session({
      id: "signin", status: "needs_human", at: now,
      steps: [{ id: "command-1", status: "paused", native: { command: "wait_for_owner", args: [] } }],
      envelope: { status: "needs_human", ask: "Sign in or clear the check in the Bao window." },
    }),
    { id: "bill", workflowId: "bill", status: "failed", at: now - 500, failure: { index: 0, reason: "The Download PDF button is gone." } },
  ];
  assert.deepEqual(runAttention(runs).map((item) => item.run.id), ["signin", "bill"]);
  const html = runsList(runs, [{ id: "bill", name: "Download the bill", steps: 1 }], "", now);
  assert.match(html, /ul aria-label="Needs you"[\s\S]*data-open-run="signin"/);
  assert.match(html, /ul aria-label="Needs you"[\s\S]*data-open-run="bill"/);
  assert.doesNotMatch(html.split('aria-label="Today"')[0] || "", /data-open-run="milk"|data-open-run="github"|data-open-run="idle"/);
  assert.match(html, /data-open-run="milk"[\s\S]*?>Add milk</);
  assert.match(html, /data-open-run="milk"[\s\S]*?Failed<\/span><span class="run-agent">Agent said: The item was sold out\./);
  assert.match(html, /data-open-run="github"[\s\S]*?>github.com</);
  assert.match(html, new RegExp(`data-open-run="github"[\\s\\S]*?${closed.replace(/[.]/g, "\\.")}`));
  assert.doesNotMatch(html, /session_closed|Bao stopped\. Open Chrome/);
  assert.match(html, new RegExp(idle.replace(/[.]/g, "\\.")));
  assert.doesNotMatch(html, /finish_task|wait_for_owner/);
  const receipt = runReceipt({
    view: "receipt",
    run: { id: "github", workflowId: "agent-browser", name: "Browser capture", status: "failed", at: now, kind: "capture", stepCount: 1, modelCalls: null, healCount: 0 },
    reason: "session_closed",
    handoff: { status: "failed", ask: closed, reason: "session_closed", deadline: undefined },
    steps: [],
    stepOffset: 0,
    nextStepOffset: null,
    workflow: null,
  }, "github.com", runs[1]!);
  assert.match(receipt, /<h2>github.com<\/h2>/);
  assert.match(receipt, new RegExp(closed.replace(/[.]/g, "\\.")));
  assert.doesNotMatch(receipt, /session_closed|Needs you|Bao stopped/);
});

test("an ended agent session receipt names its steps in words and marks the cut-off and unreached ones", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-agent-receipt-"));
  try {
    const library = new Library(root);
    const recorded = new AgentBrowserRun(root);
    const noPage = async () => { throw new Error("no page"); };
    const open = recorded.begin("open", ["https://github.com/login"]);
    await recorded.complete(open, [{ stdout: "", stderr: "", exitCode: 0 }], root, noPage);
    const wait = recorded.begin("wait_for_owner", ["60000"]);
    recorded.ownerWaiting(true);
    recorded.finish("session_closed");
    await recorded.complete(wait, [{ stdout: JSON.stringify({ outcome: "closed" }), stderr: "", exitCode: 0 }], root, noPage, undefined, true);
    const step = (id: string, text: string, status: string, extra: Record<string, unknown> = {}) =>
      ({ id, status, label: text, caption: { text }, ...extra });
    const steps = [
      step("command-1", "Open www.instacart.com/store", "passed", { startedAt: 1, endedAt: 2, native: { command: "open", args: ["https://www.instacart.com/store"] } }),
      step("command-2", "Click Add to cart", "failed", { startedAt: 3, endedAt: 4, reason: "Native agent-browser command failed.", native: { command: "click", args: ["@e3"] } }),
      step("command-3", "Wait for you to sign in", "pending", { startedAt: 5, native: { command: "wait_for_owner", args: ["60000"] } }),
      step("command-4", "Read the page", "pending", { native: { command: "snapshot", args: [] } }),
    ];
    const saved = { workflowId: "agent-browser", kind: "capture", pageEngine: "agent-browser", status: "failed", heals: [], steps } as const;
    library.saveRun({ ...saved, id: "old-idle", at: 2, envelope: { status: "failed", reason: "Session ended without finish_task after 10 minutes of inactivity." } } as never);
    library.saveRun({ ...saved, id: "old-closed", at: 1, envelope: { status: "failed", reason: "session_closed", ask: "The Bao session ended before the owner wait completed. This session cannot continue." } } as never);
    const read = (id: string) => library.readRun(id) as unknown as RunSummary;
    const receiptFor = (id: string) => runReceipt(inspectRunView(library, { run_id: id }), "Browser session", read(id));
    const waited = receiptFor(recorded.id);
    assert.match(waited, new RegExp(closed.replace(/[.]/g, "\\.")));
    assert.match(waited, /<strong>Open github\.com\/login<\/strong><span class="receipt-status">Passed</);
    assert.match(waited, /<strong>Wait for you to sign in<\/strong><span class="receipt-status run-state failed">Failed<\/span><\/div><p>The session ended before you finished\.</);
    const oldIdle = receiptFor("old-idle");
    assert.match(oldIdle, new RegExp(idle.replace(/[.]/g, "\\.")));
    assert.match(oldIdle, /<strong>Click Add to cart<\/strong><span class="receipt-status run-state failed">Failed<\/span><\/div><p>The browser could not do this step\.</);
    assert.match(oldIdle, /<strong>Wait for you to sign in<\/strong><span class="receipt-status">did not finish</);
    assert.match(oldIdle, /<strong>Read the page<\/strong><span class="receipt-status">not reached</);
    const oldClosed = receiptFor("old-closed");
    assert.match(oldClosed, new RegExp(closed.replace(/[.]/g, "\\.")));
    const rows = runsList([read("old-idle"), read("old-closed")], [], "", 3);
    assert.match(rows, new RegExp(`data-open-run="old-idle"[\\s\\S]*?${idle.replace(/[.]/g, "\\.")}`));
    assert.match(rows, new RegExp(`data-open-run="old-closed"[\\s\\S]*?${closed.replace(/[.]/g, "\\.")}`));
    const spokenReceipt = (html: string) => html.split('<h3 id="receipt-step-heading"')[0] || html;
    for (const html of [waited, oldIdle, oldClosed]) {
      assert.doesNotMatch(spokenReceipt(html), /wait_for_owner|finish_task|agent-browser command|owner wait completed|>open<|>pending</);
    }
    assert.doesNotMatch(rows, /wait_for_owner|finish_task|agent-browser command|owner wait completed|>open<|>pending</);
    const legacy = session({
      id: "dropped", status: "failed", at: 4, pageEngine: "agent-browser",
      steps: [{ id: "command-1", label: "Open example.com", status: "failed", reason: "agent-browser client disconnected", native: { command: "open", args: ["https://example.com"] } }],
    });
    const legacySteps = [
      { id: "command-1", label: "Click Add to cart", status: "failed" as const, reason: "Native agent-browser command failed.", native: { command: "click", args: ["@e3"] } },
    ];
    const evidence = runViewer({
      ...session({ id: "old-click", status: "failed", pageEngine: "agent-browser", steps: legacySteps }),
    }, { name: "agent-browser", recordedOnly: true, steps: legacySteps });
    assert.match(evidence, /Step 1 Click Add to cart failed: The browser could not do this step\./);
    assert.doesNotMatch(evidence, /Native agent-browser command failed/);
    const dropped = runsList([legacy], [], "", 5);
    assert.match(dropped, /The agent disconnected\./);
    assert.doesNotMatch(dropped, /agent-browser client disconnected/);
    const droppedEvidence = runViewer(legacy, { name: "agent-browser", recordedOnly: true, steps: legacy.steps! });
    assert.match(droppedEvidence, /Step 1 Open example.com failed: The agent disconnected\./);
    assert.doesNotMatch(droppedEvidence, /agent-browser client disconnected/);
    const live = new AgentBrowserRun(root);
    live.begin("snapshot", []);
    assert.match(receiptFor(live.id), /<strong>Read the page<\/strong><span class="receipt-status">pending</);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saved-workflow replays keep Needs you when the page engine is agent-browser", () => {
  const now = Date.UTC(2026, 10, 6, 18);
  const reason = "The Download PDF button is gone.";
  const ask = "Retry the download from the account page.";
  const failed: RunSummary = {
    id: "r", workflowId: "bill", kind: "replay", pageEngine: "agent-browser", status: "failed", at: now - 1000,
    failure: { index: 0, reason }, heals: [{ id: "h1" }], envelope: { status: "failed", ask },
  };
  const paused: RunSummary = {
    id: "paused-bill", workflowId: "bill", kind: "replay", pageEngine: "agent-browser", status: "paused", at: now, heals: [],
  };
  const workflows = [{ id: "bill", name: "Download the bill", steps: 4 }];
  assert.deepEqual(runAttention([failed, paused]).map((item) => [item.run.id, item.label]), [
    ["paused-bill", "Needs you"],
    ["r", "Heal to keep"],
    ["r", "Failed"],
  ]);
  assert.equal(runWorkflowName(failed, workflows), "Download the bill");
  assert.equal(runWorkflowName(paused, workflows), "Download the bill");
  assert.equal(runWorkflowName(failed, []), "Workflow unavailable");
  const html = runsList([failed, paused], workflows, "", now);
  assert.match(html, /id="needs-you-heading"[\s\S]*?>3</);
  assert.match(html, /data-open-run="paused-bill"[\s\S]*?>Needs you</);
  assert.match(html, /data-heal="h1"[\s\S]*?>Heal to keep</);
  assert.match(html, /data-open-run="r"[\s\S]*?>Failed<\/span> · Stopped at step 1\.</);
  assert.match(html, /Stopped at step 1 of 4/);
  assert.match(html, /class="run-extra">The Download PDF button is gone\.</);
  assert.match(html, /aria-label="Download the bill"/);
  assert.doesNotMatch(html, /Browser session/);
  const receipt = runReceipt({
    view: "receipt",
    run: { id: "r", workflowId: "bill", name: "Download the bill", status: "failed", at: now, kind: "replay", stepCount: 4, modelCalls: null, healCount: 1 },
    reason, handoff: { status: "failed", ask, reason, deadline: undefined },
    steps: [], stepOffset: 0, nextStepOffset: null, workflow: null,
  }, "Download the bill", failed);
  assert.match(receipt, /Retry the download from the account page\./);
  assert.match(receipt, /The Download PDF button is gone\./);
  assert.match(receipt, /<h2>Download the bill<\/h2>/);
});

const signInAsk = "Bao is waiting for you to sign in or clear the check in its browser window. The agent will continue here.";

test("a waiting agent session receipt shows the sign-in ask and not a stop sentence", () => {
  const run = session({
    id: "signin",
    status: "needs_human",
    steps: [{ id: "command-1", status: "paused", native: { command: "wait_for_owner", args: [] } }],
    envelope: { status: "needs_human", reason: "owner_signin", ask: signInAsk },
  });
  const receipt = runReceipt({
    view: "receipt",
    run: { id: "signin", workflowId: "agent-browser", name: "Browser capture", status: "needs_human", at: 1, kind: "capture", stepCount: 1, modelCalls: null, healCount: 0 },
    reason: "owner_signin",
    handoff: { status: "needs_human", ask: signInAsk, reason: "owner_signin", deadline: undefined },
    steps: [],
    stepOffset: 0,
    nextStepOffset: null,
    workflow: null,
  }, "instacart.com", run);
  assert.match(receipt, /<aside class="receipt-handoff"><h3>Needs you<\/h3>/);
  assert.match(receipt, /Bao is waiting for you to sign in or clear the check in its browser window\. The agent will continue here\./);
  assert.doesNotMatch(receipt, /Bao stopped\. Open Chrome to check the page before continuing\./);
});

test("Runs names agent sessions, shows the failure reason, and leaves ended sessions out of Needs you", { timeout: scaledMs(60_000) }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-agent-runs-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.setDefaultTimeout(8_000);
  const workflow: WorkflowV2 = testWorkflow({
    schema: "bao.workflow/v4", id: "bill", createdAt: 1, name: "Download the bill", startUrl: "/fixture", inputs: [],
    steps: [{
      id: "open",
      index: 0,
      timeoutMs: 1000,
      caption: { text: "Open account" },
      action: "click",
      target: { locators: [{ kind: "role", role: "button", name: "Open account" }] },
    }],
  });
  const now = Date.now();
  try {
    app.library.save(workflow);
    app.library.saveRun({
      id: "bill", workflowId: "bill", kind: "replay", status: "failed", at: now - 500, heals: [],
      steps: [{ id: "open", status: "failed", label: "Open account" }],
      failure: { index: 0, reason: "The Download PDF button is gone." },
    });
    app.library.saveRun({
      id: "milk", workflowId: "agent-browser", kind: "capture", pageEngine: "agent-browser", status: "failed",
      at: now - 1000, task: "Add milk", heals: [],
      steps: [{ id: "command-1", status: "passed", native: { command: "open", args: ["https://www.instacart.com/store"] } }],
      envelope: { status: "failed", reason: "The item was sold out." },
    });
    app.library.saveRun({
      id: "github", workflowId: "agent-browser", kind: "capture", pageEngine: "agent-browser", status: "failed",
      at: now - 2000, heals: [],
      steps: [{ id: "command-1", status: "passed", native: { command: "open", args: ["https://github.com/aaalexliu/bao-browser"] } }],
      envelope: { status: "failed", reason: "session_closed", ask: closed },
    });
    app.library.saveRun({
      id: "blank", workflowId: "agent-browser", kind: "capture", pageEngine: "agent-browser", status: "passed",
      at: now - 3000, heals: [], steps: [],
    });
    app.library.saveRun({
      id: "signin", workflowId: "agent-browser", kind: "capture", pageEngine: "agent-browser", status: "needs_human",
      at: now, heals: [],
      steps: [{ id: "command-1", status: "paused", native: { command: "open", args: ["https://instacart.com/"] } }],
      envelope: { status: "needs_human", ask: "Sign in or clear the check in the Bao window." },
    });
    await page.goto(`http://127.0.0.1:${app.port}/`);
    await page.locator("#runs").waitFor();
    const needsYou = page.locator('#runs ul[aria-label="Needs you"]');
    assert.deepEqual(await needsYou.locator("[data-open-run]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-open-run")).sort()), ["bill", "signin"]);
    assert.equal(await page.locator('#runs [data-open-run="milk"]').count(), 1);
    assert.equal(await page.locator('#runs [data-open-run="github"]').count(), 1);
    assert.equal(await page.locator('#runs [data-open-run="milk"] .run-name').innerText(), "Add milk");
    assert.match(await page.locator('#runs [data-open-run="milk"] .run-meta').innerText(), /Failed\nAgent said: The item was sold out\./);
    assert.equal(await page.locator('#runs [data-open-run="github"] .run-name').innerText(), "github.com");
    assert.match(await page.locator('#runs [data-open-run="github"] .run-meta').innerText(), new RegExp(closed.replace(/[.]/g, "\\.")));
    assert.doesNotMatch(await page.locator("#runs").innerText(), /session_closed|Bao stopped\. Open Chrome/);
    assert.equal(await page.locator('#runs [data-open-run="blank"] .run-name').innerText(), "Browser session");
    assert.equal(await page.locator('#runs [data-open-run="signin"] .run-name').first().innerText(), "instacart.com");
    await page.locator('#runs [data-open-run="milk"]').click();
    await page.locator("#run-receipt").waitFor();
    assert.equal(await page.locator("#run-receipt h2").innerText(), "Add milk");
    assert.match(await page.locator("#run-receipt").innerText(), /The item was sold out\./);
    assert.equal(await page.locator(".receipt-handoff").count(), 0);
    await page.locator('#runs [data-open-run="github"]').click();
    await page.locator("#run-receipt h2").filter({ hasText: "github.com" }).waitFor();
    assert.match(await page.locator("#run-receipt").innerText(), new RegExp(closed.replace(/[.]/g, "\\.")));
    assert.doesNotMatch(await page.locator("#run-receipt").innerText(), /session_closed|Needs you/);
  } finally {
    await browser.close();
    await app.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
