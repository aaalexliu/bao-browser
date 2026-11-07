import { baoUserHome, resolveLibraryIdentity, tildePath, type LibraryIdentity } from "../home";
import { describeWorkflow, getRun, hasHeldRuns, runWorkflow, searchWorkflows } from "./catalog";
import { frameRpc, takeRpcChunk } from "./frame";
import { Library } from "../v1/store";
import { AGENT_BROWSER_COMMANDS, AGENT_BROWSERS, AgentBrowserProxy, type AgentBrowserCommandResult } from "../engines/agent-browser-proxy";
import { supportsViewer, UI_EXTENSION, VIEWER_MIME, VIEWER_RESOURCE, VIEWER_URI, viewerResource } from "./viewer";
import { callViewerTool, isViewerTool, LIST_RUNS_TOOL, VIEWER_TOOLS } from "./viewer-tools";
import { inspectMcpRunView, listRunViews } from "./run-view";
import { BROWSER_RESULT_SCHEMA, browserToolResult } from "./tool-card";
import { createMcpVersionCheck, McpVersionError, MCP_UPDATE_POLL_MS } from "./version";

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
    description: "Steps, input schema, declared outputs, bao:// link, source, and last green time for one workflow. Secret defaults are omitted. Source is this Mac, the device name, or marketplace.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "run_workflow",
    description: "Replay a saved workflow on this device in Bao's own Chrome. Workflows from the retired cdp-live driver fail with a clear reason and do not open Chrome. A workflow on another device or a marketplace listing is installed here first. Requested workflows run without a separate Bao site or listing approval. A passed run stamps the last green time and returns declared outputs. A human step returns needs_human or needs_signin with ask, deadline, and resume_token. Pass that token to continue the same run. cancel stops it with nothing applied.",
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
    description: "Read one replay outcome or browser capture by run id, including its current status and declared outputs when the workflow has them. A bot check or a session that expired is needs_human, with the reason and pageClass.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"] },
  },
  LIST_RUNS_TOOL,
] as const;

const AGENT_BROWSER_TOOL = {
  name: "agent_browser",
  description: "Run an agent-browser command with its native arguments. Ordinary commands return exact native stdout/stderr in content; owner handoffs return Bao's wait status. In MCP Apps hosts, the primary human view is an annotated page card, with native output and errors in text blocks after its caption. Commands: open, snapshot, click, fill, press, scroll, tab, screenshot, wait_for_owner, close. When sign-in or a human check halts a command, keep this session open and call command=wait_for_owner args=[\"60000\"]. Repeat waiting replies without ending your turn; on ready take a fresh snapshot and continue in this same window. The optional timeout is 1-120000 milliseconds, below a 180-second MCP limit. On closed, report the returned session-ended instruction. While waiting Bao reads only URL and title, not snapshots, text, fields, or screenshots. A page with unchanged URL/title stays waiting. Use args as an argv array, for example command=fill args=[\"@e1\",\"hello\"] or command=tab args=[\"t2\"]. Start with open. Choose browser=copy (default) for a fresh marked Chrome profile copy, or browser=bao for Bao's lasting browser profile. Bao silently imports the requested site's sign-in from the Chrome profile selected in Settings (Default when unset) when the Bao profile needs it. Bao keeps sign-ins and site data across bao sessions. Choose browser=current only on the first open to drive the owner's own running Chrome, not a copy. BaoOSHelper uses its existing Accessibility access to enable debugging and press Allow; no Screen Recording or Automation grant is needed. Current Chrome opens a new task tab. Stay in the current session's task tab, which shares the owner's sign-ins; use another tab only when the owner asks. A native daemon restart opens a new task tab and loses prior tab selection and refs; navigate that task tab again, then take a fresh snapshot. If the owner's Chrome connection ends unexpectedly, the next open must explicitly choose browser=current to reconnect or browser=copy or browser=bao; omitting browser never silently switches that ended session to a copy. finish_task, close, and agent exit close only Bao-created task tabs and disconnect; they never quit the owner's Chrome or close pre-existing tabs. Later calls inherit the browser choice. Close before changing browser. All choices use installed Google Chrome in a visible window. For browser=copy, open returns native tab list output including restored tabs; pick the signed-in copied tab with tab <id>. Bao-profile sessions also return the native tab list. close ends the session and deletes a copy; the Bao profile stays. Agent exit also closes it unless Keep window open after agent finishes is on in Bao Settings. A new session closes any kept window first. This route needs no running Bao app. Sign-in/check pages show an owner-wait banner and omit screenshots. Each session records commands, native results, and screenshots in Bao's Library Runs. End each task with finish_task and a checked outcome and reason before your final reply, instead of close. Do not finish an owner wait or confirmation hold. It honors Keep window open after agent finishes and leaves MCP running for the next task. A final chat reply alone cannot end a long-lived MCP session. It does not redact. finish_task also saves a replayable workflow for a successful single-document task using open, click, fill, and press. Its result gives the workflow id or a one-line reason it was not saved. Second tabs, popups, stateful scroll, missing targets, and failed tasks remain capture-only. Replay uses run_workflow with the current engine, not the native pass-through. Bao does not block final clicks.",
  inputSchema: {
    type: "object", properties: {
      command: { type: "string", enum: AGENT_BROWSER_COMMANDS },
      args: { type: "array", items: { type: "string" }, default: [] },
      browser: { type: "string", enum: AGENT_BROWSERS, description: "On first open: copy makes a fresh Chrome copy; bao keeps a lasting Bao profile and imports missing site sign-ins; current drives the owner's own running Chrome. Default: copy." },
    }, required: ["command"], additionalProperties: false,
  },
} as const;

