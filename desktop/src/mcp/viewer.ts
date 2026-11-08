import type { inspectRunView, listRunViews, openStepPictures } from "./run-view";
import type { BrowserToolCard } from "./tool-card";

export const VIEWER_URI = "ui://bao/runs/v1.html";
export const VIEWER_MIME = "text/html;profile=mcp-app";
export const UI_EXTENSION = "io.modelcontextprotocol/ui";
export const VIEWER_RESOURCE = { uri: VIEWER_URI, name: "Bao run viewer", mimeType: VIEWER_MIME, description: "Read-only run history and receipts" };

export function supportsViewer(capabilities: unknown): boolean {
  const caps = capabilities as { extensions?: Record<string, { mimeTypes?: unknown }> } | undefined;
  const types = caps?.extensions?.[UI_EXTENSION]?.mimeTypes;
  return Array.isArray(types) && types.includes(VIEWER_MIME);
}

export function viewerResource() {
  return { contents: [{ ...VIEWER_RESOURCE, text: viewerHtml(), _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } } } }] };
}

type View = ReturnType<typeof inspectRunView> | ReturnType<typeof listRunViews>;
type Pictures = ReturnType<typeof openStepPictures>;
interface HostContext {
  theme?: string;
  locale?: string;
  timeZone?: string;
  displayMode?: string;
  availableDisplayModes?: string[];
  styles?: { variables?: Record<string, string> };
}
interface ToolReply {
  isError?: boolean;
  content?: { text?: string }[];
  _meta?: { baoViewer?: View; baoPictures?: Pictures; baoToolCard?: BrowserToolCard };
}

