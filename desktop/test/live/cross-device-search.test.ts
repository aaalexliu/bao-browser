// Device B's MCP search finds and runs a workflow that lives on device A.
// Local `vercel dev` only. Nothing is deployed.
// Run after `tsc -p tsconfig.desktop.json`. Chrome needs BAO_CHROME_NO_SANDBOX=1.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareImport } from "../../../web/src/lib/import-sheet";
import { releaseHash } from "../../../web/src/lib/publish";
import { pinTestBrowser } from "../../src/launch";
import { frameRpc, takeRpcChunk } from "../../src/mcp/frame";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { pairDevice, syncAll } from "../../src/v1/sync";
import { testArtifacts } from "../artifacts";

pinTestBrowser();

const WORKFLOW_ID = "span-from-a";
const LOCAL_ID = "span-here";
const LISTING_ID = "span-listing";

test("device B searches and runs a workflow saved on device A", { timeout: 600_000 }, async () => {
  process.env.TZ = "America/New_York";
  const root = mkdtempSync(path.join(tmpdir(), "bao-span-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const fixture = await startFixture();
  const logs: string[] = [];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TZ: "America/New_York",
    BAO_PG_DIR: path.join(root, "pglite"),
    BAO_BLOB_DIR: path.join(root, "blobs"),
    BAO_AUTH_STUB: "1",
    BAO_CHROME_NO_SANDBOX: "1",
  };
  delete env.DATABASE_URL;
  delete env.POSTGRES_URL;
  delete env.BLOB_READ_WRITE_TOKEN;
  delete env.BLOB_STORE_ID;
  delete env.VERCEL_OIDC_TOKEN;

  const web = spawn(
    "npx",
    ["--yes", "vercel@65.0.0", "dev", "--local", "--yes", "--non-interactive", "--listen", `127.0.0.1:${port}`],
    { cwd: path.join(process.cwd(), "web"), env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  web.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  web.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));

  let mcp: ChildProcess | undefined;
  try {
    const health = await waitHealth(origin, logs);
    assert.equal(health.ok, true);
    assert.equal(health.driver, "pglite");

    const cookie = await signIn(origin, "owner@bao.local");
    const sellerCookie = await signIn(origin, "seller@bao.local");
    const homeA = path.join(root, "mac-a");
    const homeB = path.join(root, "mac-b");
    const homeSeller = path.join(root, "seller");
    const libA = new Library(homeA);
    const libB = new Library(homeB);
    const seller = new Library(homeSeller);
    libA.save(workflow(fixture.origin));
    seller.save(workflow(fixture.origin, LISTING_ID, "Span on the marketplace"));
    await pairDevice(seller, { code: await pairCode(origin, sellerCookie), server: origin, name: "Listing Mac" });
    const sellerPush = await syncAll(seller, "push");
    assert.match(sellerPush.lastResult || "", /pushed 1/);
    await publish(origin, sellerCookie, seller.read(LISTING_ID));
    await pairDevice(libA, { code: await pairCode(origin, cookie), server: origin, name: "Mac A" });
    const pushed = await syncAll(libA, "push");
    assert.equal(pushed.lastResult, "pushed 1, pulled 0, conflicts 0");
    libB.save(workflow(fixture.origin, LOCAL_ID, "Span on this Mac"));
    await pairDevice(libB, { code: await pairCode(origin, cookie), server: origin, name: "Mac B" });
    assert.throws(() => libB.read(WORKFLOW_ID));
    assert.throws(() => libB.read(LISTING_ID));

    mcp = spawn(process.execPath, [path.join(process.cwd(), "desktop/dist/desktop/src/app/cli.js"), "mcp"], {
      env: {
        ...env,
        BAO_HOME: homeB,
        BAO_HEAL_CURSOR_ACCOUNT: "0",
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        GROQ_API_KEY: "",
        CURSOR_API_KEY: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = mcpClient(mcp);
    await client.call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "scripted", version: "0" } } });
    client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const listed = await client.call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = toolNames(listed);
    assert.deepEqual(tools, ["search_workflows", "describe_workflow", "run_workflow", "get_run"]);

    const search = await client.call({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "search_workflows", arguments: { query: "Span" } },
    });
    const searchBody = toolJson(search) as { hits: Hit[] };
    assert.deepEqual(searchBody.hits.map((item) => item.id), [LOCAL_ID, WORKFLOW_ID, LISTING_ID], JSON.stringify(searchBody.hits));
    assert.deepEqual(searchBody.hits.map((item) => item.source), ["this Mac", "Mac A", "marketplace"]);
    const listingHit = searchBody.hits.find((item) => item.id === LISTING_ID);
    assert.match(listingHit?.lastGreen || "", /^publisher green · /);
    const deviceHit = searchBody.hits[1];
    assert.equal(deviceHit?.lastGreen, "Not replayed yet");
    assert.ok(Array.isArray(deviceHit?.inputs));

    const described = await client.call({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "describe_workflow", arguments: { id: WORKFLOW_ID } },
    });
    const describeBody = toolJson(described) as { source: string; lastGreen: string; link: string; workflow: { id: string } };
    assert.equal(describeBody.workflow.id, WORKFLOW_ID);
    assert.equal(describeBody.source, "Mac A");
    assert.equal(describeBody.lastGreen, "Not replayed yet");
    assert.equal(describeBody.link, `bao://workflow/${WORKFLOW_ID}`);

    const ran = await client.call({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "run_workflow", arguments: { id: WORKFLOW_ID, inputs: {} } },
    });
    const runBody = toolJson(ran) as { outcome: string; reason?: string; source?: string; lastGreen?: string; workflowId: string };
    assert.equal(runBody.outcome, "ok", runBody.reason || JSON.stringify(runBody));
    assert.equal(runBody.source, "Mac A");
    assert.equal(runBody.workflowId, WORKFLOW_ID);
    assert.equal(libB.read(WORKFLOW_ID).name, "Span from Mac A");
    assertGreen(runBody.lastGreen);

    const searchAgain = await client.call({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "search_workflows", arguments: { query: "Span from Mac A" } },
    });
    const againBody = toolJson(searchAgain) as { hits: Hit[] };
    const again = againBody.hits.find((item) => item.id === WORKFLOW_ID);
    if (!again) throw new Error(JSON.stringify(againBody));
    assert.equal(again.lastGreen, runBody.lastGreen);

    const describedAgain = await client.call({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "describe_workflow", arguments: { id: WORKFLOW_ID } },
    });
    const describeAgain = toolJson(describedAgain) as { source: string; lastGreen: string };
    assert.equal(describeAgain.lastGreen, runBody.lastGreen);

    const blocked = await client.call({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "run_workflow", arguments: { id: LISTING_ID, inputs: {} } },
    });
    const blockedBody = toolJson(blocked) as { outcome: string; reason?: string; permissions?: { driver?: string; trust?: string } };
    assert.equal(blockedBody.outcome, "needs_approval", blockedBody.reason || JSON.stringify(blockedBody));
    assert.equal(blockedBody.permissions?.driver, "browser");
    assert.equal(blockedBody.permissions?.trust, "allow");
    assert.throws(() => libB.read(LISTING_ID));
    const allowed = await fetch(`${origin}/api/marketplace/${LISTING_ID}/allow`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(allowed.status, 200, await allowed.text());

    const installed = await client.call({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "run_workflow", arguments: { id: LISTING_ID, inputs: {} } },
    });
    const installBody = toolJson(installed) as { outcome: string; reason?: string; source?: string; lastGreen?: string; workflowId: string };
    assert.equal(installBody.outcome, "ok", installBody.reason || JSON.stringify(installBody));
    assert.equal(installBody.source, "marketplace");
    assert.equal(installBody.workflowId, LISTING_ID);
    assert.equal(libB.read(LISTING_ID).name, "Span on the marketplace");
    assertGreen(installBody.lastGreen);
    assert.equal(installBody.lastGreen.startsWith("publisher green"), false);

    const syncedB = await syncAll(libB);
    assert.match(syncedB.lastResult || "", /conflicts 0/);
    const syncedA = await syncAll(libA);
    assert.match(syncedA.lastResult || "", /conflicts 0/);
    const macA = await mcpSession(env, homeA);
    let macAHit: Hit | undefined;
    try {
      const seen = await macA.client.call({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "search_workflows", arguments: { query: "Span from Mac A" } },
      });
      const seenBody = toolJson(seen) as { hits: Hit[] };
      macAHit = seenBody.hits.find((item) => item.id === WORKFLOW_ID);
      if (!macAHit) throw new Error(JSON.stringify(seenBody));
      const transcript = {
        tools,
        search: searchBody.hits.map((item) => ({ id: item.id, title: item.title, source: item.source, lastGreen: item.lastGreen, score: item.score })),
        describe: { id: WORKFLOW_ID, source: describeBody.source, lastGreen: describeBody.lastGreen },
        run: { id: WORKFLOW_ID, outcome: runBody.outcome, source: runBody.source, lastGreen: runBody.lastGreen },
        searchAfterRun: { id: again.id, source: again.source, lastGreen: again.lastGreen },
        describeAfterRun: { id: WORKFLOW_ID, lastGreen: describeAgain.lastGreen },
        marketplaceBlocked: { id: LISTING_ID, outcome: blockedBody.outcome },
        marketplaceRun: { id: LISTING_ID, outcome: installBody.outcome, source: installBody.source, lastGreen: installBody.lastGreen, installed: true },
        macAAfterSync: { id: WORKFLOW_ID, source: macAHit.source, lastGreen: macAHit.lastGreen },
      };
      const artifact = path.join(testArtifacts("cross-device-search"), "cross-device-mcp.json");
      mkdirSync(path.dirname(artifact), { recursive: true });
      writeFileSync(artifact, JSON.stringify(transcript, null, 2));
      assert.equal(macAHit.lastGreen, runBody.lastGreen);
    } finally {
      macA.child.kill();
    }
  } finally {
    mcp?.kill();
    await stop(web);
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
});

