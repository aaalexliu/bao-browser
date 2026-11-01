// A cloud MCP client runs a saved workflow on one paired Mac.
// The registry is this machine's Next server. Chrome is a throwaway profile.
// Run after `tsc -p tsconfig.desktop.json`. Needs BAO_CHROME_NO_SANDBOX=1.

import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Browser, Page } from "playwright";
import { testChromium as chromium } from "../../src/test-browser.js";
import { startApp, type App } from "../../src/app/server";
import { pinTestBrowser } from "../../src/launch";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { pairDevice } from "../../src/v1/sync";
import { testArtifacts } from "../artifacts";

const PASSWORD = "fixture-pass-value";
const COOKIE = "session=super-secret-cookie";
const ARTIFACTS = testArtifacts("remote-mcp");
const SHOTS = testArtifacts("remote-mcp-screenshots");
const TEST_BROWSER = pinTestBrowser();

let tail: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
  const result = tail.then(run, run);
  tail = result.then(() => undefined, () => undefined);
  return result;
}

test("remote MCP stays closed without BAO_REMOTE_MCP", { timeout: 720_000 }, async () => oneAtATime(async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-remote-off-"));
  const logs: string[] = [];
  const registry = await startRegistry(root, logs, false);
  const origin = registry.origin;
  let app: App | undefined;
  try {
    const health = await fetch(`${origin}/api/health`);
    assert.equal(health.status, 200, await health.text());
    await assertDisabled(origin, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    await assertDisabled(origin, "GET", "/mcp");
    const cookie = await signIn(origin);
    const authed = { cookie, "content-type": "application/json" };
    await assertDisabled(origin, "POST", "/api/agent/tokens", { deviceId: "dev-x", label: "closed" }, authed);
    await assertDisabled(origin, "POST", "/api/agent/tokens/atk-x/revoke", {}, authed);
    await assertDisabled(origin, "GET", "/api/agent/audit", undefined, authed);
    await assertDisabled(origin, "POST", "/api/agent/poll", { waitMs: 1000 }, { authorization: "Bearer not-a-device", "content-type": "application/json" });
    await assertDisabled(origin, "POST", "/api/agent/jobs/job-x/result", { outcome: "ok" }, { authorization: "Bearer not-a-device", "content-type": "application/json" });
    await assertDisabled(origin, "POST", "/api/agent/pair", {}, authed);
    await assertDisabled(origin, "POST", "/api/agent/pair/claim", { code: "ABCD2345" });
    await assertDisabled(origin, "POST", "/api/agent/pair/revoke", {}, { authorization: "Bearer bao_rt_nope", "content-type": "application/json" });
    await assertDisabled(origin, "GET", "/api/agent/relay");
    await assertDisabled(origin, "GET", "/api/agent/jobs/job-x/stream", undefined, { authorization: "Bearer bao_at_nope" });

    const home = path.join(root, "mac");
    const library = new Library(home);
    await pairDevice(library, { code: await pairCode(origin, cookie), server: origin, name: "Mac off", secret: "fixture-invite-secret" });
    assert.notEqual(library.settings().remoteMcp, true);
    app = await startApp({ home });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const state = await uiState(app.port);
    assert.equal(state.remote?.phase || "idle", "idle");
    const page = await fetch(`http://127.0.0.1:${app.port}/`);
    const html = await page.text();
    assert.equal(html.includes("data-testid=\"remote-approval\""), false);
    assert.equal(html.includes("Remote agent running"), false);
  } finally {
    await app?.close().catch(() => undefined);
    await registry.stop();
  }
}));