const FINISH_TASK_TOOL = {
  name: "finish_task",
  description: "Finish the current Bao browser task before your final reply, whether it succeeded, failed, or was cancelled. Use this, not agent_browser close, to end a task. It also saves an eligible workflow. If the browser session already closed, it applies the outcome to the most recent run only if that run has no outcome yet. Supply passed or failed and a short reason based on what you verified. This finalizes the Library run and closes the browser session while keeping this MCP client available for the next task. Keep window open after agent finishes in Bao Settings leaves an owned window open but still ends recording. For current Chrome, only Bao-created task tabs close; the owner's tabs and Chrome stay open. Do not finish during wait_for_owner, sign-in handoffs, or a pending owner confirmation. MCP has no conversation-turn-end event, so a final chat reply alone cannot end the task. Client disconnect also finalizes any open run. Call get_run with the returned run_id to read the saved receipt.",
  inputSchema: {
    type: "object", properties: {
      outcome: { type: "string", enum: ["passed", "failed"] },
      reason: { type: "string", minLength: 1 },
    }, required: ["outcome", "reason"], additionalProperties: false,
  },
} as const;

export const TOOLS = [...CATALOG_TOOLS, AGENT_BROWSER_TOOL, FINISH_TASK_TOOL];

export const TOOL_NAMES = TOOLS.map((tool) => tool.name);

