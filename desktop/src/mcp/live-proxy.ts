import path from "node:path";
import { serverHomes, serverPort } from "../home";
import type { RunResult } from "../v1/replay";
import type { LiveReplayer } from "./catalog";
import { LIVE_REPLAY, publicLiveResult } from "../cdp-live/live-ops";

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
      preset: flag(args, "--preset") || "",
      workflowId: flag(args, "--workflow-id") || "",
    };
  }
  if (cmd === "live_snapshot") {
    const page = flag(args, "--page");
    return page ? { op: cmd, page: Number(page) } : { op: cmd };
  }
  if (cmd === "live_click") return { op: cmd, ref: flag(args, "--ref") || "" };
  if (cmd === "live_type") return { op: cmd, ref: flag(args, "--ref") || "", text: flag(args, "--text") || "" };
  if (cmd === "live_key") return { op: cmd, key: flag(args, "--key") || "", ref: flag(args, "--ref") || "" };
  if (cmd === "live_scroll") return { op: cmd, direction: flag(args, "--direction") || "", ref: flag(args, "--ref") || "" };
  return { op: cmd };
}

/** MCP tool result for one live reply. A rejected, refused, or halted call is an error. */
export function liveToolResult(result: unknown): { content: { type: "text"; text: string }[]; isError: boolean } {
  const outcome = (result as { outcome?: { kind?: string } }).outcome?.kind;
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    isError: outcome === "rejected" || outcome === "refused" || outcome === "halted",
  };
}

function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The command that starts the app for this home, from the program that is running now. */
export function serveCommand(home: string, argv: readonly string[] = process.argv, node: string = process.execPath): string {
  const cli = argv[1];
  const program = cli && path.basename(cli) === "cli.js" ? `${shellWord(node)} ${shellWord(path.resolve(cli))}` : "bao";
  return `${program} serve --home ${shellWord(home)}`;
}

export function notRunningMessage(home: string): string {
  return `Bao is not running. Open the Bao app, or run: ${serveCommand(home)}`;
}

function refused(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string; errors?: { code?: string }[] } }).cause;
  if (cause?.code === "ECONNREFUSED") return true;
  return !!cause?.errors?.some((item) => item.code === "ECONNREFUSED");
}

/**
 * Sends one live op to the running app's POST /api/live.
 * args and env pick the app the same way as bao open: --home, then BAO_HOME, then the default homes.
 */
export async function postLive(body: unknown, args: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const port = serverPort(args, env);
  const notRunning = (): Error => new Error(notRunningMessage(serverHomes(args, env)[0] || ""));
  if (!port) throw notRunning();
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/api/live`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (refused(err)) throw notRunning();
    const cause = (err as { cause?: { message?: string } }).cause?.message;
    throw new Error(`Bao did not answer on port ${port}: ${cause || (err instanceof Error ? err.message : String(err))}`);
  }
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  if (!payload) throw new Error(`Bao did not answer on port ${port}: the reply was not JSON`);
  if (!response.ok) throw new Error(`Bao refused the live call: ${payload.error || `HTTP ${response.status}`}`);
  return publicLiveResult(payload);
}

/**
 * bao mcp's live runner. The running app replays the workflow in its live target, under its
 * CDP lock, so a recording and its replay drive the same Chrome. The reply is the engine's run.
 */
export function appLiveReplay(args: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): LiveReplayer {
  return async (workflow, inputs) => {
    const reply = await postLive({ op: LIVE_REPLAY, workflow, inputs }, args, env) as { run?: RunResult; outcome?: { reason?: string } };
    if (reply.run) return reply.run;
    throw new Error(reply.outcome?.reason || "live replay failed");
  };
}

export async function runLiveCli(cmd: string, args: string[]): Promise<void> {
  const result = await postLive(liveCliBody(cmd, args), args) as { outcome?: { kind?: string } };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  const kind = result.outcome?.kind;
  if (kind === "rejected") process.exitCode = 1;
  else if (kind === "refused" || kind === "halted") process.exitCode = 2;
}
