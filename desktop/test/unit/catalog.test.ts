import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CDP_LIVE_SERVER_REFUSAL, EXTENSION_NOT_CONNECTED } from "../../src/cdp-live/launch-guard";
import { compareSearchHits, describeWorkflow, greenLabel, originLabel, runWorkflow, searchWorkflows, type SearchHit } from "../../src/mcp/catalog";
import type { RunResult } from "../../src/v1/replay";
import { Library } from "../../src/v1/store";
import type { WorkflowV2 } from "../../src/v1/schema";

test("search returns at most five hits and each hit has an input schema", async () => {
  const library = new Library(mkdtempSync(path.join(tmpdir(), "bao-cat-")));
  for (let i = 0; i < 8; i++) library.save(workflow(`wf-${i}`, `Search workflow ${i}`));
  const hits = await searchWorkflows(library, "search");
  assert.ok(hits.length <= 5);
  assert.ok(hits.length >= 1);
  for (const hit of hits) {
    assert.ok(Array.isArray(hit.inputs));
    assert.equal(hit.inputs[0]?.name, "query");
    assert.equal(hit.link.startsWith("bao://workflow/"), true);
    assert.equal(hit.source, "this Mac");
    assert.equal(hit.lastGreen, "Not replayed yet");
  }
});

test("source names this Mac, the other device, or the marketplace", () => {
  assert.equal(originLabel({ local: true, bucket: "mine" }), "this Mac");
  assert.equal(originLabel({ local: false, bucket: "mine", deviceName: "Mac A", thisDevice: "Mac B" }), "Mac A");
  assert.equal(originLabel({ local: true, bucket: "mine", forkedFrom: "listing-1", deviceName: "Mac A" }), "marketplace");
  assert.equal(originLabel({ local: false, bucket: "public" }), "marketplace");
});

test("equal scores rank this Mac, then another device, then marketplace", () => {
  const hits = [
    hit("m", "marketplace", 10, "Span marketplace"),
    hit("a", "Mac A", 10, "Span from Mac A"),
    hit("here", "this Mac", 10, "Span on this Mac"),
    hit("better", "marketplace", 30, "Better marketplace"),
  ].sort(compareSearchHits);
  assert.deepEqual(hits.map((item) => item.id), ["better", "here", "a", "m"]);
});

test("a marketplace clock this Mac has not replayed is the publisher's", () => {
  const at = Date.parse("2026-10-22T10:21:00Z");
  const publisher = greenLabel("marketplace", at);
  assert.match(publisher, /^publisher green · /);
  assert.equal(publisher.includes("Not replayed yet"), false);
  assert.equal(greenLabel("Mac A", at).startsWith("publisher green"), false);
  assert.equal(greenLabel("marketplace", undefined), "Not replayed yet");
  const mine = Date.parse("2026-10-22T10:22:00Z");
  assert.equal(greenLabel("marketplace", at, mine).startsWith("publisher green"), false);
  assert.equal(greenLabel("marketplace", at, mine), greenLabel("this Mac", mine));
});

test("a passed run stamps last green for search and describe", async () => {
  const library = new Library(mkdtempSync(path.join(tmpdir(), "bao-cat-")));
  library.save(workflow("wf-green", "Search workflow green"));
  const before = await describeWorkflow(library, "wf-green");
  assert.equal(before.lastGreen, "Not replayed yet");
  library.saveRun({
    id: "run-green",
    workflowId: "wf-green",
    status: "passed",
    at: Date.now(),
    heals: [],
    steps: [],
  });
  const described = await describeWorkflow(library, "wf-green");
  assert.notEqual(described.lastGreen, "Not replayed yet");
  const hits = await searchWorkflows(library, "green");
  assert.equal(hits[0]?.lastGreen, described.lastGreen);
});

test("describe omits secret defaults and a missing secret does not launch a browser", async () => {
  const library = new Library(mkdtempSync(path.join(tmpdir(), "bao-cat-")));
  const doc = workflow("sign-in", "Sign in");
  doc.inputs.push({ name: "password", type: "secret", label: "Password" });
  library.save(doc);
  const described = await describeWorkflow(library, "sign-in");
  const secret = described.workflow.inputs.find((input) => input.name === "password");
  assert.equal(secret?.default, undefined);
  assert.equal(described.inputs.find((input) => input.name === "password")?.type, "secret");
  assert.equal(described.link, "bao://workflow/sign-in");
  assert.equal(described.source, "this Mac");
  assert.equal(described.lastGreen, "Not replayed yet");
  const outcome = await runWorkflow(library, { id: "sign-in", inputs: { query: "ada" } });
  assert.equal(outcome.outcome, "needs_human");
  assert.match(outcome.reason || "", /Password/);
  assert.match(outcome.resume || "", /^r_[a-f0-9]+$/);
  assert.equal(JSON.stringify(outcome).includes("SuperSecret"), false);
});

