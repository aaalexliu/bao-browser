import { baoUserHome, resolveLibraryIdentity, tildePath, type LibraryIdentity } from "../home";
import { describeWorkflow, getRun, runWorkflow, searchWorkflows } from "./catalog";
import { frameRpc, takeRpcChunk } from "./frame";
import { Library } from "../v1/store";
import { AGENT_BROWSER_COMMANDS, AgentBrowserProxy } from "../engines/agent-browser-proxy";
import { supportsViewer, UI_EXTENSION, VIEWER_MIME, VIEWER_RESOURCE, VIEWER_URI, viewerResource } from "./viewer";
import { callViewerTool, isViewerTool, VIEWER_TOOLS } from "./viewer-tools";
import { inspectRunView } from "./run-view";

interface Rpc {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown>; capabilities?: unknown; uri?: string };
}

const CATALOG_TOOLS = [
  {
    name: "search_workflows",
    description: "Find workflows through Bao, not by browsing folders. Search the active Library on this Mac, workflows synced from your other devices, and installed marketplace listings. At most 5 hits. Each hit includes its input schema, a source (this Mac, the device name, or marketplace), and the last green time. A marketplace time this Mac has not replayed is labeled publisher green. Equal relevance ranks this Mac, then another device, then marketplace.",
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
    description: "Read a workflow through Bao, not by browsing folders. Steps, input schema, declared outputs, bao:// link, source, and last green time for one workflow. Secret defaults are omitted. Source is this Mac, the device name, or marketplace.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "run_workflow",
    description: "Replay a saved workflow from the active Library on this device in Bao's own Chrome. Use Bao's tools to find workflows, not folder browsing. Workflows from the retired cdp-live driver fail with a clear reason and do not open Chrome. A workflow on another device or a marketplace listing is installed here first. A listing that has not been allowed returns needs_approval. A passed run stamps the last green time and returns declared outputs. A human step returns needs_human or needs_signin with ask, deadline, and resume_token. Pass that token to continue the same run. cancel stops it with nothing applied.",
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
    description: "Read a run from the active Library through Bao, not by browsing folders. Pass its run id to read the outcome, including declared outputs when the workflow has them. A bot check or a session that expired is needs_human, with the reason and pageClass.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"] },
  },
] as const;

const AGENT_BROWSER_TOOL = {
  name: "agent_browser",
  description: "Run an agent-browser command with its native arguments. Ordinary commands return native output; owner handoffs return Bao's wait status. Commands: open, snapshot, click, fill, press, scroll, tab, screenshot, wait_for_owner, close. When sign-in or a human check halts a command, keep this session open and call command=wait_for_owner args=[\"60000\"]. Repeat waiting replies without ending your turn; on ready take a fresh snapshot and continue in this same window. The optional timeout is 1-120000 milliseconds, below a 180-second MCP limit. On closed, report that the owner closed the window. While waiting Bao reads only URL and title, not snapshots, text, fields, or screenshots. A page with unchanged URL/title stays waiting. Use args as an argv array, for example command=fill args=[\"@e1\",\"hello\"] or command=tab args=[\"t2\"]. Bao fixes one session, installed Google Chrome, a visible window, and a marked copy of the Chrome profile selected in Settings (Default when unset). Start with open. After open, native tab list output includes every restored tab on the site's host; pick the signed-in tab with tab <id>. close ends the session and deletes the copy. Agent exit also closes it unless Keep window open after agent finishes is on in Bao Settings. A new session closes any kept window first. This route needs no running Bao app. Sign-in/check pages show an owner-wait banner and omit screenshots. Each session records commands, native results, and screenshots in Bao's Library Runs. It does not redact or save a workflow. Bao does not block final clicks.",
  inputSchema: {
    type: "object", properties: {
      command: { type: "string", enum: AGENT_BROWSER_COMMANDS },
      args: { type: "array", items: { type: "string" }, default: [] },
    }, required: ["command"], additionalProperties: false,
  },
} as const;

export const TOOLS = [...CATALOG_TOOLS, AGENT_BROWSER_TOOL];