test("remote MCP runs a workflow on one Mac", { timeout: 720_000 }, async () => oneAtATime(async () => {
  process.env.BAO_CHROME_NO_SANDBOX = "1";
  process.env.BAO_HEAL_CURSOR_ACCOUNT = "0";
  mkdirSync(SHOTS, { recursive: true });
  const root = mkdtempSync(path.join(tmpdir(), "bao-remote-"));
  const evidence: Record<string, unknown> = {};
  const logs: string[] = [];
  let fixture: Awaited<ReturnType<typeof startFixture>> | undefined;
  let appA: App | undefined;
  let appB: App | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let registry: { stop: () => Promise<void> } | undefined;
  try {
  fixture = await startFixture();
  const site = fixture;
  const started = await startRegistry(root, logs, true);
  registry = started;
  const origin = started.origin;
  const cookie = await signIn(origin);
  const homeA = path.join(root, "mac-a");
  const homeB = path.join(root, "mac-b");
  const homeC = path.join(root, "mac-c");
  const libA = new Library(homeA);
  saveWorkflows(libA, site.origin);
  const invite = "fixture-invite-secret";
  await pairDevice(libA, { code: await pairCode(origin, cookie), server: origin, name: "Mac A", secret: invite });
  libA.updateSettings({ remoteMcp: true });
  const libB = new Library(homeB);
  await pairDevice(libB, { code: await pairCode(origin, cookie), server: origin, name: "Mac B", secret: invite });
  libB.updateSettings({ remoteMcp: true });
  const libC = new Library(homeC);
  await pairDevice(libC, { code: await pairCode(origin, cookie), server: origin, name: "Mac C", secret: invite });
  const idA = deviceId(homeA);
  const idB = deviceId(homeB);
  const idC = deviceId(homeC);
  const tokenA = await mint(origin, cookie, idA, "cursor-a");
  const tokenB = await mint(origin, cookie, idB, "cursor-b");
  const tokenC = await mint(origin, cookie, idC, "cursor-c");
  evidence.mcp = redactMcp(tokenA.mcp);
  writeFileSync(path.join(ARTIFACTS, "cursor-mcp.json"), JSON.stringify(evidence.mcp, null, 2));
  const mcpUrl = new URL(tokenA.mcp.mcpServers.bao.url);
  assert.equal(mcpUrl.pathname, "/mcp");
  assert.equal(mcpUrl.port, new URL(origin).port);
  assert.match(tokenA.mcp.mcpServers.bao.headers.Authorization, /^Bearer bao_at_/);

    appA = await startApp({ home: homeA });
    appB = await startApp({ home: homeB });
    browser = await chromium.launch({
      executablePath: TEST_BROWSER,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const videoDir = path.join(root, "video");
    mkdirSync(videoDir, { recursive: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
    });
    page = await context.newPage();
    await page.goto(`http://127.0.0.1:${appA.port}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("#rail", { timeout: 20_000 });

    const method = await fetch(`${origin}/mcp`);
    assert.equal(method.status, 405, await method.text());
    const listed = await rpc(origin, tokenA.token, "tools/list");
    const names = ((listed.body as { result?: { tools?: { name: string }[] } }).result?.tools || []).map((tool) => tool.name);
    assert.deepEqual(names, ["search_workflows", "describe_workflow", "run_workflow", "resume_workflow", "get_run"]);
    await waitOnline(origin, tokenA.token);
    await waitOnline(origin, tokenB.token);

    const searched = await tool(origin, tokenA.token, "search_workflows", { query: "Hello" });
    assert.equal(searched.json.outcome, "ok", JSON.stringify(searched.json));
    assert.ok((searched.json.hits as { id: string }[]).some((hit) => hit.id === "hello-bao"));
    const described = await tool(origin, tokenA.token, "describe_workflow", { id: "hello-bao" });
    assert.equal(described.json.outcome, "ok", JSON.stringify(described.json));
    assert.equal((described.json as { link?: string }).link, "bao://workflow/hello-bao");
    const stateDuringRead = await uiState(appA.port);
    assert.equal(stateDuringRead.remote?.phase, "idle");

    const beforeHello = (await site.state()).hello;
    const runStarted = Date.now();
    const running = tool(origin, tokenA.token, "run_workflow", {
      id: "hello-bao",
      inputs: { password: PASSWORD, cookie: COOKIE },
    });
    await page.waitForSelector("[data-testid=remote-allow]", { timeout: 20_000 });
    await shot(page, "remote-approval.png");
    await page.click("[data-testid=remote-allow]");
    const hello = await running;
    const helloMs = Date.now() - runStarted;
    evidence.helloMs = helloMs;
    assert.equal(hello.json.outcome, "ok", JSON.stringify(hello.json));
    assert.ok(helloMs < 60_000, `run took ${helloMs}ms`);
    assert.equal((await site.state()).hello, beforeHello + 1);
    assert.ok(hello.image.startsWith("iVBORw0KGgo"), "run did not return a png");
    writeFileSync(path.join(SHOTS, "remote-result.png"), Buffer.from(hello.image, "base64"));
    assertClean(JSON.stringify(hello.json));
    await page.close();
    const video = await page.video()?.path();
    if (video) {
      const { copyFileSync } = await import("node:fs");
      copyFileSync(video, path.join(ARTIFACTS, "remote-allow.webm"));
    }
    page = await context.newPage();
    await page.goto(`http://127.0.0.1:${appA.port}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const beforeDeny = (await site.state()).hello;
    const denying = tool(origin, tokenA.token, "run_workflow", {
      id: "hello-bao",
      inputs: { password: PASSWORD, cookie: COOKIE },
    });
    await page.waitForSelector("[data-testid=remote-deny]", { timeout: 20_000 });
    await shot(page, "remote-deny.png");
    await page.click("[data-testid=remote-deny]");
    const denied = await denying;
    assert.equal(denied.json.outcome, "denied", JSON.stringify(denied.json));
    assert.equal((await site.state()).hello, beforeDeny);

    const wall = await allowRun(origin, tokenA.token, page, "bot-wall", "Bot wall");
    assert.equal(wall.json.outcome, "needs_human", JSON.stringify(wall.json));
    assert.equal((wall.json.pageClass as { class?: string } | undefined)?.class, "bot_wall");
    const login = await allowRun(origin, tokenA.token, page, "login-wall", "Login wall");
    assert.equal(login.json.outcome, "needs_human", JSON.stringify(login.json));
    assert.equal((login.json.pageClass as { class?: string } | undefined)?.class, "login_wall");

    const beforePlace = (await site.state()).placed;
    const confirming = allowRun(origin, tokenA.token, page, "place-order", "Place Order");
    await page.waitForSelector("[data-testid=remote-confirm]", { timeout: 30_000 });
    await shot(page, "remote-confirm.png");
    const paused = await confirming;
    assert.equal(paused.json.outcome, "needs_human", JSON.stringify(paused.json));
    const resumeToken = String(paused.json.resume || paused.json.resume_token || "");
    assert.ok(resumeToken, "confirm did not return a resume token");
    const remoteResume = await tool(origin, tokenA.token, "resume_workflow", { resume: resumeToken, approved: true });
    assert.equal(remoteResume.json.outcome, "needs_human", JSON.stringify(remoteResume.json));
    assert.match(String(remoteResume.json.reason || ""), /Mac/);
    assert.equal((await site.state()).placed, beforePlace);
    const approvedText = await page.evaluate(async () => {
      const res = await fetch("/api/remote/confirm", { method: "POST" });
      return await res.text();
    });
    evidence.approve = approvedText;
    const approved = JSON.parse(approvedText) as { outcome?: string; reason?: string };
    assert.equal(approved.outcome, "ok", approvedText);
    assert.equal((await site.state()).placed, beforePlace + 1);

    const killing = allowRun(origin, tokenA.token, page, "slow-bao", "Slow Bao");
    await page.waitForSelector("[data-testid=remote-kill]", { timeout: 20_000 });
    await waitFor(async () => (await site.state()).phase === "working", 20_000, "slow run did not start");
    await shot(page, "remote-running.png");
    await page.click("[data-testid=remote-kill]");
    const killed = await killing;
    evidence.kill = killed.json.outcome;
    assert.equal(killed.json.outcome, "cancelled", JSON.stringify(killed.json));
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal((await site.state()).finished, false);

    const mismatchStarted = Date.now();
    const mismatch = await rpc(origin, tokenA.token, "tools/call", {
      name: "run_workflow",
      arguments: { id: "hello-bao", deviceId: idB, inputs: { password: PASSWORD, cookie: COOKIE } },
    });
    const mismatchMs = Date.now() - mismatchStarted;
    evidence.mismatchMs = mismatchMs;
    assert.equal(mismatch.status, 403, mismatch.text);
    assert.equal((mismatch.body as { error?: string }).error, "device mismatch");
    assert.ok(mismatchMs < 5_000);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const stateB = await uiState(appB.port);
    assert.equal(stateB.remote?.phase || "idle", "idle");

    const revokeStarted = Date.now();
    const revoked = await fetch(`${origin}/api/agent/tokens/${tokenA.id}/revoke`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
    });
    assert.equal(revoked.ok, true, await revoked.text());
    const rejected = await rpc(origin, tokenA.token, "tools/list");
    const revokeMs = Date.now() - revokeStarted;
    evidence.revokeMs = revokeMs;
    assert.equal(rejected.status, 401, rejected.text);
    assert.ok(revokeMs < 5_000, `revoke took ${revokeMs}ms`);

    const offlineStarted = Date.now();
    const offline = await tool(origin, tokenC.token, "search_workflows", { query: "Hello" });
    const offlineMs = Date.now() - offlineStarted;
    evidence.offlineMs = offlineMs;
    assert.equal(offline.json.outcome, "device_offline", JSON.stringify(offline.json));
    assert.ok(offlineMs < 2_000, `offline took ${offlineMs}ms`);
    assert.ok(Number(offline.json.ms) < 2_000);

    const auditRes = await fetch(`${origin}/api/agent/audit`, { headers: { cookie } });
    const audit = await auditRes.json() as { jobs: Record<string, unknown>[] };
    assert.equal(auditRes.ok, true, JSON.stringify(audit));
    const blob = JSON.stringify(audit);
    assertClean(blob);
    const jobs = audit.jobs;
    assert.ok(jobs.length >= 5, `only ${jobs.length} audit rows`);
    for (const job of jobs) {
      assert.match(String(job.token_id), /^atk-/);
      assert.ok(job.device_id);
      assert.ok(job.created_at);
      assert.ok(job.tool);
    }
    const outcomes = jobs.map((job) => String(job.outcome));
    for (const outcome of ["ok", "denied", "needs_human", "cancelled", "forbidden", "device_offline"]) {
      assert.ok(outcomes.includes(outcome), `audit missing ${outcome}: ${outcomes.join(",")}`);
    }
    const forbidden = jobs.filter((job) => job.outcome === "forbidden");
    assert.ok(forbidden.every((job) => job.device_id === idA && job.token_id === tokenA.id));
    assert.equal(jobs.some((job) => job.device_id === idB && job.outcome === "forbidden"), false);
    evidence.auditJobs = jobs.length;
    evidence.outcomes = outcomes;
    writeFileSync(path.join(ARTIFACTS, "remote-mcp-results.json"), JSON.stringify(evidence, null, 2));
  } finally {
    writeFileSync(path.join(ARTIFACTS, "remote-mcp-results.json"), JSON.stringify({ ...evidence, logs: logs.slice(-40) }, null, 2));
    await page?.context().close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await appA?.close().catch(() => undefined);
    await appB?.close().catch(() => undefined);
    await fixture?.close();
    await registry?.stop();
  }
}));

function saveWorkflows(library: Library, origin: string): void {
  library.save(workflow("hello-bao", "Hello Bao", `${origin}/hello`, [
    click("go", 0, "Click Go", "#go", "go", "Go", "Hello Bao", 8000),
  ]));
  library.save(workflow("bot-wall", "Bot wall", `${origin}/wall`, [
    click("checkout", 0, "Click checkout", "#checkout", "checkout", "Checkout", "Paid", 4000),
  ]));
  library.save(workflow("login-wall", "Login wall", `${origin}/app`, [
    click("checkout", 0, "Click checkout", "#checkout", "checkout", "Checkout", "Paid", 4000),
  ]));
  library.save(workflow("place-order", "Place Order", `${origin}/confirm`, [
    click("arm", 0, "Arm the order", "#arm", "arm", "Arm", "Ready", 8000),
    {
      id: "place",
      index: 1,
      action: "confirm",
      label: "Place Order",
      surface: "dom",
      human: true,
      confirm: true,
      timeoutMs: 8000,
      heal: "never",
      postcondition: { kind: "text", match: "Placed", timeoutMs: 4000 },
    },
  ]));
  library.save(workflow("slow-bao", "Slow Bao", `${origin}/slow`, [
    click("go", 0, "Click Go", "#go", "go", "Go", "Finished", 20_000),
  ]));
}

function workflow(id: string, name: string, startUrl: string, steps: WorkflowV2["steps"]): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id,
    name,
    startUrl,
    createdAt: Date.now(),
    inputs: [],
    steps,
  };
}

