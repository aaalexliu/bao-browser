import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { CDP_LIVE_SERVER_REFUSAL, EXTENSION_NOT_CONNECTED } from "../../src/cdp-live/launch-guard";
import { compareSearchHits, describeWorkflow, greenLabel, originLabel, runWorkflow, searchWorkflows, withHeldPage, workflowReplayRefusal, type SearchHit } from "../../src/mcp/catalog";
import { withInputDefaults } from "../../src/v1/replay";
import { adoptOwnerValues } from "../../src/v1/saved-inputs";
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

test("an app replay fills an imported author default and adopts only a changed value", () => {
  const doc: WorkflowV2 = {
    ...workflow("imp", "Imported"),
    imported: true,
    inputs: [
      { name: "who", type: "text", label: "Who", required: true, default: "front desk" },
      { name: "note", type: "text", label: "Note", required: true, default: "author" },
    ],
  };
  assert.deepEqual(withInputDefaults(doc, {}), { who: "front desk", note: "author" });
  assert.equal(adoptOwnerValues(doc, { who: "front desk", note: "author" }), undefined);
  const changed = adoptOwnerValues(doc, { who: "me", note: "author" });
  assert.equal(changed?.inputs.find((input) => input.name === "who")?.default, "me");
  assert.equal(changed?.inputs.find((input) => input.name === "who")?.ownerSaved, true);
  assert.equal(changed?.inputs.find((input) => input.name === "note")?.ownerSaved, undefined);
  assert.equal(changed?.inputs.find((input) => input.name === "note")?.default, "author");
  assert.equal(adoptOwnerValues(changed!, { who: "Beth", note: "author" }), undefined);
  const untouched = adoptOwnerValues({
    ...doc,
    inputs: [
      ...doc.inputs,
      { name: "count", type: "number", label: "Count", required: true },
      { name: "when", type: "date", label: "When", required: true },
    ],
  }, { who: "front desk", note: "author", count: 0, when: "today" });
  assert.equal(untouched, undefined);
});

