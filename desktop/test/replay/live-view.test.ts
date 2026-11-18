import { testWorkflow } from "../support/workflow";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Route } from "playwright";
import { liveRunView } from "../../src/app/live-view";
import { startApp } from "../../src/app/server";
import type { ActiveRun, RunSummary, ShellState } from "../../src/app/views";
import { testChromium } from "../../src/test-browser";
import { makeAsk } from "../../src/v1/human-ask";
import { readPendingPrompt, writePendingPrompt } from "../../src/v1/pending-prompt";
import type { WorkflowV2 } from "../../src/v1/schema";
import { blankPng } from "../../src/v1/redacted-png";
import { saveRelay } from "../../src/v1/relay-link";
import { MemoryJobStore } from "../../../web/src/lib/relay-job";
import { createRelay, listenRelay, MemoryDirectory } from "../../../web/src/lib/relay";
import { applyHermeticApp, scaledMs } from "../runtime";

function workflow(startUrl: string): WorkflowV2 {
  return testWorkflow({
    schema: "bao.workflow/v4", id: "wf-live-detail", name: "Book a class",
    startUrl, createdAt: 1, inputs: [],
    steps: [
      {
        id: "open",
        index: 0,
        timeoutMs: 1000,
        caption: { text: "Open the schedule", citation: { text: "Apply", source: "name" } },
        action: "click",
        target: {
          locators: [{ kind: "role", role: "button", name: "Apply" }, { kind: "text", value: "Apply" }],
          hint: { role: "button", surface: "dom" },
        },
      },
      {
        id: "reserve",
        index: 1,
        timeoutMs: 60000,
        caption: { text: "Press Reserve" },
        action: "handoff",
        reason: "owner-press",
        check: { kind: "text", match: "Booked", timeoutMs: 60000 },
      },
      {
        id: "check",
        index: 2,
        timeoutMs: 1000,
        caption: { text: "Check the booking" },
        action: "verify",
        check: { kind: "text", match: "Booked", timeoutMs: 1000 },
      },
    ],
  });
}

function waiting(prompt: ReturnType<typeof makeAsk>): ActiveRun {
  return { id: prompt.runId!, workflowId: prompt.workflowId, startedAt: prompt.startedAt, phase: "waiting", ask: prompt };
}

async function stop(base: string): Promise<void> {
  const state = await (await fetch(`${base}/api/state`)).json() as ShellState;
  if (state.activeRun) await post(`${base}/api/replay/cancel`, { runId: state.activeRun.id });
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
    await page.setContent(liveRunView(waiting(prompt), run, wf, 1000));
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
    await page.setContent(liveRunView(waiting({ ...prompt, kind: "login", deadline: null }), { ...run, steps: [] }, wf, 1000));
    assert.equal(await page.locator(".live-preview img").count(), 0);
    assert.equal(await page.locator(".live-no-shot").innerText(), "No screen captured yet.");
    assert.equal(await page.locator("#live-film li").count(), 0);
    assert.equal(await page.getByRole("button", { name: "I’m signed in, continue" }).count(), 1);
    assert.match(await page.getByRole("timer").innerText(), /no timeout/);
    assert.equal(await page.locator('#live-steps [data-status="passed"]').count(), 0, "missing earlier results must not claim success");
    await page.setContent(liveRunView(waiting({ ...prompt, kind: "wall" }), null, null));
    assert.equal(await page.getByRole("button", { name: "Continue", exact: true }).count(), 1);
    assert.match(await page.locator("#live-steps").innerText(), /unavailable/);
    await page.setContent(liveRunView({ id: "run-unsaved", workflowId: wf.id, startedAt: 1000, phase: "running", ask: null }, null, wf, 1000));
    assert.match(await page.locator(".live-state").innerText(), /Running/);
    assert.equal(await page.getByRole("button", { name: "Continuing" }).count(), 0);
    assert.equal(await page.getByText("Bao is continuing this run").count(), 0);
    assert.equal(await page.getByText("Not yet").count(), 0);
    assert.equal(await page.getByText("No screen captured yet.").count(), 0);
    assert.equal(await page.getByText("No screens captured yet.").count(), 0);
    assert.equal(await page.getByText("Steps appear when the run pauses or ends.").count(), 1);
    assert.equal(await page.getByText("Screens appear when the run pauses or ends.").count(), 2);
    assert.equal(await page.locator("#live-stop-dialog button[value=cancel]").innerText(), "Keep running");
    await page.setContent(liveRunView({ id: "run-detail", workflowId: wf.id, startedAt: 1000, phase: "running", ask: prompt }, run, wf, 1000));
    assert.equal(await page.getByRole("button", { name: "Continuing" }).count(), 1);
    assert.equal(await page.locator("#live-stop-dialog button[value=cancel]").innerText(), "Keep waiting");
  } finally { await browser.close(); }
});

