// One-step client for bao's stdio MCP server.
// `serve` holds the server. `call` sends exactly one tool call.
// Coordinates come from the caller, never from this file.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { resolveHome } from "../home";
import { createConnection, createServer } from "node:net";
import path from "node:path";
import { frameRpc, takeRpcChunk } from "./frame";

interface Rpc {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
  result?: { content?: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };
  error?: { message?: string };
}

const sock = process.env.BAO_MCP_SOCK || "/tmp/bao-mcp.sock";

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "serve") {
    await serve();
    return;
  }
  if (cmd === "call") {
    await call(rest);
    return;
  }
  process.stderr.write("usage: mcp-client serve | mcp-client call <screenshot|click|type|key|scroll> [json]\n");
  process.exit(1);
}

async function serve(): Promise<void> {
  const home = resolveHome();
  process.env.BAO_HOME = home;
  try { unlinkSync(sock); } catch { /* first start */ }
  const cli = path.join(process.cwd(), "desktop/dist/desktop/src/app/cli.js");
  const child = spawn(process.execPath, [cli, "mcp"], {
    env: { ...process.env, BAO_MCP_LIVE: "1", BAO_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  const pending = new Map<number, (msg: Rpc) => void>();
  let nextId = 1;
  readFrames(child, (msg) => {
    if (msg.id != null) pending.get(msg.id)?.(msg);
  });
  const server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString();
      const lineEnd = buf.indexOf("\n");
      if (lineEnd < 0) return;
      const line = buf.slice(0, lineEnd);
      buf = buf.slice(lineEnd + 1);
      const request = JSON.parse(line) as { name: string; arguments?: Record<string, unknown> };
      const id = nextId++;
      const done = new Promise<Rpc>((resolve) => pending.set(id, resolve));
      writeFrame(child, { jsonrpc: "2.0", id, method: "tools/call", params: { name: request.name, arguments: request.arguments || {} } });
      done.then((msg) => {
        pending.delete(id);
        const saved = saveImages(home, msg);
        socket.write(JSON.stringify({
          isError: msg.result?.isError || !!msg.error,
          text: (msg.result?.content || []).filter((item) => item.type === "text").map((item) => item.text).join("\n"),
          error: msg.error?.message,
          images: saved,
        }) + "\n");
      }).catch((err) => socket.write(JSON.stringify({ isError: true, error: String(err) }) + "\n"));
    });
  });
  writeFrame(child, { jsonrpc: "2.0", id: nextId++, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "live-model", version: "0" } } as unknown as Rpc["params"] });
  await new Promise<void>((resolve) => {
    server.listen(sock, () => {
      process.stdout.write(`mcp client listening ${sock}\n`);
      resolve();
    });
  });
  await new Promise<void>(() => {});
}

function call(rest: string[]): Promise<void> {
  const name = rest[0] || "";
  const args = rest[1] ? JSON.parse(rest[1]) as Record<string, unknown> : {};
  return new Promise((resolve, reject) => {
    const socket = createConnection(sock, () => {
      socket.write(JSON.stringify({ name, arguments: args }) + "\n");
    });
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString();
      if (!buf.includes("\n")) return;
      const msg = JSON.parse(buf) as { text?: string; error?: string; images?: string[]; isError?: boolean };
      const line = [msg.text, msg.error, ...(msg.images || [])].filter(Boolean).join("\n");
      process.stdout.write(line + "\n");
      socket.end();
      if (msg.isError) reject(new Error(msg.error || msg.text || "tool error"));
      else resolve();
    });
    socket.on("error", reject);
  });
}

function saveImages(home: string, msg: Rpc): string[] {
  const images = (msg.result?.content || []).filter((item) => item.type === "image" && item.data);
  return images.map((item, index) => {
    const file = path.join(home, index === 0 ? "latest.png" : `latest-${index}.png`);
    writeFileSync(file, Buffer.from(item.data || "", "base64"));
    const grid = path.join(home, "latest-grid.png");
    try {
      const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
      spawnSync("ffmpeg", [
        "-y", "-loglevel", "error", "-i", file,
        "-vf", "drawgrid=width=100:height=100:thickness=1:color=red@0.8",
        grid,
      ], { stdio: "ignore" });
    } catch { /* grid is a ruler for the operator; the trail keeps the clean shot */ }
    return file;
  });
}

function readFrames(child: ChildProcessWithoutNullStreams, onMessage: (msg: Rpc) => void): void {
  let buf = Buffer.alloc(0);
  child.stdout.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const next = takeRpcChunk(buf, null);
      if (!next) return;
      onMessage(JSON.parse(next.body) as Rpc);
      buf = Buffer.from(next.rest);
    }
  });
}

function writeFrame(child: ChildProcessWithoutNullStreams, msg: Rpc): void {
  child.stdin.write(frameRpc(msg, "json"));
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