/** Self-contained: the compiled function is bundled into the versioned HTML. */
function viewerMain(): void {
  const root = document.querySelector<HTMLElement>("#root")!;
  let current: View | undefined;
  let browserCall: BrowserToolCard | undefined;
  let browserPicture: Pictures["pictures"][number] | undefined;
  let pictureLoading = false;
  let pictureError = "";
  let context: HostContext = {};
  let canRead = false;
  let nextId = 0;
  let viewRequest = 0;
  let userRequest: number | undefined;
  let expanded = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const pictures = new Map<string, Pictures>();
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, value?: string, className?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = value;
    if (className) node.className = className;
    return node;
  };
  const notify = (method: string, params: unknown) => window.parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
  function request(method: string, params: unknown): Promise<unknown> {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Bao did not answer. Check that it is running, then refresh.")); }, 30_000);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    });
  }
  const alert = document.querySelector<HTMLElement>("#error [role=alert]")!;
  const recovery = document.querySelector<HTMLElement>("#error .muted")!;
  class HostDataError extends Error {}
  function error(cause: unknown): void {
    alert.textContent = cause instanceof Error ? cause.message : String(cause);
    recovery.textContent = cause instanceof HostDataError ? "" : browserCall ? "Try View run again. If this keeps happening, open Bao desktop for local details." : current ? "Try Refresh. If this keeps happening, open Bao desktop for local details." : "Reopen this viewer from the conversation, or open Bao desktop for local details.";
    if (!current && !browserCall) root.textContent = "Could not load the run viewer.";
  }
  function clearError(): void { alert.textContent = ""; recovery.textContent = ""; }
  function button(label: string, act: () => Promise<void>, className?: string): HTMLButtonElement {
    const node = el("button", label, className);
    node.type = "button";
    node.onclick = async () => {
      node.disabled = true;
      clearError();
      try { await act(); } catch (err) { error(err); }
      finally { node.disabled = false; }
    };
    return node;
  }
  async function tool(name: string, args: Record<string, unknown>): Promise<ToolReply> {
    if (!canRead) throw new HostDataError("This host cannot read more Bao data. The text receipt is still available in the conversation.");
    const reply = await request("tools/call", { name, arguments: args }) as ToolReply;
    if (reply.isError) {
      let message = reply.content?.[0]?.text || "Bao could not read this record.";
      try {
        const data = JSON.parse(message) as { error?: unknown } | null;
        if (typeof data?.error === "string") message = data.error;
      } catch {}
      throw new Error(message);
    }
    return reply;
  }
  async function show(name: string, args: Record<string, unknown>, automatic = false): Promise<void> {
    const version = ++viewRequest;
    if (!automatic) userRequest = version;
    try {
      const reply = await tool(name, args);
      if (version !== viewRequest) return;
      if (!reply._meta?.baoViewer) throw new HostDataError("This host did not forward Bao's viewer data. Use the text receipt or the Bao desktop app.");
      browserCall = undefined;
      current = reply._meta.baoViewer;
      clearError(); render();
    } catch (err) {
      if (version === viewRequest) throw err;
    } finally {
      if (userRequest === version) userRequest = undefined;
    }
  }
  const history = () => show("list_runs", {});
  async function inspect(runId: string, stepOffset = 0, workflowOffset = 0): Promise<void> {
    await show("inspect_run", { run_id: runId, step_offset: stepOffset, workflow_offset: workflowOffset });
  }
  function applyContext(): void {
    document.documentElement.dataset.theme = context.theme === "dark" ? "dark" : "light";
    document.documentElement.lang = context.locale || "en";
    for (const [key, value] of Object.entries(context.styles?.variables || {})) {
      if (/^--(?:color-|font-|border-radius-)/.test(key) && typeof value === "string") document.documentElement.style.setProperty(key, value);
    }
  }
  function date(value: number | null): string {
    if (value === null) return "Time unknown";
    try { return new Intl.DateTimeFormat(context.locale, { dateStyle: "medium", timeStyle: "short", timeZone: context.timeZone }).format(value); }
    catch { return new Date(value).toISOString(); }
  }
  function calls(value: number | null): string { return value === null ? "Model calls unknown (not tracked)" : `${value} Bao model calls`; }
  async function loadBrowserPicture(card: BrowserToolCard): Promise<void> {
    const picture = card.picture;
    if (picture.kind !== "captured" || !card.runId) return;
    const stepId = picture.stepId ?? card.stepId;
    if (!stepId) return;
    pictureLoading = true; render();
    try {
      const reply = await tool("open_browser_picture", { run_id: card.runId, step_id: stepId, phase: picture.phase });
      if (browserCall !== card) return;
      const data = reply._meta?.baoPictures;
      if (!data || data.runId !== card.runId || data.stepId !== stepId) throw new HostDataError("This host did not forward the page picture.");
      browserPicture = data.pictures.find((candidate) => candidate.phase === picture.phase);
      if (!browserPicture) pictureError = "The page picture is missing, invalid, or over the size limit.";
    } catch (cause) {
      if (browserCall !== card) return;
      pictureError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (browserCall === card) { pictureLoading = false; render(); }
    }
  }
  function renderBrowserCall(card: BrowserToolCard): void {
    applyContext(); root.replaceChildren();
    const header = el("header");
    header.append(el("strong", "BAO", "brand"), el("span", "Browser action", "muted"), el("span", card.status === "failed" ? "Failed" : card.status === "waiting" ? "Waiting for you" : "Completed", `status browser-status ${card.status}`));
    root.append(header);
    const picture = card.picture;
    if (picture.kind === "captured" && browserPicture) {
      const figure = el("figure", undefined, `browser-picture${expanded ? " expanded" : ""}`);
      const image = el("img");
      const phase = card.command === "close" ? "Last recorded page" : picture.phase === "before" ? `Before ${card.command}` : `After ${card.command}`;
      image.src = `data:${browserPicture.mimeType};base64,${browserPicture.data}`; image.alt = `${phase}: ${card.caption}`;
      const frame = el("div", undefined, "browser-frame"); frame.append(image);
      if (picture.target) {
        const { rect, viewport } = picture.target;
        const mark = el("div", undefined, `browser-mark${rect.y / viewport.height < .15 ? " below" : ""}${rect.x / viewport.width > .7 ? " trailing" : ""}`);
        mark.setAttribute("aria-hidden", "true");
        Object.assign(mark.style, { left: `${rect.x / viewport.width * 100}%`, top: `${rect.y / viewport.height * 100}%`, width: `${rect.width / viewport.width * 100}%`, height: `${rect.height / viewport.height * 100}%` });
        mark.append(el("span", card.caption || (card.command === "fill" ? "Typed here" : "Clicked here"))); frame.append(mark);
      } else {
        const label = card.status === "failed" ? "Command failed" : card.command === "snapshot" ? "Read this page" : card.command === "open" ? "Opened page" : card.command === "tab" ? "Browser tab" : "Page captured";
        frame.append(el("span", label, "browser-page-label"));
      }
      figure.append(frame, el("figcaption", phase)); root.append(figure);
      const toggle = button(expanded ? "Close picture" : "Open picture", async () => {
        expanded = !expanded;
        try {
          const mode = expanded ? "fullscreen" : "inline";
          if (context.availableDisplayModes?.includes(mode)) {
            const reply = await request("ui/request-display-mode", { mode }) as { mode?: string };
            context.displayMode = reply.mode || context.displayMode;
          }
        } finally { render(); root.querySelector<HTMLButtonElement>(".picture-toggle")?.focus(); }
      }, "picture-toggle");
      root.append(toggle);
    } else {
      const empty = el("div", undefined, "browser-empty");
      const outline = el("div", undefined, "browser-outline"); outline.setAttribute("aria-hidden", "true");
      const reason = picture.kind === "unavailable" ? picture.reason : pictureLoading ? "Reading the recorded page picture." : pictureError || "This host cannot read the page picture.";
      empty.append(outline, el("strong", pictureLoading ? "Loading page picture" : "Page picture unavailable"), el("p", reason, "muted")); root.append(empty);
    }
    root.append(el("p", card.caption, "browser-caption"));
    if ((card.command === "click" || card.command === "fill") && picture.kind === "captured" && !picture.target && card.status === "complete") {
      root.append(el("p", "The target picture was unavailable. This page picture does not mark the target.", "muted"));
    }
    if (card.runId && canRead) {
      const runId = card.runId;
      root.append(button("View run", async () => { expanded = false; await inspect(runId); }, "primary"));
    }
    root.append(el("footer", "Recorded browser session · View only. Supported single-page tasks save a workflow when the session ends."));
    document.title = `${card.command} · Bao`;
  }
  function render(): void {
    if (browserCall) { renderBrowserCall(browserCall); return; }
    if (!current) return;
    applyContext();
    root.replaceChildren();
    const header = el("header");
    header.append(el("strong", "BAO", "brand"), el("span", "Read-only run viewer", "muted"));
    const nav = el("div", undefined, "actions");
    nav.append(button("History", history), button("Refresh", async () => {
      if (current && "run" in current) await inspect(current.run.id, current.stepOffset, current.workflow?.offset);
      else await show("list_runs", { offset: current && "runs" in current ? current.offset : 0 });
    }));
    header.append(nav); root.append(header);
    if ("runs" in current) {
      root.append(el("h1", "Run history"), el("p", "This Mac · Recently updated", "muted"));
      if (!current.runs.length) root.append(el("p", current.skipped ? "No readable runs on this page." : "No runs yet. Run a workflow with Bao to see its receipt here.", "empty"));
      for (const run of current.runs) {
        const row = el("section", undefined, "run-row");
        const label = el("div"); label.append(el("h2", run.name), el("p", `${date(run.at)} · ${run.stepCount} steps`, "muted"));
        row.append(label, el("span", run.status, "status"), button("Inspect run", async () => { expanded = false; await inspect(run.id); }));
        root.append(row);
      }
      if (current.skipped) root.append(el("p", `${current.skipped} unavailable or oversized records skipped.`, "muted"));
      const paging = el("div", undefined, "actions");
      if (current.offset > 0) paging.append(button("Previous runs", () => show("list_runs", { offset: Math.max(0, (current && "runs" in current ? current.offset : 0) - 5) })));
      if (current.nextOffset !== null) { const page = current.nextOffset; paging.append(button("Next runs", () => show("list_runs", { offset: page }))); }
      root.append(paging);
    } else {
      const view = current;
      root.append(el("h1", view.run.name));
      const summary = el("section", undefined, "summary");
      summary.append(el("span", view.run.status, "status"), el("p", `${date(view.run.at)} · ${view.run.stepCount} steps · ${calls(view.run.modelCalls)}`), el("p", view.run.id, "mono"));
      if (view.reason) summary.append(el("p", `Stop reason: ${view.reason}`));
      if (view.handoff?.ask) {
        const handoff = el("aside"); handoff.append(el("strong", "Needs you in Bao"), el("p", view.handoff.ask));
        if (view.handoff.deadline) handoff.append(el("p", `Deadline: ${view.handoff.deadline}`, "muted"));
        summary.append(handoff);
      }
      root.append(summary);
      if (!expanded && context.displayMode !== "fullscreen") {
        root.append(button("Inspect receipt", async () => {
          expanded = true;
          if (context.availableDisplayModes?.includes("fullscreen")) {
            const result = await request("ui/request-display-mode", { mode: "fullscreen" }) as { mode?: string };
            context.displayMode = result.mode || context.displayMode;
          }
          render();
        }, "primary"));
      } else {
        if (context.displayMode === "fullscreen" && context.availableDisplayModes?.includes("inline")) root.append(button("Back to conversation", async () => {
          const result = await request("ui/request-display-mode", { mode: "inline" }) as { mode?: string };
          context.displayMode = result.mode || context.displayMode; expanded = false; render();
        }));
        root.append(el("h2", "Step results"));
        const missingReadBack = "No separate read-back recorded. Status does not prove a durable page change.";
        const allMissingReadBack = view.steps.length > 0 && view.steps.every((step) => !step.reason && !step.result);
        if (!view.steps.length) root.append(el("p", "No step results recorded.", "muted"));
        else if (allMissingReadBack) root.append(el("p", missingReadBack, "muted"));
        for (const step of view.steps) {
          const section = el("section", undefined, "step");
          section.append(el("h3", `${step.index}. ${step.label || step.id || "Step"}`), el("span", step.status, "status"));
          if (step.reason || step.result) section.append(el("p", step.reason || step.result));
          else if (!allMissingReadBack) section.append(el("p", missingReadBack, "muted"));
          const key = `${view.run.id}/${step.id}`;
          const opened = step.picturesAllowed ? pictures.get(key) : undefined;
          if (opened) {
            if (!opened.pictures.length) section.append(el("p", "No pictures found: missing, invalid, or over the size limit.", "muted"));
            const pair = el("div", undefined, "pictures");
            for (const picture of opened.pictures) {
              const figure = el("figure"); const image = el("img");
              image.src = `data:${picture.mimeType};base64,${picture.data}`; image.alt = `${step.label || "Step"}: ${picture.phase}`;
              figure.append(image, el("figcaption", picture.phase)); pair.append(figure);
            }
            section.append(pair);
          } else if (step.picturesAllowed && step.id) {
            section.append(button("Open step pictures", async () => {
              let reply: ToolReply;
              try { reply = await tool("open_step_pictures", { run_id: view.run.id, step_id: step.id }); }
              catch (err) { if (!current || !("run" in current) || current.run.id !== view.run.id) return; throw err; }
              if (!current || !("run" in current) || current.run.id !== view.run.id) return;
              if (!reply._meta?.baoPictures) throw new HostDataError("This host did not forward the pictures.");
              pictures.set(key, reply._meta.baoPictures); render();
            }));
          }
          root.append(section);
        }
        const pages = el("div", undefined, "actions");
        if (view.stepOffset) pages.append(button("Previous steps", () => inspect(view.run.id, Math.max(0, view.stepOffset - 20), view.workflow?.offset)));
        if (view.nextStepOffset !== null) pages.append(button("Next steps", () => inspect(view.run.id, view.nextStepOffset!, view.workflow?.offset)));
        root.append(pages);
        const workflow = el("details"); workflow.open = true;
        workflow.append(el("summary", "Workflow steps"));
        if (!view.workflow) workflow.append(el("p", "No saved workflow is linked to this run. Check the closing tool result for the saved workflow or capture-only reason.", "muted"));
        else {
          const list = el("ol"); list.start = view.workflow.offset + 1;
          for (const step of view.workflow.steps) list.append(el("li", `${step.label || "Step"} · ${step.action}`));
          workflow.append(list);
          if (view.workflow.offset) workflow.append(button("Previous workflow steps", () => inspect(view.run.id, view.stepOffset, Math.max(0, view.workflow!.offset - 20))));
          if (view.workflow.nextOffset !== null) workflow.append(button("Next workflow steps", () => inspect(view.run.id, view.stepOffset, view.workflow!.nextOffset!)));
        }
        root.append(workflow);
      }
    }
    document.title = `${root.querySelector("h1")?.textContent || "Run viewer"} · Bao`;
    root.append(el("footer", "Reads the same Library as Bao desktop. No run, edit, resume, approve, or browser controls."));
  }
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
    const message = event.data as { jsonrpc?: string; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
    if (message.jsonrpc !== "2.0") return;
    if (typeof message.id === "number" && pending.has(message.id)) {
      const callback = pending.get(message.id)!; pending.delete(message.id); clearTimeout(callback.timer);
      if (message.error) callback.reject(new Error(message.error.message || "Host request failed")); else callback.resolve(message.result);
    } else if (message.method === "ui/notifications/tool-result") {
      const reply = message.params as ToolReply;
      const data = reply?._meta?.baoViewer;
      const card = reply?._meta?.baoToolCard;
      if ((data || card) && userRequest === undefined) {
        ++viewRequest; browserCall = card; current = data; browserPicture = undefined; pictureLoading = false; pictureError = ""; if (card) expanded = false; clearError(); render();
        if (card && canRead) void loadBrowserPicture(card);
      }
    } else if (message.method === "ui/notifications/host-context-changed") {
      const changes = message.params as HostContext;
      const contentChanged = (["locale", "timeZone", "displayMode"] as const).some((key) => key in changes && changes[key] !== context[key]);
      context = { ...context, ...changes }; applyContext();
      if (contentChanged) render();
    } else if (message.id !== undefined && message.method === "ping") {
      window.parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*");
    }
  });
  void (async () => {
    const init = await request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "Bao run viewer", version: "1.0.0" }, appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] } }) as { hostContext?: HostContext; hostCapabilities?: { serverTools?: unknown } };
    context = init.hostContext || {}; canRead = Boolean(init.hostCapabilities?.serverTools); applyContext();
    notify("ui/notifications/initialized", {});
    if (browserCall) void loadBrowserPicture(browserCall);
    new ResizeObserver(() => { notify("ui/notifications/size-changed", { height: Math.ceil(document.documentElement.getBoundingClientRect().height) }); }).observe(root.parentElement!);
    setTimeout(() => { if (!current && viewRequest === 0) void show("list_runs", {}, true).catch((err: Error) => error(err)); }, 500);
  })().catch((err: Error) => error(err));
}

