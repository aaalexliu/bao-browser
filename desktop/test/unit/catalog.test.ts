import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { CDP_LIVE_SERVER_REFUSAL, EXTENSION_NOT_CONNECTED } from "../../src/cdp-live/launch-guard";
import { compareSearchHits, describeWorkflow, greenLabel, originLabel, runWorkflow, searchWorkflows, workflowReplayRefusal, type SearchHit } from "../../src/mcp/catalog";
import { Library } from "../../src/v1/store";
import { validateWorkflow, type WorkflowV2 } from "../../src/v1/schema";
import { loadState, saveState } from "../../src/v1/sync";

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

test("search excludes retired and fixture workflows while preserving readable records and replay eligibility", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-cat-"));
  try {
    const library = new Library(home);
    const normal = workflow("owner", "Blueberries owner workflow (fixture notes)");
    const retired = { ...workflow("retired", "Blueberries retired workflow"), driver: "cdp-live" as const };
    const fixture = { ...workflow("fixture", "Blueberries sample"), provenance: "fixture" as const };
    for (const doc of [normal, retired, fixture]) library.save(doc);

    assert.deepEqual((await searchWorkflows(library, "Blueberries")).map((hit) => hit.id), [normal.id]);
    assert.equal(library.list().workflows.length, 3);
    assert.equal((await describeWorkflow(library, retired.id)).workflow.driver, "cdp-live");
    assert.equal((await describeWorkflow(library, fixture.id)).workflow.provenance, "fixture");
    assert.deepEqual(validateWorkflow(library.read(fixture.id)), []);
    assert.equal(workflowReplayRefusal(library, normal), null);
    assert.equal(workflowReplayRefusal(library, retired), CDP_LIVE_SERVER_REFUSAL);
    assert.equal(workflowReplayRefusal(library, fixture), null);
    const outcome = await runWorkflow(library, { id: retired.id });
    assert.equal(outcome.outcome, "failed");
    assert.equal(outcome.reason, CDP_LIVE_SERVER_REFUSAL);
    assert.equal(existsSync(path.join(home, "chrome-profile")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("remote search preserves local exclusions without document fetches", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-cat-"));
  const documents = [
    workflow("remote-owner", "Blueberries owner"),
    workflow("local-retired", "Blueberries synced owner"),
    workflow("local-fixture", "Blueberries synced sample"),
  ];
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url || "");
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/api/catalog?")) {
      res.end(JSON.stringify({ hits: documents.map((doc) => ({ ...hit(doc.id, "mine", 10, doc.name), source: "mine" })) }));
      return;
    }
    const doc = documents.find((item) => req.url === `/api/workflows/${item.id}`);
    if (!doc) { res.statusCode = 404; res.end("{}"); return; }
    res.end(JSON.stringify({ document: doc }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const library = new Library(home);
    library.save({ ...documents[1]!, driver: "cdp-live" });
    library.save({ ...documents[2]!, provenance: "fixture" });
    const { port } = server.address() as AddressInfo;
    saveState(home, { ...loadState(home), server: `http://127.0.0.1:${port}`, deviceToken: "fixture" });
    assert.deepEqual((await searchWorkflows(library, "Blueberries", {}, { extensionLinked: true, relay: true })).map((item) => item.id), ["remote-owner"]);
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0]!, "http://localhost").searchParams.get("extensionLinked"), "true");
    assert.equal(new URL(requests[0]!, "http://localhost").searchParams.get("relay"), "true");
    library.updateSettings({ pageEngine: "agent-browser" });
    await searchWorkflows(library, "Blueberries");
    assert.equal(requests.length, 2);
    assert.equal(new URL(requests[1]!, "http://localhost").searchParams.get("pageEngine"), "agent-browser");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});

test("search uses the caller's extension connection and selected engine", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-cat-"));
  try {
    const library = new Library(home);
    const extension = { ...workflow("extension", "Blueberries extension"), driver: "extension" as const };
    library.save(extension);
    assert.deepEqual(await searchWorkflows(library, "Blueberries"), []);
    assert.deepEqual((await searchWorkflows(library, "Blueberries", {}, { extensionLinked: true })).map((hit) => hit.id), [extension.id]);
    assert.equal(workflowReplayRefusal(library, extension), EXTENSION_NOT_CONNECTED);
    library.updateSettings({ pageEngine: "agent-browser" });
    assert.deepEqual(await searchWorkflows(library, "Blueberries", {}, { extensionLinked: true }), []);
    assert.deepEqual((await searchWorkflows(library, "Blueberries", {}, { extensionLinked: true, relay: true })).map((hit) => hit.id), [extension.id]);
    assert.match(workflowReplayRefusal(library, extension)!, /pass-through/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("desktop replay keeps its engine refusal for extension workflows", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-cat-app-"));
  const library = new Library(home);
  library.save({ ...workflow("extension", "Extension replay"), driver: "extension" });
  library.updateSettings({ pageEngine: "agent-browser" });
  const app = await startApp({ home, port: 0, extensionHost: false });
  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "extension" }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "pass-through sessions do not support saved workflow replay" });
    assert.deepEqual(library.listRuns(), []);
    assert.equal(existsSync(path.join(home, "chrome-profile")), false);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
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

test("a capture-only workflow is not green in search, describe, or run_workflow", async () => {
  const library = new Library(mkdtempSync(path.join(tmpdir(), "bao-cat-")));
  const doc = { ...workflow("wf-recorded", "Recorded workflow"), driver: "cdp-live" as const };
  library.save(doc);
  library.saveRun({ id: "recording", kind: "capture", workflowId: doc.id, status: "passed", at: Date.now(), heals: [], steps: [] });
  assert.equal((await describeWorkflow(library, doc.id)).lastGreen, "Not replayed yet");
  assert.deepEqual(await searchWorkflows(library, "Recorded"), []);
  const outcome = await runWorkflow(library, { id: doc.id });
  assert.equal(outcome.reason, CDP_LIVE_SERVER_REFUSAL);
  assert.equal(library.readRun("recording").kind, "capture");
});

for (const driver of ["playwright", "extension"] as const) {
  test(`the selected native engine refuses ordinary ${driver} MCP replay before launching Chrome`, async () => {
    const library = new Library(mkdtempSync(path.join(tmpdir(), "bao-cat-")));
    library.save({ ...workflow("wf-native", "Native workflow"), driver });
    library.updateSettings({ pageEngine: "agent-browser", chromeProfile: "Default" });
    const outcome = await runWorkflow(library, { id: "wf-native", inputs: { query: "ada" } });
    assert.equal(outcome.outcome, "failed");
    assert.equal(outcome.reason, "pass-through sessions do not support saved workflow replay");
    assert.deepEqual(await searchWorkflows(library, "Native"), []);
    assert.equal(existsSync(path.join(library.root, "chrome-profile")), false);
  });
}

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
    assert.deepEqual(await searchWorkflows(library, "Driver"), []);
    assert.equal(outcome.runId, undefined);
    assert.equal(outcome.resume, undefined);
    assert.equal(existsSync(path.join(library.root, "chrome-profile")), false);
    assert.deepEqual(library.listRuns(), []);
  });
}

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