export const TOOL_NAMES = TOOLS.map((tool) => tool.name);

export const INSTRUCTIONS = [
  "For direct agent-browser control, use agent_browser with its native command and args array. Start with open, inspect the returned tab list, and select the signed-in tab with tab <id>. Bao uses a marked profile copy in visible installed Google Chrome. close removes the copy. Each session records commands, native results, and screenshots in Bao's Library Runs. Sign-in or a human check returns halted with an instruction to call agent_browser command=wait_for_owner args=[\"60000\"]. Keep calling it on waiting; do not end your turn or restart. On ready take a fresh snapshot and continue in this same session. On closed report that the owner closed the window. While waiting only URL and title are read, and no page pictures or content are saved. This path otherwise does not redact or save a workflow. It needs no running Bao app. Bao does not block final clicks.",
  "Use Bao's tools to find and read runs and workflows, not filesystem browsing. Catalog replies identify library.active, the one Library Bao uses for search, get_run, and replay. library.inactive lists other roots with data, their contents, and the latest data-file update time; Bao does not use or search those roots. Nothing is merged or migrated. search_workflows, describe_workflow, run_workflow, and get_run work on saved workflows and runs. Workflows from the retired live driver cannot replay. Replay on the pass-through is not yet available.",
].join("\n");

interface Context {
  library: Library;
  identity: LibraryIdentity;
  proxy: AgentBrowserProxy;
  ui: boolean;
}

