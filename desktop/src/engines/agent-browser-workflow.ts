import { connectCdp, type CdpSocket } from "../cdp-live/socket";
import { dumpPage, type DomDump, type PageDump } from "../v1/dom-page";
import { interpret, type TrailEvent } from "../v1/interpret";
import { buildLocators, matchLocator } from "../v1/locators";
import { leafTexts, smallestChange } from "../v1/recorder";
import type { Identity, StepLocator } from "../v1/schema";
import { Library } from "../v1/store";
import type { AgentBrowserCommandResult } from "./agent-browser-proxy";

interface BrowserPage {
  port: number;
  browserPath: string;
  targetId: string;
  targetIds: string[];
}

interface Observation {
  page: PageDump;
  leaves: Record<string, string>;
}

interface AgentBrowserReplayTarget {
  url: string;
  identity: Identity;
  locators: StepLocator[];
}

interface ActionCapture {
  before: Observation;
  target?: DomDump;
  pageLevel?: boolean;
}

function armCommand(command: string, binding: string, dump: typeof dumpPage, leaves: typeof leafTexts): ActionCapture {
  const before = { page: dump(), leaves: leaves() };
  const control = (element: Element) => /^(button|link|textbox|checkbox|radio|combobox|listbox|searchbox|menuitem|tab|option|switch)$/.test(element.getAttribute("role") || "")
    || /^(A|BUTTON|INPUT|TEXTAREA|SELECT|SUMMARY)$/.test(element.tagName) || (element as HTMLElement).isContentEditable;
  const targetOf = (elements: EventTarget[]): DomDump | undefined => {
    const candidates = elements.filter((element): element is Element => element instanceof Element);
    const ownTarget = elements[0];
    const element = candidates.find(control) || (ownTarget instanceof Element && ownTarget.hasAttribute("data-bao-i") ? ownTarget : undefined);
    const handle = element?.getAttribute("data-bao-i");
    return before.page.nodes.find((node) => node.handle === handle);
  };
  const capture = (event: Event) => {
    if (!event.isTrusted) return;
    const target = targetOf(event.composedPath());
    if (target) (window as unknown as Record<string, (payload: string) => void>)[binding]!(JSON.stringify(target));
  };
  const event = command === "fill" ? "input" : "click";
  if (command === "click" || command === "fill") document.addEventListener(event, capture, true);
  (window as unknown as Record<string, unknown>).__baoWorkflowCleanup = () => {
    document.removeEventListener(event, capture, true);
    delete (window as unknown as Record<string, unknown>).__baoWorkflowCleanup;
  };
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return { before, ...(command === "press" ? { target: active ? targetOf([active]) : undefined, pageLevel: !active || active === document.body || active === document.documentElement } : {}) };
}

function readObservation(dump: typeof dumpPage, leaves: typeof leafTexts): Observation {
  const cleanup = (window as unknown as Record<string, (() => void) | undefined>).__baoWorkflowCleanup;
  cleanup?.();
  return { page: dump(), leaves: leaves() };
}

function effectState(observation: Observation): string {
  return JSON.stringify({
    ...observation,
    page: { ...observation.page, nodes: observation.page.nodes.map(({ bbox: _bbox, ...node }) => node) },
  });
}

const PAGE_FUNCTIONS = `const dumpPage = ${dumpPage.toString()}; const leafTexts = ${leafTexts.toString()};`;

function durableTarget(node: DomDump, page: PageDump): AgentBrowserReplayTarget | undefined {
  const { handle: _handle, bbox: _bbox, value: _value, checked: _checked, enabled: _enabled, hidden: _hidden, overlay: _overlay, inDialog: _dialog, ...identity } = node;
  if (identity.cssPath?.includes(":nth-of-type(")) delete identity.cssPath;
  if (identity.xpath && /\[\d+\]/.test(identity.xpath)) delete identity.xpath;
  const locators = buildLocators(identity, page.nodes).filter((locator) => {
    const hit = matchLocator(locator, page.nodes);
    return hit !== undefined && page.nodes[hit.index]?.handle === node.handle;
  });
  const priority = ["testid", "css", "xpath", "role", "text", "anchor"];
  locators.sort((left, right) => priority.indexOf(left.kind) - priority.indexOf(right.kind));
  return locators.length ? { url: page.url, identity, locators } : undefined;
}

