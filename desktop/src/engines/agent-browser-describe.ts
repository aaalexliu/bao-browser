// One plain sentence per pass-through step, quoting the element's own text from the latest snapshot.

import { ownerAsk, ownerSite, ownerTask, type OwnerAsk, type OwnerPage } from "../cdp-live/owner-wait";
import type { AgentBrowserCommandResult } from "./agent-browser-proxy";

/** A sentence piece. `cite` is text copied from the page; `value` is text the agent supplied. */
export type SummaryPart = string | { cite: string } | { value: string };

export interface OwnerHandoff {
  kind: OwnerAsk;
  site: string;
  url: string;
  title: string;
  /** Time since the handoff started, when Bao knows that start. */
  waitedMs?: number;
}

/** A sign-in or check page, with the time Bao first stopped for it. */
export type OwnerWaitPage = OwnerPage & { since?: number };

export interface StepSummary {
  parts: SummaryPart[];
  /** The sentence for text-only clients and the model. It may add the page address. */
  text: string;
  /** Label for the box drawn on the step's picture. */
  mark?: string;
  /** The page after the step, from Chrome's own URL and title. */
  page?: OwnerPage;
  owner?: OwnerHandoff;
  error?: string;
}

export interface StepFacts {
  command: string;
  args: readonly string[];
  results: readonly AgentBrowserCommandResult[];
  error?: string;
  /** The latest snapshot before this step, for the element a click or fill names. */
  snapshot?: string;
  /** Headings and dialogs earlier reads saw on this page. Absent on a page's first read. */
  seen?: ReadonlySet<string>;
  page?: OwnerPage;
  previousPage?: OwnerPage;
  owner?: OwnerWaitPage;
  /** The session drives the owner's own running Chrome, not a Bao window. */
  current?: boolean;
  /** When the step ended. Defaults to now. */
  at?: number;
}

interface SnapshotLine {
  index: number;
  indent: number;
  role: string;
  name?: string;
  ref?: string;
}

const LINE = /^(\s*)- ([A-Za-z][\w-]*)(?: "((?:[^"\\]|\\.)*)")?(.*)$/;
const NAME_LIMIT = 60;

export function parseSnapshot(text: string | undefined): SnapshotLine[] {
  if (!text) return [];
  return text.split("\n").flatMap((row, index) => {
    const match = LINE.exec(row);
    if (!match) return [];
    const name = match[3]?.replace(/\\(.)/g, "$1").replace(/\s+/g, " ").trim();
    const ref = /\bref=(e\d+)(?![\w])/.exec(match[4] ?? "")?.[1];
    return [{ index, indent: match[1]!.length, role: match[2]!, ...(name ? { name } : {}), ...(ref ? { ref } : {}) }];
  });
}

/** Keep the element's own words, cut at a separator or a word boundary when they run long. */
export function shortName(name: string): string {
  const text = name.replace(/\s+/g, " ").trim();
  if (text.length <= NAME_LIMIT) return text;
  const bar = text.indexOf("|");
  const cut = bar >= 12 && bar <= NAME_LIMIT ? bar : text.lastIndexOf(" ", NAME_LIMIT);
  return `${text.slice(0, cut > 12 ? cut : NAME_LIMIT).trimEnd()}…`;
}

const ROLE_WORDS: Record<string, string> = {
  textbox: "text field", searchbox: "search box", combobox: "drop-down", listbox: "list", radio: "option button",
  menuitem: "menu item", menuitemcheckbox: "menu item", menuitemradio: "menu item", spinbutton: "number field",
  img: "image", image: "image", gridcell: "cell", cell: "cell", columnheader: "column header", rowheader: "row header",
  treeitem: "tree item", alertdialog: "dialog", StaticText: "text",
};

export function roleWord(role: string): string {
  return ROLE_WORDS[role] ?? role;
}

interface Element { role: string; name?: string; context?: string }

