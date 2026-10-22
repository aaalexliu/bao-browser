// Two Macs, a replay, the review gate, and a scripted agent.
// Run after `tsc -p tsconfig.desktop.json`. Chrome needs BAO_CHROME_NO_SANDBOX=1.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { reviewWorkflow, runWorkflow } from "../../src/mcp/catalog";
import { startApp } from "../../src/app/server";
import { migrate, type ReplayArgs, type WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { pairDevice, syncAll } from "../../src/v1/sync";
import { SEED_WORKFLOWS } from "../../../web/src/lib/seeds";

const planted = "SuperSecretValue99";
const fixturePassword = "fixture-pass-value";

test("two devices, review gate, agent, and the web app", { timeout: 720_000 }, async () => {
  process.env.BAO_CHROME_NO_SANDBOX = "1";
  const root = mkdtempSync(path.join(tmpdir(), "bao-live-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  const web = spawn("npm", ["run", "dev", "--", "--port", String(port), "-H", "127.0.0.1"], {
    detached: true,
    cwd: path.join(process.cwd(), "web"),
    env: {
      ...process.env,
      BAO_PG_DIR: path.join(root, "pglite"),
      BAO_BLOB_DIR: path.join(root, "blobs"),
      BAO_AUTH_STUB: "1",
      BAO_CHROME_NO_SANDBOX: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  web.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  web.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  try {
    await waitHealth(origin, logs);
    const owner = await signIn(origin, "owner@bao.local");
    const examples = await signIn(origin, "examples@bao.local");
    const homeA = path.join(root, "mac-a");
    const homeB = path.join(root, "mac-b");
    const libA = new Library(homeA);
    const libB = new Library(homeB);
    const fixture = `${origin}/fixture.html`;
    const doc = localCopy("fixture-username", "cross-mac", fixture);
    doc.name = "From the first Mac";
    libA.save(doc);

    await pairDevice(libA, { code: await pairCode(origin, owner), server: origin, name: "Mac A" });
    await pairDevice(libB, { code: await pairCode(origin, owner), server: origin, name: "Mac B" });
    const first = await syncAll(libA);
    assert.ok(first.backupPath && statSync(first.backupPath).isDirectory());
    assert.ok(statSync(path.join(first.backupPath, "workflows", "cross-mac.json")).isFile());
    assert.equal(statSync(path.join(homeA, "sync.json")).mode & 0o777, 0o600);
    const tokenA = JSON.parse(readFileSync(path.join(homeA, "sync.json"), "utf8")).deviceToken as string;
    assert.ok(tokenA);

    const pulled = await syncAll(libB);
    assert.equal(libB.read("cross-mac").name, "From the first Mac");
    assert.ok(pulled.devices.length >= 2);
    assert.ok(pulled.categories.some((row) => row.count >= 1));
    const replayed = await runWorkflow(libB, { id: "cross-mac", inputs: { username: "grace" } });
    assert.equal(replayed.outcome, "ok", JSON.stringify(replayed));

    libA.rename("cross-mac", "From the first Mac again");
    await syncAll(libA);
    libB.rename("cross-mac", "Edited on the second Mac");
    const conflicted = await syncAll(libB);
    assert.equal(libB.read("cross-mac").name, "From the first Mac again");
    const stashed = readFileSync(path.join(homeB, "conflicts", "cross-mac.json"), "utf8");
    assert.match(stashed, /Edited on the second Mac/);
    assert.ok(conflicted.conflicts.some((item) => item.id === "cross-mac"));
    const again = await syncAll(libA);
    assert.equal(again.backupPath, first.backupPath);

    const bad = await fetch(`${origin}/api/workflows/bad-secret/versions`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      body: JSON.stringify({
        baseVersion: 0,
        document: {
          ...localCopy("fixture-username", "bad-secret", fixture),
          inputs: [{ name: "password", type: "secret", default: planted }],
        },
        cookie: "session=secretcookie",
        args: { password: planted },
      }),
    });
    const badText = await bad.text();
    assert.equal(bad.status, 400, badText);
    const absent = await fetch(`${origin}/api/workflows/bad-secret`, { headers: { authorization: `Bearer ${tokenA}` } });
    assert.equal(absent.status, 404);
    const stored = await fetch(`${origin}/api/workflows/cross-mac`, { headers: { authorization: `Bearer ${tokenA}` } });
    const storedText = await stored.text();
    assert.equal(stored.ok, true);
    assert.equal(storedText.includes(planted), false);
    assert.equal(storedText.includes("secretcookie"), false);

    const shared = await fetch(`${origin}/api/workflows/fixture-sign-in/share`, {
      method: "POST",
      headers: { cookie: examples, "content-type": "application/json" },
      body: JSON.stringify({ permission: "fork" }),
    });
    const shareBody = await shared.json() as { token: string; document?: unknown };
    assert.equal(shared.ok, true, JSON.stringify(shareBody));
    const share = await fetch(`${origin}/api/share/${shareBody.token}`, { headers: { cookie: examples } });
    const shareView = await share.json() as { questions: { name: string; type: string }[]; document: unknown };
    assert.ok(shareView.questions.some((question) => question.type === "secret"));
    assert.equal(JSON.stringify(shareView.document).includes("@"), false);
    const reader = await signIn(origin, "reader@bao.local");
    const leaked = await fetch(`${origin}/api/share/${shareBody.token}/install`, {
      method: "POST",
      headers: { cookie: reader, "content-type": "application/json" },
      body: JSON.stringify({ answers: { username: "ada@secret.com", password: fixturePassword } }),
    });
    assert.equal(leaked.status, 400);

    const noted = localCopy("fixture-username", "noted-hello", "http://127.0.0.1/fixture.html");
    noted.name = "Hello with a note";
    noted.inputs.push({ name: "note", type: "text", label: "Note", required: false, default: "ada@acme.com" });
    const pushed = await fetch(`${origin}/api/workflows/noted-hello/versions`, {
      method: "POST",
      headers: { cookie: examples, "content-type": "application/json" },
      body: JSON.stringify({ baseVersion: 0, document: noted }),
    });
    assert.equal(pushed.status, 201, await pushed.text());
    const early = await fetch(`${origin}/api/workflows/noted-hello/publish`, {
      method: "POST",
      headers: { cookie: examples },
    });
    assert.equal(early.status, 409);

    const published: string[] = [];
    for (const seed of SEED_WORKFLOWS) {
      const inputs = seedInputs(seed.id, fixture);
      const result = await reviewWorkflow(new Library(path.join(root, `review-${seed.id}`)), seed.id, inputs, {
        server: origin,
        cookie: examples,
        startUrl: seed.id.startsWith("fixture-") ? fixture : undefined,
      });
      if (result.reviewed) {
        const confirmed = await fetch(`${origin}/api/workflows/${seed.id}/publish`, {
          method: "POST",
          headers: { cookie: examples, "content-type": "application/json" },
        });
        if (confirmed.ok) published.push(seed.id);
        else logs.push(`publish ${seed.id} ${confirmed.status} ${await confirmed.text()}\n`);
      } else {
        logs.push(`review ${seed.id} ${result.outcome} ${result.reason || ""}\n`);
      }
    }
    for (const id of ["fixture-sign-in", "fixture-row", "fixture-username", "fixture-upload"]) {
      assert.ok(published.includes(id), `${id} was not listed\n${logs.slice(-30).join("")}`);
    }
    const publicSignIn = await (await fetch(`${origin}/api/marketplace/fixture-sign-in`)).text();
    assert.equal(publicSignIn.includes(fixturePassword), false);

    const noteReview = await reviewWorkflow(new Library(path.join(root, "review-note")), "noted-hello", { username: "Ada" }, {
      server: origin,
      cookie: examples,
      startUrl: fixture,
    });
    assert.equal(noteReview.reviewed, true, JSON.stringify(noteReview));

    const shots = "/opt/cursor/artifacts/screenshots";
    mkdirSync(shots, { recursive: true });
    const browser = await chromium.launch({ channel: "chrome", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await context.addCookies([{ name: "bao_session", value: examples.split("=")[1] || "", url: origin }]);
      const page = await context.newPage();
      await page.goto(`${origin}/workflows/noted-hello/publish`, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "What goes public" }).waitFor();
      await page.getByTestId("verified").waitFor();
      await page.getByTestId("domains").waitFor();
      assert.match(await page.getByTestId("last-green").innerText(), /Last replayed green: \d{4}-\d{2}-\d{2}/);
      assert.match(await page.locator("table.diff").innerText(), /ada@acme.com/);
      await page.screenshot({ path: path.join(shots, "publish-preview.png"), fullPage: true });

      const listed = await fetch(`${origin}/api/workflows/noted-hello/publish`, {
        method: "POST",
        headers: { cookie: examples, "content-type": "application/json" },
      });
      assert.equal(listed.ok, true, await listed.text());
      const publicNote = await (await fetch(`${origin}/api/marketplace/noted-hello`)).text();
      assert.equal(publicNote.includes("ada@acme.com"), false);

      await page.goto(`${origin}/marketplace`, { waitUntil: "networkidle" });
      await page.getByTestId("marketplace").waitFor();
      await page.locator("input[name=q]").fill("fixture");
      await page.getByRole("button", { name: "Search" }).click();
      await page.waitForURL(/q=fixture/);
      assert.ok(await page.locator("[data-testid=marketplace] a").count() >= 1);
      await page.screenshot({ path: path.join(shots, "marketplace.png"), fullPage: true });
      await page.locator("[data-testid=marketplace] a").first().click();
      await page.getByTestId("workflow").waitFor();
      await page.getByTestId("verified").waitFor();
      await page.getByTestId("domains").waitFor();
      assert.match(await page.getByTestId("last-green").innerText(), /Last replayed green/);
      assert.match(await page.locator("body").innerText(), /bao:\/\/workflow\//);
      await page.screenshot({ path: path.join(shots, "workflow.png"), fullPage: true });

      const fresh = await context.newPage();
      await fresh.goto(`${origin}/login`, { waitUntil: "networkidle" });
      await fresh.locator("input[name=email]").fill("guest@bao.local");
      await fresh.getByRole("button", { name: "Email me a link" }).click();
      await fresh.getByRole("link", { name: "Open the sign-in link" }).click();
      await fresh.getByRole("heading", { name: "Library" }).waitFor();
    } finally {
      await browser.close();
    }

    const transcript = await agentExchange(path.join(root, "agent"), origin, owner);
    const transcriptPath = "/opt/cursor/artifacts/agent-transcript.json";
    mkdirSync(path.dirname(transcriptPath), { recursive: true });
    writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2));
    assert.equal(JSON.stringify(transcript).includes(fixturePassword), false);
    assert.equal(transcript.run.outcome, "ok");
    assert.ok(transcript.search.hits.length <= 5);
    assert.ok(transcript.search.hits.every((hit) => Array.isArray(hit.inputs)));
    assert.equal(transcript.tools.join(","), "search_workflows,describe_workflow,run_workflow,get_run");

    const app = await startApp({ home: homeB });
    try {
      const state = await (await fetch(`http://127.0.0.1:${app.port}/api/state`)).text();
      const tokenB = JSON.parse(readFileSync(path.join(homeB, "sync.json"), "utf8")).deviceToken as string;
      assert.equal(state.includes(tokenB), false);
      const desktop = await chromium.launch({ channel: "chrome", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
      try {
        const page = await desktop.newPage({ viewport: { width: 1100, height: 900 } });
        await page.goto(`http://127.0.0.1:${app.port}/`);
        await page.getByRole("button", { name: "Library" }).click();
        await page.getByText("bao://workflow/cross-mac").waitFor();
        await page.getByRole("button", { name: "Replay" }).click();
        await page.getByRole("button", { name: "Re-run with past inputs" }).waitFor();
        await page.getByRole("button", { name: "Settings" }).click();
        await page.getByRole("heading", { name: "Devices" }).waitFor();
        await page.getByText("Mac A").waitFor();
        await page.getByText("Conflicts", { exact: true }).waitFor();
        await page.getByText("before-sync-").waitFor();
        await page.screenshot({ path: path.join(shots, "desktop-sync.png"), fullPage: true });
      } finally {
        await desktop.close();
      }
    } finally {
      await app.close();
    }
  } finally {
    await stop(web);
  }
});

async function agentExchange(home: string, origin: string, ownerCookie: string) {
  const library = new Library(home);
  const doc = localCopy("fixture-sign-in", "agent-sign-in", `${origin}/fixture.html`);
  library.save(doc);
  for (let i = 0; i < 6; i++) {
    const extra = localCopy("fixture-username", `extra-${i}`, `${origin}/fixture.html`);
    extra.name = `Extra search ${i}`;
    library.save(extra);
  }
  await pairDevice(library, { code: await pairCode(origin, ownerCookie), server: origin, name: "Agent Mac" });
  const child = spawn(process.execPath, [path.join(process.cwd(), "desktop/dist/desktop/src/app/cli.js"), "mcp"], {
    env: { ...process.env, BAO_HOME: home, BAO_CHROME_NO_SANDBOX: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: { id?: number; result?: { tools?: { name: string }[]; content?: { text: string }[] } }[] = [];
  let buf = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buf.slice(0, headerEnd).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) return;
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (buf.length < start + length) return;
      messages.push(JSON.parse(buf.slice(start, start + length).toString("utf8")));
      buf = buf.slice(start + length);
    }
  });
  const send = (msg: unknown) => child.stdin.write(frame(msg));
  const waitFor = async (id: number) => {
    const start = Date.now();
    while (Date.now() - start < 90_000) {
      if (messages.some((msg) => msg.id === id)) return messages.find((msg) => msg.id === id);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`agent timed out waiting for ${id}`);
  };
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = await waitFor(2);
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_workflows", arguments: { query: "sign in" } } });
    const searchMsg = await waitFor(3);
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "describe_workflow", arguments: { id: "agent-sign-in" } } });
    const describeMsg = await waitFor(4);
    send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "run_workflow", arguments: { id: "agent-sign-in", inputs: { username: "grace", password: fixturePassword } } },
    });
    const runMsg = await waitFor(5);
    const text = (msg: { result?: { content?: { text: string }[] } } | undefined) => msg?.result?.content?.[0]?.text || "";
    const search = JSON.parse(text(searchMsg)) as { hits: { inputs: unknown[] }[] };
    const described = JSON.parse(text(describeMsg)) as { link?: string };
    const run = JSON.parse(text(runMsg)) as { outcome: string };
    assert.equal(text(runMsg).includes(fixturePassword), false);
    assert.equal(described.link, "bao://workflow/agent-sign-in");
    return {
      tools: listed?.result?.tools?.map((tool) => tool.name) ?? [],
      search,
      describe: described,
      run,
    };
  } finally {
    child.kill();
  }
}

