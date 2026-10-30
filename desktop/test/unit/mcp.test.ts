import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LIVE_TOOL_NAMES } from "../../src/cdp-live/live-ops";
import { frameRpc } from "../../src/mcp/frame";
import { serveCommand } from "../../src/mcp/live-proxy";
import { INSTRUCTIONS, TOOL_NAMES } from "../../src/mcp/server";

const cli = path.join(process.cwd(), "desktop/dist/desktop/src/app/cli.js");
const CATALOG = ["search_workflows", "describe_workflow", "run_workflow", "get_run"];

function frame(msg: unknown): Buffer {
  return Buffer.from(frameRpc(msg, "json"));
}

function headerFrame(msg: unknown): Buffer {
  return Buffer.from(frameRpc(msg, "headers"));
}

interface Reply {
  id?: number;
  result?: {
    tools?: { name: string }[];
    instructions?: string;
    serverInfo?: { name?: string };
    content?: { text?: string }[];
    isError?: boolean;
  };
}

interface Mcp {
  home: string;
  child: ChildProcessWithoutNullStreams;
  request(method: string, params?: unknown): Promise<Reply>;
  tool(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

// The child gets its own HOME, so it never reads or writes the person's library.
function startMcp(prefix: string, cmd = "mcp"): Mcp {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const home = path.join(root, "library");
  const user = path.join(root, "user");
  mkdirSync(user);
  const child = spawn(process.execPath, [cli, cmd], {
    env: { ...process.env, HOME: user, BAO_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: Reply[] = [];
  let buf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith("{")) messages.push(JSON.parse(line) as Reply);
      nl = buf.indexOf("\n");
    }
  });
  let nextId = 1;
  const request = async (method: string, params?: unknown): Promise<Reply> => {
    const id = nextId++;
    child.stdin.write(frame({ jsonrpc: "2.0", id, method, params }));
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const hit = messages.find((msg) => msg.id === id);
      if (hit) return hit;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no reply ${id}`);
  };
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await request("tools/call", { name, arguments: args });
    return { text: reply.result?.content?.[0]?.text || "", isError: reply.result?.isError === true };
  };
  return { home, child, request, tool };
}

async function initialize(mcp: Mcp): Promise<Reply> {
  const reply = await mcp.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "scripted", version: "0" } });
  mcp.child.stdin.write(frame({ jsonrpc: "2.0", method: "notifications/initialized" }));
  return reply;
}

/** A stand-in for bao serve's POST /api/live. It records each body and answers with reply(body). */
async function fakeApp(home: string, reply: (body: Record<string, unknown>) => unknown): Promise<{ bodies: Record<string, unknown>[]; server: Server }> {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/api/live") {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply(body)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "server.json"), JSON.stringify({ port: (server.address() as AddressInfo).port }));
  return { bodies, server };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

test("bao mcp lists the catalog tools, then the live tools", () => {
  assert.deepEqual(TOOL_NAMES, [...CATALOG, ...LIVE_TOOL_NAMES]);
  for (const name of ["live_session_start", "live_snapshot", "live_click", "live_type", "live_stop"]) {
    assert.ok(TOOL_NAMES.includes(name as (typeof TOOL_NAMES)[number]), name);
  }
});

test("tools/list stays the same after workflows are added", async () => {
  const mcp = startMcp("bao-mcp-");
  try {
    await initialize(mcp);
    const first = await mcp.request("tools/list");
    writeFileSync(path.join(mcp.home, "workflows", "extra-one.json"), "{}\n");
    writeFileSync(path.join(mcp.home, "workflows", "extra-two.json"), "{}\n");
    const second = await mcp.request("tools/list");
    const names = (reply: Reply) => reply.result?.tools?.map((tool) => tool.name);
    assert.deepEqual(names(first), [...CATALOG, ...LIVE_TOOL_NAMES]);
    assert.deepEqual(names(second), names(first));
  } finally {
    mcp.child.kill();
  }
});

test("initialize tells the agent to start, read, act, and end, and that ending saves the workflow", async () => {
  const mcp = startMcp("bao-mcp-init-");
  try {
    const reply = await initialize(mcp);
    assert.equal(reply.result?.serverInfo?.name, "bao");
    const text = reply.result?.instructions || "";
    assert.equal(text, INSTRUCTIONS);
    const order = ["live_session_start", "live_snapshot", "live_click", "live_stop"].map((name) => text.indexOf(name));
    assert.ok(order.every((at) => at >= 0), text);
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.match(text, /live_stop\. Ending the session saves the workflow/);
    assert.match(text, /Bao app running/);
  } finally {
    mcp.child.kill();
  }
});

test("a live tool goes to the running app's /api/live, and a catalog tool stays in this process", async () => {
  const mcp = startMcp("bao-mcp-proxy-");
  const app = await fakeApp(mcp.home, (body) => body.op === "live_type"
    ? { op: body.op, outcome: { kind: "refused", reason: "credential_field" } }
    : { op: body.op, outcome: { kind: "applied" }, view: { path: "/store/costco" }, cookies: "sid=1", nested: { localStorage: "x" } });
  try {
    await initialize(mcp);
    const click = await mcp.tool("live_click", { ref: "e1.c2", op: "live_stop", client: "other" });
    assert.equal(click.isError, false);
    assert.deepEqual(JSON.parse(click.text), { op: "live_click", outcome: { kind: "applied" }, view: { path: "/store/costco" }, nested: {} });
    const typed = await mcp.tool("live_type", { ref: "e1.c3", text: "costco blueberries" });
    assert.equal(typed.isError, true);
    assert.equal(JSON.parse(typed.text).outcome.reason, "credential_field");
    // One client id per process, and a caller cannot override op or client.
    const client = app.bodies[0]?.client;
    assert.match(String(client), /^[0-9a-f-]{36}$/);
    assert.deepEqual(app.bodies, [
      { ref: "e1.c2", op: "live_click", client },
      { ref: "e1.c3", text: "costco blueberries", op: "live_type", client },
    ]);
    const search = await mcp.tool("search_workflows", { query: "blueberries" });
    assert.equal(search.isError, false);
    assert.deepEqual(JSON.parse(search.text), { hits: [] });
    assert.equal(app.bodies.length, 2);
  } finally {
    mcp.child.kill();
    await closeServer(app.server);
  }
});

test("bao mcp-live is the same server as bao mcp", async () => {
  const mcp = startMcp("bao-mcp-alias-", "mcp-live");
  const app = await fakeApp(mcp.home, (body) => ({ op: body.op, outcome: { kind: "applied" } }));
  try {
    const init = await initialize(mcp);
    assert.equal(init.result?.serverInfo?.name, "bao");
    assert.equal(init.result?.instructions, INSTRUCTIONS);
    const list = await mcp.request("tools/list");
    assert.deepEqual(list.result?.tools?.map((tool) => tool.name), [...CATALOG, ...LIVE_TOOL_NAMES]);
    assert.equal((await mcp.tool("live_snapshot")).isError, false);
    assert.deepEqual(app.bodies.map(({ client: _client, ...body }) => body), [{ op: "live_snapshot" }]);
    assert.equal((await mcp.tool("search_workflows", { query: "x" })).isError, false);
  } finally {
    mcp.child.kill();
    await closeServer(app.server);
  }
});

test("a live tool names the command that starts Bao when the app is not running", async () => {
  const mcp = startMcp("bao-mcp-down-");
  const expected = `Bao is not running. Open the Bao app, or run: ${serveCommand(mcp.home, ["node", cli])}`;
  try {
    await initialize(mcp);
    const missing = await mcp.tool("live_session_start", { intent: "put costco blueberries in the cart", url: "https://www.instacart.com/", portFile: "/tmp/DevToolsActivePort" });
    assert.deepEqual(missing, { text: expected, isError: true });

    // server.json left behind by an app that quit.
    const gone = createServer();
    await new Promise<void>((resolve) => gone.listen(0, "127.0.0.1", () => resolve()));
    const port = (gone.address() as AddressInfo).port;
    await closeServer(gone);
    writeFileSync(path.join(mcp.home, "server.json"), JSON.stringify({ port }));
    assert.deepEqual(await mcp.tool("live_snapshot"), { text: expected, isError: true });

    assert.equal((await mcp.tool("search_workflows", { query: "x" })).isError, false);
  } finally {
    mcp.child.kill();
  }
});

test("the printed start command serves the app from a directory outside the repo", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-srv-"));
  const home = path.join(root, "h");
  const user = path.join(root, "user");
  const elsewhere = path.join(root, "cwd");
  for (const dir of [home, user, elsewhere]) mkdirSync(dir, { recursive: true });
  const app = spawn(process.execPath, [cli, "serve", "--home", home, "--port", "0"], {
    cwd: elsewhere,
    env: { ...process.env, HOME: user, BAO_HOME: home, BAO_PUBLIC: "", BAO_HEAL_CURSOR_ACCOUNT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  app.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  app.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(logs || "serve did not listen")), 30_000);
      app.stdout.on("data", () => {
        const match = logs.match(/bao (\d+) home /);
        if (!match?.[1]) return;
        clearTimeout(timer);
        resolve(Number(match[1]));
      });
      app.on("exit", () => {
        clearTimeout(timer);
        reject(new Error(logs || "serve exited"));
      });
    });
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200, logs);
    assert.match(await page.text(), /<html/i);
    const script = await fetch(`http://127.0.0.1:${port}/app.js`);
    assert.equal(script.status, 200, logs);
    assert.equal(app.exitCode, null, logs);
  } finally {
    app.kill();
  }
});