function click(id: string, index: number, label: string, css: string, testId: string, text: string, match: string, timeoutMs: number): WorkflowV2["steps"][number] {
  return {
    id,
    index,
    action: "click",
    label,
    surface: "dom",
    timeoutMs,
    heal: "never",
    identity: { surface: "dom", role: "button", path: [], id, testId, text, tag: "button", name: text },
    locators: [{ kind: "css", value: css }],
    postcondition: { kind: "text", match, timeoutMs },
  };
}

async function allowRun(origin: string, token: string, page: Page, id: string, title: string): Promise<ToolBody> {
  await page.locator("#remote-agent").waitFor({ state: "hidden", timeout: 5_000 }).catch(() => undefined);
  const pending = tool(origin, token, "run_workflow", { id, inputs: { password: PASSWORD, cookie: COOKIE } });
  await page.waitForFunction((name) => {
    const el = document.querySelector("[data-testid=remote-approval] .instruction");
    return !!el && (el.textContent || "").includes(name);
  }, title, { timeout: 20_000 });
  await page.click("[data-testid=remote-allow]");
  return pending;
}

async function waitOnline(origin: string, token: string): Promise<void> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < 20_000) {
    const hit = await tool(origin, token, "search_workflows", { query: "Hello" });
    last = JSON.stringify(hit.json);
    if (hit.json.outcome === "ok") return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`device stayed offline: ${last}`);
}

