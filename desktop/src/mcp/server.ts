import { baoUserHome, resolveLibraryIdentity, tildePath, type LibraryIdentity } from "../home";
import { describeWorkflow, getRun, hasHeldRuns, peekResume, runWorkflow, searchWorkflows } from "./catalog";
import { frameRpc, takeRpcChunk } from "./frame";
import { Library } from "../v1/store";
import { AGENT_BROWSER_COMMANDS, AgentBrowserProxy, otherTaskClosed, type AgentBrowserCommandResult } from "../engines/agent-browser-proxy";
import { abandonVideoOnHostStop } from "../engines/agent-browser-record";
import { sweepClaimedVideoFrames } from "../engines/video-handoff";
import { BROWSER_CHOICES, BROWSER_CHOICE_DESCRIPTION, DEFAULT_BROWSER, PROFILE_DESCRIPTION, browserChoice, type BrowserChoice } from "../browser-choice";
import { supportsViewer, UI_EXTENSION, VIEWER_MIME, VIEWER_RESOURCE, VIEWER_URI, viewerResource } from "./viewer";
import { callViewerTool, isViewerTool, LIST_RUNS_TOOL, VIEWER_TOOLS } from "./viewer-tools";
import { finishCardFor, inspectMcpRunView, listRunViews } from "./run-view";
import { BROWSER_RESULT_SCHEMA, browserToolResult, finishToolResult, pageShotLine, profileQuestionResult, runLine, stepSentence, textToolResult } from "./tool-card";
import { ChromeFolderDenied } from "../chrome-access";
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
    description: BROWSER_CHOICE_DESCRIPTION + " Name the Chrome profile folder with profile, such as profile=\"Default\"; without it, run_workflow uses the one picked in Bao Settings, or the only one. With several and none named or picked, it opens nothing and fails with the profiles, their names and emails, and the call to retry. On browser=bao, a Chrome without readable profiles runs with no sign-in import. A run that names no browser runs on Running Chrome; a workflow with a file step runs on browser=bao instead, and when Bao cannot use running Chrome the run uses Bao's own profile, imports no new sign-ins, and says why, unless macOS cannot start apps; then restart the Mac. Replay a saved workflow on this device in the selected browser. Omit inputs marked saved. Bao fills those saved values and names them in savedValues. A saved password is listed as saved password, never the value. Author values on an imported workflow stay required until the owner saves his own. Workflows from the retired cdp-live driver fail with a clear reason and do not open Chrome. A workflow on another device or a marketplace listing is installed here first. Requested workflows run without a separate Bao site or listing approval. A passed run stamps the last green time and returns declared outputs. A human step returns needs_human or needs_signin with ask, deadline, and resume_token. Pass that token to continue the same run. A run that fails at a sign-in, password, or log-in step also returns needs_signin, with no deadline. Its token starts a fresh run with the same inputs once the owner has signed in. cancel stops it with nothing applied. A result that opened a browser lists in browser the route, the Chrome app path, the user-data-dir, and the Chrome profile, and why Bao chose them, and each sign-in import; a failed open, and a profile choice that fails before anything opens, names what Bao tried, and a resumed held run names the route and profile in one line. When a Bao profile or copy stops at a sign-in or check, browser also gives the exact run_workflow calls to fall back to browser=current on the same Chrome profile. Once a run's browser opens, Bao never switches routes on its own.",
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

const RUN_SCOPE = "While a session is open, every command except a new open needs run_id, the run id from this chat's latest agent_browser result. Any command other than open that names another run, or names none, changes nothing and does not name the open run. Pass run_id on open when continuing your own task. An open with no run_id starts a new task and ends any other open task. An open that names a run a newer task ended does not start a new task and does not touch the open session. An open with a stale run id that is not a run a newer task ended still ends the open run and starts a new task. An open that names this run keeps this task and its wait open. Only wait_for_owner continues a wait.";

