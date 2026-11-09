import { baoUserHome, resolveLibraryIdentity, tildePath, type LibraryIdentity } from "../home";
import { describeWorkflow, getRun, hasHeldRuns, peekResume, runWorkflow, searchWorkflows } from "./catalog";
import { frameRpc, takeRpcChunk } from "./frame";
import { Library } from "../v1/store";
import { AGENT_BROWSER_COMMANDS, AgentBrowserProxy, type AgentBrowserCommandResult } from "../engines/agent-browser-proxy";
import { BROWSER_CHOICES, BROWSER_CHOICE_DESCRIPTION, DEFAULT_BROWSER, PROFILE_DESCRIPTION, browserChoice, type BrowserChoice } from "../browser-choice";
import { supportsViewer, UI_EXTENSION, VIEWER_MIME, VIEWER_RESOURCE, VIEWER_URI, viewerResource } from "./viewer";
import { callViewerTool, isViewerTool, LIST_RUNS_TOOL, VIEWER_TOOLS } from "./viewer-tools";
import { finishCardFor, inspectMcpRunView, listRunViews } from "./run-view";
import { BROWSER_RESULT_SCHEMA, browserToolResult, finishToolResult, pageShotLine, profileQuestionResult, stepSentence, textToolResult } from "./tool-card";
import { ChromeProfileQuestion } from "../engines/browser-pick";
import { createMcpVersionCheck, McpVersionError, MCP_UPDATE_POLL_MS } from "./version";
import { baoVersion } from "../app/bundle";

interface Rpc {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown>; capabilities?: unknown; uri?: string };
}