/** The named element for a ref, plus the item that holds it when the page repeats the element's name. */
export function elementFor(ref: string | undefined, snapshot: string | undefined): Element | undefined {
  const id = ref?.trim().replace(/^@/, "");
  if (!id || !/^e\d+$/.test(id)) return undefined;
  const lines = parseSnapshot(snapshot);
  const at = lines.findIndex((line) => line.ref === id);
  if (at < 0) return undefined;
  const line = lines[at]!;
  if (!line.name) return { role: line.role };
  const repeated = lines.filter((other) => other.name === line.name && other.role === line.role).length > 1;
  const context = repeated ? itemName(lines, at) : undefined;
  return { role: line.role, name: line.name, ...(context ? { context } : {}) };
}

const ITEM_ROLES = new Set(["listitem", "row", "article"]);
const LABELLED_ROLES = new Set(["group", "region"]);

/** The own name of the nearest list item, row, article, or labelled group or region that holds this element in the snapshot tree. */
function itemName(lines: SnapshotLine[], at: number): string | undefined {
  let indent = lines[at]!.indent;
  for (let i = at - 1; i >= 0 && indent > 0; i--) {
    const parent = lines[i]!;
    if (parent.indent >= indent) continue;
    indent = parent.indent;
    if (ITEM_ROLES.has(parent.role) || LABELLED_ROLES.has(parent.role) && parent.name) return parent.name;
  }
  return undefined;
}

function landmarks(snapshot: string | undefined): SnapshotLine[] {
  return parseSnapshot(snapshot).filter((line) => (line.role === "heading" || line.role === "dialog" || line.role === "alertdialog") && line.name);
}

/** Keys for the headings and dialogs a read shows, so a later read of the same page can tell what is new. */
export function landmarkKeys(snapshot: string | undefined): string[] {
  return landmarks(snapshot).map((line) => `${line.role}\n${line.name}`);
}

/** The first heading or dialog this read shows that no earlier read of the same page showed. */
export function newInRead(seen: ReadonlySet<string> | undefined, current: string | undefined): SnapshotLine | undefined {
  if (!seen?.size) return undefined;
  return landmarks(current).find((line) => line.ref && !seen.has(`${line.role}\n${line.name}`));
}