test("the start command quotes a home with a space and names the running program", () => {
  assert.equal(
    serveCommand("/Users/a/Library/Application Support/bao", ["node", "/opt/bao/cli.js"], "/usr/local/bin/node"),
    "/usr/local/bin/node /opt/bao/cli.js serve --home '/Users/a/Library/Application Support/bao'",
  );
  assert.equal(serveCommand("/tmp/it's", ["bao"], "/usr/local/bin/node"), "bao serve --home '/tmp/it'\\''s'");
});

test("a Content-Length request still gets a newline-delimited reply", async () => {
  const { child } = startMcp("bao-mcp-header-");
  try {
    let buf = "";
    const messages: { id?: number }[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith("{")) messages.push(JSON.parse(line));
        nl = buf.indexOf("\n");
      }
    });
    child.stdin.write(headerFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "old", version: "0" } } }));
    const start = Date.now();
    while (!messages.some((msg) => msg.id === 1) && Date.now() - start < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const reply = messages.find((msg) => msg.id === 1);
    assert.ok(reply);
    assert.equal(JSON.stringify(reply).includes("Content-Length"), false);
  } finally {
    child.kill();
  }
});

const shelfWorkflow = `{
  "schema": "bao.workflow/v2",
  "version": 2,
  "id": "wf-shelf",
  "name": "Shelf",
  "startUrl": "https://example.test/",
  "createdAt": 1,
  "inputs": [],
  "steps": []
}
`;