const CATALOG_TOOLS = [
  {
    name: "search_workflows",
    description: "Find workflows through Bao, not by browsing folders. Search the active Library on this Mac, workflows synced from your other devices, and installed marketplace listings. At most 5 hits. Each hit includes its input schema, a source (this Mac, the device name, or marketplace), and the last green time. A marketplace time this Mac has not replayed is labeled publisher green. Equal relevance ranks this Mac, then another device, then marketplace. An input with saved true is optional: omit it and Bao fills the owner's saved value. The saved text is not in the schema. An imported workflow keeps the author's values required until the owner saves his own.",
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
    description: "Steps, input schema, declared outputs, bao:// link, source, and last green time for one workflow. Secret defaults are omitted. An input with saved true is optional: omit it and Bao fills the owner's saved value. The saved text is not in the schema. An imported workflow keeps the author's values required until the owner saves his own. Source is this Mac, the device name, or marketplace.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "run_workflow",
    description: BROWSER_CHOICE_DESCRIPTION + " Name the Chrome profile folder with profile, such as profile=\"Default\"; without it, run_workflow uses the one picked in Bao Settings, or the only one. With several and none named or picked, it opens nothing and fails with the profiles, their names and emails, and the call to retry. On browser=bao, a Chrome without readable profiles runs with no sign-in import. Replay a saved workflow on this device in the selected browser. Omit inputs marked saved. Bao fills those saved values and names them in savedValues. A saved password is listed as saved password, never the value. Author values on an imported workflow stay required until the owner saves his own. Workflows from the retired cdp-live driver fail with a clear reason and do not open Chrome. A workflow on another device or a marketplace listing is installed here first. Requested workflows run without a separate Bao site or listing approval. A passed run stamps the last green time and returns declared outputs. A human step returns needs_human or needs_signin with ask, deadline, and resume_token. Pass that token to continue the same run. A run that fails at a sign-in, password, or log-in step also returns needs_signin, with no deadline. Its token starts a fresh run with the same inputs once the owner has signed in. cancel stops it with nothing applied. A result that opened a browser lists in browser the route, the Chrome app path, the user-data-dir, and the Chrome profile, and why Bao chose them, and each sign-in import; a failed open names what Bao tried, and a resumed held run names the route and profile in one line. When a Bao profile or copy stops at a sign-in or check, browser also gives the exact run_workflow calls to fall back to browser=current on the same Chrome profile. Bao never switches routes on its own.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        inputs: { type: "object", description: "Omit an owner-saved input. Bao fills it. Author values on an imported workflow are required until the owner saves his own." },
        resume: { type: "string" },
        rerun: { type: "boolean" },
        cancel: { type: "boolean" },
        browser: { type: "string", enum: BROWSER_CHOICES, default: DEFAULT_BROWSER, description: BROWSER_CHOICE_DESCRIPTION },
        profile: { type: "string", description: "The Chrome profile folder, such as Default or Profile 2. It wins over the one picked in Bao Settings." },
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
  description: BROWSER_CHOICE_DESCRIPTION + " Run an agent-browser command with its native arguments. Ordinary commands return exact native stdout/stderr in content; owner handoffs return Bao's wait status. A plain snapshot returns the whole page tree, often 5,000 to 20,000 characters. To keep results short, pass find on snapshot to get only the lines whose text or role matches, each with its ref, the lines that hold it, and everything inside it, such as command=snapshot find={\"text\":\"Sign in\",\"role\":\"button\"}; or pass diff=true on snapshot after an action to get only the lines added (+) or removed (-) since the last snapshot with the same args. Use find to locate what to act on or read, diff to see what an action changed, and a plain snapshot only when you need the whole page. Native snapshot flags such as -i (interactive elements only) and -s <css selector> also narrow it. click, fill, and press results stay one sentence plus native status; a sentence names the new page when the address changed. In MCP Apps hosts, the primary human view is an annotated page card, with native output and errors in text blocks after its caption. Commands: open, snapshot, click, fill, press, scroll, tab, screenshot, wait_for_owner, close. When sign-in or a human check halts a command, keep this session open and call command=wait_for_owner args=[\"60000\"]. Repeat waiting replies without ending your turn; on ready take a fresh snapshot and continue in this same window. Only wait_for_owner continues a wait: an open during an owner wait ends that wait and its session and starts a new task, and Bao also ends a wait and its session when no wait_for_owner call continues it for 30 minutes. The next result names the wait Bao ended. The optional timeout is 1-120000 milliseconds, below a 180-second MCP limit. On closed, report the returned session-ended instruction. While waiting Bao reads only URL and title, not snapshots, text, fields, or screenshots. A page with unchanged URL/title stays waiting. Use args as an argv array, for example command=fill args=[\"@e1\",\"hello\"] or command=tab args=[\"t2\"]. Start with open. Choose browser=bao (default) for Bao's separate lasting agent profile, not the app's Login sites profile. They use different keychains, so sign-ins made in one do not appear in the other. Name the Chrome profile folder with profile on the first open, such as profile=\"Default\"; Bao uses the only one when Chrome has one. With several and none named, open opens nothing and lists them, with names, emails, and the one picked in Bao Settings, and gives the call to retry. Every explicit open checks that Chrome profile for newer site sign-ins. Bao keeps sign-ins and site data across sessions. A recognized login wall retries once with that open's source sign-in; an unreadable source keeps saved Bao state. When a result says macOS did not let Bao read Google Chrome's folder, tell the owner the Files & Folders switch it names; a retry fails the same way until it is on. Choose browser=current only on the first open to drive the owner's own running Chrome over remote debugging, not a copy. BaoOSHelper uses its existing Accessibility access to enable debugging and press Allow; no Screen Recording or Automation grant is needed. The task tab opens in a window of the chosen Chrome profile, never another one: in the background when it is the profile the owner used last, so his active tab and window focus stay as they were, and otherwise in front. Every open result names the route, the Chrome app path, the user-data-dir, and the Chrome profile, and why Bao chose them; a failed open names what Bao tried, and every later result names the route and profile in one line. When a browser=bao session stops at a sign-in or check (a sign-in URL or title, or a snapshot with a sign-in or verification dialog or main heading beside a password field, a code field, or a send-a-code control), and when you call wait_for_owner on it, Bao first moves the session by itself to the owner's running Chrome over remote debugging on the same Chrome profile its sign-in import used, opens the same page there in a task tab, and closes its own window. That result's first sentence says so, the run records it on that step, and the result names the new route; take a fresh snapshot before acting. Do not ask the owner to sign in, enter a code, or clear a check in Bao's window before Bao has tried Running Chrome. When that move fails, the line says why and the session stays in Bao's window; every later wait_for_owner tries Running Chrome again first and waits for the time left, but at least 5 seconds, and halted and waiting results give the exact calls to fall back to browser=current on the same Chrome profile. A wait in Running Chrome is a real wait. When a copy stops at a sign-in or check, the result gives the exact calls to fall back to browser=current on the same Chrome profile; a copy never switches on its own. Stay in the current session's task tab, which shares the owner's sign-ins; use another tab only when the owner asks. Tab lists mark it (Bao task tab) and leave out Chrome's own panels, such as Gemini in Chrome; a tab the task tab opens becomes the current tab. A native daemon restart returns to the task tab but loses refs; take a fresh snapshot. If the owner's Chrome connection ends unexpectedly, the next open must explicitly choose browser=current to reconnect or browser=copy or browser=bao; omitting browser never silently switches that ended session to a copy. finish_task, close, and agent exit close only Bao-created task tabs and disconnect; they never quit the owner's Chrome or close pre-existing tabs. Later calls inherit the browser choice. Close before changing browser. All choices use installed Google Chrome in a visible window. For browser=copy, open loads in Bao's own tab and returns native tab list output including restored tabs; switch to a signed-in restored tab with tab <id> only when the task needs that tab. Bao-profile sessions also return the native tab list. close ends the session and deletes a copy; the Bao profile stays. Agent exit also closes it unless Keep window open after agent finishes is on in Bao Settings. A new session closes any kept window first. No browser choice needs a running Bao app. Sign-in/check pages show an owner-wait banner and omit screenshots. Each session records commands, native results, and screenshots in Bao's Library Runs. End each task with finish_task and a checked outcome and reason before your final reply, instead of close. Do not finish an owner wait or confirmation hold. It honors Keep window open after agent finishes and leaves MCP running for the next task. A final chat reply alone cannot end a long-lived MCP session. It does not redact. finish_task also saves a replayable workflow for a successful single-document task using open, click, fill, and press. Its result gives the workflow id or a one-line reason it was not saved. Second tabs, popups, scrolling, missing targets, and failed tasks remain capture-only. Replay uses run_workflow with the current engine, not the native pass-through. Bao does not block final clicks.",
  inputSchema: {
    type: "object", properties: {
      command: { type: "string", enum: AGENT_BROWSER_COMMANDS },
      args: { type: "array", items: { type: "string" }, default: [] },
      browser: { type: "string", enum: BROWSER_CHOICES, default: DEFAULT_BROWSER, description: "On first open. " + BROWSER_CHOICE_DESCRIPTION },
      profile: { type: "string", description: PROFILE_DESCRIPTION },
      find: { type: "object", description: "Only on snapshot. Return only the lines whose accessible name or value contains text (case-insensitive) and whose role is role, each with its ref, the lines that hold it, and everything inside it. Give text, role, or both.",
        properties: { text: { type: "string" }, role: { type: "string", description: "An accessibility role as the snapshot prints it, such as button, link, textbox, heading, or dialog." } }, additionalProperties: false },
      diff: { type: "boolean", description: "Only on snapshot. Return only the lines added (+) or removed (-) since the last snapshot with the same args in this session, with the lines that hold them. The first such snapshot, or a page that mostly changed, returns the full tree." },
    }, required: ["command"], additionalProperties: false,
  },
} as const;

const FINISH_TASK_TOOL = {
  name: "finish_task",
  description: "Finish the current Bao browser task before your final reply, whether it succeeded, failed, or was cancelled. Use this, not agent_browser close, to end a task. It also saves an eligible workflow. If the browser session is already fully removed, this returns no_session and leaves earlier runs unchanged. Supply passed or failed and a short reason based on what you verified. Optional task is a short name for the run, such as the request you carried out. Omit task when you have no task name. Optional done lists what the task did, one short item per thing, such as each subscription cancelled; Bao shows the list on the finished card. Omit done when there is no list to report. This finalizes the Library run and closes the browser session while keeping this MCP client available for the next task. Keep window open after agent finishes in Bao Settings leaves an owned window open but still ends recording. For current Chrome, only Bao-created task tabs close; the owner's tabs and Chrome stay open. Do not finish during wait_for_owner, sign-in handoffs, or a pending owner confirmation. MCP has no conversation-turn-end event, so a final chat reply alone cannot end the task. Client disconnect also finalizes any open run. Call get_run with the returned run_id to read the saved receipt.",
  inputSchema: {
    type: "object", properties: {
      outcome: { type: "string", enum: ["passed", "failed"] },
      reason: { type: "string", minLength: 1 },
      task: { type: "string", description: "Short name for this run. Omit it when you have no task name." },
      done: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, maxItems: 50,
        description: "What the task did, one short item per thing, such as each subscription cancelled. Omit it when there is no list." },
    }, required: ["outcome", "reason"], additionalProperties: false,
  },
} as const;