function counts(snapshot: string | undefined): string {
  const lines = parseSnapshot(snapshot);
  const fields = new Set(["textbox", "searchbox", "combobox", "checkbox", "radio", "spinbutton", "slider", "switch", "listbox"]);
  const tally = (test: (line: SnapshotLine) => boolean, one: string, many: string) => {
    const n = lines.filter(test).length;
    return n ? `${n} ${n === 1 ? one : many}` : "";
  };
  const parts = [
    tally((line) => line.role === "button", "button", "buttons"),
    tally((line) => line.role === "link", "link", "links"),
    tally((line) => fields.has(line.role), "field", "fields"),
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "no buttons, links, or fields";
}

function firstLine(text: string | undefined): string {
  return text?.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

export function failureText(results: readonly AgentBrowserCommandResult[], error?: string): string {
  const failed = results.find((result) => result.exitCode !== 0);
  return firstLine(failed?.stderr) || firstLine(failed?.stdout) || firstLine(error) || "The command failed.";
}

export const CURRENT_CHROME_ENDED = "The owner's Chrome session ended. Reconnect with command=open and browser=current, or choose browser=bao explicitly to use Bao's lasting profile.";

export interface OwnerReply { outcome: "halted" | "waiting" | "ready" | "closed"; instruction: string }

/** Bao's own reply while the owner has a turn, which stands in for native output. */
export function ownerReply(results: readonly AgentBrowserCommandResult[]): OwnerReply | undefined {
  try {
    const value = JSON.parse(results[0]?.stdout || "") as { outcome?: unknown; instruction?: unknown };
    return typeof value.outcome === "string" && ["halted", "waiting", "ready", "closed"].includes(value.outcome) && typeof value.instruction === "string"
      ? { outcome: value.outcome as OwnerReply["outcome"], instruction: value.instruction } : undefined;
  } catch { return undefined; }
}

export function ownerOutcome(results: readonly AgentBrowserCommandResult[]): OwnerReply["outcome"] | undefined {
  return ownerReply(results)?.outcome;
}

export function ownerHandoff(page: OwnerWaitPage | undefined, at = Date.now()): OwnerHandoff | undefined {
  if (!page) return undefined;
  return { kind: ownerAsk(page), site: ownerSite(page.url), url: page.url, title: page.title,
    ...(page.since !== undefined ? { waitedMs: Math.max(0, at - page.since) } : {}) };
}

/** How long the owner has had the turn, in words: "45 s", "4 min", "9 h 53 min". */
export function waited(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes / 60} h`;
}

function openedPage(results: readonly AgentBrowserCommandResult[], page: OwnerPage | undefined, arg: string | undefined): OwnerPage | undefined {
  const match = /^✓ (.*)\n\s+(\S+)/.exec(results[0]?.stdout ?? "");
  if (match && (!page || page.url === match[2])) return { title: match[1]!.trim(), url: match[2]! };
  if (page) return page;
  return arg ? { title: "", url: arg } : undefined;
}

export function summaryText(parts: readonly SummaryPart[]): string {
  return parts.map((part) => typeof part === "string" ? part : "cite" in part ? `"${part.cite}"` : `"${part.value}"`).join("");
}

/** The card's copy of the parts: an agent value is cut like an element name. The text sentence keeps it whole. */
function cardParts(parts: readonly SummaryPart[]): SummaryPart[] {
  return parts.map((part) => typeof part === "object" && "value" in part ? { value: shortName(part.value) } : part);
}

function elementParts(element: Element | undefined, arg: string | undefined): SummaryPart[] {
  if (!element) return [arg && !/^@?e\d+$/.test(arg.trim()) ? { value: arg } : "the element"];
  const head: SummaryPart[] = element.name ? [{ cite: shortName(element.name) }, ` (${roleWord(element.role)})`] : [`the ${roleWord(element.role)}`];
  return element.context ? [...head, " for ", { cite: shortName(element.context) }] : head;
}

function moved(facts: StepFacts): string {
  const page = facts.page;
  if (!page?.url || !facts.previousPage || page.url === facts.previousPage.url) return ".";
  return page.title ? `. Now on "${page.title}" (${page.url}).` : `. Now on ${page.url}.`;
}

/** Describe a finished pass-through step. Facts come from native output and Chrome's own page metadata. */
export function describeStep(facts: StepFacts): StepSummary {
  const { command, args, results } = facts;
  const reply = ownerReply(results);
  const outcome = reply?.outcome;
  const failed = facts.error !== undefined || results.some((result) => result.exitCode !== 0);
  const page = facts.page;
  const browser = facts.current ? "your Chrome" : "Bao's Chrome window";
  const done = (parts: SummaryPart[], extra = ".", more: Partial<StepSummary> = {}): StepSummary =>
    ({ parts: cardParts(parts), text: summaryText(parts) + extra, ...(page ? { page } : {}), ...more });

  if (outcome === "halted" || outcome === "waiting") {
    const owner = ownerHandoff(facts.owner, facts.at);
    if (!owner) return done([`Your turn: finish the check on the page in ${browser}`]);
    const ask = `Your turn: ${ownerTask(owner)} in ${browser}`;
    const waiting = owner.waitedMs !== undefined ? `, waiting ${waited(owner.waitedMs)}` : "";
    const where = owner.title ? ` The page is "${owner.title}" (${owner.url})${waiting}.` : ` The page is ${owner.url}${waiting}.`;
    return { parts: [ask], text: `${ask}.${where} Bao reads only the title and address until the page changes.`, owner };
  }
  if (outcome === "ready") {
    const back = ownerHandoff(facts.owner)?.kind === "sign-in" ? "Back from sign-in" : "Back from the check";
    return page?.title ? done([`${back}: now on `, { cite: page.title }], page.url ? ` (${page.url}).` : ".")
      : done([back]);
  }
  if (outcome === "closed") {
    const ended = reply?.instruction === CURRENT_CHROME_ENDED ? "Your Chrome session ended" : "The Bao window closed";
    return { parts: [`${ended}. This session cannot continue`], text: `${ended}. This session cannot continue.` };
  }

  const error = failed ? failureText(results, facts.error) : undefined;
  const element = command === "click" || command === "fill" ? elementFor(args[0], facts.snapshot) : undefined;
  if (failed) {
    const verb: Record<string, string> = { open: "open", snapshot: "read the page", click: "click", fill: "type into", press: "press", scroll: "scroll", tab: "change tabs", screenshot: "take a screenshot", close: facts.current ? "close Bao's task tab" : "close the window", wait_for_owner: "wait for you" };
    const target: SummaryPart[] = command === "open" && args[0] ? [" ", { value: args[0] }]
      : command === "click" || command === "fill" ? [" ", ...elementParts(element, args[0])]
        : command === "press" && args[0] ? [` ${args[0]}`] : [];
    const parts: SummaryPart[] = [`Could not ${verb[command] ?? command}`, ...target];
    // The native error follows in its own block, so the sentence does not repeat it.
    return { parts: cardParts(parts), text: `${summaryText(parts)}.`, error, ...(page ? { page } : {}) };
  }

  switch (command) {
    case "open": {
      const opened = openedPage(results, page, args[0]);
      if (!opened) return done(["Went to the page"]);
      const parts: SummaryPart[] = opened.title ? ["Went to ", { cite: opened.title }] : ["Went to ", opened.url];
      return { parts, text: opened.title ? `Went to ${opened.url} ("${opened.title}").` : `Went to ${opened.url}.`, page: opened };
    }
    case "snapshot": {
      const current = results.find((result) => result.exitCode === 0)?.stdout;
      const added = newInRead(facts.seen, current);
      const where = page?.title ? ` on "${page.title}"` : "";
      if (added?.name) {
        const parts: SummaryPart[] = ["Read ", { cite: shortName(added.name) }, ` (new ${roleWord(added.role)})`];
        return done(parts, `${where}: ${counts(current)}.`, { mark: "New" });
      }
      const parts: SummaryPart[] = page?.title ? ["Read the page ", { cite: page.title }] : ["Read the page"];
      return done(parts, `${page?.url ? ` (${page.url})` : ""}: ${counts(current)}.`);
    }
    case "click": return done(["Clicked ", ...elementParts(element, args[0])], moved(facts), { mark: "Clicked" });
    case "fill": return done(["Typed ", { value: args[1] ?? "" }, " into ", ...elementParts(element, args[0])], ".", { mark: "Typed here" });
    case "press": return done([`Pressed ${args[0] || "a key"}`], moved(facts));
    case "scroll": {
      const [direction, amount] = args;
      return done([`Scrolled ${direction || "the page"}${amount && /^\d+$/.test(amount) ? ` ${amount} px` : ""}`], page?.title ? ` on "${page.title}".` : ".");
    }
    case "tab": {
      if (args[0] === "list" || args.length === 0) return done(["Listed the browser tabs"]);
      if (args[0] === "new") return done(["Opened a new tab"]);
      if (args[0] === "close") return done(["Closed a tab"]);
      return done(page?.title ? ["Switched to the tab ", { cite: page.title }] : ["Switched tabs"]);
    }
    case "screenshot": return done(page?.title ? ["Took a screenshot of ", { cite: page.title }] : ["Took a screenshot of the page"]);
    case "close": {
      const closed = facts.current ? "Closed Bao's task tab in your Chrome" : "Closed the Bao browser window";
      return { parts: [closed], text: `${closed}.` };
    }
    default: return done([`Ran ${command}`]);
  }
}