interface Hit {
  id: string;
  title?: string;
  source: string;
  lastGreen: string;
  score?: number;
  inputs?: unknown[];
}

function assertGreen(value: string | undefined): asserts value is string {
  if (!value || value === "Not replayed yet" || !/·.+(EDT|EST)/.test(value)) {
    throw new Error(`expected a green time, got ${value}`);
  }
}

async function publish(origin: string, cookie: string, doc: WorkflowV2): Promise<void> {
  const preview = prepareImport(doc);
  const reviewed = await fetch(`${origin}/api/workflows/${doc.id}/review`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ documentHash: releaseHash(preview.document), shots: [] }),
  });
  assert.equal(reviewed.status, 200, await reviewed.text());
  const listed = await fetch(`${origin}/api/workflows/${doc.id}/publish`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
  });
  assert.equal(listed.status, 200, await listed.text());
}

async function mcpSession(env: NodeJS.ProcessEnv, home: string): Promise<{ child: ChildProcess; client: ReturnType<typeof mcpClient> }> {
  const child = spawn(process.execPath, [path.join(process.cwd(), "desktop/dist/desktop/src/app/cli.js"), "mcp"], {
    env: {
      ...env,
      BAO_HOME: home,
      BAO_HEAL_CURSOR_ACCOUNT: "0",
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      GROQ_API_KEY: "",
      CURSOR_API_KEY: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = mcpClient(child);
  await client.call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "scripted", version: "0" } } });
  client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { child, client };
}

