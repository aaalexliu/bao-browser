import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

function frame(msg: unknown): Buffer {
  const json = JSON.stringify(msg);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

test("a scripted MCP client records a click in the bao trail", { skip: process.platform === "darwin" }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-mcp-"));
  const child = spawn(process.execPath, [path.join(process.cwd(), "desktop/dist/desktop/src/app/cli.js"), "mcp"], {
    env: { ...process.env, BAO_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = Buffer.alloc(0);
  const messages: { id?: number; result?: { tools?: { name: string }[] } }[] = [];
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
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "scripted", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "click", arguments: { x: 40, y: 50 } } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  child.kill();
  const names = messages.find((msg) => msg.id === 2)?.result?.tools?.map((tool) => tool.name);
  assert.deepEqual(names, ["screenshot", "click", "type", "key", "scroll"]);
  const trail = readFileSync(path.join(home, "trail.jsonl"), "utf8");
  assert.match(trail, /"op":"click"/);
  assert.match(trail, /"x":40/);
});
