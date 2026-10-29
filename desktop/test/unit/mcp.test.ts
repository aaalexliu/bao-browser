import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("MCP tool names stay fixed", () => {
  assert.deepEqual(TOOL_NAMES, ["search_workflows", "describe_workflow", "run_workflow", "get_run"]);
});

test("tools/list stays the same four tools after workflows are added", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-mcp-"));
  const child = spawn(process.execPath, [path.join(process.cwd(), "desktop/dist/desktop/src/app/cli.js"), "mcp"], {
    env: { ...process.env, BAO_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
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
  child.kill();
  const names = (id: number) => messages.find((msg) => msg.id === id)?.result?.tools?.map((tool) => tool.name);
  assert.deepEqual(names(2), ["search_workflows", "describe_workflow", "run_workflow", "get_run"]);
  assert.deepEqual(names(3), names(2));
});

test("a Content-Length request still gets a newline-delimited reply", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-mcp-header-"));
  const child = spawn(process.execPath, [path.join(process.cwd(), "desktop/dist/desktop/src/app/cli.js"), "mcp"], {
    env: { ...process.env, BAO_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
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
  child.kill();
  const reply = messages.find((msg) => msg.id === 1);
  assert.ok(reply);
  assert.equal(JSON.stringify(reply).includes("Content-Length"), false);
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

test("search_workflows reads the serve home only when BAO_HOME is set", async () => {
  const serve = mkdtempSync(path.join(tmpdir(), "bao-serve-"));
  const cwd = mkdtempSync(path.join(tmpdir(), "bao-mcp-cwd-"));
  mkdirSync(path.join(serve, "workflows"));
  writeFileSync(path.join(serve, "workflows", "wf-shelf.json"), shelfWorkflow);
  const env = { ...process.env };
  delete env.BAO_HOME;
  const missed = await callSearch(env, cwd);
  assert.deepEqual(missed.hits, []);
  const found = await callSearch({ ...env, BAO_HOME: serve }, cwd);
  assert.equal(found.hits?.some((hit) => hit.title === "Shelf"), true);
});
