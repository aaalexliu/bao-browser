// The live session's trail. Each live_click, live_type, live_key, and live_scroll
// that goes through appends one TrailEvent to <home>/live-session/trail.jsonl, with
// the control's full identity from CdpLiveDriver.tree(). A refused or halted call
// appends nothing. When the session ends, condense() and interpret() build its
// workflow from that trail, as the eval drivers do: typed text becomes an input,
// a search box's text replays as typed, a cart add is skipped while its item is
// in the cart, and a purchase control is a gate.

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { condense } from "../v1/condense";
import { normText, withoutPrice } from "../v1/identity";
import type { TrailEvent } from "../v1/interpret";
import { smallestChange } from "../v1/recorder";
import { validateWorkflow, type Identity, type WorkflowV2 } from "../v1/schema";
import { liveSessionDir } from "./audit";
import type { LabelGuard } from "./live-ops";
import { redactLabel } from "./live-record";
import { COMMIT_FLOOR } from "./presets";

export const LIVE_TRAIL_SOURCE = { agent: "live-model", vendor: "bao", adapter: "cdp-live" } as const;

export function liveTrailFile(home: string): string {
  return path.join(liveSessionDir(home), "trail.jsonl");
}

/** One act as the host records it. The trail adds the id, the time, and the source. */
export type LiveTrailAct = Omit<TrailEvent, "id" | "ts" | "kind" | "source">;

export class LiveTrail {
  private readonly events: TrailEvent[] = [];

  private constructor(readonly file: string) {}

  /** A new session starts an empty trail file. */
  static async open(home: string): Promise<LiveTrail> {
    const file = liveTrailFile(home);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "");
    return new LiveTrail(file);
  }

  async add(act: LiveTrailAct): Promise<TrailEvent> {
    const event: TrailEvent = {
      id: `live-${this.events.length + 1}`,
      ts: Date.now(),
      kind: "act",
      source: { ...LIVE_TRAIL_SOURCE },
      ...act,
    };
    this.events.push(event);
    await appendFile(this.file, `${JSON.stringify(event)}\n`);
    return event;
  }

  list(): readonly TrailEvent[] {
    return this.events;
  }
}

const SHOWN = ["name", "text", "label", "title"] as const;

/** Some node's name, text, label, or title reads `want` once its prices are dropped. */
function showsPriceFree(node: Identity, want: string): boolean {
  const plain = normText(want);
  return SHOWN.some((key) => {
    const value = node[key];
    return !!value && normText(withoutPrice(value)) === plain;
  });
}

/**
 * The marked control's identity for the trail. `nodes` is the page tree() read, with the marked
 * control in it. A field's current text is not part of who the field is. A price is not part of
 * a control's name either: its name, text, label, and title drop prices, unless a price is all
 * one of them shows. They keep their prices as recorded when another node on the page reads the
 * same once its prices drop, as "Donate $10" beside "Donate $25". Replay matches a role or text
 * locator against a control's text with its prices dropped too, so a product link's step label
 * and locators carry no price and still find the link after its price changes, while its text
 * fits the page dump's 80-character cut. The href stays.
 */
export function trailIdentity(identity: Identity | undefined, nodes: readonly Identity[]): Identity | undefined {
  if (!identity) return undefined;
  const copy: Identity = { ...identity, path: identity.path.map((seg) => ({ ...seg })) };
  if (copy.tag === "textarea" || (copy.tag === "input" && copy.role !== "button")) delete copy.value;
  const free = SHOWN.flatMap((key) => {
    const shown = copy[key];
    const plain = shown ? withoutPrice(shown) : "";
    return plain && plain !== shown ? [{ key, plain }] : [];
  });
  const others = nodes.filter((node) => node !== identity);
  if (!free.some(({ plain }) => others.some((node) => showsPriceFree(node, plain)))) {
    for (const { key, plain } of free) copy[key] = plain;
  }
  return copy;
}

/** The page around one act, read just before it and again just after. */
export interface LiveSide {
  url: string;
  /** Leaf text by structural path, from leafTexts. Empty when the act does not need it. */
  leaves: Record<string, string>;
  /** The control's own text. */
  text: string;
  /** A text field's value. Empty for other controls. */
  value: string;
  /** The control is no longer on the page. */
  missing: boolean;
}

function sameDocument(before: string, after: string): boolean {
  if (before === after) return true;
  try {
    const a = new URL(before);
    const b = new URL(after);
    return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return before.split("#")[0] === after.split("#")[0];
  }
}

function scrubLeaves(leaves: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(leaves)) {
    const clean = redactLabel(text);
    if (clean) out[key] = clean;
  }
  return out;
}

/**
 * smallestChange over text the page showed nowhere before the click, so a leaf that only
 * moved to a new path is not an effect.
 */
export function appearedLeaf(
  before: Record<string, string>,
  after: Record<string, string>,
): { before: string; after: string } | undefined {
  const seen = new Set(Object.values(before));
  const fresh = Object.fromEntries(Object.entries(after).filter(([key, text]) => text === before[key] || !seen.has(text)));
  return smallestChange(before, fresh);
}

/**
 * What a click changed, as condense and interpret read it. A url change is the effect by
 * itself. Otherwise it is the shortest leaf text that is new to the page, else the clicked
 * control's own text, else nothing, and condense drops a click with no effect.
 * Prices, long numbers, emails, and addresses are scrubbed first.
 */