function callSearch(env: NodeJS.ProcessEnv, cwd: string): Promise<{ hits?: { title?: string }[] }> {
  const child = spawn(process.execPath, [path.join(process.cwd(), "desktop/dist/desktop/src/app/cli.js"), "mcp"], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: { id?: number; result?: { content?: { text?: string }[] } }[] = [];
  let buf = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith("{")) messages.push(JSON.parse(line));
      nl = buf.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const send = (msg: unknown) => child.stdin.write(frame(msg));
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "scripted", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_workflows", arguments: { query: "Shelf" } } });
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const reply = messages.find((msg) => msg.id === 2);
      if (reply) {
        clearInterval(timer);
        child.kill();
        const text = reply.result?.content?.[0]?.text || "";
        resolve(JSON.parse(text) as { hits?: { title?: string }[] });
        return;
      }
      if (Date.now() - start > 5000) {
        clearInterval(timer);
        child.kill();
        reject(new Error(`no search reply\n${stderr}`));
      }
    }, 20);
  });
}

// The quickstart says bao mcp without BAO_HOME reads the home bao serve uses, and a set BAO_HOME wins.
test("search_workflows reads the serve home without BAO_HOME, and a set BAO_HOME wins", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bao-mcp-serve-")));
  const user = path.join(root, "user");
  const cwd = path.join(root, "cwd");
  mkdirSync(user);
  mkdirSync(cwd);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: user };
  delete env.BAO_HOME;
  const status = spawnSync(process.execPath, [path.join(process.cwd(), "desktop/dist/desktop/src/app/cli.js"), "status"], { cwd, env, encoding: "utf8" });
  assert.equal(status.status, 0, status.stderr);
  const serve = (JSON.parse(status.stdout) as { home: string }).home;
  const platformHome = process.platform === "darwin"
    ? path.join(user, "Library", "Application Support", "bao")
    : path.join(user, ".local", "share", "bao");
  assert.equal(serve, platformHome);
  mkdirSync(path.join(serve, "workflows"), { recursive: true });
  writeFileSync(path.join(serve, "workflows", "wf-shelf.json"), shelfWorkflow);
  const found = await callSearch(env, cwd);
  assert.equal(found.hits?.some((hit) => hit.title === "Shelf"), true);
  const missed = await callSearch({ ...env, BAO_HOME: path.join(root, "other") }, cwd);
  assert.deepEqual(missed.hits, []);
});