export async function mcpMain(args: readonly string[] = []): Promise<void> {
  const env = { ...process.env };
  const identity = resolveLibraryIdentity(args);
  const home = identity.active.path;
  process.env.BAO_HOME = home;
  if (process.env.BAO_MCP_LIVE === "1") {
    const { liveMcpMain } = await import("../eval/live-mcp");
    await liveMcpMain();
    return;
  }
  let ending = false;
  const library = new Library(home);
  const proxy = new AgentBrowserProxy({ home, sourceRoot: env.BAO_AGENT_BROWSER_PROFILE_ROOT, directory: library.settings().chromeProfile,
    keepOpen: () => library.settings().keepAgentBrowserOpen === true });
  const ctx: Context = { library, identity, proxy, ui: false };
  let buf = Buffer.alloc(0);
  let chain = Promise.resolve();
  process.stdin.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const next = takeRpcChunk(buf, null);
      if (!next) return;
      buf = Buffer.from(next.rest);
      let msg: Rpc;
      try { msg = JSON.parse(next.body) as Rpc; }
      catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        continue;
      }
      let releaseClose: (() => void) | undefined;
      if (msg?.method === "tools/call" && msg.params?.name === "agent_browser" && msg.params.arguments?.command === "close") {
        try {
          const { args = [] } = msg.params.arguments;
          releaseClose = ctx.proxy.queueClose(args);
          if (ending) void ctx.proxy.end(true).catch((error: unknown) => {
            process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
          });
        } catch {}
      }
      chain = chain.then(() => handle(msg, ctx)).catch((err: unknown) => {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      }).finally(releaseClose);
    }
  });
  // End proxy ownership immediately; queued catalog work can outlast cleanup.
  // After stdin closes, catalog work finishes and saves with no cap.
  // SIGTERM, SIGINT, and SIGHUP cap that wait at 15 s, even mid-run.
  const end = (): void => {
    if (ending) return;
    ending = true;
    const proxyEnd = ctx.proxy.end();
    void Promise.all([proxyEnd, chain])
      .catch((error: unknown) => process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`))
      .finally(async () => {
        try { await ctx.proxy.end(); }
        catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); }
        finally { process.exit(0); }
      });
  };
  const stop = (): void => {
    setTimeout(() => process.exit(0), 15_000).unref();
    end();
  };
  process.stdin.on("end", end);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", stop);
  await new Promise(() => {});
}

async function handle(msg: Rpc, ctx: Context): Promise<void> {
  if (msg.method === "initialize") {
    ctx.ui = supportsViewer(msg.params?.capabilities);
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: ctx.ui ? { tools: {}, resources: {}, extensions: { [UI_EXTENSION]: { mimeTypes: [VIEWER_MIME] } } } : { tools: {} },
        serverInfo: { name: "bao", version: "0.2.0" },
        instructions: INSTRUCTIONS,
      },
    });
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    const tools = ctx.ui ? [
      ...TOOLS.map((tool) => ({ ...tool, _meta: { ui: { visibility: ["model"], ...(tool.name === "get_run" ? { resourceUri: VIEWER_URI } : {}) } } })),
      ...VIEWER_TOOLS,
    ] : TOOLS;
    send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
    return;
  }
  if (ctx.ui && msg.method === "resources/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { resources: [VIEWER_RESOURCE] } });
    return;
  }
  if (ctx.ui && msg.method === "resources/read") {
    if (msg.params?.uri !== VIEWER_URI) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32002, message: "resource not found" } });
    else send({ jsonrpc: "2.0", id: msg.id, result: viewerResource() });
    return;
  }
  if (msg.method === "tools/call") {
    const name = msg.params?.name || "";
    const args = msg.params?.arguments || {};
    try {
      const result = ctx.ui && isViewerTool(name)
        ? callViewerTool(ctx.library, name, args)
        : name === "agent_browser"
        ? await proxyTool(args, ctx.proxy)
        : { content: [{ type: "text", text: JSON.stringify(await callTool(ctx.library, ctx.identity, name, args)) }], isError: false };
      if (ctx.ui && name === "get_run") {
        try {
          send({ jsonrpc: "2.0", id: msg.id, result: { ...result, _meta: { baoViewer: inspectRunView(ctx.library, args) } } });
        } catch {
          // A missing/oversized viewer record must not change the existing text receipt.
          send({ jsonrpc: "2.0", id: msg.id, result });
        }
      } else send({ jsonrpc: "2.0", id: msg.id, result });
    } catch (err) {
      const message = ctx.ui && isViewerTool(name)
        ? "Bao viewer data unavailable: invalid request, missing, linked, or oversized record. Open Bao desktop for local details."
        : err instanceof Error ? err.message : String(err);
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

async function proxyTool(args: Record<string, unknown>, proxy: AgentBrowserProxy) {
  const results = await proxy.execute(args.command, args.args);
  return {
    content: results.flatMap((result) => [result.stdout, result.stderr].filter((text) => text.length > 0).map((text) => ({ type: "text", text }))),
    isError: results.some((result) => result.exitCode !== 0),
  };
}

async function callTool(library: Library, identity: LibraryIdentity, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === "search_workflows") {
    const filters = args.filters && typeof args.filters === "object" ? args.filters as Record<string, unknown> : args;
    return withLibrary({
      damagedWorkflows: library.list().damagedWorkflows,
      hits: await searchWorkflows(library, String(args.query || ""), {
        source: stringArg(filters.source),
        site: stringArg(filters.site),
        category: stringArg(filters.category),
      }),
    }, identity);
  }
  if (name === "describe_workflow") return withLibrary(await describeWorkflow(library, String(args.id || "")), identity);
  if (name === "run_workflow") {
    const result = await runWorkflow(library, {
      id: args.id ? String(args.id) : undefined,
      inputs: args.inputs && typeof args.inputs === "object" ? args.inputs as Record<string, string | number> : {},
      resume: args.resume ? String(args.resume) : undefined,
      rerun: args.rerun === true,
      cancel: args.cancel === true,
    });
    return withLibrary(result, identity);
  }
  if (name === "get_run") return withLibrary(getRun(library, String(args.run_id || "")), identity);
  throw new Error("unknown tool");
}

function withLibrary(result: object, identity: LibraryIdentity): object {
  const prefix = baoUserHome();
  return { ...result, library: {
    active: { path: tildePath(identity.active.path, prefix) },
    inactive: identity.inactive.map((item) => ({ ...item, path: tildePath(item.path, prefix) })),
  } };
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function send(msg: unknown): void {
  process.stdout.write(frameRpc(msg, "json"));
}