test("Runs opens its exact active handoff, keeps progress stable, and confirms Stop", { timeout: scaledMs(60000) }, async () => {
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
    assert.equal(await page.locator("#live-run").getAttribute("aria-label"), "Run: Book a class");
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
    assert.deepEqual(continuationRequests, ["POST"], "a confirmation check carries the server run id");
    assert.equal((await (await fetch(`${base}/api/state`)).json() as ShellState).activeAsk?.kind, "confirm");
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

test("a returned-paused confirm does not block the next Run", { timeout: scaledMs(60000) }, async () => {
  const dirs = applyHermeticApp("paused-rerun");
  const app = await startApp({ home: dirs.home, port: 0 });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const wf = workflow(`${base}/fixture`);
    wf.steps = [
      {
        id: "reserve",
        index: 0,
        timeoutMs: 60000,
        caption: { text: "Press Reserve" },
        action: "handoff",
        reason: "owner-press",
      },
    ];
    app.library.save(wf);
    const first = await post(`${base}/api/replay`, { id: wf.id, args: {} });
    assert.equal(first.status, "paused");
    const ended = await (await fetch(`${base}/api/state`)).json() as ShellState;
    assert.equal(ended.replaying, false);
    assert.equal(ended.activeRun?.phase, "waiting");
    assert.equal(ended.activeRun?.id, first.runId);
    assert.equal(readPendingPrompt(dirs.home)?.runId, first.runId, "returning paused must keep its pending prompt");
    const second = await post(`${base}/api/replay`, { id: wf.id, args: {} });
    assert.equal(second.status, "paused");
    assert.notEqual(second.runId, first.runId, "Run again must start a new replay, not refuse the ended handoff");
    assert.equal(app.library.readRun(first.runId).status, "needs_human");
    assert.equal(readPendingPrompt(dirs.home)?.runId, second.runId);
  } finally {
    await stop(base).catch(() => undefined);
    await app.close();
    rmSync(dirs.home, { recursive: true, force: true });
  }
});

test("a relay extension run leaves a waiting local run controllable", { timeout: scaledMs(60000) }, async () => {
  const dirs = applyHermeticApp("overlap");
  const directory = new MemoryDirectory();
  directory.addDevice("overlap-device", "overlap-user");
  const app = await startApp({ home: dirs.home, port: 0, extensionHost: true, extensionConfigHome: path.join(dirs.home, "host-config") });
  const relay = await listenRelay(createRelay({ store: new MemoryJobStore(), directory, enabled: () => true }), { principal: () => ({ userId: "overlap-user" }) });
  const browser = await testChromium.launch();
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${app.port}`;
  let replay: ReturnType<typeof post> | undefined;
  let relayRun: Promise<Record<string, unknown>> | undefined;
  let releaseOpen!: () => void;
  const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
  let opened!: () => void;
  const opening = new Promise<void>((resolve) => { opened = resolve; });
  async function relayPost(route: string, body: unknown, token?: string): Promise<Record<string, unknown>> {
    const response = await fetch(`${relay.origin}${route}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const result = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  }
  try {
    assert.ok(app.extensionLink);
    app.extensionLink.connected = () => true;
    app.extensionLink.command = async (op) => {
      if (op === "open") { opened(); await openGate; }
      return {};
    };
    const wf = workflow(`${base}/fixture`);
    wf.steps = [
      {
        id: "login-first",
        index: 0,
        timeoutMs: 60000,
        caption: { text: "Sign in first" },
        action: "handoff",
        reason: "sign-in",
      },
      {
        id: "login-next",
        index: 1,
        timeoutMs: 60000,
        caption: { text: "Sign in next" },
        action: "handoff",
        reason: "sign-in",
      },
    ];
    app.library.save(wf);
    app.library.save(testWorkflow({ ...wf, id: "relay-note", name: "Relay overlap", driver: "extension", steps: [
      {
        id: "note",
        index: 0,
        timeoutMs: 1000,
        caption: { text: "Relay overlap" },
        action: "note",
        text: "Relay overlap",
      },
    ] }));
    const issued = await relayPost("/api/agent/pair", {});
    const paired = await relayPost("/api/agent/pair/claim", { code: issued.code, name: "Overlap Mac", deviceId: "overlap-device" });
    const agent = await directory.mintAgent("overlap-user", "overlap-device");
    assert.ok(agent);
    saveRelay(dirs.home, { server: relay.origin, token: String(paired.token), tokenId: String(paired.tokenId), deviceId: String(paired.deviceId) });
    app.library.updateSettings({ remoteMcp: true });
    async function tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const body = await relayPost("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, agent!.token);
      const result = body.result as { content?: { type: string; text?: string }[] };
      const text = result.content?.find((item) => item.type === "text")?.text;
      assert.ok(text, JSON.stringify(body));
      return JSON.parse(text) as Record<string, unknown>;
    }
    let online = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if ((await tool("search_workflows", { query: "Relay overlap" })).outcome === "ok") { online = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(online);
    replay = post(`${base}/api/replay`, { id: wf.id, args: {} });
    await page.goto(`${base}/?screen=live`);
    await page.getByRole("button", { name: "I’m signed in, continue" }).waitFor();
    const before = (await (await fetch(`${base}/api/state`)).json() as ShellState).activeRun!;
    relayRun = tool("run_workflow", { id: "relay-note" });
    await opening;
    const during = await (await fetch(`${base}/api/state`)).json() as ShellState;
    assert.deepEqual(during.activeRun, before, "relay start must preserve the local handoff identity");
    assert.equal(during.replaying, true);
    releaseOpen();
    const relayResult = await relayRun;
    assert.equal(relayResult.outcome, "ok", JSON.stringify(relayResult));
    await page.getByRole("button", { name: "Open workflow", exact: true }).click();
    await page.locator(`#workflow-detail [data-screen="replay"][data-workflow="${wf.id}"]`).click();
    await page.locator("#wf").selectOption(wf.id);
    await page.locator("#run").click();
    await page.waitForFunction(() => document.getElementById("live")?.textContent === "Another run is waiting for you. Finish or stop it first.");
    await page.goto(`${base}/?screen=live`);
    await page.getByRole("button", { name: "I’m signed in, continue" }).waitFor();
    assert.equal(await page.locator("#live-run").getAttribute("data-run"), before.id);
    await page.getByRole("button", { name: "Stop run…" }).click();
    await page.getByRole("button", { name: "Keep waiting" }).click();
    await page.getByRole("button", { name: "I’m signed in, continue" }).click();
    await page.waitForFunction(() => document.getElementById("live-run")?.dataset.step?.includes(":login-next:"));
    await page.getByRole("button", { name: "Stop run…" }).click();
    await page.getByRole("button", { name: "Stop run", exact: true }).click();
    assert.notEqual((await replay).status, "passed", "Stop must still stop the waiting local run");
  } finally {
    releaseOpen();
    await relayRun?.catch(() => undefined);
    await stop(base).catch(() => undefined);
    await replay?.catch(() => undefined);
    await browser.close();
    await app.close();
    await relay.close();
    rmSync(dirs.home, { recursive: true, force: true });
  }
});

test("a relay clear does not remove a local hold or its pending prompt", { timeout: scaledMs(60000) }, async () => {
  const dirs = applyHermeticApp("rclr");
  const directory = new MemoryDirectory();
  directory.addDevice("clear-hold-device", "clear-hold-user");
  const app = await startApp({
    home: dirs.home,
    port: 0,
    extensionHost: true,
    extensionConfigHome: path.join(dirs.home, "host-config"),
    chromeProfilesRoot: path.join(dirs.home, "profiles"),
  });
  const relay = await listenRelay(createRelay({ store: new MemoryJobStore(), directory, enabled: () => true }), { principal: () => ({ userId: "clear-hold-user" }) });
  const base = `http://127.0.0.1:${app.port}`;
  let replay: ReturnType<typeof post> | undefined;
  let relayRun: Promise<Record<string, unknown>> | undefined;
  async function relayPost(route: string, body: unknown, token?: string): Promise<Record<string, unknown>> {
    const response = await fetch(`${relay.origin}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const result = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  }
  try {
    assert.ok(app.extensionLink);
    app.extensionLink.connected = () => true;
    app.extensionLink.command = async () => ({ nodes: [], texts: [], url: "https://example.test/login" });
    const wf = workflow(`${base}/fixture`);
    wf.steps = [
      { id: "login", index: 0, timeoutMs: 60000, caption: { text: "Sign in" }, action: "handoff", reason: "sign-in" },
    ];
    app.library.save(wf);
    app.library.save({
      ...wf,
      id: "relay-login",
      name: "Relay login",
      driver: "extension",
      steps: [{
        id: "login",
        index: 0,
        timeoutMs: 1000,
        caption: { text: "Relay sign in" },
        action: "handoff",
        reason: "sign-in",
      }],
    });
    const issued = await relayPost("/api/agent/pair", {});
    const paired = await relayPost("/api/agent/pair/claim", { code: issued.code, name: "Clear-hold Mac", deviceId: "clear-hold-device" });
    const agent = await directory.mintAgent("clear-hold-user", "clear-hold-device");
    assert.ok(agent);
    saveRelay(dirs.home, { server: relay.origin, token: String(paired.token), tokenId: String(paired.tokenId), deviceId: String(paired.deviceId) });
    app.library.updateSettings({ remoteMcp: true });
    async function tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const body = await relayPost("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, agent!.token);
      const result = body.result as { content?: { type: string; text?: string }[] };
      const text = result.content?.find((item) => item.type === "text")?.text;
      assert.ok(text, JSON.stringify(body));
      return JSON.parse(text) as Record<string, unknown>;
    }
    let online = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if ((await tool("search_workflows", { query: "Relay login" })).outcome === "ok") { online = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(online);
    replay = post(`${base}/api/replay`, { id: wf.id, args: {} });
    let localId = "";
    for (let attempt = 0; attempt < 80; attempt++) {
      const state = await (await fetch(`${base}/api/state`)).json() as ShellState;
      if (state.activeRun?.phase === "waiting" && state.activeRun.id && readPendingPrompt(dirs.home)?.runId === state.activeRun.id) {
        localId = state.activeRun.id;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(localId);
    app.library.updateSettings({ actTimeoutMs: 400 });
    relayRun = tool("run_workflow", { id: "relay-login" });
    const relayResult = await relayRun;
    assert.notEqual(relayResult.outcome, "ok", JSON.stringify(relayResult));
    const after = await (await fetch(`${base}/api/state`)).json() as ShellState;
    assert.equal(after.activeRun?.id, localId);
    assert.equal(after.activeRun?.phase, "waiting");
    assert.equal(after.replaying, true);
    assert.equal(after.runExecuting, true);
    assert.equal(after.activeAsk?.runId, localId);
    assert.equal(readPendingPrompt(dirs.home)?.runId, localId);
  } finally {
    await relayRun?.catch(() => undefined);
    await stop(base).catch(() => undefined);
    await replay?.catch(() => undefined);
    await app.close();
    await relay.close();
    rmSync(dirs.home, { recursive: true, force: true });
  }
});

test("a passed extension rerun drops the earlier host-grant hold", { timeout: scaledMs(60000) }, async () => {
  const dirs = applyHermeticApp("grant");
  const app = await startApp({
    home: dirs.home,
    port: 0,
    extensionHost: true,
    extensionConfigHome: path.join(dirs.home, "host-config"),
    chromeProfilesRoot: path.join(dirs.home, "profiles"),
  });
  const base = `http://127.0.0.1:${app.port}`;
  let opens = 0;
  try {
    assert.ok(app.extensionLink);
    app.extensionLink.connected = () => true;
    app.extensionLink.command = async (op) => {
      if (op === "open") {
        opens += 1;
        if (opens === 1) return { needsHuman: true, pattern: "https://example.test/*" };
      }
      return { nodes: [], texts: [], url: "https://example.test/" };
    };
    const wf = workflow(`${base}/fixture`);
    wf.driver = "extension";
    wf.steps = [{ id: "note", index: 0, timeoutMs: 1000, caption: { text: "Note" }, action: "note", text: "Note" }];
    app.library.save(wf);
    const first = await post(`${base}/api/replay`, { id: wf.id, args: {} });
    assert.equal(first.status, "needs_human");
    const held = await (await fetch(`${base}/api/state`)).json() as ShellState;
    assert.equal(held.activeRun?.id, first.runId);
    assert.equal(held.activeRun?.phase, "waiting");
    assert.equal(held.activeAsk?.kind, "wall");
    assert.equal(readPendingPrompt(dirs.home)?.runId, first.runId);
    const second = await post(`${base}/api/replay`, { id: wf.id, args: {} });
    assert.equal(second.status, "passed");
    assert.notEqual(second.runId, first.runId);
    const after = await (await fetch(`${base}/api/state`)).json() as ShellState;
    assert.equal(after.activeRun, null);
    assert.equal(after.activeAsk, null);
    assert.equal(readPendingPrompt(dirs.home), null);
  } finally {
    await stop(base).catch(() => undefined);
    await app.close();
    rmSync(dirs.home, { recursive: true, force: true });
  }
});

test("Guide me during an owned wait says the run is waiting", { timeout: scaledMs(60000) }, async () => {
  const dirs = applyHermeticApp("gwait");
  const app = await startApp({
    home: dirs.home,
    port: 0,
    extensionHost: true,
    extensionConfigHome: path.join(dirs.home, "host-config"),
    chromeProfilesRoot: path.join(dirs.home, "profiles"),
  });
  const base = `http://127.0.0.1:${app.port}`;
  let replay: ReturnType<typeof post> | undefined;
  try {
    assert.ok(app.extensionLink);
    app.extensionLink.connected = () => true;
    app.extensionLink.command = async () => ({ nodes: [], texts: [], url: "https://example.test/login" });
    const wf = workflow(`${base}/fixture`);
    wf.driver = "extension";
    wf.steps = [{ id: "login", index: 0, timeoutMs: 60000, caption: { text: "Sign in" }, action: "handoff", reason: "sign-in" }];
    app.library.save(wf);
    replay = post(`${base}/api/replay`, { id: wf.id, args: {} });
    let owned = "";
    for (let attempt = 0; attempt < 80; attempt++) {
      const state = await (await fetch(`${base}/api/state`)).json() as ShellState;
      if (state.activeRun?.phase === "waiting" && state.replaying && state.runExecuting && state.activeRun.id) {
        owned = state.activeRun.id;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(owned);
    const refused = await fetch(`${base}/api/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: wf.id, args: {}, guide: true }),
    });
    const body = await refused.json() as { error?: string };
    assert.equal(refused.status, 409);
    assert.equal(body.error, "Another run is waiting for you. Finish or stop it first.");
    const after = await (await fetch(`${base}/api/state`)).json() as ShellState;
    assert.equal(after.activeRun?.id, owned);
    assert.equal(after.activeRun?.phase, "waiting");
    assert.equal(after.replaying, true);
    assert.equal(after.runExecuting, true);
  } finally {
    await stop(base).catch(() => undefined);
    await replay?.catch(() => undefined);
    await app.close();
    rmSync(dirs.home, { recursive: true, force: true });
  }
});

test("a refused Guide me shows the owned-wait sentence on screen", { timeout: scaledMs(60000) }, async () => {
  const dirs = applyHermeticApp("gvis");
  const app = await startApp({
    home: dirs.home,
    port: 0,
    extensionHost: true,
    extensionConfigHome: path.join(dirs.home, "host-config"),
    chromeProfilesRoot: path.join(dirs.home, "profiles"),
  });
  const browser = await testChromium.launch();
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${app.port}`;
  let replay: ReturnType<typeof post> | undefined;
  try {
    assert.ok(app.extensionLink);
    app.extensionLink.connected = () => true;
    app.extensionLink.command = async () => ({ nodes: [], texts: [], url: "https://example.test/login" });
    const wf = workflow(`${base}/fixture`);
    wf.driver = "extension";
    wf.steps = [{ id: "login", index: 0, timeoutMs: 60000, caption: { text: "Sign in" }, action: "handoff", reason: "sign-in" }];
    app.library.save(wf);
    replay = post(`${base}/api/replay`, { id: wf.id, args: {} });
    let owned = "";
    for (let attempt = 0; attempt < 80; attempt++) {
      const state = await (await fetch(`${base}/api/state`)).json() as ShellState;
      if (state.activeRun?.phase === "waiting" && state.replaying && state.runExecuting && state.activeRun.id) {
        owned = state.activeRun.id;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(owned);
    await page.goto(`${base}/?screen=live`);
    await page.getByRole("button", { name: "Open workflow", exact: true }).click();
    await page.getByRole("button", { name: "Guide me", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("live")?.textContent === "Another run is waiting for you. Finish or stop it first.");
    await page.getByRole("button", { name: "Workflows", exact: true }).click();
    await page.getByRole("button", { name: "Book a class", exact: true }).click();
    await page.getByRole("button", { name: "Run…", exact: true }).click();
    await page.locator("#run").waitFor();
    assert.notEqual(await page.locator("#live").textContent(), "Another run is waiting for you. Finish or stop it first.");
    const after = await (await fetch(`${base}/api/state`)).json() as ShellState;
    assert.equal(after.activeRun?.id, owned);
    assert.equal(after.activeRun?.phase, "waiting");
    assert.equal(after.replaying, true);
    assert.equal(after.runExecuting, true);
  } finally {
    await stop(base).catch(() => undefined);
    await replay?.catch(() => undefined);
    await browser.close();
    await app.close();
    rmSync(dirs.home, { recursive: true, force: true });
  }
});

test("a refused Guide me shows the still-going sentence on screen", { timeout: scaledMs(60000) }, async () => {
  const dirs = applyHermeticApp("gstl");
  const app = await startApp({
    home: dirs.home,
    port: 0,
    extensionHost: true,
    extensionConfigHome: path.join(dirs.home, "host-config"),
    chromeProfilesRoot: path.join(dirs.home, "profiles"),
  });
  const browser = await testChromium.launch();
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${app.port}`;
  let releaseRun!: () => void;
  const held = new Promise<void>((resolve) => { releaseRun = resolve; });
  let replay: ReturnType<typeof post> | undefined;
  try {
    assert.ok(app.extensionLink);
    app.extensionLink.connected = () => true;
    app.extensionLink.command = async () => {
      await held;
      return { nodes: [], texts: [], url: "https://example.test/" };
    };
    const wf = workflow(`${base}/fixture`);
    wf.driver = "extension";
    wf.steps = [{ id: "note", index: 0, timeoutMs: 60000, caption: { text: "Note" }, action: "note", text: "Note" }];
    app.library.save(wf);
    replay = post(`${base}/api/replay`, { id: wf.id, args: {} });
    let owned = "";
    for (let attempt = 0; attempt < 80; attempt++) {
      const state = await (await fetch(`${base}/api/state`)).json() as ShellState;
      if (state.activeRun?.phase === "running" && state.replaying && state.runExecuting && state.activeRun.id) {
        owned = state.activeRun.id;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(owned);
    await page.goto(base);
    await page.getByRole("button", { name: "Workflows", exact: true }).click();
    await page.getByRole("button", { name: "Book a class", exact: true }).click();
    await page.getByRole("button", { name: "Guide me", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("live")?.textContent === "Another run is still going. Finish or stop it first.");
    const after = await (await fetch(`${base}/api/state`)).json() as ShellState;
    assert.equal(after.activeRun?.id, owned);
    assert.equal(after.activeRun?.phase, "running");
    assert.equal(after.replaying, true);
    assert.equal(after.runExecuting, true);
  } finally {
    releaseRun();
    await stop(base).catch(() => undefined);
    await replay?.catch(() => undefined);
    await browser.close();
    await app.close();
    rmSync(dirs.home, { recursive: true, force: true });
  }
});

test("a closed guide window does not open the Run form", { timeout: scaledMs(60000) }, async () => {
  const dirs = applyHermeticApp("gcls");
  const app = await startApp({ home: dirs.home, port: 0 });
  const browser = await testChromium.launch();
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${app.port}`;
  let releaseGuide!: () => void;
  const held = new Promise<void>((resolve) => { releaseGuide = resolve; });
  let guided = false;
  try {
    app.library.save(workflow(`${base}/fixture`));
    await page.route("**/api/replay", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const body = route.request().postDataJSON() as { guide?: boolean };
      if (!body?.guide) return route.continue();
      guided = true;
      await held;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Target page, context or browser has been closed" }),
      });
    });
    await page.goto(base);
    await page.getByRole("button", { name: "Workflows", exact: true }).click();
    await page.getByRole("button", { name: "Book a class", exact: true }).click();
    await page.getByRole("button", { name: "Guide me", exact: true }).click();
    for (let attempt = 0; attempt < 50 && !guided; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(guided, true);
    await page.locator('#rail button[data-place="runs"]').click();
    const closed = page.waitForResponse((response) => response.url().includes("/api/replay") && response.status() === 500);
    releaseGuide();
    await closed;
    await page.waitForResponse((response) => response.url().includes("/api/state") && response.request().method() === "GET");
    assert.equal(await page.locator("#run").count(), 0);
    assert.equal(await page.locator("#main").innerText().then((text) => text.includes("Target page, context or browser has been closed")), false);
    assert.equal(await page.locator("#rail button[data-place=\"runs\"]").getAttribute("aria-current"), "page");
  } finally {
    releaseGuide();
    await browser.close();
    await app.close();
    rmSync(dirs.home, { recursive: true, force: true });
  }
});

test("delayed R1 Stop and Continue cannot act on R2 before the client polls", { timeout: scaledMs(60000) }, async () => {
  const dirs = applyHermeticApp("live-run-identity");
  process.env.BAO_DRIVE = "1";
  const app = await startApp({ home: dirs.home, port: 0 });
  const browser = await testChromium.launch();
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${app.port}`;
  let replay: Promise<{ status: string; runId: string }> | undefined;
  try {
    const wf = workflow(`${base}/fixture`);
    wf.steps = [
      {
        id: "login",
        index: 0,
        timeoutMs: 60000,
        caption: { text: "Sign in" },
        action: "handoff",
        reason: "sign-in",
        check: { kind: "text", match: "Owner signed in", timeoutMs: 60000 },
      },
      {
        id: "finish",
        index: 1,
        timeoutMs: 60000,
        caption: { text: "Check the final note" },
        action: "verify",
        check: { kind: "text", match: "Finish the run", timeoutMs: 60000 },
      },
    ];
    app.library.save(wf);
    replay = post(`${base}/api/replay`, { id: wf.id, args: {} });
    await page.goto(`${base}/?screen=live`);
    await page.getByRole("button", { name: "I’m signed in, continue" }).waitFor();
    const r1 = (await (await fetch(`${base}/api/state`)).json() as ShellState).activeRun!;
    const heldPolls: Route[] = [];
    await page.route("**/api/state", (route) => { heldPolls.push(route); });
    let holdStop!: (route: Route) => void;
    let holdContinue!: (route: Route) => void;
    const heldStop = new Promise<Route>((resolve) => { holdStop = resolve; });
    const heldContinue = new Promise<Route>((resolve) => { holdContinue = resolve; });
    await page.route("**/api/replay/cancel", (route) => holdStop(route));
    await page.route("**/api/prompt/continue", (route) => holdContinue(route));
    await page.getByRole("button", { name: "Stop run…" }).click();
    await page.getByRole("button", { name: "Stop run", exact: true }).click();
    const staleStop = await heldStop;
    await page.getByRole("button", { name: "I’m signed in, continue" }).click();
    const staleContinue = await heldContinue;
    const r1Action = { runId: r1.id, stepId: r1.ask!.stepId, startedAt: r1.ask!.startedAt };
    assert.deepEqual(staleStop.request().postDataJSON(), { runId: r1.id });
    assert.deepEqual(staleContinue.request().postDataJSON(), r1Action);
    await post(`${base}/api/prompt/continue`, r1Action);
    await post(`${base}/api/replay/press`, { fill: { selector: "#note-input", value: "Finish the run" }, name: "Save note" });
    assert.equal((await replay).status, "passed");
    replay = post(`${base}/api/replay`, { id: wf.id, args: {} });
    let r2: ActiveRun | null | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      r2 = (await (await fetch(`${base}/api/state`)).json() as ShellState).activeRun;
      if (r2?.id !== r1.id && r2?.phase === "waiting") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(r2);
    assert.equal(await page.locator("#live-run").getAttribute("data-run"), r1.id, "the client has not polled R2");
    assert.notEqual(r2.id, r1.id);
    assert.equal(r2.phase, "waiting");
    await Promise.all([staleStop.continue(), staleContinue.continue()]);
    assert.equal((await staleStop.request().response())?.status(), 409);
    assert.equal((await staleContinue.request().response())?.status(), 409);
    for (const endpoint of ["/api/replay/cancel", "/api/prompt/continue"]) {
      assert.equal((await fetch(`${base}${endpoint}`, { method: "POST" })).status, 409, "an unscoped action cannot affect R2 either");
    }
    await page.unroute("**/api/state");
    await Promise.all(heldPolls.map((route) => route.continue()));
    await page.waitForResponse((response) => response.url() === `${base}/api/state`);
    const unchanged = await (await fetch(`${base}/api/state`)).json() as ShellState;
    assert.equal(unchanged.activeRun?.id, r2.id);
    assert.equal(unchanged.activeRun?.phase, "waiting");
    assert.equal(unchanged.activeAsk?.kind, "login");
    assert.equal(unchanged.replaying, true);
    await stop(base);
    assert.equal((await replay).status, "failed");
  } finally {
    await stop(base).catch(() => undefined);
    await replay?.catch(() => undefined);
    await browser.close(); await app.close();
    delete process.env.BAO_DRIVE;
    rmSync(dirs.home, { recursive: true, force: true });
  }
});

test("a continuing run row opens live detail after navigation and reload, until its final receipt", { timeout: scaledMs(60000) }, async () => {
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
      {
        id: "reserve",
        index: 0,
        timeoutMs: 60000,
        caption: { text: "Press \"Apply\"" },
        action: "handoff",
        reason: "owner-press",
        check: { kind: "text", match: "Applied", timeoutMs: 60000 },
      },
      {
        id: "working",
        index: 1,
        timeoutMs: 60000,
        caption: { text: "Wait for the note" },
        action: "verify",
        check: { kind: "text", match: "Go to login", timeoutMs: 60000 },
      },
      {
        id: "login",
        index: 2,
        timeoutMs: 60000,
        caption: { text: "Sign in" },
        action: "handoff",
        reason: "sign-in",
        check: { kind: "text", match: "Owner signed in", timeoutMs: 60000 },
      },
      {
        id: "finish",
        index: 3,
        timeoutMs: 60000,
        caption: { text: "Check the final note" },
        action: "verify",
        check: { kind: "text", match: "Finish the run", timeoutMs: 60000 },
      },
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
    await page.locator(`#runs [data-open-run="${runId}"][aria-current="true"]`).click();
    await page.waitForSelector("#live-run");
    assert.equal(await page.locator("#run-receipt").count(), 0);
    await page.getByRole("button", { name: "Open workflow", exact: true }).click();
    await page.waitForSelector("#workflow-detail");
    await page.locator('#rail button[data-place="runs"]').click();
    await page.locator(`#runs [data-open-run="${runId}"]`).click();
    await page.waitForSelector("#live-run");
    await page.reload();
    await page.waitForFunction(() => document.getElementById("live-action-status")?.textContent === "Bao is continuing this run");
    assert.equal(await page.locator("#live-run").getAttribute("data-run"), runId);
    assert.equal(await page.locator("#live-session, #run-receipt").count(), 0);
    assert.equal(await page.getByText("Historical unrelated task").count(), 0);
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
    await stop(base).catch(() => undefined);
    await replay?.catch(() => undefined);
    await browser.close(); await app.close();
    delete process.env.BAO_DRIVE;
    rmSync(dirs.home, { recursive: true, force: true });
  }
});

test("the Needs-you row becomes Running as soon as its server run continues", { timeout: scaledMs(60000) }, async () => {
  const dirs = applyHermeticApp("live-row-phase");
  process.env.BAO_DRIVE = "1";
  const app = await startApp({ home: dirs.home, port: 0 });
  const browser = await testChromium.launch();
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${app.port}`;
  let replay: Promise<{ status: string; runId: string }> | undefined;
  try {
    const wf = workflow(`${base}/fixture`);
    wf.steps = [
      {
        id: "reserve",
        index: 0,
        timeoutMs: 60000,
        caption: { text: "Press \"Apply\"" },
        action: "handoff",
        reason: "owner-press",
        check: { kind: "text", match: "Applied", timeoutMs: 60000 },
      },
      {
        id: "finish",
        index: 1,
        timeoutMs: 60000,
        caption: { text: "Check the final note" },
        action: "verify",
        check: { kind: "text", match: "Finish the run", timeoutMs: 60000 },
      },
    ];
    app.library.save(wf);
    replay = post(`${base}/api/replay`, { id: wf.id, args: {} });
    await page.goto(base);
    await page.getByRole("button", { name: "I pressed Apply" }).waitFor();
    const runId = (await (await fetch(`${base}/api/state`)).json() as ShellState).activeRun!.id;
    assert.equal(await page.locator(`#runs ul[aria-label="Needs you"] [data-open-run="${runId}"]`).count(), 1);
    await post(`${base}/api/replay/press`, { name: "Apply" });
    await page.waitForFunction(() => document.getElementById("live-action-status")?.textContent === "Bao is continuing this run");
    const state = await (await fetch(`${base}/api/state`)).json() as ShellState;
    assert.equal(state.activeRun?.id, runId);
    assert.equal(state.activeRun?.phase, "running");
    assert.equal(app.library.readRun(runId).status, "needs_human", "the saved pause snapshot is not the live row's source of truth");
    assert.equal(await page.locator(`#runs ul[aria-label="Needs you"] [data-open-run="${runId}"]`).count(), 0);
    assert.equal(await page.locator(`#runs section[aria-label="Now"] [data-open-run="${runId}"] .run-state`).innerText(), "Running");
    assert.equal(await page.locator("#needs-you-heading .run-count").innerText(), "0");
    assert.equal(await page.locator('#rail [data-count]').getAttribute("data-count"), "0");
    await post(`${base}/api/replay/press`, { fill: { selector: "#note-input", value: "Finish the run" }, name: "Save note" });
    assert.equal((await replay).status, "passed");
  } finally {
    await stop(base).catch(() => undefined);
    await replay?.catch(() => undefined);
    await browser.close(); await app.close();
    delete process.env.BAO_DRIVE;
    rmSync(dirs.home, { recursive: true, force: true });
  }
});

test("live confirmation checks the site without pressing its final action", { timeout: scaledMs(60000) }, async () => {
  const dirs = applyHermeticApp("live-handoff");
  let releaseDetails!: () => void;
  const detailsGate = new Promise<void>((resolve) => { releaseDetails = resolve; });
  process.env.BAO_DRIVE = "1";
  const app = await startApp({ home: dirs.home, port: 0 });
  const browser = await testChromium.launch();
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${app.port}`;
  let replay: Promise<{ status: string; runId: string }> | undefined;
  try {
    const wf = workflow(`${base}/fixture`);
    wf.inputs = [{ name: "class", type: "text", label: "class", supply: "must" }];
    wf.steps = [
      {
        id: "open",
        index: 0,
        timeoutMs: 1000,
        caption: { text: "Read the fixture" },
        action: "verify",
        check: { kind: "text", match: "Bao fixture", timeoutMs: 1000 },
      },
      {
        id: "reserve",
        index: 1,
        timeoutMs: 60000,
        caption: { text: "Press \"Apply\"" },
        action: "handoff",
        reason: "owner-press",
        target: {
          locators: [{ kind: "role", role: "button", name: "Apply" }, { kind: "text", value: "Apply" }],
          hint: { role: "button", surface: "dom" },
        },
        check: { kind: "text", match: "Applied", timeoutMs: 60000 },
      },
      {
        id: "login",
        index: 2,
        timeoutMs: 60000,
        caption: { text: "Sign in" },
        action: "handoff",
        reason: "sign-in",
        check: { kind: "text", match: "Owner signed in", timeoutMs: 60000 },
      },
      {
        id: "check",
        index: 3,
        timeoutMs: 1000,
        caption: { text: "Check the result" },
        action: "verify",
        check: { kind: "text", match: "Applied", timeoutMs: 1000 },
      },
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
    await page.route(/\/api\/(workflows|runs)\/[^/]+$/, async (route) => {
      await detailsGate;
      await route.continue();
    });
    await post(`${base}/api/replay/press`, { name: "Apply" });
    await page.waitForResponse(async (response) => response.url() === `${base}/api/state` && ((await response.json()) as ShellState).activeAsk?.kind === "login");
    await page.getByRole("button", { name: "I’m signed in, continue" }).waitFor({ timeout: scaledMs(5000) });
    assert.equal(await page.getByRole("button", { name: "I pressed Apply" }).count(), 0, "the old confirmation control must disappear before delayed detail reads finish");
    releaseDetails();
    await page.unrouteAll({ behavior: "wait" });
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
    await stop(base).catch(() => undefined);
    await replay?.catch(() => undefined);
    releaseDetails();
    await page.unrouteAll({ behavior: "wait" });
    await browser.close(); await app.close();
    delete process.env.BAO_DRIVE;
    rmSync(dirs.home, { recursive: true, force: true });
  }
});
