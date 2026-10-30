import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { frameRpc } from "../../src/mcp/frame";
import { TOOL_NAMES } from "../../src/mcp/server";

function frame(msg: unknown): Buffer {
  return Buffer.from(frameRpc(msg, "json"));
}

function headerFrame(msg: unknown): Buffer {
  return Buffer.from(frameRpc(msg, "headers"));
}

// The child gets its own HOME, so it never reads or writes the person's library.
function startMcp(prefix: string): { home: string; child: ChildProcessWithoutNullStreams } {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const home = path.join(root, "library");
  const user = path.join(root, "user");
  mkdirSync(user);
  const child = spawn(process.execPath, [path.join(process.cwd(), "desktop/dist/desktop/src/app/cli.js"), "mcp"], {
    env: { ...process.env, HOME: user, BAO_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { home, child };
}

test("MCP tool names stay fixed", () => {
  assert.deepEqual(TOOL_NAMES, ["search_workflows", "describe_workflow", "run_workflow", "get_run"]);
});

test("tools/list stays the same four tools after workflows are added", async () => {
  const { home, child } = startMcp("bao-mcp-");
  try {
    const messages: { id?: number; result?: { tools?: { name: string }[] } }[] = [];
    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) messages.push(JSON.parse(line));
        nl = buf.indexOf("\n");
      }
    });
    const send = (msg: unknown) => child.stdin.write(frame(msg));
    const waitFor = async (id: number) => {
      const start = Date.now();
      while (Date.now() - start < 5000) {
        if (messages.some((msg) => msg.id === id)) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`no reply ${id}`);
    };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "scripted", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await waitFor(2);
    writeFileSync(path.join(home, "workflows", "extra-one.json"), "{}\n");
    writeFileSync(path.join(home, "workflows", "extra-two.json"), "{}\n");
    send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    await waitFor(3);
    const names = (id: number) => messages.find((msg) => msg.id === id)?.result?.tools?.map((tool) => tool.name);
    assert.deepEqual(names(2), ["search_workflows", "describe_workflow", "run_workflow", "get_run"]);
    assert.deepEqual(names(3), names(2));
  } finally {
    child.kill();
  }
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