export const INSTRUCTIONS = [
  "Call finish_task with outcome=passed or failed and a short reason before your final answer whenever a Bao browser task ends, including a cancelled or unsuccessful task. Do not rely on the conversation ending: long-lived MCP clients have no turn-end event. finish_task ends recording, returns the saved run receipt, and releases the browser session without stopping MCP. It honors Keep window open after agent finishes; explicit agent_browser close overrides that setting. Do not finish while waiting for owner input, sign-in, or confirmation. No idle timer ends those waits.",
  "For direct agent-browser control, use agent_browser with its native command and args array. Start with open. On open choose browser=copy (default) for a fresh marked Chrome copy or browser=bao for a lasting Bao profile with automatic site sign-in import. For browser=copy, inspect the returned tab list and select the signed-in copied tab with tab <id>. Bao-profile sessions also return the native tab list. On first open, browser=current drives the owner's own running Chrome. Bao's helper enables debugging and presses Allow through existing Accessibility access, without Screen Recording or Automation. For browser=current, stay in the new task tab, which shares the owner's sign-ins; use another tab only when the owner asks. A native daemon restart opens a new task tab; navigate that task tab again and take a fresh snapshot. finish_task, close, and agent exit close only Bao-created task tabs and disconnect, leaving the owner's Chrome and pre-existing tabs open. Later calls inherit the browser choice. Close before changing browser. close removes a copy but keeps the Bao profile. Both use visible installed Google Chrome. Each session records commands, native results, and screenshots in Bao's Library Runs. Sign-in or a human check returns halted with an instruction to call agent_browser command=wait_for_owner args=[\"60000\"]. Keep calling it on waiting; do not end your turn or restart. On ready take a fresh snapshot and continue in this same session. On closed report the returned session-ended instruction. If the owner's Chrome session ended unexpectedly, reconnect with open and browser=current or explicitly choose browser=copy or browser=bao; do not silently start a copy. While waiting only URL and title are read, and no page pictures or content are saved. This path otherwise does not redact. End the task with finish_task instead of close. A successful, representable single-document task saves a workflow; finish_task returns its id or the reason it was not saved. Never claim a workflow exists without that saved result. It needs no running Bao app. Bao does not block final clicks.",
  "In MCP Apps hosts, agent_browser shows a page picture and caption. Exact native stdout/stderr, snapshot refs, and thrown errors remain in content blocks after the caption, followed by a short run_id and step_id block, then a workflow save notice when the session ends. structuredContent contains only command, status, run_id, step_id, and optional error metadata, not another copy of native output. Picture bytes are fetched separately by the app and never included in ordinary agent_browser results. A visual result includes run_id: use get_run with that id when asked to show the session, not filesystem access. finish_task saves a successful single-document task as a WorkflowV2 for open, click, fill, and press when every action has a durable target. Its result says saved with its id, or not saved with the reason. Stateful scroll, second tabs, popups, unsupported options, and missing targets remain capture-only.",
  "Use Bao's tools to find and read runs and workflows, not filesystem browsing. Catalog replies identify library.active, the one Library Bao uses for search, get_run, and replay. library.inactive lists other roots with data, their contents, and the latest data-file update time; Bao does not use or search those roots. Nothing is merged or migrated. search_workflows, describe_workflow, run_workflow, list_runs, and get_run work on saved workflows and runs. get_run also reads browser capture sessions. Workflows from the retired live driver cannot replay. Workflows saved from pass-through tasks replay through run_workflow on the current engine, not through the native pass-through.",
].join("\n");