const AGENT_BROWSER_TOOL = {
  name: "agent_browser",
  description: BROWSER_CHOICE_DESCRIPTION + " Run an agent-browser command with its native arguments. Ordinary commands return exact native stdout/stderr in content; owner handoffs return Bao's wait status. A plain snapshot returns the whole page tree, often 5,000 to 20,000 characters. To keep results short, pass find on snapshot to get only the lines whose text or role matches, each with its ref, the lines that hold it, and everything inside it, such as command=snapshot find={\"text\":\"Sign in\",\"role\":\"button\"}; or pass diff=true on snapshot after an action to get only the lines added (+) or removed (-) since the last snapshot with the same args. Use find to locate what to act on or read, diff to see what an action changed, and a plain snapshot only when you need the whole page. Native snapshot flags such as -i (interactive elements only) and -s <css selector> also narrow it. click, fill, and press results stay one sentence plus native status, then a picture line when the step has no page picture or kept a picture of a different tab; a sentence names the new page when the address changed. The picture line is left out when the step failed to start, the command is close or wait_for_owner, or the page is owner-private. In MCP Apps hosts, the primary human view is an annotated page card, with native output, the picture line, and errors in text blocks after its caption. Commands: open, snapshot, click, fill, press, scroll, tab, screenshot, upload, download, wait_for_owner, close. upload sets files through a page's upload control: command=upload args=[\"<selector>\", \"<file>\", ...]. Target the upload button, its label, or the file input; a ref from snapshot is fine. When the target is not a file input, Bao clicks it with Chrome's file chooser caught, so no macOS file panel opens, and sets the files on the input the chooser belongs to. A file is an absolute path, a ~/ path, or the bare name of a file this run downloaded. download clicks an element and saves the file it gives: command=download args=[\"<selector>\", \"<file name>\"]. Give a plain file name such as statement-2026-10.pdf, not a path; Bao saves it in this run's downloads folder and the result names the full path. When the target is a link, Bao fetches that link with the page's sign-in and does not open a tab, so the owner's tab stays where it was. When that fetch returns a page or an error instead of a file, Bao clicks again so a click handler still runs. When the target is not a link, Bao clicks. When that click makes Chrome show a PDF in its viewer, in this tab or a new one, Bao saves that PDF with the page's sign-in and closes a new tab it opened. Both work on Running Chrome over remote debugging, the Bao profile, and a copy. On Running Chrome, Bao returns the owner's Chrome to its own download settings after each download. Each upload and download step in the run keeps every file's full path, size, and SHA-256, and how Bao moved it. finish_task saves a task that moved files with a note step naming each file by full path; replay does not move those files yet. When sign-in or a human check halts a command, keep this session open and call command=wait_for_owner args=[\"60000\"]. Every result names its run id. " + RUN_SCOPE + " The older chat's next call is told the browser now belongs to another task, so stop and report to the owner. Repeat a waiting reply only while the result still says waiting. On a recognized sign-in or check, do not end your turn; Bao ends that wait and its session when no wait_for_owner call continues it for 30 minutes. The next result names the wait Bao ended. On a page that is not a sign-in or check, the call's deadline ends the wait and the run returns to recording. Once a result says recording, the wait is over and you continue. On ready, take a fresh snapshot and continue in this same window. The optional timeout is 1-120000 milliseconds, below a 180-second MCP limit. On closed, report the returned session-ended instruction. While waiting Bao reads only URL and title, not snapshots, text, fields, or screenshots. On a recognized sign-in or check, a page with unchanged URL/title stays waiting. Use args as an argv array, for example command=fill args=[\"@e1\",\"hello\"] or command=tab args=[\"list\"]. Start with open. Without browser, open uses the owner's own running Chrome. Choose browser=bao for Bao's separate lasting agent profile, not the app's Login sites profile. They use different keychains, so sign-ins made in one do not appear in the other. Name the Chrome profile folder with profile on the first open, such as profile=\"Default\"; Bao uses the only one when Chrome has one. With several and none named, open opens nothing and lists them, with names, emails, and the one picked in Bao Settings, and gives the call to retry. Every explicit open checks that Chrome profile for newer site sign-ins. Bao keeps sign-ins and site data across sessions. A recognized login wall retries once with that open's source sign-in, except on sites that tie their sign-in to the owner's Chrome; an unreadable source keeps saved Bao state. When a result says macOS blocked an app from reading Chrome's data and names a Files & Folders switch, report that sentence. Bao opened that Settings pane. When it names only the blocked app, report that sentence and do not ask the owner to turn on a switch. Running Chrome uses the listening port and the profile that listening Chrome reports when Chrome already listens, and does not guess Default. A named Running Chrome that report does not confirm, or a report that fails, stops with that sentence. A named copy that cannot read the folder stops with that sentence; a default open falls back when nothing listens or the report fails. browser=current drives the owner's own running Chrome over remote debugging, not a copy, and is the default; Bao starts Chrome when it is not open, unless macOS cannot start apps; then restart the Mac. Bao uses its Device Control and Data Access grant to enable debugging and press Allow; no Screen Recording or Automation grant is needed. The task tab opens in a window of the chosen Chrome profile, never another one: in the background when it is the profile the owner used last, so his active tab and window focus stay as they were, and otherwise in front. Every open result names the route, the Chrome app path, the user-data-dir, and the Chrome profile, and why Bao chose them; a failed open names what Bao tried, and every later result names the route and profile in one line. A later open in a browser=bao or browser=copy session of a site that ties its sign-in to the owner's Chrome moves the session there the same way before any import. When a browser=bao session stops at a sign-in or check (a sign-in URL or title, or a snapshot with a sign-in or verification dialog or main heading beside a password field, a code field, or a send-a-code control), and when you call wait_for_owner on it, Bao first moves the session by itself to the owner's running Chrome over remote debugging on the same Chrome profile its sign-in import used, opens the page the session was on before a sign-in or check address, or the page that holds an in-page dialog, in a task tab, and closes its own window. That result's first sentence says so, the run records it on that step, and the result names the new route; take a fresh snapshot before acting. It reopens the page that open asked for when the stop came from an open, except a check found only by its title. A click or later navigation reopens the page before the wall when the wall matched the URL path, and when a sign-in title is on a different host from that page. A check found only by its title, such as a Cloudflare \"Just a moment\" title, and a sign-in title on the same host reopen that wall's own URL. It names the wall's host, not the host of the reopened page. \"a sign-in or verification prompt\" is only for a snapshot that matched an in-page wall. A later wait_for_owner whose page is not a URL or title wall, including a dialog an earlier wait started, says \"a step that needs the owner\", not \"a sign-in or verification prompt\" and not \"a sign-in page\". Do not ask the owner to sign in, enter a code, or clear a check in Bao's window before Bao has tried Running Chrome. When that move fails, the line says why and the session stays in Bao's window; every later wait_for_owner tries Running Chrome again first and waits for the time left, but at least 5 seconds, and halted and waiting results give the exact calls to fall back to browser=current on the same Chrome profile. A wait in Running Chrome is a real wait. When a copy stops at a sign-in or check, the result gives the exact calls to fall back to browser=current on the same Chrome profile; at a sign-in or check, a copy does not switch on its own. Stay in the current session's task tab, which shares the owner's sign-ins. When the owner wants work done on a page he has open, open that page's URL in your task tab (it shares his sign-ins). Tab lists on Running Chrome name only Bao's own task tabs, marked (Bao task tab), and leave out the owner's tabs, other profiles, and Chrome's own panels, such as Gemini in Chrome. A tab opened while the agent's click, open, download, tab new, or press is running becomes the current tab. A tab command on a tab the owner opened is refused. A native daemon restart returns to the task tab but loses refs; take a fresh snapshot. If the owner's Chrome connection ends unexpectedly, the next open must explicitly choose browser=current to reconnect or browser=copy or browser=bao; omitting browser never silently switches that ended session to a copy. If Bao's task tab was closed, start a new session with open and an explicit browser. finish_task, close, and agent exit close only Bao-created task tabs and disconnect; they never quit the owner's Chrome or close pre-existing tabs. Later calls inherit the browser choice. Close before changing browser. All choices use installed Google Chrome in a visible window. For browser=copy, open loads in Bao's own tab and returns native tab list output including restored tabs; switch to a signed-in restored tab with tab <id> only when the task needs that tab. Bao-profile sessions also return the native tab list. close ends the session and deletes a copy; the Bao profile stays. Agent exit also closes it unless Keep window open after agent finishes is on in Bao Settings. A new session closes any kept window first. No browser choice needs a running Bao app. Sign-in/check pages show an owner-wait banner and omit screenshots. Each session records commands, native results, and screenshots in Bao's Library Runs. End each task with finish_task and a checked outcome and reason before your final reply, instead of close. Do not finish an owner wait or confirmation hold. It honors Keep window open after agent finishes and leaves MCP running for the next task. A final chat reply alone cannot end a long-lived MCP session. It does not redact. finish_task also saves a replayable workflow for a successful single-document task using open, click, fill, and press. Its result gives the workflow id or a one-line reason it was not saved. Second tabs, popups, scrolling, missing targets, and failed tasks remain capture-only. Replay uses run_workflow with the current engine, not the native pass-through. Bao does not block final clicks.",
  inputSchema: {
    type: "object", properties: {
      command: { type: "string", enum: AGENT_BROWSER_COMMANDS },
      args: { type: "array", items: { type: "string" }, default: [] },
      browser: { type: "string", enum: BROWSER_CHOICES, default: DEFAULT_BROWSER, description: "On first open. " + BROWSER_CHOICE_DESCRIPTION },
      profile: { type: "string", description: PROFILE_DESCRIPTION },
      find: { type: "object", description: "Only on snapshot. Return only the lines whose accessible name or value contains text (case-insensitive) and whose role is role, each with its ref, the lines that hold it, and everything inside it. Give text, role, or both.",
        properties: { text: { type: "string" }, role: { type: "string", description: "An accessibility role as the snapshot prints it, such as button, link, textbox, heading, or dialog." } }, additionalProperties: false },
      run_id: { type: "string", description: RUN_SCOPE },
      diff: { type: "boolean", description: "Only on snapshot. Return only the lines added (+) or removed (-) since the last snapshot with the same args in this session, with the lines that hold them. The first such snapshot returns the full tree. When most of the page changed, the changed part is too large to compare, or the changed lines are longer than the full tree, the result is the full tree and says why. A few changed lines on a tiny page stay a diff." },
    }, required: ["command"], additionalProperties: false,
  },
} as const;