test("the first marketplace run asks for the author's values", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-cat-market-"));
  const listing: WorkflowV2 = {
    ...workflow("listing", "Front desk"),
    inputs: [
      { name: "who", type: "text", label: "Who", required: true, default: "front desk", ownerSaved: true },
      { name: "note", type: "text", label: "Note", required: true, default: "author note" },
    ],
  };
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/marketplace/listing") {
      res.end(JSON.stringify({ document: listing, version: 3 }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const library = new Library(home);
    const { port } = server.address() as AddressInfo;
    saveState(home, { ...loadState(home), server: `http://127.0.0.1:${port}`, deviceToken: "fixture" });
    const first = await runWorkflow(library, { id: "listing" });
    assert.equal(first.outcome, "needs_human", first.reason);
    assert.match(first.reason || "", /Who/);
    assert.equal(first.savedValues, undefined);
    const stored = library.read("listing");
    assert.equal(stored.imported, true);
    assert.equal(stored.inputs.find((input) => input.name === "who")?.ownerSaved, undefined);
    assert.equal(stored.inputs.find((input) => input.name === "note")?.default, "author note");
    const again = await runWorkflow(library, { resume: first.resume_token });
    assert.equal(again.outcome, "needs_human", again.reason);
    assert.match(again.reason || "", /Who/);
    assert.equal(library.listRuns().length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});

test("an owned fork keeps the owner's import answers", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-cat-fork-"));
  const fork: WorkflowV2 = {
    ...workflow("forked", "Fork of Front desk"),
    imported: true,
    inputs: [
      { name: "name", type: "text", label: "Name", required: true, default: "Alex", ownerSaved: true },
      { name: "note", type: "text", label: "Note", required: true, default: "author note" },
    ],
  };
  const legacy: WorkflowV2 = {
    ...workflow("legacy", "Old fork"),
    inputs: [{ name: "name", type: "text", label: "Name", required: true, default: "Alex", ownerSaved: true }],
  };
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/workflows/forked") {
      res.end(JSON.stringify({ document: fork, forkedFrom: "listing", owned: true, version: 2 }));
      return;
    }
    if (req.url === "/api/workflows/legacy") {
      res.end(JSON.stringify({ document: legacy, forkedFrom: "listing", owned: true, version: 1 }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const library = new Library(home);
    const { port } = server.address() as AddressInfo;
    saveState(home, { ...loadState(home), server: `http://127.0.0.1:${port}`, deviceToken: "fixture" });
    const kept = await runWorkflow(library, { id: "forked" });
    assert.equal(kept.outcome, "needs_human", kept.reason);
    assert.match(kept.reason || "", /Note/);
    assert.equal((kept.reason || "").includes("Name"), false);
    const stored = library.read("forked");
    assert.equal(stored.imported, true);
    assert.equal(stored.inputs.find((input) => input.name === "name")?.ownerSaved, true);
    assert.equal(stored.inputs.find((input) => input.name === "name")?.default, "Alex");
    const marked = await runWorkflow(library, { id: "legacy" });
    assert.equal(marked.outcome, "needs_human", marked.reason);
    assert.match(marked.reason || "", /Name/);
    const old = library.read("legacy");
    assert.equal(old.imported, true);
    assert.equal(old.inputs[0]?.ownerSaved, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});

test("a refused app run does not adopt an imported author value", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-cat-refuse-"));
  const library = new Library(home);
  library.save({
    ...workflow("extension", "Imported extension"),
    driver: "extension",
    imported: true,
    inputs: [{ name: "who", type: "text", label: "Who", required: true, default: "front desk" }],
  });
  library.updateSettings({ pageEngine: "agent-browser" });
  const app = await startApp({ home, port: 0, extensionHost: false });
  try {
    const response = await fetch(`http://127.0.0.1:${app.port}/api/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "extension", args: { who: "me" } }),
    });
    assert.equal(response.status, 409);
    const stored = library.read("extension");
    assert.equal(stored.inputs[0]?.default, "front desk");
    assert.equal(stored.inputs[0]?.ownerSaved, undefined);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("file import keeps an owner's workflow unmarked and marks a new file", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-cat-file-"));
  const library = new Library(home);
  const owner = workflow("mine", "Mine");
  library.save(owner);
  const app = await startApp({ home, port: 0, extensionHost: false });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const replaced = await fetch(`${base}/api/workflows/import`, {
      method: "POST",
      body: JSON.stringify({ ...owner, name: "Mine edited", imported: true }),
    });
    assert.equal(replaced.status, 200, await replaced.clone().text());
    assert.equal(library.read("mine").imported, undefined);
    assert.equal(library.read("mine").name, "Mine edited");
    const shared = {
      ...workflow("shared", "Shared"),
      inputs: [{ name: "who", type: "text", label: "Who", required: true, default: "author", ownerSaved: true }],
    };
    const imported = await fetch(`${base}/api/workflows/import`, {
      method: "POST",
      body: JSON.stringify(shared),
    });
    assert.equal(imported.status, 200, await imported.clone().text());
    assert.equal(library.read("shared").imported, true);
    assert.equal(library.read("shared").inputs[0]?.ownerSaved, undefined);
    const again = await fetch(`${base}/api/workflows/import`, {
      method: "POST",
      body: JSON.stringify({ ...shared, imported: undefined, name: "Shared again" }),
    });
    assert.equal(again.status, 200, await again.clone().text());
    assert.equal(library.read("shared").imported, true);
    assert.equal(library.read("shared").name, "Shared again");
  } finally {
    await app.close();
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

for (const driver of [undefined, "extension"] as const) {
  test(`the selected native engine refuses ordinary ${driver ?? "undeclared"} MCP replay before launching Chrome`, async () => {
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
  doc.inputs.find((input) => input.name === "password")!.default = "SuperSecretFixture";
  library.save(doc);
  const withDefault = await describeWorkflow(library, "sign-in");
  assert.equal(withDefault.workflow.inputs.find((input) => input.name === "password")?.default, undefined);
  assert.equal(library.read(doc.id).inputs.find((input) => input.name === "password")?.default, "SuperSecretFixture");
});

test("MCP rerun and saved resume require fresh OTP input while keeping local history", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-otp-rerun-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  const doc = workflow("otp-rerun", "OTP rerun");
  doc.inputs.push(
    { name: "code", type: "secret", label: "Verification code", default: "123456" },
    { name: "attachment", type: "file", label: "Attachment" },
  );
  doc.steps.unshift({
    id: "code", index: 0, action: "type", label: "Verification code", input: "code", value: "{{code}}",
    surface: "dom", timeoutMs: 0,
    identity: { surface: "dom", role: "textbox", id: "code", autocomplete: "section-login one-time-code", path: [] },
  });
  doc.steps.forEach((step, index) => { step.index = index; });
  library.save(doc);
  library.savePublicInputs(doc.id, { code: "234567", query: "Ada" });
  const rerun = await runWorkflow(library, { id: doc.id, rerun: true });
  assert.equal(rerun.outcome, "needs_human");
  assert.match(rerun.reason || "", /Enter Verification code/);
  const token = "r_1234567890abcdef";
  mkdirSync(path.join(library.root, "resumes"), { recursive: true });
  const writeResume = () => writeFileSync(path.join(library.root, "resumes", `${token}.json`), JSON.stringify({
    workflowId: doc.id, stepId: "code", kind: "input", publicInputs: { code: "345678", query: "Ada" },
  }));
  writeResume();
  const resumed = await runWorkflow(library, { resume: token });
  assert.equal(resumed.outcome, "needs_human");
  assert.match(resumed.reason || "", /Enter Verification code/);
  for (const request of [{ id: doc.id, rerun: true }, { resume: token }]) {
    writeResume();
    const fresh = await runWorkflow(library, { ...request, inputs: { code: "654321" } });
    assert.equal(fresh.outcome, "needs_human");
    assert.match(fresh.reason || "", /Choose Attachment/);
  }
  assert.deepEqual(library.readPublicInputs(doc.id), { code: "234567", query: "Ada" });
  assert.equal(library.read(doc.id).inputs.find((input) => input.name === "code")?.default, "123456");
  assert.equal(existsSync(path.join(library.root, "chrome-profile")), false);
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

for (const replaceOnResume of [false, true]) {
  test(`a live MCP run retains fresh OTP input across repeated pauses${replaceOnResume ? " and accepts a replacement" : ""}`, { timeout: 60_000 }, async (t) => {
    const home = mkdtempSync(path.join(tmpdir(), "bao-otp-live-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const library = new Library(home);
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end('<!doctype html><p id="status">Waiting</p><button onclick="document.getElementById(\'status\').textContent = \'Signed in\'">Sign in</button><input id="code" aria-label="Verification code" autocomplete="one-time-code">');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let token = "";
    try {
      const doc: WorkflowV2 = {
        schema: "bao.workflow/v2", version: 2, id: "otp-live", name: "Live OTP", createdAt: 1,
        startUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
        inputs: [{ name: "code", type: "text", label: "Verification code", default: "123456" }],
        steps: [
          {
            id: "signin", index: 0, action: "login", label: "Sign in", surface: "dom", timeoutMs: 5000,
            postcondition: { kind: "text", match: "Signed in", timeoutMs: 5000 },
          },
          {
            id: "code", index: 1, action: "type", label: "Verification code", surface: "dom", timeoutMs: 5000,
            input: "code", value: "{{code}}",
            identity: { surface: "dom", role: "textbox", id: "code", autocomplete: "one-time-code", path: [] },
            postcondition: { kind: "value", match: "{{code}}", timeoutMs: 5000 },
          },
        ],
      };
      library.save(doc);
      const first = await runWorkflow(library, { id: doc.id, inputs: { code: "654321" } });
      token = first.resume_token || "";
      assert.equal(first.outcome, "needs_signin", first.reason);
      assert.ok(token);
      const again = await runWorkflow(library, {
        resume: token, ...(replaceOnResume ? { inputs: { code: "765432" } } : {}),
      });
      assert.equal(again.outcome, "needs_signin", again.reason);
      assert.equal(again.runId, first.runId);
      assert.equal(again.resume_token, token);
      await withHeldPage(token, async (page) => {
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
      });
      const done = await runWorkflow(library, { resume: token });
      assert.equal(done.outcome, "ok", done.reason);
      assert.equal(done.status, "completed");
      assert.equal(done.runId, first.runId);
      token = "";
      assert.equal(library.readRun(done.runId!).inputs?.code, replaceOnResume ? "765432" : "654321");
      assert.equal(library.read(doc.id).inputs[0]?.default, "123456");
    } finally {
      if (token) await runWorkflow(library, { resume: token, cancel: true }).catch(() => undefined);
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
}

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
