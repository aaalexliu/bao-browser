// The live session's trail. Each live_click, live_type, live_key, and live_scroll
// that goes through appends one TrailEvent to <home>/live-session/trail.jsonl, with
// the control's full identity from CdpLiveDriver.tree(). A refused or halted call
// appends nothing. When the session ends, condense() and interpret() build its
// workflow from that trail, as the eval drivers do: typed text becomes an input,
// a search box's text is the input `query`, and a purchase control is a gate.

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { condense } from "../v1/condense";
import type { TrailEvent } from "../v1/interpret";
import { smallestChange } from "../v1/recorder";
import { validateWorkflow, type Identity, type WorkflowV2 } from "../v1/schema";
import { liveSessionDir } from "./audit";
import type { LabelGuard } from "./live-ops";
import { redactLabel } from "./live-record";
import { COMMIT_FLOOR } from "./presets";

export const LIVE_TRAIL_SOURCE = { agent: "live-model", vendor: "bao", adapter: "cdp-live" } as const;

/** The input a search box's typed text becomes. */
export const QUERY_INPUT = "query";

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

/** The marked control's identity for the trail. A field's current text is not part of who the field is. */
export function trailIdentity(identity: Identity | undefined): Identity | undefined {
  if (!identity) return undefined;
  const copy: Identity = { ...identity, path: identity.path.map((seg) => ({ ...seg })) };
  if (copy.tag === "textarea" || (copy.tag === "input" && copy.role !== "button")) delete copy.value;
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

/** The item an Add control names, as Instacart's "Add 1 ct {item}". Empty for a bare Add or Add to cart. */
export function cartAddItem(label: string): string {
  const text = label.replace(/\s+/g, " ").trim();
  for (const shape of CART_ADD) {
    const item = shape.exec(text)?.[1]?.trim() || "";
    if (item.length >= 3) return item;
  }
  return "";
}

function nameOf(node: Identity): string {
  return (node.name || node.label || node.text || "").replace(/\s+/g, " ").trim();
}

/**
 * After a cart add, a control that says the item is in the cart: it names the item and was
 * not on the page before the add, such as "Increment quantity of {item}". Replay skips the
 * add while the page shows it. A control that adds more is preferred, because it stays at
 * every quantity. Empty when the add revealed no such control.
 */
export function inCartMarker(label: string, before: readonly Identity[], after: readonly Identity[]): string {
  const item = cartAddItem(label);
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

/** Step labels that match the preset's deny or confirm labels, or the commit floor. A saved workflow has none. */
export function refusedStepLabels(workflow: Pick<WorkflowV2, "steps">, guard: LabelGuard): string[] {
  return workflow.steps
    .filter((step) => [guard.deny, guard.commit, COMMIT_FLOOR].some((source) => matches(source, step.label)))
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
    summary: "Local draft. Recorded in the open Chrome through bao's live tools. Typed text is an input.",
  };
  const errors = [
    ...validateWorkflow(workflow),
    ...refusedStepLabels(workflow, input.guard).map((label) => `refused label in step: ${label}`),
  ];
  if (errors.length) throw new Error(errors.join(", "));
  return workflow;
}
