// Permissions preview before the first run of a marketplace workflow.
// Local `vercel dev` only. Nothing is deployed.
// Run after `tsc -p tsconfig.desktop.json`. Chrome needs BAO_CHROME_NO_SANDBOX=1.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type Page } from "playwright";
import { frameRpc, takeRpcChunk } from "../../src/mcp/frame";
import { isElementCrop } from "../../../web/src/lib/png";
import { prepareImport } from "../../../web/src/lib/import-sheet";
import { releaseHash } from "../../../web/src/lib/publish";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { pairDevice, syncAll } from "../../src/v1/sync";

const LISTING_ID = "trust-submit";
const shots = "/opt/cursor/artifacts/screenshots";

test("a marketplace listing previews permissions and waits for Allow", { timeout: 600_000 }, async () => {
  process.env.TZ = "America/New_York";
  process.env.BAO_CHROME_NO_SANDBOX = "1";
  const root = mkdtempSync(path.join(tmpdir(), "bao-trust-"));
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

  const browser = await chromium.launch({ channel: "chrome", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  let mcp: ChildProcess | undefined;
  try {
    const health = await waitHealth(origin, logs);
    assert.equal(health.driver, "pglite");
    const sellerCookie = await signIn(origin, "seller@bao.local");
    const buyerCookie = await signIn(origin, "buyer@bao.local");
    const doc = workflow(fixture.origin);
    const sellerHome = path.join(root, "seller");
    const buyerHome = path.join(root, "buyer");
    const seller = new Library(sellerHome);
    const buyer = new Library(buyerHome);
    seller.save(doc);

    const shotContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const shotPage = await shotContext.newPage();
    await shotPage.goto(fixture.origin, { waitUntil: "domcontentloaded" });
    const button = shotPage.locator("[data-testid=send]");
    const box = await button.boundingBox();
    if (!box) throw new Error("submit button missing");
    const png = await shotPage.screenshot({
      type: "png",
      clip: {
        x: Math.max(0, box.x - 24),
        y: Math.max(0, box.y - 24),
        width: Math.min(480, box.width + 48),
        height: Math.min(280, box.height + 48),
      },
    });
    await shotContext.close();
    assert.equal(isElementCrop(png), true);

    await pairDevice(seller, { code: await pairCode(origin, sellerCookie), server: origin, name: "Listing Mac" });
    const pushed = await syncAll(seller, "push");
    assert.match(pushed.lastResult || "", /pushed 1/);
    await publish(origin, sellerCookie, seller.read(LISTING_ID), png);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const publishedClicks = fixture.submits;
    assert.equal(publishedClicks >= 1, true);

    mkdirSync(shots, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "America/New_York" });
    await context.addCookies([{ name: "bao_session", value: buyerCookie.split("=")[1] || "", url: origin }]);
    const page = await context.newPage();
    await page.goto(`${origin}/marketplace/${LISTING_ID}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("permissions").waitFor();
    assert.match(await page.getByTestId("perm-sites").innerText(), new RegExp(fixture.origin.replace(/[.]/g, "\\.")));
    assert.equal(await page.locator("h2", { hasText: /^Sites$/ }).count(), 0);
    assert.equal(await page.getByTestId("domains").count(), 0);
    assert.equal(await page.locator("[data-secret=true]").innerText(), "Password · secret");
    assert.equal(await page.getByTestId("secret-note").innerText(), "You enter this on your device.");
    assert.equal(await page.getByTestId("inputs").locator("input").count(), 0);
    assert.equal(await page.locator("input[type=password]").count(), 0);
    assert.equal(await page.getByTestId("perm-driver").innerText(), "Browser");
    assert.equal(await page.getByTestId("perm-trust").innerText(), "Can press submit. Always ask.");
    assert.equal(await page.getByTestId("step-ask").innerText(), "Always ask");
    assert.equal(await page.getByTestId("allow").innerText(), "Allow");
    assert.equal(await page.getByTestId("copy").isDisabled(), true);
    assert.equal(await page.getByTestId("install").count(), 0);
    assert.match(await page.getByTestId("last-green").innerText(), /^Publisher replayed green:/);
    assert.equal(await page.getByTestId("your-green").count(), 0);
    assert.equal(await page.getByTestId("share-panel").getAttribute("hidden"), "");
    const publisherGreen = await page.getByTestId("last-green").innerText();
    assert.equal(await bodyColor(page), "rgb(245, 245, 247)");
    await page.locator("main").screenshot({ path: path.join(shots, "permissions-preview-light.png") });
    await chooseTheme(page, "dark");
    assert.equal(await bodyColor(page), "rgb(28, 28, 30)");
    assert.equal(await page.getByTestId("share-panel").getAttribute("hidden"), "");
    await page.locator("main").screenshot({ path: path.join(shots, "permissions-preview-dark.png") });
    await chooseTheme(page, "light");

    const copied = await fetch(`${origin}/api/marketplace/${LISTING_ID}/fork`, {
      method: "POST",
      headers: { cookie: buyerCookie, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(copied.status, 403, await copied.text());

    await pairDevice(buyer, { code: await pairCode(origin, buyerCookie), server: origin, name: "Buyer Mac" });
    mcp = spawn(process.execPath, [path.join(process.cwd(), "desktop/dist/desktop/src/app/cli.js"), "mcp"], {
      env: {
        ...env,
        BAO_HOME: buyerHome,
        BAO_HEAL_CURSOR_ACCOUNT: "0",
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        GROQ_API_KEY: "",
        CURSOR_API_KEY: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = mcpClient(mcp);
    await client.call({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "scripted", version: "0" } },
    });
    client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const tools = await client.call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.deepEqual(toolNames(tools), ["search_workflows", "describe_workflow", "run_workflow", "get_run"]);

    const blocked = await client.call({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "run_workflow", arguments: { id: LISTING_ID, inputs: {} } },
    });
    const blockedBody = toolJson(blocked) as {
      outcome: string;
      status?: string;
      reason?: string;
      source?: string;
      permissions?: { driver?: string; submit?: boolean; trust?: string; inputs?: { secret?: boolean }[]; sites?: string[] };
    };
    assert.equal(blockedBody.outcome, "needs_approval", blockedBody.reason || JSON.stringify(blockedBody));
    assert.equal(blockedBody.status, "needs_approval");
    assert.equal(blockedBody.source, "marketplace");
    assert.equal(blockedBody.permissions?.driver, "browser");
    assert.equal(blockedBody.permissions?.submit, true);
    assert.equal(blockedBody.permissions?.trust, "ask");
    assert.equal(blockedBody.permissions?.inputs?.[0]?.secret, true);
    assert.ok(blockedBody.permissions?.sites?.includes(fixture.origin));
    assert.throws(() => buyer.read(LISTING_ID));

    await page.getByTestId("allow").click();
    await page.getByTestId("install").waitFor();
    assert.equal(await page.getByTestId("install").getAttribute("href"), `bao://import/${LISTING_ID}`);
    assert.match(await page.getByTestId("allowed").innerText(), /Always ask/);
    assert.equal(await page.getByTestId("step-ask").innerText(), "Always ask");
    assert.equal(await page.getByTestId("copy").isDisabled(), false);
    assert.equal(await page.getByTestId("share-panel").getAttribute("hidden"), "");
    await page.locator("main").screenshot({ path: path.join(shots, "permissions-after-allow.png") });

    const ran = await client.call({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "run_workflow", arguments: { id: LISTING_ID, inputs: {} } },
    });
    const ranBody = toolJson(ran) as { outcome: string; reason?: string; status?: string };
    assert.equal(ranBody.outcome, "needs_human", ranBody.reason || JSON.stringify(ranBody));
    assert.match(ranBody.reason || "", /Always ask/);
    assert.equal(buyer.read(LISTING_ID).name, "Submit a payment");
    assert.equal(buyer.settings().siteTrust?.[fixture.origin], "ask");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(fixture.submits, publishedClicks);
    const token = JSON.parse(readFileSync(path.join(buyerHome, "sync.json"), "utf8")).deviceToken as string;
    const stamped = await fetch(`${origin}/api/workflows/${LISTING_ID}/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "run-buyer-green", status: "passed", at: Date.now(), steps: [{ id: "send", status: "passed" }] }),
    });
    assert.equal(stamped.status, 201, await stamped.text());
    await page.reload({ waitUntil: "domcontentloaded" });
    assert.equal(await page.getByTestId("last-green").innerText(), publisherGreen);
    assert.match(await page.getByTestId("your-green").innerText(), /^Your last green:/);
    await context.close();
  } finally {
    mcp?.kill();
    await browser.close();
    await stop(web);
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
});

function workflow(startUrl: string): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id: LISTING_ID,
    name: "Submit a payment",
    startUrl,
    createdAt: 1,
    inputs: [{ name: "password", type: "secret", label: "Password", required: false }],
    steps: [{
      id: "send",
      index: 0,
      action: "click",
      label: "Submit the form",
      surface: "dom",
      timeoutMs: 8000,
      identity: { surface: "dom", role: "button", path: [], testId: "send", text: "Submit" },
      postcondition: { kind: "text", match: "Sent", timeoutMs: 8000 },
    }],
  };
}

async function publish(origin: string, cookie: string, doc: WorkflowV2, png: Buffer): Promise<void> {
  const preview = prepareImport(doc);
  const reviewed = await fetch(`${origin}/api/workflows/${doc.id}/review`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      documentHash: releaseHash(preview.document),
      shots: [{ stepId: "send", png: png.toString("base64"), redacted: true }],
    }),
  });
  assert.equal(reviewed.status, 200, await reviewed.text());
  const listed = await fetch(`${origin}/api/workflows/${doc.id}/publish`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
  });
  assert.equal(listed.status, 200, await listed.text());
}

function startFixture(): Promise<{ origin: string; server: Server; submits: number }> {
  const state = { submits: 0 };
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/clicked") {
      state.submits += 1;
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><button type="submit" data-testid="send">Submit</button><p id="out"></p>
<script>document.querySelector("[data-testid=send]").addEventListener("click", (event) => {
  event.preventDefault();
  fetch("/clicked", { method: "POST" });
  document.getElementById("out").textContent = "Sent";
});</script>`);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ origin: `http://127.0.0.1:${port}`, server, get submits() { return state.submits; } });
    });
  });
}

async function bodyColor(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

async function chooseTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate((value) => {
    localStorage.setItem("bao-theme", value);
    if (value === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
  }, theme);
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
