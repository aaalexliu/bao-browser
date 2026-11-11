import { spawn } from "node:child_process";
import path from "node:path";
import { frameRpc, takeRpcChunk } from "../../src/mcp/frame";
import type { TOOLS } from "../../src/mcp/server";

export function snapshotRefs(snapshot: string, label: RegExp): string[] {
  return snapshot.split("\n").flatMap((line) => {
    const ref = /\bref=(e\d+)\]/.exec(line)?.[1];
    label.lastIndex = 0;
    return ref && label.test(line) ? [ref] : [];
  });
}

export function baoDriver<Result>(env: NodeJS.ProcessEnv, timeoutMs = 60_000) {
  const child = spawn(process.execPath, [path.resolve(__dirname, "../../src/app/cli.js"), "mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, { resolve(value: Result): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let buffer = Buffer.alloc(0), nextId = 0, stderr = "";
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure = error;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  };
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      fail(new Error(`MCP exited ${code ?? signal}: ${stderr}`));
      resolve();
    });
    child.once("error", (error) => { fail(error); resolve(); });
  });
  child.stdin.on("error", fail);
  child.stderr.on("data", (bytes: Buffer) => { stderr = (stderr + bytes.toString()).slice(-8192); });
  child.stdout.on("data", (bytes: Buffer) => {
    buffer = Buffer.concat([buffer, bytes]);
    try {
      while (true) {
        const chunk = takeRpcChunk(buffer, null);
        if (!chunk) break;
        buffer = Buffer.from(chunk.rest);
        const message = JSON.parse(chunk.body) as { id?: number; result: Result; error?: unknown };
        if (message.id === undefined) continue;
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      }
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
  function request(method: string, params: unknown = {}): Promise<Result> {
    if (failure) return Promise.reject(failure);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout ${method}: ${stderr}`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(frameRpc({ jsonrpc: "2.0", id, method, params }, "json"));
    });
  }
  return {
    request,
    stderr: () => stderr,
    tool: (name: typeof TOOLS[number]["name"], args: Record<string, unknown>) => request("tools/call", { name, arguments: args }),
    async initialize(params: Record<string, unknown> = {}) {
      const result = await request("initialize", params);
      child.stdin.write(frameRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, "json"));
      return result;
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.stdin.end();
      const terminate = setTimeout(() => child.kill("SIGTERM"), 3000);
      const kill = setTimeout(() => child.kill("SIGKILL"), 6000);
      try {
        await exited;
        if (child.exitCode !== 0) throw failure;
      } finally { clearTimeout(terminate); clearTimeout(kill); }
    },
  };
}