interface Context {
  checkVersion(): Promise<void>;
  canStopForUpdate(currentRequest?: boolean): boolean;
  stop(): void;
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
    keepOpen: () => library.settings().keepAgentBrowserOpen === true, hasHold: hasHeldRuns });
  let pending = 0;
  const ctx: Context = { library, identity, proxy, ui: false, checkVersion: createMcpVersionCheck(__filename),
    canStopForUpdate: (currentRequest = false) => pending === (currentRequest ? 1 : 0) && !proxy.hasSession() && !hasHeldRuns(),
    stop: () => stop() };
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
      pending++;
      chain = chain.then(() => handle(msg, ctx)).catch((err: unknown) => {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      }).finally(() => {
        releaseClose?.();
        pending--;
      });
    }
  });
  // End proxy ownership immediately; queued catalog work can outlast cleanup.
  // After stdin closes, catalog work finishes and saves with no cap.
  // SIGTERM, SIGINT, and SIGHUP cap that wait at 15 s, even mid-run.
  const end = (): void => {
    if (ending) return;
    ending = true;
    clearInterval(versionPoll);
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
  const versionPoll = setInterval(() => {
    void ctx.checkVersion().catch((error: unknown) => {
      if (error instanceof McpVersionError && ctx.canStopForUpdate()) {
        process.stderr.write(`${error.message}\n`);
        stop();
      }
    });
  }, MCP_UPDATE_POLL_MS);
  versionPoll.unref();
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
  if ((msg.method === "tools/list" || msg.method === "tools/call") &&
      !(msg.method === "tools/call" && (msg.params?.name === "finish_task" || msg.params?.name === "agent_browser" && msg.params.arguments?.command === "close"))) {
    try { await ctx.checkVersion(); }
    catch (error) {
      if (!(error instanceof McpVersionError) || ctx.canStopForUpdate(true)) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
        if (error instanceof McpVersionError) ctx.stop();
        return;
      }
    }
  }
  if (msg.method === "tools/list") {
    const tools = ctx.ui ? [
      ...TOOLS.map((tool) => ({ ...tool, ...(tool.name === "agent_browser" ? { outputSchema: BROWSER_RESULT_SCHEMA } : {}), _meta: { ui: { visibility: tool.name === "list_runs" ? ["model", "app"] : ["model"], ...(["get_run", "list_runs", "agent_browser"].includes(tool.name) ? { resourceUri: VIEWER_URI } : {}) } } })),
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
      let result;
      if (ctx.ui && isViewerTool(name)) result = callViewerTool(ctx.library, name, args);
      else if (name === "agent_browser") result = await proxyTool(args, ctx);
      else if (name === "finish_task") {
        if ((args.outcome !== "passed" && args.outcome !== "failed") || typeof args.reason !== "string" || !args.reason.trim()) {
          throw new Error("finish_task requires outcome passed or failed and a non-empty reason");
        }
        const runId = await ctx.proxy.finishTask({ outcome: args.outcome, reason: args.reason.trim() });
        const receipt = runId ? getRun(ctx.library, runId) : { outcome: "no_session", reason: "No browser task is open." };
        result = { content: [{ type: "text", text: JSON.stringify(withLibrary({ ...receipt, workflow: ctx.proxy.lastWorkflowOutcome }, ctx.identity)) }], isError: false };
      }
      else {
        const data = await callTool(ctx.library, ctx.identity, name, args);
        result = { content: [{ type: "text", text: JSON.stringify(data) }], isError: false,
          ...(ctx.ui && name === "list_runs" ? { _meta: { baoViewer: data } } : {}) };
      }
      if (ctx.ui && name === "get_run") {
        try {
          send({ jsonrpc: "2.0", id: msg.id, result: { ...result, _meta: { baoViewer: inspectMcpRunView(ctx.library, args) } } });
        } catch {
          // A missing/oversized viewer record must not change the existing text receipt.
          send({ jsonrpc: "2.0", id: msg.id, result });
        }
      } else send({ jsonrpc: "2.0", id: msg.id, result });
    } catch (err) {
      const message = ctx.ui && (isViewerTool(name) || name === "list_runs")
        ? "Bao viewer data unavailable: invalid request, missing, linked, or oversized record. Open Bao desktop for local details."
        : err instanceof Error ? err.message : String(err);
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: CATALOG_TOOLS.some((tool) => tool.name === name)
          ? JSON.stringify(withLibrary({ error: message }, ctx.identity)) : message }], isError: true },
      });
    }
    return;
  }
  if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
}

async function proxyTool(args: Record<string, unknown>, ctx: Context) {
  const activeRunId = ctx.proxy.activeRunId;
  let results: AgentBrowserCommandResult[] = [];
  let error: string | undefined;
  try { results = await ctx.proxy.execute(args.command, args.args, args.browser, ctx.ui); }
  catch (cause) {
    if (!ctx.ui) {
      if (ctx.proxy.lastWorkflowOutcome) throw new Error(`${cause instanceof Error ? cause.message : String(cause)}\n${ctx.proxy.lastWorkflowOutcome}`);
      throw cause;
    }
    results = ctx.proxy.lastCommand?.step.native.results ?? [];
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const notice = ctx.proxy.lastWorkflowOutcome ? [{ type: "text" as const, text: ctx.proxy.lastWorkflowOutcome }] : [];
  if (!ctx.ui) return {
    content: [...(args.browser === "current" ? [{ type: "text", text: "Current Chrome: this drives the owner's own Chrome, not a profile copy. finish_task and close end only Bao-created task tabs and disconnect; the owner's Chrome and pre-existing tabs stay open." }] : []), ...results.flatMap((result) => [result.stdout, result.stderr].filter((text) => text.length > 0).map((text) => ({ type: "text", text }))), ...notice],
    isError: results.some((result) => result.exitCode !== 0),
  };
  const result = browserToolResult(String(args.command || ""), results, ctx.proxy.lastCommand, ctx.proxy.activeRunId ?? activeRunId, error);
  return { ...result, content: [...result.content, ...notice] };
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
  if (name === "list_runs") return withLibrary(listRunViews(library, args), identity);
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
