import type { inspectRunView, listRunViews, openStepPictures } from "./run-view";

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
  _meta?: { baoViewer?: View; baoPictures?: Pictures };
}

/** Self-contained: the compiled function is bundled into the versioned HTML. */
function viewerMain(): void {
  const root = document.querySelector<HTMLElement>("#root")!;
  let current: View | undefined;
  let context: HostContext = {};
  let canRead = false;
  let nextId = 0;
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
  function error(message: string): void {
    let node = root.querySelector<HTMLElement>("[role=alert]");
    if (!node) { node = el("p"); node.setAttribute("role", "alert"); root.append(node); }
    node.textContent = message;
  }
  function button(label: string, act: () => Promise<void>, className?: string): HTMLButtonElement {
    const node = el("button", label, className);
    node.type = "button";
    node.onclick = async () => {
      node.disabled = true;
      try { await act(); } catch (err) { error(err instanceof Error ? err.message : String(err)); }
      finally { node.disabled = false; }
    };
    return node;
  }
  async function tool(name: string, args: Record<string, unknown>): Promise<ToolReply> {
    if (!canRead) throw new Error("This host cannot read more Bao data. The text receipt is still available in the conversation.");
    const reply = await request("tools/call", { name, arguments: args }) as ToolReply;
    if (reply.isError) throw new Error(reply.content?.[0]?.text || "Bao could not read this record.");
    return reply;
  }
  async function show(name: string, args: Record<string, unknown>): Promise<void> {
    const reply = await tool(name, args);
    if (!reply._meta?.baoViewer) throw new Error("This host did not forward Bao's viewer data. Use the text receipt or the Bao desktop app.");
    current = reply._meta.baoViewer;
    render();
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
  function render(): void {
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
        if (!view.steps.length) root.append(el("p", "No step results recorded.", "muted"));
        for (const step of view.steps) {
          const section = el("section", undefined, "step");
          section.append(el("h3", `${step.index}. ${step.label || step.id || "Step"}`), el("span", step.status, "status"));
          if (step.reason || step.result) section.append(el("p", step.reason || step.result));
          else section.append(el("p", "No separate read-back recorded. Status does not prove a durable page change.", "muted"));
          const key = `${view.run.id}/${step.id}`;
          const opened = pictures.get(key);
          if (opened) {
            if (!opened.pictures.length) section.append(el("p", "No shareable pictures: missing, withheld, invalid, or over the size limit.", "muted"));
            const pair = el("div", undefined, "pictures");
            for (const picture of opened.pictures) {
              const figure = el("figure"); const image = el("img");
              image.src = `data:${picture.mimeType};base64,${picture.data}`; image.alt = `${step.label || "Step"}: ${picture.phase}`;
              figure.append(image, el("figcaption", picture.phase)); pair.append(figure);
            }
            section.append(pair);
          } else if (step.picturesAllowed && step.id) {
            section.append(el("p", "Opening pictures sends them from this Mac to the host app. Other page content may be visible.", "muted"));
            section.append(button("Open step pictures", async () => {
              const reply = await tool("open_step_pictures", { run_id: view.run.id, step_id: step.id });
              if (!reply._meta?.baoPictures) throw new Error("This host did not forward the pictures.");
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
        if (!view.workflow) workflow.append(el("p", "No saved workflow is available for this run. Browser captures do not create one.", "muted"));
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
      const data = (message.params as ToolReply)?._meta?.baoViewer;
      if (data) { current = data; render(); }
    } else if (message.method === "ui/notifications/host-context-changed") {
      context = { ...context, ...message.params as HostContext }; render();
    } else if (message.id !== undefined && message.method === "ping") {
      window.parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*");
    }
  });
  void (async () => {
    const init = await request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "Bao run viewer", version: "1.0.0" }, appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] } }) as { hostContext?: HostContext; hostCapabilities?: { serverTools?: unknown } };
    context = init.hostContext || {}; canRead = Boolean(init.hostCapabilities?.serverTools); applyContext();
    notify("ui/notifications/initialized", {});
    new ResizeObserver(() => { notify("ui/notifications/size-changed", { height: Math.ceil(document.documentElement.getBoundingClientRect().height) }); }).observe(root);
    setTimeout(() => { if (!current) void history().catch((err: Error) => error(err.message)); }, 500);
  })().catch((err: Error) => error(err.message));
}

export function viewerHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"><title>Bao run viewer</title><style>
*{box-sizing:border-box}html{color-scheme:light;--bg:#fff;--fg:#1c3029;--muted:#5f7069;--line:#dce5df;--soft:#f5f8f6;--accent:#21604c}html[data-theme=dark]{color-scheme:dark;--bg:#19221e;--fg:#e6eee8;--muted:#a8b8ae;--line:#3b4d42;--soft:#24332a;--accent:#a5d8b8}body{margin:0;background:var(--color-background-primary,var(--bg));color:var(--color-text-primary,var(--fg));font:14px var(--font-sans,system-ui,sans-serif);line-height:1.45}main{max-width:900px;margin:auto;padding:18px}header,.actions,.run-row{display:flex;align-items:center;gap:12px}header{flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:12px}header .actions{margin-left:auto}.brand{letter-spacing:3px;color:var(--accent)}h1{font-size:20px;line-height:1.3;margin:18px 0 6px}h2{font-size:15px;margin:0 0 4px}h3{font-size:14px;margin:0 0 8px}p{margin:6px 0;overflow-wrap:anywhere}.muted,footer,figcaption{color:var(--color-text-secondary,var(--muted));font-size:12px}.run-row{padding:14px 0;border-bottom:1px solid var(--line)}.run-row>div{flex:1;min-width:0}button{font:inherit;font-size:12px;cursor:pointer;background:var(--color-background-primary,var(--bg));color:var(--accent);border:1px solid var(--line);border-radius:6px;padding:7px 11px;white-space:nowrap}button:hover{background:var(--soft)}button:disabled{opacity:.5;cursor:wait}.primary{font-weight:600}.status{display:inline-block;font-size:11px;font-weight:650;padding:3px 8px;border-radius:4px;background:var(--soft);color:var(--accent);overflow-wrap:anywhere}.summary,.step{padding:14px 0;border-bottom:1px solid var(--line);margin-bottom:12px}.mono{font:11px ui-monospace,monospace;color:var(--muted)}aside{border-left:3px solid var(--accent);padding:8px 12px;margin-top:12px;background:var(--soft)}.pictures{display:flex;flex-wrap:wrap;gap:16px;margin-top:12px}figure{margin:0;max-width:100%}img{display:block;max-width:100%;height:auto;border:1px solid var(--line);border-radius:4px}figcaption{margin-top:4px}details{margin-top:18px}summary{font-weight:600;cursor:pointer}li{padding:4px 0;overflow-wrap:anywhere}footer{margin-top:18px;padding-top:12px;border-top:1px solid var(--line);font-size:11px}[role=alert]{color:var(--color-text-danger,#b12c35)}.empty{padding:20px 0}@media(max-width:440px){main{padding:12px}.run-row{flex-wrap:wrap}.run-row>div{flex-basis:65%}.run-row>button{margin-left:auto}header{gap:8px}header .muted{display:none}}
</style></head><body><main id="root" aria-live="polite">Connecting to Bao...</main><script>(${viewerMain.toString()})();</script></body></html>`;
}