export function viewerHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"><title>Bao run viewer</title><style>
*{box-sizing:border-box}
html{color-scheme:light;--bg:#fff;--fg:#1c3029;--muted:#5f7069;--line:#dce5df;--soft:#f5f8f6;--accent:#21604c;--danger:#b12c35}
html[data-theme=dark]{color-scheme:dark;--bg:#19221e;--fg:#e6eee8;--muted:#a8b8ae;--line:#3b4d42;--soft:#24332a;--accent:#a5d8b8;--danger:#ff929b}
body{margin:0;background:var(--color-background-primary,var(--bg));color:var(--color-text-primary,var(--fg));font:.875rem var(--font-sans,system-ui,sans-serif);line-height:1.45}
main{max-width:900px;margin:auto;padding:18px}
header,.actions,.run-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
header{border-bottom:1px solid var(--line);padding-bottom:12px}
header .actions{margin-inline-start:auto}
.brand{letter-spacing:.2em;color:var(--accent)}
h1,h2,h3{overflow-wrap:anywhere}
h1{font-size:1.25rem;line-height:1.3;margin:18px 0 6px}
h2{font-size:.9375rem;margin:0 0 4px}
#root>h2{margin-top:18px}
h3{font-size:.875rem;margin:0 0 8px}
p{margin:6px 0;overflow-wrap:anywhere}
.muted,footer,figcaption{color:var(--color-text-secondary,var(--muted));font-size:.75rem}
.run-row{padding:14px 0;border-bottom:1px solid var(--line)}
.run-row>div{flex:1;min-width:0}
button{font:inherit;font-size:.75rem;cursor:pointer;background:var(--color-background-primary,var(--bg));color:var(--accent);border:1px solid var(--line);border-radius:6px;padding:7px 11px;max-width:100%;overflow-wrap:anywhere}
button:hover{background:var(--soft)}
button:disabled{opacity:.5;cursor:wait}
:focus-visible{outline-offset:2px}
.primary{font-weight:600}
.status{display:inline-block;font-size:.6875rem;font-weight:650;padding:3px 8px;border-radius:4px;background:var(--soft);color:var(--accent);overflow-wrap:anywhere}
.summary,.step{padding:14px 0;border-bottom:1px solid var(--line);margin-bottom:12px}
.mono{font:.6875rem ui-monospace,monospace;color:var(--muted)}
aside{border-inline-start:3px solid var(--accent);padding:8px 12px;margin-top:12px;background:var(--soft)}
.pictures{display:flex;flex-wrap:wrap;gap:16px;margin-top:12px}
figure{margin:0;max-width:100%}
img{display:block;max-width:100%;height:auto;border:1px solid var(--line);border-radius:4px}
figcaption{margin-top:4px}
details{margin-top:18px}
summary{font-weight:600;cursor:pointer}
li{padding:4px 0;overflow-wrap:anywhere}
footer{margin-top:18px;padding-top:12px;border-top:1px solid var(--line);font-size:.6875rem}
[role=alert]{color:var(--color-text-danger,var(--danger))}
#error p:empty{margin:0}
.empty{padding:20px 0}
.browser-status{margin-inline-start:auto}
.browser-status.failed{color:var(--danger)}
.browser-picture{position:relative;max-width:480px;margin:16px auto 8px}
.browser-picture.expanded{max-width:none}
.browser-frame{position:relative}
.browser-frame img{width:100%;height:auto;outline:1px solid #0000001a;outline-offset:-1px}
html[data-theme=dark] .browser-frame img{outline-color:#ffffff1a}
.browser-mark{position:absolute;border:2px solid #21604c;box-shadow:0 0 0 1px #fff,0 0 0 3px #21604c;border-radius:4px;pointer-events:none}
.browser-mark span{position:absolute;bottom:calc(100% + 6px);inset-inline-start:-2px;white-space:nowrap;background:#21604c;color:#fff;border:1px solid #fff;border-radius:4px;padding:3px 7px;font-size:11px;font-weight:600}
.browser-mark.below span{bottom:auto;top:calc(100% + 6px)}
.browser-mark.trailing span{inset-inline-start:auto;inset-inline-end:-2px}
.browser-page-label{position:absolute;top:10px;inset-inline-start:10px;max-width:calc(100% - 20px);background:#fff;color:#1c3029;border:1px solid #819b8c;border-radius:4px;padding:3px 7px;font-size:11px}
.browser-caption{font-weight:600;margin:14px 0 12px}
.picture-toggle{display:block;margin:8px auto}
.browser-empty{display:grid;justify-items:center;align-content:center;gap:12px;min-height:200px;padding:24px;text-align:center;background:var(--soft);margin-top:16px;border-radius:6px}
.browser-outline{width:88px;height:60px;border:1px solid var(--muted);border-radius:5px;position:relative}
.browser-outline:before{content:"";position:absolute;top:12px;inset-inline:0;border-top:1px solid var(--muted)}
@media(max-width:440px){main{padding:12px}.run-row>div{flex-basis:65%}.run-row>button{margin-inline-start:auto}header{gap:8px}header .muted{display:none}}
</style></head><body><main><div id="root" aria-live="polite">Connecting to Bao…</div><section id="error"><p role="alert"></p><p class="muted"></p></section></main><script>(${viewerMain.toString()})();</script></body></html>`;
}