export function clickEffect(before: LiveSide, after: LiveSide): Pick<TrailEvent, "subtreeBefore" | "subtreeAfter"> {
  if (!sameDocument(before.url, after.url)) return {};
  const appeared = appearedLeaf(scrubLeaves(before.leaves), scrubLeaves(after.leaves));
  if (appeared) return { subtreeBefore: appeared.before, subtreeAfter: appeared.after };
  const was = redactLabel(before.text);
  if (after.missing) return { subtreeBefore: was, subtreeAfter: was ? "" : "\u0000" };
  const now = redactLabel(after.text);
  return now === was ? {} : { subtreeBefore: was, subtreeAfter: now };
}

const CART_ADD = [
  /^add\s+\d+\s+(?:ct|items?|pkg|ea|each)\s+(.+)$/i,
  /^add\s+(.+?)\s+to\s+(?:cart|bag|basket)$/i,
];

/** A product page's "Add to cart", which does not name its item. */
const PLAIN_ADD = /^add to cart$/i;

/** What a product page shows once its item is in the cart, as "1 in cart". */
const IN_CART = /^\d+ in cart$/i;

function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The item an Add control names, as Instacart's "Add 1 ct {item}". Empty for a bare Add or Add to cart. */
export function cartAddItem(label: string): string {
  const text = flat(label);
  for (const shape of CART_ADD) {
    const item = shape.exec(text)?.[1]?.trim() || "";
    if (item.length >= 3) return item;
  }
  return "";
}

function nameOf(node: Identity): string {
  return flat(node.name || node.label || node.text || "");
}

/** A product page names its one item in one top-level heading. A page with no named h1, or several, is not one. */
export function productPage(nodes: readonly Identity[]): boolean {
  return nodes.filter((node) => node.tag === "h1" && nameOf(node)).length === 1;
}

/** The text replay looks for before a cart add, and whether each number in it matches any number. */
export interface CartSkip {
  text: string;
  anyCount: boolean;
}

/**
 * What tells replay that a cart add's item is already in the cart, so the add is skipped.
 * An Add that names its item, as "Add 1 ct {item}" on a results page, is marked by a control
 * the add revealed that names the item. A plain "Add to cart" on a product page, one with a
 * single h1, is marked only by the add's own effect when it reads "{n} in cart", at any count.
 * Undefined when the control is no cart add, or the add left no mark. `effect` is the text the
 * add made appear, from clickEffect. `readAfter` reads the page after the add, and only an Add
 * that names its item calls it.
 */
export async function cartAddSkip(
  label: string,
  before: readonly Identity[],
  effect: string | undefined,
  readAfter: () => Promise<readonly Identity[]>,
): Promise<CartSkip | undefined> {
  const named = cartAddItem(label);
  if (named) {
    const marker = inCartMarker(named, before, await readAfter());
    return marker ? { text: marker, anyCount: false } : undefined;
  }
  const shown = flat(effect || "");
  return PLAIN_ADD.test(flat(label)) && productPage(before) && IN_CART.test(shown) ? { text: shown, anyCount: true } : undefined;
}

/**
 * After a cart add, a control that says the item is in the cart: it names the item and was
 * not on the page before the add, such as "Increment quantity of {item}". Replay skips the
 * add while the page shows it. A control that adds more is preferred, because it stays at
 * every quantity. Empty when the add revealed no such control.
 */
export function inCartMarker(item: string, before: readonly Identity[], after: readonly Identity[]): string {
  if (!item) return "";
  const want = item.toLowerCase();
  const had = new Set(before.map(nameOf));
  const found = after.map(nameOf).filter((name) => {
    if (!name || had.has(name) || /^add\b/i.test(name) || /[@$]/.test(name)) return false;
    const at = name.toLowerCase().indexOf(want);
    if (at < 0) return false;
    // A count beside the item, as in "{item}, quantity 1", changes with the next add.
    return !/\d/.test(name.slice(0, at) + name.slice(at + item.length));
  });
  return found.find((name) => /^(?:increment|increase)\b/i.test(name))
    || found.find((name) => /^(?:remove|decrement|decrease)\b/i.test(name))
    || found[0]
    || "";
}

function matches(source: string, label: string): boolean {
  if (!source) return false;
  try {
    return new RegExp(source, "i").test(label);
  } catch {
    return false;
  }
}

/** A read's output name does not imply a click; only action labels can block saving. */
export function refusedStepLabels(workflow: Pick<WorkflowV2, "steps">, guard: LabelGuard): string[] {
  return workflow.steps
    .filter((step) => step.action !== "extract" && [guard.deny, guard.commit, COMMIT_FLOOR].some((source) => matches(source, step.label)))
    .map((step) => step.label);
}

/** The session's workflow, built from its trail the way the eval drivers build one. */
export function workflowFromTrail(input: {
  id: string;
  name: string;
  intent: string;
  startUrl: string;
  createdAt: number;
  savedAt: number;
  events: readonly TrailEvent[];
  guard: LabelGuard;
}): WorkflowV2 {
  const built = condense(input.events, { id: input.id, name: input.name, startUrl: input.startUrl });
  const workflow: WorkflowV2 = {
    ...built,
    createdAt: input.createdAt,
    updatedAt: input.savedAt,
    heal: "approve",
    driver: "cdp-live",
    intent: input.intent,
    summary: "Local draft. Recorded in the open Chrome through bao's live tools. Typed text is an input, except search text, which replays as typed.",
  };
  const errors = [
    ...validateWorkflow(workflow),
    ...refusedStepLabels(workflow, input.guard).map((label) => `refused label in step: ${label}`),
  ];
  if (errors.length) throw new Error(errors.join(", "));
  return workflow;
}
