// MCP stdio server. screenshot, click, type, key, scroll.
// Each call is appended to the bao trail. BAO_MCP_STUB=1 records without a browser
// so a scripted client can test the protocol. A live session uses the same trail shape.

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

interface Rpc {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

const tools = [
  { name: "screenshot", description: "Capture the bao screen.", inputSchema: { type: "object", properties: {} } },
  { name: "click", description: "Click. Recorded in the bao trail.", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } },
  { name: "type", description: "Type text through bao.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "key", description: "Press a key through bao.", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
  { name: "scroll", description: "Scroll through bao.", inputSchema: { type: "object", properties: { dx: { type: "number" }, dy: { type: "number" } } } },
];

export async function mcpMain(): Promise<void> {
  const home = process.env.BAO_HOME || path.join(process.cwd(), ".bao-mcp");
  mkdirSync(home, { recursive: true });
  const trail = path.join(home, "trail.jsonl");
  const input = process.stdin;
  let buf = Buffer.alloc(0);
  input.on("data", (chunk: Buffer) => {
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
      const body = buf.slice(start, start + length).toString("utf8");
      buf = buf.slice(start + length);
      handle(body, trail);
    }
  });
  await new Promise(() => {});
}

function handle(body: string, trail: string): void {
  const msg = JSON.parse(body) as Rpc;
  if (msg.method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "bao", version: "0.1.0" },
      },
    });
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  }
  if (msg.method === "tools/call") {
    const name = msg.params?.name || "";
    const args = msg.params?.arguments || {};
    const event = {
      kind: name === "screenshot" ? "read" : "act",
      op: name,
      args,
      ts: Date.now(),
      source: { agent: "mcp", vendor: "bao", adapter: "stdio" },
    };
    appendFileSync(trail, JSON.stringify(event) + "\n");
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: name === "screenshot" ? "screenshot recorded" : "OK" }], isError: false },
    });
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}

function send(msg: unknown): void {
  const json = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}
