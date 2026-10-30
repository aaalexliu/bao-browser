// A small MCP client for the driver eval. Frames match bao mcp.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { frameRpc, takeRpcChunk } from "../mcp/frame";

interface Pending {
  resolve: (value: McpResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface McpResult {
  text: string;
  isError: boolean;
  tools?: { name: string }[];
}

export class McpClient {
  private buf = Buffer.alloc(0);
  private pending = new Map<number, Pending>();
  private next = 1;
  readonly stderr: string[] = [];

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.stderr.push(chunk.toString("utf8")));
    child.on("exit", (code) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`bao mcp exited ${code}`));
      }
      this.pending.clear();
    });
  }

  static start(env: NodeJS.ProcessEnv): McpClient {
    const cli = require("node:path").join(process.cwd(), "desktop/dist/desktop/src/app/cli.js") as string;
    const child = spawn(process.execPath, [cli, "mcp"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new McpClient(child);
  }

  async handshake(): Promise<string[]> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "bao-eval", version: "0" },
    });
    this.notify("notifications/initialized");
    const listed = await this.request("tools/list", {});
    const names = listed.tools?.map((tool) => tool.name) || [];
    return names;
  }

  notify(method: string): void {
    this.send({ jsonrpc: "2.0", method });
  }

  async request(method: string, params: unknown, timeoutMs = 60000): Promise<{ text: string; isError: boolean; tools?: { name: string }[] }> {
    const id = this.next++;
    const result = await new Promise<McpResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
    return result as { text: string; isError: boolean; tools?: { name: string }[] };
  }

  async call(name: string, args: Record<string, unknown>): Promise<McpResult> {
    return this.request("tools/call", { name, arguments: args });
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGTERM");
        resolve();
      }, 5000);
      this.child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private send(msg: unknown): void {
    this.child.stdin.write(frameRpc(msg, "json"));
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const next = takeRpcChunk(this.buf, null);
      if (!next) return;
      this.buf = Buffer.from(next.rest);
      this.onMessage(next.body);
    }
  }

  private onMessage(body: string): void {
    const msg = JSON.parse(body) as {
      id?: number;
      result?: { content?: { type?: string; text?: string }[]; isError?: boolean; tools?: { name: string }[] };
      error?: { message?: string };
    };
    if (msg.id == null) return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(new Error(msg.error.message || "mcp error"));
      return;
    }
    const text = msg.result?.content?.find((item) => item.type === "text")?.text || "";
    pending.resolve({
      text,
      isError: !!msg.result?.isError,
      tools: msg.result?.tools,
    });
  }
}
