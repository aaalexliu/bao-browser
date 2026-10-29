import { baoServerPort } from "../app/bao-home";
import { frameRpc, takeRpcChunk } from "./frame";
import { isLiveOp, LIVE_TOOLS, publicLiveResult } from "../cdp-live/live-ops";

interface Rpc {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function liveCliBody(cmd: string, args: string[]): Record<string, unknown> {
  if (cmd === "live_session_start") {
    return {
      op: cmd,
      intent: flag(args, "--intent") || "",
      url: flag(args, "--url") || "",
      portFile: flag(args, "--port-file") || "",
      preset: flag(args, "--preset") || "generic",
      workflowId: flag(args, "--workflow-id") || "",
    };
  }
  if (cmd === "live_click") return { op: cmd, ref: flag(args, "--ref") || "" };
  if (cmd === "live_type") return { op: cmd, ref: flag(args, "--ref") || "", text: flag(args, "--text") || "" };
  return { op: cmd };
}

export async function postLive(body: unknown, homeFlag?: string): Promise<unknown> {
  const port = baoServerPort(homeFlag);
  if (!port) throw new Error("bao app is not running");
  const response = await fetch(`http://127.0.0.1:${port}/api/live`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as unknown;
  return publicLiveResult(payload);
}

export async function runLiveCli(cmd: string, args: string[]): Promise<void> {
  const result = await postLive(liveCliBody(cmd, args), flag(args, "--home")) as { outcome?: { kind?: string } };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  const kind = result.outcome?.kind;
  if (kind === "rejected") process.exitCode = 1;
  else if (kind === "refused" || kind === "halted") process.exitCode = 2;
}

export async function liveProxyMain(args: string[] = []): Promise<void> {
  const home = flag(args, "--home");
  let buf = Buffer.alloc(0);
  let chain = Promise.resolve();
  const send = (msg: unknown): void => {
    process.stdout.write(frameRpc(msg, "json"));
  };
  const handle = async (text: string): Promise<void> => {
    const msg = JSON.parse(text) as Rpc;
    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "bao-live", version: "0.2.0" } },
      });
      return;
    }
    if (msg.method === "notifications/initialized") return;
    if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: LIVE_TOOLS } });
      return;
    }
    if (msg.method === "tools/call") {
      const name = msg.params?.name || "";
      if (!isLiveOp(name)) {
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "unknown tool" }], isError: true } });
        return;
      }
      try {
        const result = await postLive({ op: name, ...(msg.params?.arguments || {}) }, home);
        const outcome = (result as { outcome?: { kind?: string } }).outcome?.kind;
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result) }],
            isError: outcome === "rejected" || outcome === "refused" || outcome === "halted",
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "live call failed";
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: message }], isError: true } });
      }
      return;
    }
    if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  };
  process.stdin.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const next = takeRpcChunk(buf, null);
      if (!next) return;
      buf = Buffer.from(next.rest);
      chain = chain.then(() => handle(next.body)).catch((err: unknown) => {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      });
    }
  });
  await new Promise(() => {});
}