export class AgentBrowserWorkflow {
  private readonly events: TrailEvent[] = [];
  private readonly workflowId: string;
  private startUrl: string | undefined;
  private targetId: string | undefined;
  private reason: string | undefined;
  private finished: string | undefined;
  private failedAction = false;
  private pending: { event: TrailEvent; before: Observation } | undefined;

  constructor(private readonly home: string, runId: string, private readonly activePage: () => Promise<BrowserPage>) {
    this.workflowId = `wf-${runId.replace(/^run-/, "")}`;
  }

  unavailable(reason: string): void { this.reason ??= reason; }

  async record(command: string, args: string[], id: string, perform: () => Promise<AgentBrowserCommandResult>, ownerWaiting: () => boolean): Promise<AgentBrowserCommandResult> {
    if (command === "close") {
      const result = await perform();
      if (result.exitCode !== 0) this.unavailable("the closing command failed");
      return result;
    }
    if (command === "scroll") this.unavailable("it used stateful scroll");
    if (command === "tab" && ["new", "close"].includes(args[0] ?? "")) this.unavailable("it used a second tab");
    const action = ["open", "click", "fill", "press"].includes(command);
    const expectedArgs = command === "fill" ? 2 : 1;
    if (action && args.length !== expectedArgs) this.unavailable(`${command} options cannot be replayed`);
    if (this.reason) return perform();

    let cdp: CdpSocket | undefined;
    let sessionId: string | undefined;
    let before: ActionCapture | undefined;
    let captured: DomDump | undefined;
    let page: BrowserPage | undefined;
    const binding = "__baoWorkflowTarget";
    try {
      try {
        page = await this.activePage();
        if (this.targetId && page.targetId !== this.targetId) this.unavailable("it used a second tab");
        if (action) {
          cdp = await connectCdp(page.port, page.browserPath, { timeoutMs: 3000 });
          ({ sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: page.targetId, flatten: true }, undefined, 3000));
          await cdp.send("Runtime.enable", {}, sessionId, 3000);
          cdp.on("Runtime.bindingCalled", sessionId, (params) => {
            if (params.name === binding && typeof params.payload === "string") captured ??= JSON.parse(params.payload) as DomDump;
          });
          await cdp.send("Runtime.addBinding", { name: binding }, sessionId, 3000);
          const armed = await cdp.send<{ result: { value?: ActionCapture } }>("Runtime.evaluate", {
            expression: `(() => { ${PAGE_FUNCTIONS} return (${armCommand.toString()})(${JSON.stringify(command)}, ${JSON.stringify(binding)}, dumpPage, leafTexts); })()`, returnByValue: true,
          }, sessionId, 3000);
          before = armed.result.value;
          if (!before) throw new Error("page observation unavailable");
          if (command === "press") captured = before.target;
          this.updatePending(before.before);
        }
      } catch { this.unavailable("its replay target could not be recorded"); }

      const result = await perform();
      if (action) this.failedAction = result.exitCode !== 0;
      if (result.exitCode !== 0 && (command === "snapshot" || command === "screenshot" || command === "tab" && args[0] === "list")) return result;
      if (this.reason || !page) return result;
      try {
        const afterPage = await this.activePage();
        if (afterPage.targetId !== page.targetId || afterPage.targetIds.some((target) => !page!.targetIds.includes(target))) {
          this.unavailable("it opened a second tab or popup");
          return result;
        }
        this.targetId = afterPage.targetId;
        if (!cdp) {
          cdp = await connectCdp(afterPage.port, afterPage.browserPath, { timeoutMs: 3000 });
          ({ sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: afterPage.targetId, flatten: true }, undefined, 3000));
        }
        if (!cdp || !sessionId) throw new Error("page observation unavailable");
        let after: Observation | undefined;
        if (!ownerWaiting()) {
          const observed = await cdp.send<{ result: { value?: Observation } }>("Runtime.evaluate", {
            expression: `(() => { ${PAGE_FUNCTIONS} return (${readObservation.toString()})(dumpPage, leafTexts); })()`, returnByValue: true,
          }, sessionId, 3000);
          after = observed.result.value;
          if (!after) throw new Error("page observation unavailable");
        }
        if (result.exitCode !== 0) {
          if (action && (!before || !after || effectState(before.before) !== effectState(after))) this.unavailable("a failed action changed the page");
          return result;
        }
        if (command === "open") {
          const url = /^[a-z][a-z\d+.-]*:\/\//i.test(args[0]!) ? new URL(args[0]!).href : after?.page.url ?? new URL(`https://${args[0]!}`).href;
          if (!this.startUrl) this.startUrl = url;
          else {
            this.pending = undefined;
            this.events.push({ id, toolCallId: id, ts: Date.now(), kind: "act", op: "navigate", value: url, afterUrl: after?.page.url });
          }
        } else if (action && before) {
          const target = captured && durableTarget(captured, before.before.page);
          if (!target && command !== "press") this.unavailable("an action had no durable target");
          else if (command === "press" && !target && !before.pageLevel) this.unavailable("a key action had no durable target");
          else {
            const box = captured?.bbox;
            const viewport = before.before.page.viewport;
            const seen = box && viewport && box.w > 0 && box.h > 0
              && box.x < viewport.width && box.y < viewport.height && box.x + box.w > 0 && box.y + box.h > 0
              ? { box: { x: box.x, y: box.y, width: box.w, height: box.h }, viewport } : {};
            const event: TrailEvent = {
              id, toolCallId: id, ts: Date.now(), kind: "act", op: command === "fill" ? "type" : command === "press" ? "key" : "click",
              ...(target ? { identity: target.identity, locators: target.locators } : {}),
              ...seen,
              ...(command === "fill" ? { value: args[1], valueMode: "full" } : {}),
              ...(command === "press" ? { key: args[0] } : {}),
              beforeUrl: target?.url ?? before.before.page.url,
              subtreeBefore: captured?.text,
              valueBefore: captured?.value,
            };
            this.events.push(event);
            this.pending = { event, before: before.before };
            if (after) this.updatePending(after);
          }
        } else if (after) this.updatePending(after);
        this.persist();
      } catch { this.unavailable("its replay outcome could not be recorded"); }
      return result;
    } finally {
      if (cdp && sessionId && action) {
        await cdp.send("Runtime.evaluate", { expression: "window.__baoWorkflowCleanup?.()" }, sessionId, 1000).catch(() => undefined);
        await cdp.send("Runtime.removeBinding", { name: binding }, sessionId, 1000).catch(() => undefined);
      }
      cdp?.close();
    }
  }

  finish(): string {
    if (this.finished) return this.finished;
    if (this.failedAction) this.unavailable("the task ended with a failed action");
    if (!this.startUrl || !this.events.length) this.unavailable("it contained no replayable actions");
    if (!this.reason) {
      try {
        const workflow = interpret(this.events, { id: this.workflowId, name: `Browser task on ${new URL(this.startUrl!).hostname}`, startUrl: this.startUrl!, preserveActions: true });
        if (workflow.steps.length !== this.events.length) throw new Error("an action could not be converted");
        workflow.driver = "playwright";
        workflow.replayed = false;
        this.persist();
        if (this.reason) throw new Error(this.reason);
        new Library(this.home).save(workflow);
        return this.finished = `Saved workflow: ${workflow.name} (${workflow.id}; bao://workflow/${workflow.id}).`;
      } catch { this.unavailable("its workflow could not be saved"); }
    }
    return this.finished = `Not saved as a workflow: ${this.reason}.`;
  }

  private updatePending(after: Observation): void {
    if (!this.pending) return;
    const { event, before } = this.pending;
    event.afterUrl = after.page.url;
    if (event.op !== "type") event.afterText = smallestChange(before.leaves, after.leaves)?.after;
    const hit = event.locators?.map((locator) => matchLocator(locator, after.page.nodes)).find((item) => item !== undefined);
    const node = hit && after.page.nodes[hit.index];
    event.subtreeAfter = node?.text;
    event.valueAfter = node?.value;
    event.checked = node?.checked;
  }

  private persist(): void {
    try { new Library(this.home).saveTrail(this.workflowId, this.events); }
    catch { this.unavailable("its replay evidence could not be saved"); }
  }
}