interface ToolBody {
  status: number;
  json: Record<string, unknown>;
  image: string;
  text: string;
  ms: number;
}

async function tool(origin: string, token: string, name: string, args: Record<string, unknown>): Promise<ToolBody> {
  const res = await rpc(origin, token, "tools/call", { name, arguments: args });
  const content = (res.body as { result?: { content?: { type?: string; text?: string; data?: string }[] } }).result?.content || [];
  const text = content.find((item) => item.type === "text")?.text || res.text;
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { raw: text }; }
  return { status: res.status, json, image: content.find((item) => item.type === "image")?.data || "", text, ms: res.ms };
}

async function rpc(origin: string, token: string, method: string, params?: unknown): Promise<{ status: number; body: unknown; text: string; ms: number }> {
  const started = Date.now();
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as unknown : null, text, ms: Date.now() - started };
}

function assertClean(text: string): void {
  assert.equal(text.includes(PASSWORD), false, "audit or result kept a password");
  assert.equal(text.includes("super-secret-cookie"), false, "audit or result kept a cookie");
  assert.equal(text.includes("iVBORw0KGgo"), false, "audit kept screenshot bytes");
}

async function shot(page: Page, name: string): Promise<void> {
  await page.locator("#remote-agent").screenshot({ path: path.join(SHOTS, name) });
}