for (const [driver, reason] of [["cdp-live", CDP_LIVE_SERVER_REFUSAL], ["extension", EXTENSION_NOT_CONNECTED]] as const) {
  test(`run_workflow refuses ${driver} workflows and does not open Bao's Chrome`, async () => {
    const library = new Library(mkdtempSync(path.join(tmpdir(), "bao-cat-")));
    library.save({ ...workflow("wf-driver", "Driver workflow"), driver });
    const outcome = await runWorkflow(library, { id: "wf-driver", inputs: { query: "ada" } });
    assert.equal(outcome.outcome, "failed");
    assert.equal(outcome.reason, reason);
    assert.equal(outcome.runId, undefined);
    assert.equal(outcome.resume, undefined);
    assert.equal(existsSync(path.join(library.root, "chrome-profile")), false);
    assert.deepEqual(library.listRuns(), []);
  });
}

test("run_workflow sends a cdp-live workflow to the live runner with the recorded defaults, and never opens Bao's Chrome", async () => {
  const library = new Library(mkdtempSync(path.join(tmpdir(), "bao-cat-")));
  const doc: WorkflowV2 = { ...workflow("wf-live", "Live workflow"), driver: "cdp-live" };
  doc.inputs = [{ name: "query", type: "text", label: "Query", default: "blueberries" }];
  library.save(doc);
  const seen: Record<string, unknown>[] = [];
  const live = async (run: WorkflowV2, inputs: Record<string, unknown>, status: RunResult["status"] = "passed"): Promise<RunResult> => {
    seen.push({ id: run.id, ...inputs });
    return {
      runId: `run-live-${seen.length}`,
      status,
      steps: run.steps.map((step) => ({ id: step.id, status: status === "passed" ? "passed" as const : "paused" as const })),
      heals: [],
      repairs: [],
      locatorHits: [],
      receipts: [],
      trajectory: [],
      trail: [],
      pageClasses: [],
      modelCalls: 0,
      ...(status === "paused" ? { pausedKind: "wall" as const, pausedStepId: "go" } : {}),
    };
  };
  const plain = await runWorkflow(library, { id: "wf-live" }, undefined, { live: (run, inputs) => live(run, inputs) });
  assert.equal(plain.outcome, "ok", plain.reason);
  const asked = await runWorkflow(library, { id: "wf-live", inputs: { query: "strawberries" } }, undefined, { live: (run, inputs) => live(run, inputs) });
  assert.equal(asked.outcome, "ok", asked.reason);
  assert.deepEqual(seen, [{ id: "wf-live", query: "blueberries" }, { id: "wf-live", query: "strawberries" }]);
  assert.equal(library.readRun("run-live-2").status, "passed");
  assert.deepEqual(library.readRun("run-live-2").inputs, { query: "strawberries" });
  const walled = await runWorkflow(library, { id: "wf-live" }, undefined, { live: (run, inputs) => live(run, inputs, "paused") });
  assert.equal(walled.outcome, "needs_human");
  assert.equal(existsSync(path.join(library.root, "chrome-profile")), false);
  const broken = await runWorkflow(library, { id: "wf-live" }, undefined, {
    live: async () => {
      throw new Error("bao app is not running");
    },
  });
  assert.equal(broken.outcome, "failed");
  assert.equal(broken.reason, "bao app is not running");
});

test("run_workflow still replays a Playwright workflow in Bao's Chrome", { timeout: 60_000 }, async () => {
  process.env.BAO_CHROME_NO_SANDBOX = "1";
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><button data-testid=\"go\" onclick=\"document.getElementById('status').textContent = 'Clicked'\">Go</button><p id=\"status\">Waiting</p>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const { port } = server.address() as AddressInfo;
    const library = new Library(mkdtempSync(path.join(tmpdir(), "bao-cat-")));
    library.save(clickWorkflow(`http://127.0.0.1:${port}/`));
    const outcome = await runWorkflow(library, { id: "wf-click" });
    assert.equal(outcome.outcome, "ok", outcome.reason);
    assert.equal(existsSync(path.join(library.root, "chrome-profile")), true);
    const run = library.readRun(outcome.runId || "");
    assert.equal(run.status, "passed");
    assert.equal(run.modelCalls, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function clickWorkflow(startUrl: string): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id: "wf-click",
    name: "Click Go",
    startUrl,
    createdAt: 1,
    inputs: [],
    steps: [{
      id: "go",
      index: 0,
      action: "click",
      label: "Go",
      surface: "dom",
      timeoutMs: 5000,
      identity: { surface: "dom", role: "button", testId: "go", text: "Go", path: [] },
      postcondition: { kind: "text", match: "Clicked", timeoutMs: 5000 },
    }],
  };
}

function hit(id: string, source: string, score: number, title: string): SearchHit {
  return {
    id,
    title,
    summary: "",
    site: "",
    category: "",
    source,
    lastGreen: "Not replayed yet",
    score,
    inputs: [],
    link: `bao://workflow/${id}`,
  };
}

function workflow(id: string, name: string): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id,
    name,
    startUrl: "https://example.com",
    createdAt: 1,
    inputs: [{ name: "query", type: "text", label: "Query" }],
    steps: [{
      id: "go",
      index: 0,
      action: "key",
      key: "Enter",
      label: `${name} step`,
      surface: "dom",
      timeoutMs: 1000,
    }],
  };
}