const FINISH_TASK_TOOL = {
  name: "finish_task",
  description: "Finish the current Bao browser task before your final reply, whether it succeeded, failed, or was cancelled. Use this, not agent_browser close, to end a task. It also saves an eligible workflow. Send back as run_id the run id this chat's latest agent_browser result names. If the browser session is already fully removed, or run_id is not Bao's open session, this returns no_session and leaves every run unchanged. Supply passed or failed and a short reason based on what you verified. Optional task is a short name for the run, such as the request you carried out. Omit task when you have no task name. Optional done lists what the task did, one short item per thing, such as each subscription cancelled; Bao shows the list on the finished card. Omit done when there is no list to report. This finalizes the Library run and closes the browser session while keeping this MCP client available for the next task. Keep window open after agent finishes in Bao Settings leaves an owned window open but still ends recording. For current Chrome, only Bao-created task tabs close; the owner's tabs and Chrome stay open. Do not finish during wait_for_owner, sign-in handoffs, or a pending owner confirmation. MCP has no conversation-turn-end event, so a final chat reply alone cannot end the task. Client disconnect also finalizes any open run. The result the model reads is a short receipt: the outcome sentence, run id, status, link, workflow line, and browser lines, not each step's native output. Call get_run with the returned run_id to read the saved receipt.",
  inputSchema: {
    type: "object", properties: {
      outcome: { type: "string", enum: ["passed", "failed"] },
      reason: { type: "string", minLength: 1 },
      run_id: { type: "string", description: "The run id this chat's latest agent_browser result names. Required while a browser session is open." },
      task: { type: "string", description: "Short name for this run. Omit it when you have no task name." },
      done: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, maxItems: 50,
        description: "What the task did, one short item per thing, such as each subscription cancelled. Omit it when there is no list." },
    }, required: ["outcome", "reason"], additionalProperties: false,
  },
} as const;

