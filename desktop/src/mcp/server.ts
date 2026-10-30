import { baoUserHome, otherLibraries, resolveHome, tildePath } from "../home";
import { randomUUID } from "node:crypto";
import { isLiveOp, LIVE_DISCONNECT, LIVE_TOOLS } from "../cdp-live/live-ops";
import { describeWorkflow, getRun, runWorkflow, searchWorkflows, type LiveReplayer } from "./catalog";
import { frameRpc, takeRpcChunk } from "./frame";
import { appLiveReplay, liveToolResult, postLive } from "./live-proxy";
import { Library } from "../v1/store";

interface Rpc {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

const CATALOG_TOOLS = [
  {
    name: "search_workflows",
    description: "Search this Mac, workflows synced from your other devices, and installed marketplace listings. At most 5 hits. Each hit includes its input schema, a source (this Mac, the device name, or marketplace), and the last green time. A marketplace time this Mac has not replayed is labeled publisher green. Equal relevance ranks this Mac, then another device, then marketplace.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        source: { type: "string", enum: ["mine", "team", "public"] },
        site: { type: "string" },
        category: { type: "string" },
        filters: { type: "object" },
      },
    },
  },
  {
    name: "describe_workflow",
    description: "Steps, input schema, declared outputs, bao:// link, source, and last green time for one workflow. Secret defaults are omitted. Source is this Mac, the device name, or marketplace.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "run_workflow",
    description: "Replay a workflow on this device, in Bao's own Chrome. A cdp-live workflow, which a live session saves, replays instead through the running Bao app in a new window of the Chrome the live tools drive, with no model call and no approval step. It repeats the recorded steps, including the search text the session typed. It skips a cart add when the item is already in the cart, and it keeps the live guards: checkout and other confirm or denied controls are refused, and a sign-in page or bot check stops it with needs_human. An extension workflow returns failed with the reason and does not run. A workflow that is only on another device or a marketplace listing is installed onto this Mac first. A marketplace listing that has not been allowed returns needs_approval and does not run. A passed run stamps the last green time and returns declared outputs. A human step returns needs_human or needs_signin with ask, deadline, and resume_token. Pass that token to continue the same run. cancel stops it with nothing applied.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        inputs: { type: "object" },
        resume: { type: "string" },
        rerun: { type: "boolean" },
        cancel: { type: "boolean" },
      },
    },
  },
  {
    name: "get_run",
    description: "Read one replay outcome by run id, including declared outputs when the workflow has them. A bot check or a session that expired is needs_human, with the reason and pageClass.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"] },
  },
] as const;

/** The catalog runs in this process. The live tools go to the running Bao app. */
export const TOOLS = [...CATALOG_TOOLS, ...LIVE_TOOLS];

export const TOOL_NAMES = TOOLS.map((tool) => tool.name);

export const INSTRUCTIONS = [
  "Bao drives a Chrome window for you and saves what you did as a workflow.",
  "To do a task in the browser:",
  "1. Start: live_session_start with the user's intent and the start url. The Bao app picks the Chrome to drive. portFile and preset are optional.",
  "2. Read: live_snapshot. Use only refs from the latest snapshot. A long page comes in pages; pass page to read the next one.",
  "3. Act: live_click, live_type, live_key, or live_scroll on one ref, then read again.",
  "4. End: live_stop. Ending the session saves the workflow in the Bao library. If the client disconnects first, Bao saves it too.",
  "Bao does not click a control listed under stopBeforeConfirm, such as a place order button. For a stale_ref or unknown_ref refusal, read again. For any other refusal or a halted reply, do not try another way: end the session and tell the user what Bao stopped on.",
  "search_workflows, describe_workflow, run_workflow, and get_run work on saved workflows. run_workflow replays a saved live workflow through the running Bao app with no model call. It repeats the recorded search and skips a cart add when the item is already in the cart.",
  "The live tools need the Bao app running. When a live tool says Bao is not running, tell the user the command it names.",
].join("\n");

interface Context {
  library: Library;
  libraries: string[] | undefined;
  /** CLI arguments and environment from before BAO_HOME was set, so live calls find the app the way bao open does. */
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  /** One id per process. The app saves and ends only this client's session when it goes away. */
  client: string;
  live: LiveReplayer;
  /** Set once this process sends a live call, so a disconnect is sent only then. */
  liveUsed: boolean;
  /** Resolves when the client goes away. From then on each live_* call and the disconnect post get 15 s. */
  gone: Promise<void>;
}