export const TOOLS = [...CATALOG_TOOLS, AGENT_BROWSER_TOOL, FINISH_TASK_TOOL];

export const TOOL_NAMES = TOOLS.map((tool) => tool.name);

export const INSTRUCTIONS = [
  "Call finish_task with outcome=passed or failed, a short reason, and optional task as a short name for the run when you have one, before your final answer whenever a Bao browser task ends, including a cancelled or unsuccessful task. Do not rely on the conversation ending: long-lived MCP clients have no turn-end event. finish_task ends recording, returns the saved run receipt, and releases the browser session without stopping MCP. It honors Keep window open after agent finishes; explicit agent_browser close overrides that setting. Do not finish while waiting for owner input, sign-in, or confirmation. No idle timer ends those waits.",
  BROWSER_CHOICE_DESCRIPTION + " For direct agent-browser control, use agent_browser with its native command and args array. Start with open. Name the Chrome profile folder with profile on the first open; with several profiles and none named, open opens nothing and lists them, and with one Bao uses it. Bao checks that Chrome profile on every explicit open, keeps sign-ins across runs, and retries recognized login walls once with the source sign-in. An unreadable source keeps saved Bao state. When a result says macOS did not let Bao read Google Chrome's folder, tell the owner the Files & Folders switch it names; a retry fails the same way until it is on. For browser=copy, open loads in Bao's own tab; switch to a signed-in restored tab with tab <id> only when the task needs that tab. Bao-profile sessions also return the native tab list. On first open, browser=current drives the owner's own running Chrome over remote debugging, in a task tab in a window of the chosen Chrome profile. Bao's helper enables debugging and presses Allow through existing Accessibility access, without Screen Recording or Automation. Every open result names the route, the Chrome app path, the user-data-dir, the Chrome profile, and why; a failed open names what Bao tried, and later results name the route and profile in one line. When a browser=bao session stops at a sign-in or check, including a sign-in or verification dialog Bao reads in a snapshot, or when you call wait_for_owner on it, Bao first moves the session by itself to the owner's running Chrome over remote debugging on the same Chrome profile, opens the same page there, and says so in one line; take a fresh snapshot before acting. Do not ask the owner to clear a check before Bao has tried Running Chrome. If that move fails, the line says why and the owner wait continues in Bao's window; every later wait_for_owner tries Running Chrome again first, and halted and waiting results give the exact calls to fall back to browser=current on the same Chrome profile. When a copy stops at a sign-in or check, the result gives the exact calls to fall back to browser=current on the same Chrome profile; a copy never switches on its own. For browser=current, stay in the new task tab, which shares the owner's sign-ins; use another tab only when the owner asks. Tab lists mark it (Bao task tab) and leave out Chrome's own panels, such as Gemini in Chrome. A native daemon restart returns to the task tab but loses refs; take a fresh snapshot. finish_task, close, and agent exit close only Bao-created task tabs and disconnect, leaving the owner's Chrome and pre-existing tabs open. Later calls inherit the browser choice. Close before changing browser. close removes a copy but keeps the Bao profile. Both use visible installed Google Chrome. Each session records commands, native results, and screenshots in Bao's Library Runs. Sign-in or a human check returns halted with an instruction to call agent_browser command=wait_for_owner args=[\"60000\"]. Keep calling it on waiting; do not end your turn or restart. On ready take a fresh snapshot and continue in this same session. On closed report the returned session-ended instruction. If the owner's Chrome session ended unexpectedly, reconnect with open and browser=current or explicitly choose browser=copy or browser=bao; do not silently start a copy. While waiting only URL and title are read, and no page pictures or content are saved. This path otherwise does not redact. End the task with finish_task instead of close. A successful, representable single-document task saves a workflow; finish_task returns its id or the reason it was not saved. Never claim a workflow exists without that saved result. No browser choice needs a running Bao app. Bao does not block final clicks.",
  "Keep agent_browser results short: after open, use snapshot with find={text, role} to get just the elements you need with their refs, and snapshot with diff=true after a click, fill, or press to see only what changed. Take a plain full snapshot only when you need the whole page.",
  "Every agent_browser result starts with one plain sentence of what the step did, quoting the element's own text from the latest snapshot, such as Clicked \"Save\" (button). In MCP Apps hosts, a card shows that sentence with the page picture and the target boxed; a failed step shows the last picture before it and the page now; an owner wait shows the sign-in or check page's title and address; finish_task shows the run's result and its optional done list. Exact native stdout/stderr (for a snapshot with find or diff, Bao's shorter view of it), snapshot refs, and thrown errors remain in content blocks after the sentence, followed by a short run_id and step_id block, then a workflow save notice when the session ends. structuredContent contains only command, status, run_id, step_id, and optional error metadata, not another copy of native output. Without MCP Apps, a sign-in or check wait returns the sentence, a Run <run_id> · <outcome> line, and the instruction as text, with outcome and instruction in structuredContent. finish_task returns the sentence, a Run <run_id> · <status> · <link> line, and the workflow save result as text, with its full receipt in structuredContent. Picture bytes are fetched separately by the app and never included in ordinary agent_browser results. A visual result includes run_id: use get_run with that id when asked to show the session, not filesystem access. finish_task saves a successful single-document task as a WorkflowV2 for open, click, fill, and press when every action has a durable target. Its result says saved with its id, or not saved with the reason. Scrolling, second tabs, popups, unsupported options, and missing targets remain capture-only.",
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
  const proxy = new AgentBrowserProxy({ home, sourceRoot: env.BAO_AGENT_BROWSER_PROFILE_ROOT, settingsProfile: () => library.settings().chromeProfile,
    extensionRoute: () => library.settings().runningChromeExtension === true,
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
        serverInfo: { name: "bao", version: baoVersion(__filename) },
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
      ...TOOLS.map((tool) => ({ ...tool, ...(tool.name === "agent_browser" ? { outputSchema: BROWSER_RESULT_SCHEMA } : {}), _meta: { ui: { visibility: tool.name === "list_runs" ? ["model", "app"] : ["model"], ...(["get_run", "list_runs", "agent_browser", "finish_task"].includes(tool.name) ? { resourceUri: VIEWER_URI } : {}) } } })),
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
        const task = typeof args.task === "string" ? args.task.trim() : "";
        const done = doneList(args.done);
        const runId = await ctx.proxy.finishTask({ outcome: args.outcome, reason: args.reason.trim(), ...(task ? { task } : {}), ...(done.length ? { done } : {}) });
        const receipt = runId ? getRun(ctx.library, runId) : { outcome: "no_session", reason: "No browser task is open." };
        let card;
        try { card = runId ? finishCardFor(ctx.library, runId) : undefined; }
        catch { card = undefined; }
        result = { ...finishToolResult(card, withLibrary({ ...receipt, workflow: ctx.proxy.lastWorkflowOutcome }, ctx.identity), ctx.ui, ctx.proxy.pickLines),
          ...(ctx.ui && card ? { _meta: { baoToolCard: card } } : {}) };
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
  let browser: BrowserChoice | undefined;
  try {
    browser = args.browser === undefined ? undefined : browserChoice(args.browser);
    results = await ctx.proxy.execute(args.command, args.args, browser, ctx.ui, args.profile, { find: args.find, diff: args.diff });
  }
  catch (cause) {
    if (cause instanceof ChromeProfileQuestion) {
      const asked = profileQuestionResult(cause, { command: "open", ...(Array.isArray(args.args) && args.args.length ? { args: args.args } : {}), ...(browser ? { browser } : {}) }, ctx.ui);
      const ended = ctx.proxy.endedWait;
      return ended ? { ...asked, content: [...asked.content, { type: "text" as const, text: ended }] } : asked;
    }
    if (!ctx.ui) {
      const shot = pageShotLine(ctx.proxy.lastCommand?.step);
      const notice = [...shot ? [shot] : [], ...ctx.proxy.endedWait ? [ctx.proxy.endedWait] : [], ...ctx.proxy.pickLines, ...ctx.proxy.lastWorkflowOutcome ? [ctx.proxy.lastWorkflowOutcome] : []];
      if (notice.length) throw new Error([cause instanceof Error ? cause.message : String(cause), ...notice].join("\n"));
      throw cause;
    }
    results = ctx.proxy.lastCommand?.step.native.results ?? [];
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const picked = ctx.proxy.pickLines;
  const notice = [...ctx.proxy.endedWait ? [ctx.proxy.endedWait] : [], ...picked, ...ctx.proxy.lastWorkflowOutcome ? [ctx.proxy.lastWorkflowOutcome] : []];
  const command = String(args.command || "");
  const facts = { args: Array.isArray(args.args) ? args.args.filter((arg): arg is string => typeof arg === "string") : [], owner: ctx.proxy.ownerPage, current: ctx.proxy.currentChrome };
  if (!ctx.ui) {
    const current = args.browser === "current" ? ["Current Chrome: this drives the owner's own Chrome, not a profile copy. finish_task and close end only Bao-created task tabs and disconnect; the owner's Chrome and pre-existing tabs stay open."] : [];
    const shot = pageShotLine(ctx.proxy.lastCommand?.step);
    return textToolResult(results, stepSentence(command, results, ctx.proxy.lastCommand, undefined, facts), [...shot ? [shot] : [], ...current, ...notice], picked,
      ctx.proxy.lastCommand?.runId ?? ctx.proxy.activeRunId ?? activeRunId);
  }
  const result = browserToolResult(command, results, ctx.proxy.lastCommand, ctx.proxy.activeRunId ?? activeRunId, error, facts);
  return { ...result, content: [...result.content, ...notice.map((text) => ({ type: "text" as const, text }))],
    structuredContent: { ...result.structuredContent, ...picked.length ? { browser: picked } : {} } };
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
    if (args.profile !== undefined && (typeof args.profile !== "string" || !args.profile.trim())) {
      throw new Error("profile must be a Chrome profile folder, such as Default or Profile 2");
    }
    const browser = args.browser === undefined
      ? (args.resume ? peekResume(library, String(args.resume))?.browser : undefined) ?? DEFAULT_BROWSER
      : browserChoice(args.browser);
    const result = await runWorkflow(library, {
      ...typeof args.profile === "string" ? { profile: args.profile.trim() } : {},
      id: args.id ? String(args.id) : undefined,
      inputs: args.inputs && typeof args.inputs === "object" ? args.inputs as Record<string, string | number> : {},
      resume: args.resume ? String(args.resume) : undefined,
      rerun: args.rerun === true,
      cancel: args.cancel === true,
      browser,
      why: args.browser === undefined && browser === DEFAULT_BROWSER ? "the default" : "named by the agent",
    });
    return withLibrary(result, identity);
  }
  if (name === "get_run") return withLibrary(getRun(library, String(args.run_id || "")), identity);
  if (name === "list_runs") return withLibrary(listRunViews(library, args), identity);
  throw new Error("unknown tool");
}

function withLibrary(result: object, identity: LibraryIdentity): Record<string, unknown> {
  const prefix = baoUserHome();
  return { ...result, library: {
    active: { path: tildePath(identity.active.path, prefix) },
    inactive: identity.inactive.map((item) => ({ ...item, path: tildePath(item.path, prefix) })),
  } };
}

function doneList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50 || !value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 200)) {
    throw new Error("finish_task done must be a list of at most 50 non-empty items, each at most 200 characters");
  }
  return value.map((item: string) => item.replace(/\s+/g, " ").trim());
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function send(msg: unknown): void {
  process.stdout.write(frameRpc(msg, "json"));
}