async function uiState(port: number): Promise<{ remote?: { phase?: string } }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/state`);
  return await res.json() as { remote?: { phase?: string } };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(message);
}

function deviceId(home: string): string {
  return JSON.parse(readFileSync(path.join(home, "sync.json"), "utf8")).deviceId as string;
}

async function mint(origin: string, cookie: string, deviceIdValue: string, label: string): Promise<{
  id: string;
  token: string;
  mcp: { mcpServers: { bao: { url: string; headers: { Authorization: string } } } };
}> {
  const res = await fetch(`${origin}/api/agent/tokens`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ deviceId: deviceIdValue, label }),
  });
  const body = await res.json() as { id: string; token: string; mcp: { mcpServers: { bao: { url: string; headers: { Authorization: string } } } }; error?: string };
  if (!res.ok) throw new Error(body.error || `mint ${res.status}`);
  return body;
}

function redactMcp(mcp: { mcpServers: { bao: { url: string; headers: { Authorization: string } } } }): unknown {
  return {
    mcpServers: {
      bao: {
        url: mcp.mcpServers.bao.url,
        headers: { Authorization: "Bearer bao_at_…" },
      },
    },
  };
}

async function signIn(origin: string): Promise<string> {
  const sent = await fetch(`${origin}/api/auth/magic`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@bao.local", secret: "fixture-invite-secret" }),
  });
  const body = await sent.json() as { verifyUrl?: string; error?: string };
  if (!body.verifyUrl) throw new Error(body.error || "no verify link");
  const verified = await fetch(`${origin}${body.verifyUrl}`, { redirect: "manual" });
  const match = verified.headers.get("set-cookie")?.match(/bao_session=([^;]+)/);
  if (!match) throw new Error("no session cookie");
  return `bao_session=${match[1]}`;
}

async function pairCode(origin: string, cookie: string): Promise<string> {
  const res = await fetch(`${origin}/api/pair`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
  });
  const body = await res.json() as { code?: string; error?: string };
  if (!body.code) throw new Error(body.error || "no pair code");
  return body.code;
}

let webBuild: Promise<void> | undefined;

function ensureWebBuild(): Promise<void> {
  if (!webBuild) {
    const webDir = path.join(process.cwd(), "web");
    webBuild = new Promise((resolve, reject) => {
      execFile("npm", ["run", "build"], { cwd: webDir }, (err) => err ? reject(err) : resolve());
    });
  }
  return webBuild;
}

async function startRegistry(root: string, logs: string[], enabled: boolean): Promise<{ origin: string; stop: () => Promise<void> }> {
  await ensureWebBuild();
  const webDir = path.join(process.cwd(), "web");
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BAO_PG_DIR: path.join(root, "pglite"),
    BAO_BLOB_DIR: path.join(root, "blobs"),
    BAO_OWNER_EMAIL: "owner@bao.local",
    BAO_INVITE_SECRET: "fixture-invite-secret",
  };
  if (enabled) env.BAO_REMOTE_MCP = "1";
  else delete env.BAO_REMOTE_MCP;
  const child = spawn("npm", ["run", "start", "--", "--port", String(port), "-H", "127.0.0.1"], {
    detached: true,
    cwd: webDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  const start = Date.now();
  let last = "";
  while (Date.now() - start < 180_000) {
    try {
      const res = await fetch(`${origin}/api/health`);
      last = await res.text();
      if (res.ok) return { origin, stop: () => stopChild(child) };
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  await stopChild(child);
  throw new Error(`web did not start: ${last}\n${logs.join("").slice(-4000)}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  await new Promise((resolve) => setTimeout(resolve, 500));
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
}

