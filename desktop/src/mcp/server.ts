import { baoUserHome, otherLibraries, resolveHome, tildePath } from "../home";
import { describeWorkflow, getRun, runWorkflow, searchWorkflows } from "./catalog";
import { frameRpc, takeRpcChunk } from "./frame";
import { Library } from "../v1/store";
import { AGENT_BROWSER_COMMANDS, AgentBrowserProxy } from "../engines/agent-browser-proxy";

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
    description: "Replay a saved workflow on this device in Bao's own Chrome. Workflows from the retired cdp-live driver fail with a clear reason and do not open Chrome. A workflow on another device or a marketplace listing is installed here first. A listing that has not been allowed returns needs_approval. A passed run stamps the last green time and returns declared outputs. A human step returns needs_human or needs_signin with ask, deadline, and resume_token. Pass that token to continue the same run. cancel stops it with nothing applied.",
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
  "search_workflows, describe_workflow, run_workflow, and get_run work on saved workflows. Workflows from the retired live driver cannot replay. Replay on the pass-through is not yet available.",
].join("\n");

interface Context {
  library: Library;
  libraries: string[] | undefined;
  proxy: AgentBrowserProxy;
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
  const library = new Library(home);
  const proxy = new AgentBrowserProxy({ home, sourceRoot: env.BAO_AGENT_BROWSER_PROFILE_ROOT, directory: library.settings().chromeProfile,
    keepOpen: () => library.settings().keepAgentBrowserOpen === true });
  const ctx: Context = { library, libraries, proxy };
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
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await new Promise(() => {});
}

async function handle(msg: Rpc, ctx: Context): Promise<void> {
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
      const result = name === "agent_browser"
        ? await proxyTool(args, ctx.proxy)
        : { content: [{ type: "text", text: JSON.stringify(await callTool(ctx.library, ctx.libraries, name, args)) }], isError: false };
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

async function proxyTool(args: Record<string, unknown>, proxy: AgentBrowserProxy) {
  const results = await proxy.execute(args.command, args.args);
  return {
    content: results.flatMap((result) => [result.stdout, result.stderr].filter((text) => text.length > 0).map((text) => ({ type: "text", text }))),
    isError: results.some((result) => result.exitCode !== 0),
  };
}

async function callTool(library: Library, libraries: string[] | undefined, name: string, args: Record<string, unknown>): Promise<unknown> {
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
    });
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