export async function mcpMain(args: readonly string[] = []): Promise<void> {
  const env = { ...process.env };
  const home = resolveHome(args);
  const libraries = publishedLibraries(home, otherLibraries(home, args));
  process.env.BAO_HOME = home;
  if (process.env.BAO_MCP_LIVE === "1") {
    const { liveMcpMain } = await import("../eval/live-mcp");
    await liveMcpMain();
    return;
  }
  let ending = false;
  let ended: () => void = () => undefined;
  const gone = new Promise<void>((resolve) => { ended = resolve; });
  const ctx: Context = { library: new Library(home), libraries, args, env, client: randomUUID(), live: appLiveReplay(args, env), liveUsed: false, gone };
  let buf = Buffer.alloc(0);
  let chain = Promise.resolve();
  process.stdin.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const next = takeRpcChunk(buf, null);
      if (!next) return;
      buf = Buffer.from(next.rest);
      chain = chain.then(() => handle(next.body, ctx)).catch((err: unknown) => {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      });
    }
  });
  // The client closed stdin or stopped this process: finish queued calls, then save its live session.
  // A live_* call or the disconnect stuck in the app must not keep this process alive. The app's idle timeout still saves.
  // After stdin closes, catalog work, a run_workflow live replay included, finishes and saves with no cap. A SIGTERM or SIGINT exits within 15 s, even mid-run.
  const end = (): void => {
    if (ending) return;
    ending = true;
    ended();
    void chain
      .then(() => ctx.liveUsed ? limited(postLive({ op: LIVE_DISCONNECT, client: ctx.client }, ctx.args, ctx.env), gone) : undefined)
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  const stop = (): void => {
    setTimeout(() => process.exit(0), 15_000).unref();
    end();
  };
  process.stdin.on("end", end);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await new Promise(() => {});
}

async function handle(body: string, ctx: Context): Promise<void> {
  const msg = JSON.parse(body) as Rpc;
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "bao", version: "0.2.0" },
        instructions: INSTRUCTIONS,
      },
    });
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    return;
  }
  if (msg.method === "tools/call") {
    const name = msg.params?.name || "";
    const args = msg.params?.arguments || {};
    try {
      const result = isLiveOp(name)
        ? liveToolResult(await liveCall({ ...args, op: name, client: ctx.client }, ctx))
        : { content: [{ type: "text", text: JSON.stringify(await callTool(ctx.library, ctx.libraries, ctx.live, name, args)) }], isError: false };
      send({ jsonrpc: "2.0", id: msg.id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: message }], isError: true },
      });
    }
    return;
  }
  if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
}

function liveCall(body: Record<string, unknown>, ctx: Context): Promise<unknown> {
  ctx.liveUsed = true;
  return limited(postLive(body, ctx.args, ctx.env), ctx.gone);
}

/** A live_* call or the disconnect gets 15 s from when it starts or the client goes away, whichever is later. */
function limited<T>(work: Promise<T>, gone: Promise<void>): Promise<T> {
  const deadline = gone.then(() => new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("The Bao app did not answer.")), 15_000).unref();
  }));
  return Promise.race([work, deadline]);
}

async function callTool(library: Library, libraries: string[] | undefined, live: LiveReplayer, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === "search_workflows") {
    const filters = args.filters && typeof args.filters === "object" ? args.filters as Record<string, unknown> : args;
    return withLibraries({
      hits: await searchWorkflows(library, String(args.query || ""), {
        source: stringArg(filters.source),
        site: stringArg(filters.site),
        category: stringArg(filters.category),
      }),
    }, libraries);
  }
  if (name === "describe_workflow") return describeWorkflow(library, String(args.id || ""));
  if (name === "run_workflow") {
    const result = await runWorkflow(library, {
      id: args.id ? String(args.id) : undefined,
      inputs: args.inputs && typeof args.inputs === "object" ? args.inputs as Record<string, string | number> : {},
      resume: args.resume ? String(args.resume) : undefined,
      rerun: args.rerun === true,
      cancel: args.cancel === true,
    }, undefined, { live });
    return withLibraries(result, libraries);
  }
  if (name === "get_run") return withLibraries(getRun(library, String(args.run_id || "")), libraries);
  throw new Error("unknown tool");
}

function publishedLibraries(root: string, also: string[]): string[] | undefined {
  if (!also.length) return undefined;
  const prefix = baoUserHome();
  return [root, ...also].map((dir) => tildePath(dir, prefix));
}

function withLibraries(result: object, libraries: string[] | undefined): object {
  if (!libraries) return result;
  return { ...result, libraries };
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function send(msg: unknown): void {
  process.stdout.write(frameRpc(msg, "json"));
}