export const TOOLS = [...CATALOG_TOOLS, AGENT_BROWSER_TOOL, FINISH_TASK_TOOL];

export const TOOL_NAMES = TOOLS.map((tool) => tool.name);

export const INSTRUCTIONS = [
  "Call finish_task with outcome=passed or failed, a short reason, the run_id your latest agent_browser result names, and optional task as a short name for the run when you have one, before your final answer whenever a Bao browser task ends, including a cancelled or unsuccessful task. Do not rely on the conversation ending: long-lived MCP clients have no turn-end event. finish_task ends recording, returns a short receipt, and releases the browser session without stopping MCP. It honors Keep window open after agent finishes; explicit agent_browser close overrides that setting. Do not finish while waiting for owner input, sign-in, or confirmation. No idle timer ends those waits.",
  BROWSER_CHOICE_DESCRIPTION + " For direct agent-browser control, use agent_browser with its native command and args array. Start with open. " + RUN_SCOPE + " Name the Chrome profile folder with profile on the first open; with several profiles and none named, open opens nothing and lists them, and with one Bao uses it. Without browser, open uses the owner's own running Chrome, and Bao starts Chrome when it is not open, unless macOS cannot start apps; then restart the Mac. On browser=bao, Bao checks that Chrome profile on every explicit open, keeps sign-ins across runs, and retries recognized login walls once with the source sign-in. An unreadable source keeps saved Bao state. When a result says macOS blocked an app from reading Chrome's data and names a Files & Folders switch, report that sentence. Bao opened that Settings pane. When it names only the blocked app, report that sentence and do not ask the owner to turn on a switch. Running Chrome uses the listening port and the profile that listening Chrome reports when Chrome already listens, and does not guess Default. A named Running Chrome that report does not confirm, or a report that fails, stops with that sentence. A named copy that cannot read the folder stops with that sentence; a default open falls back when nothing listens or the report fails. For browser=copy, open loads in Bao's own tab; switch to a signed-in restored tab with tab <id> only when the task needs that tab. Bao-profile sessions also return the native tab list. browser=current drives the owner's own running Chrome over remote debugging, in a task tab in a window of the chosen Chrome profile. Bao's helper enables debugging and presses Allow through Bao's Device Control and Data Access grant, without Screen Recording or Automation. Every open result names the route, the Chrome app path, the user-data-dir, the Chrome profile, and why; a failed open names what Bao tried, and later results name the route and profile in one line. When a browser=bao session stops at a sign-in or check, including a sign-in or verification dialog Bao reads in a snapshot, or when you call wait_for_owner on it, Bao first moves the session by itself to the owner's running Chrome over remote debugging on the same Chrome profile, opens the page the session was on before a sign-in or check address, or the page that holds an in-page dialog, and says so in one line that names the wall's host. It reopens the page that open asked for when the stop came from an open, except a check found only by its title. A click or later navigation reopens the page before the wall when the wall matched the URL path, and when a sign-in title is on a different host from that page. A check found only by its title, such as a Cloudflare \"Just a moment\" title, and a sign-in title on the same host reopen that wall's own URL. An open that lands on a URL wall reopens the page that open asked for. Take a fresh snapshot before acting. \"a sign-in or verification prompt\" is only for a snapshot that matched an in-page wall. A later wait_for_owner whose page is not a URL or title wall, including a dialog an earlier wait started, says \"a step that needs the owner\", not \"a sign-in or verification prompt\" and not \"a sign-in page\". Do not ask the owner to clear a check before Bao has tried Running Chrome. If that move fails, the line says why and the owner wait continues in Bao's window; every later wait_for_owner tries Running Chrome again first, and halted and waiting results give the exact calls to fall back to browser=current on the same Chrome profile. When a copy stops at a sign-in or check, the result gives the exact calls to fall back to browser=current on the same Chrome profile; at a sign-in or check, a copy does not switch on its own. For browser=current, stay in the new task tab, which shares the owner's sign-ins. When the owner wants work done on a page he has open, open that page's URL in your task tab (it shares his sign-ins). A tab command on a tab the owner opened is refused. Tab lists on Running Chrome name only Bao's own task tabs, marked (Bao task tab), and leave out the owner's tabs, other profiles, and Chrome's own panels, such as Gemini in Chrome. A native daemon restart returns to the task tab but loses refs; take a fresh snapshot. finish_task, close, and agent exit close only Bao-created task tabs and disconnect, leaving the owner's Chrome and pre-existing tabs open. Later calls inherit the browser choice. Close before changing browser. close removes a copy but keeps the Bao profile. Both use visible installed Google Chrome. Each session records commands, native results, and screenshots in Bao's Library Runs. Sign-in or a human check returns halted with an instruction to call agent_browser command=wait_for_owner args=[\"60000\"] and send back the run_id that halted or waiting result names. Repeat a waiting reply only while the result still says waiting. On a recognized sign-in or check, do not end your turn or restart; Bao ends that wait if no wait_for_owner call continues it for 30 minutes. On a page that is not a sign-in or check, the call's deadline ends the wait and the run returns to recording. Once a result says recording, the wait is over and you continue. On ready, take a fresh snapshot and continue in this same session. On closed report the returned session-ended instruction. If the owner's Chrome session ended unexpectedly, reconnect with open and browser=current or explicitly choose browser=copy or browser=bao; do not silently start a copy. If Bao's task tab was closed, start a new session with open and an explicit browser. While waiting only URL and title are read, and no page pictures or content are saved. This path otherwise does not redact. End the task with finish_task instead of close. A successful, representable single-document task saves a workflow; finish_task returns its id or the reason it was not saved. Never claim a workflow exists without that saved result. No browser choice needs a running Bao app. Bao does not block final clicks.",
  "Keep agent_browser results short: after open, use snapshot with find={text, role} to get just the elements you need with their refs, and snapshot with diff=true after a click, fill, or press to see only what changed. Take a plain full snapshot only when you need the whole page.",
  "Every agent_browser result starts with one plain sentence of what the step did, quoting the element's own text from the latest snapshot, such as Clicked \"Save\" (button). In MCP Apps hosts, a card shows that sentence with the page picture and the target boxed; a failed step shows the last picture before it and the page now; an owner wait shows the sign-in or check page's title and address; finish_task shows the run's result and its optional done list. Exact native stdout/stderr (for a snapshot with find or diff, Bao's shorter view of it) and snapshot refs remain in content blocks after the sentence. A picture text block follows that output when the step has no page picture or kept a picture of a different tab, unless the step failed to start, the command is close or wait_for_owner, or the page is owner-private. A thrown error follows, then a short run_id and step_id block, then a workflow save notice when the session ends. structuredContent contains only command, status, run_id, step_id, and optional error metadata, not another copy of native output. Without MCP Apps, the sentence is followed by a Run <run_id> line; a sign-in or check wait adds · <outcome> to it and gives the instruction as text, with outcome, instruction, and run_id in structuredContent. finish_task returns the sentence, a Run <run_id> · <status> · <link> line, and the workflow save result as text. structuredContent is a short receipt for the model: that sentence, the run id, status, link, workflow line, and browser lines, not each step's native output. Picture bytes are fetched separately by the app and never included in ordinary agent_browser results. A visual result includes run_id: use get_run with that id when asked to show the session, not filesystem access. finish_task saves a successful single-document task as a WorkflowV2 for open, click, fill, and press when every action has a durable target. Its result says saved with its id, or not saved with the reason. Scrolling, second tabs, popups, unsupported options, and missing targets remain capture-only.",
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
  sweepClaimedVideoFrames(home);
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
          releaseClose = ctx.proxy.queueClose(args, msg.params.arguments.run_id);
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
  // A tab video still encoding at that cap keeps running after exit and attaches when it finishes.
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
    // Tests set BAO_HOST_STOP_MS. A normal session leaves it unset and keeps the 15 second cap.
    const rawCap = process.env.BAO_HOST_STOP_MS;
    const parsedCap = rawCap === undefined ? 15_000 : Number(rawCap);
    const cap = Number.isSafeInteger(parsedCap) && parsedCap >= 0 ? parsedCap : 15_000;
    setTimeout(() => {
      try { abandonVideoOnHostStop(); }
      catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); }
      process.exit(0);
    }, cap).unref();
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
        if (args.run_id !== undefined && (typeof args.run_id !== "string" || !args.run_id.trim())) {
          throw new Error("finish_task run_id must be the run id this chat's latest agent_browser result names");
        }
        const runId = await ctx.proxy.finishTask({ outcome: args.outcome, reason: args.reason.trim(), ...(task ? { task } : {}), ...(done.length ? { done } : {}) },
          typeof args.run_id === "string" ? args.run_id.trim() : undefined);
        const other = ctx.proxy.refused?.runId;
        const closed = other && ctx.proxy.endedByNewerTask(other) ? otherTaskClosed(other) : undefined;
        const receipt = runId ? getRun(ctx.library, runId)
          : { outcome: "no_session", reason: closed ?? (other ? `Run ${other} is not Bao's open browser session, so finish_task changed nothing.` : "No browser task is open.") };
        let card;
        try { card = runId ? finishCardFor(ctx.library, runId) : undefined; }
        catch { card = undefined; }
        result = { ...finishToolResult(card, { ...receipt, workflow: ctx.proxy.lastWorkflowOutcome, endedWait: ctx.proxy.endedWait }, ctx.ui, ctx.proxy.pickLines),
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
      if (err instanceof ChromeFolderDenied) err.present();
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
  let results: AgentBrowserCommandResult[] = [];
  let error: string | undefined;
  let browser: BrowserChoice | undefined;
  let started = false;
  try {
    browser = args.browser === undefined ? undefined : browserChoice(args.browser);
    started = true;
    results = await ctx.proxy.execute(args.command, args.args, browser, ctx.ui, args.profile, { find: args.find, diff: args.diff }, args.run_id);
  }
  catch (cause) {
    if (!started) throw cause;
    if (cause instanceof ChromeProfileQuestion) {
      const asked = profileQuestionResult(cause, { command: "open", ...(Array.isArray(args.args) && args.args.length ? { args: args.args } : {}), ...(browser ? { browser } : {}) }, ctx.ui);
      const ended = ctx.proxy.endedWait;
      return ended ? { ...asked, content: [...asked.content, { type: "text" as const, text: ended }] } : asked;
    }
    if (!ctx.ui) {
      const shot = pageShotLine(ctx.proxy.lastCommand?.step);
      const runId = ctx.proxy.refused ? undefined : ctx.proxy.lastCommand?.runId ?? ctx.proxy.activeRunId;
      const notice = [...runId ? [runLine(runId)] : [], ...shot ? [shot] : [], ...ctx.proxy.endedWait ? [ctx.proxy.endedWait] : [], ...ctx.proxy.pickLines, ...ctx.proxy.lastWorkflowOutcome ? [ctx.proxy.lastWorkflowOutcome] : []];
      if (notice.length) throw new Error([cause instanceof Error ? cause.message : String(cause), ...notice].join("\n"));
      throw cause;
    }
    results = ctx.proxy.lastCommand?.step.native.results ?? [];
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const picked = ctx.proxy.pickLines;
  const saved = ctx.proxy.savedFile;
  const notice = [...saved ? [`Bao saved the file at ${saved}.`] : [], ...ctx.proxy.endedWait ? [ctx.proxy.endedWait] : [], ...picked, ...ctx.proxy.lastWorkflowOutcome ? [ctx.proxy.lastWorkflowOutcome] : []];
  const command = String(args.command || "");
  const refused = ctx.proxy.refused;
  const facts = { args: Array.isArray(args.args) ? args.args.filter((arg): arg is string => typeof arg === "string") : [],
    owner: refused ? undefined : ctx.proxy.ownerPage, current: refused ? false : ctx.proxy.currentChrome };
  const runId = refused ? refused.runId : ctx.proxy.lastCommand?.runId ?? ctx.proxy.activeRunId;
  if (!ctx.ui) {
    const current = args.browser === "current" ? ["Current Chrome: this drives the owner's own Chrome, not a profile copy. finish_task and close end only Bao-created task tabs and disconnect; the owner's Chrome and pre-existing tabs stay open."] : [];
    const shot = pageShotLine(ctx.proxy.lastCommand?.step);
    return textToolResult(results, stepSentence(command, results, ctx.proxy.lastCommand, undefined, facts), [...shot ? [shot] : [], ...current, ...notice], picked, runId);
  }
  const result = browserToolResult(command, results, ctx.proxy.lastCommand, refused ? refused.runId : ctx.proxy.activeRunId, error, facts);
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