async function assertDisabled(origin: string, method: string, pathname: string, body?: unknown, headers?: Record<string, string>): Promise<void> {
  const started = Date.now();
  const res = await fetch(`${origin}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ms = Date.now() - started;
  const text = await res.text();
  assert.equal(res.status, 404, `${method} ${pathname} ${text}`);
  assert.deepEqual(JSON.parse(text), { error: "remote_disabled" });
  assert.ok(ms < 5_000, `${method} ${pathname} took ${ms}ms`);
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function startFixture(): Promise<{ origin: string; state: () => Promise<{ hello: number; placed: number; phase: string; finished: boolean }>; close: () => Promise<void> }> {
  const counts = { hello: 0, placed: 0, phase: "idle", finished: false };
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", origin);
    if (req.method === "GET" && url.pathname === "/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(counts));
      return;
    }
    if (req.method === "POST" && url.pathname === "/hello") {
      counts.hello += 1;
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/placed") {
      counts.placed += 1;
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/working") {
      counts.phase = "working";
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/finished") {
      counts.finished = true;
      counts.phase = "finished";
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/app") {
      res.writeHead(302, { location: `${origin}/login` });
      res.end();
      return;
    }
    const pages: Record<string, string> = {
      "/hello": `<button id="go" data-testid="go">Go</button><p id="status"></p><script>
        document.getElementById("go").onclick = () => { document.getElementById("status").textContent = "Hello Bao"; fetch("/hello", { method: "POST" }); };
      </script>`,
      "/wall": `<h1>Verify you are human</h1><p>This fixture has no checkout button and no challenge widget.</p>`,
      "/login": `<h1>Sign in</h1><form><input type="password" id="password" name="password"></form>`,
      "/confirm": `<button id="arm" data-testid="arm">Arm</button><button id="place-order">Place Order</button><p id="status"></p><script>
        document.getElementById("arm").onclick = () => { document.getElementById("status").textContent = "Ready"; };
        document.getElementById("place-order").onclick = () => { document.getElementById("status").textContent = "Placed"; fetch("/placed", { method: "POST" }); };
      </script>`,
      "/slow": `<button id="go" data-testid="go">Go</button><p id="status"></p><script>
        document.getElementById("go").onclick = () => {
          document.getElementById("status").textContent = "Working";
          fetch("/working", { method: "POST" });
          setTimeout(() => { document.getElementById("status").textContent = "Finished"; fetch("/finished", { method: "POST" }); }, 30000);
        };
      </script>`,
    };
    const html = pages[url.pathname];
    if (!html || req.method !== "GET") {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>fixture</title>${html}`);
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    origin,
    state: async () => {
      const res = await fetch(`${origin}/state`);
      return await res.json() as typeof counts;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
