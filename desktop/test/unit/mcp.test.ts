import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TOOL_NAMES } from "../../src/mcp/server";

function frame(msg: unknown): Buffer {
  const json = JSON.stringify(msg);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
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