function seedInputs(id: string, _fixture: string): ReplayArgs {
  if (id === "fixture-sign-in") return { username: "ada", password: fixturePassword };
  if (id === "fixture-row") return { row: "Ada" };
  if (id === "fixture-username") return { username: "grace" };
  if (id === "fixture-upload") {
    const file = path.join(tmpdir(), "bao-upload.txt");
    writeFileSync(file, "hello from bao\n");
    return { file: { name: "bao-upload.txt", path: file } };
  }
  if (id === "wikipedia-search") return { query: "Ada Lovelace" };
  if (id === "public-form") return { name: "Ada Lovelace", note: "Leave at the desk" };
  return {};
}

function localCopy(seedId: string, id: string, startUrl: string): WorkflowV2 {
  const seed = SEED_WORKFLOWS.find((item) => item.id === seedId);
  if (!seed) throw new Error(seedId);
  const doc = migrate(JSON.parse(JSON.stringify(seed.document)) as unknown);
  doc.id = id;
  doc.startUrl = startUrl;
  doc.createdAt = Date.now();
  return doc;
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
  if (!body.code) throw new Error(body.error || "no pair code");
  return body.code;
}

async function waitHealth(origin: string, logs: string[]): Promise<void> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < 180_000) {
    try {
      const res = await fetch(`${origin}/api/health`);
      last = await res.text();
      if (res.ok) return;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`web did not start: ${last}\n${logs.join("").slice(-5000)}`);
}

function frame(msg: unknown): Buffer {
  const json = JSON.stringify(msg);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
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