function workflow(startUrl: string, id = WORKFLOW_ID, name = "Span from Mac A"): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id,
    name,
    startUrl,
    createdAt: Date.now(),
    inputs: [],
    steps: [{
      id: "s0",
      index: 0,
      action: "click",
      label: "Open the fixture",
      surface: "dom",
      identity: { surface: "dom", role: "button", path: [], testId: "go" },
      postcondition: { kind: "text", match: "Opened", timeoutMs: 8000 },
      timeoutMs: 8000,
    }],
  };
}

function startFixture(): Promise<{ origin: string; server: Server }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><button data-testid="go">Open</button><p id="out"></p>
<script>document.querySelector("[data-testid=go]").addEventListener("click", () => { document.getElementById("out").textContent = "Opened"; });</script>`);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ origin: `http://127.0.0.1:${port}/`, server });
    });
  });
}

function mcpClient(child: ChildProcess | undefined) {
  if (!child?.stdin || !child.stdout) throw new Error("mcp");
  const messages: { id?: number; result?: { content?: { text?: string }[]; tools?: { name: string }[]; isError?: boolean } }[] = [];
  let buf = Buffer.alloc(0);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdout?.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const next = takeRpcChunk(buf, null);
      if (!next) return;
      messages.push(JSON.parse(next.body));
      buf = Buffer.from(next.rest);
    }
  });
  const send = (msg: unknown) => child.stdin?.write(frame(msg));
  const call = async (msg: { id: number; jsonrpc?: string; method?: string; params?: unknown }) => {
    send(msg);
    const start = Date.now();
    while (Date.now() - start < 120_000) {
      const found = messages.find((item) => item.id === msg.id);
      if (found) return found;
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`no mcp reply ${msg.id}\n${stderr.slice(-2000)}`);
  };
  return { send, call };
}

function frame(msg: unknown): Buffer {
  return Buffer.from(frameRpc(msg, "json"));
}

function toolNames(msg: { result?: { tools?: { name: string }[] } }): string[] {
  return msg.result?.tools?.map((tool) => tool.name) ?? [];
}

function toolJson(msg: { result?: { content?: { text?: string }[]; isError?: boolean } }): unknown {
  const text = msg.result?.content?.[0]?.text || "";
  if (msg.result?.isError) throw new Error(text);
  return JSON.parse(text);
}

async function signIn(origin: string, email: string): Promise<string> {
  const sent = await fetch(`${origin}/api/auth/magic`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
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
  if (!body.code) throw new Error(body.error || `no pair code (${res.status})`);
  return body.code;
}

async function waitHealth(origin: string, logs: string[]): Promise<{ ok?: boolean; driver?: string }> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < 300_000) {
    try {
      const res = await fetch(`${origin}/api/health`);
      last = await res.text();
      if (res.ok) return JSON.parse(last) as { ok?: boolean; driver?: string };
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`vercel dev did not start: ${last}\n${logs.join("").slice(-8000)}`);
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

async function stop(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 800));
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}
