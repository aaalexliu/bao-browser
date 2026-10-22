// Cheap repairs. They run before any model call and only use the step's
// recorded intent plus the live tree. A repair that is not sure returns nothing.

import { lookup } from "./identity";
import { isCollapsedBox, locatorIndexes, matchLocator } from "./locators";
import type { Identity, StepLocator, WorkflowStep } from "./schema";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type RepairKind = "wait" | "overlay" | "label" | "anchor" | "reveal";

export interface RepairLog {
  stepId: string;
  repair: RepairKind;
  detail: string;
}

const ACCEPT = 0.8;
const MARGIN = 0.12;

export function textScore(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const xWords = x.split(" ");
  const yWords = y.split(" ");
  if (covers(xWords, yWords) || covers(yWords, xWords)) return 0.86;
  const left = grams(x.replace(/ /g, ""));
  const right = grams(y.replace(/ /g, ""));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/** A unique label close to the step's intent. Ties, weak scores, and collapsed boxes are refused. */
export function labelCandidate(
  step: WorkflowStep,
  nodes: Identity[],
  boxes?: Box[],
): { index: number; detail: string } | undefined {
  const want = intentText(step);
  if (!want) return undefined;
  const ranked = nodes.map((node, index) => ({ index, score: scoreNode(want, node, step) }))
    .filter((item) => item.score >= ACCEPT)
    .filter((item) => {
      const box = boxes?.[item.index];
      return !box || box.w > 0 || box.h > 0;
    })
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const second = ranked[1];
  if (!best) return undefined;
  if (second && best.score - second.score < MARGIN) return undefined;
  const node = nodes[best.index];
  return { index: best.index, detail: `${want} ~ ${shown(node)} (${best.score.toFixed(2)})` };
}

/** The nearest element of the step's role on the requested side of the anchor. */
export function anchorCandidate(
  step: WorkflowStep,
  nodes: Identity[],
  boxes: Box[] | undefined,
): { index: number; detail: string } | undefined {
  const anchor = step.anchor;
  if (!anchor || !boxes) return undefined;
  const found = lookup(anchor.identity, nodes);
  if (!found.ok || found.index == null) return undefined;
  const origin = center(boxes[found.index]);
  if (!origin) return undefined;
  const role = normRole(step.identity?.role);
  let best: { index: number; distance: number } | undefined;
  nodes.forEach((node, index) => {
    if (index === found.index) return;
    if (role && normRole(node.role) !== role) return;
    const point = center(boxes[index]);
    if (!point || !onSide(origin, point, anchor.relation)) return;
    const distance = Math.hypot(point.x - origin.x, point.y - origin.y);
    if (!best || distance < best.distance) best = { index, distance };
  });
  if (!best) return undefined;
  return { index: best.index, detail: `${anchor.relation} ${shown(nodes[best.index])}` };
}

const TOGGLE = /^(search|buscar)$/;

/**
 * The recorded target is present and its box is 0×0 or hidden.
 * A visible match is not this case: the locator would have used it.
 */
export function collapsedTarget(
  step: WorkflowStep,
  nodes: Identity[],
  boxes?: Box[],
  hidden?: boolean[],
  locators?: StepLocator[],
): { index: number; detail: string } | undefined {
  const list = locators && locators.length ? locators : step.locators;
  if (list && list.length) {
    for (const locator of list) {
      const indexes = locatorIndexes(locator, nodes);
      if (indexes.length !== 1) continue;
      const index = indexes[0]!;
      if (!isCollapsedBox(index, boxes, hidden)) continue;
      const node = nodes[index];
      return { index, detail: `${locator.kind} ${node?.id || node?.name || node?.text || "collapsed"}` };
    }
    return undefined;
  }
  if (!step.identity) return undefined;
  const found = lookup(step.identity, nodes);
  if (!found.ok || found.index == null) return undefined;
  if (!isCollapsedBox(found.index, boxes, hidden)) return undefined;
  return { index: found.index, detail: "identity collapsed" };
}

/**
 * A visible search toggle for a collapsed field. Recorded `step.reveal` wins
 * when it is on the step; this is the discoverable fallback.
 */
export function discoverReveal(
  nodes: Identity[],
  boxes: Box[] | undefined,
  collapsedIndex: number,
  hidden?: boolean[],
): { index: number; detail: string } | undefined {
  const target = nodes[collapsedIndex];
  const hay = norm([target?.name, target?.label, target?.text, target?.title].filter(Boolean).join(" "));
  const hits: number[] = [];
  nodes.forEach((node, index) => {
    if (index === collapsedIndex || isCollapsedBox(index, boxes, hidden)) return;
    const role = normRole(node.role);
    if (role !== "button" && role !== "link") return;
    const label = norm(node.name || node.text || node.label || "");
    if (!TOGGLE.test(label)) return;
    const inSearch = (node.path || []).some((seg) => normRole(seg.role) === "search");
    if (!inSearch && !hay.includes(label)) return;
    hits.push(index);
  });
  if (hits.length !== 1) return undefined;
  const index = hits[0]!;
  const node = nodes[index];
  return { index, detail: node?.text || node?.name || node?.label || "search toggle" };
}

/** The recorded reveal control, when it is visible. */
export function recordedReveal(
  step: WorkflowStep,
  nodes: Identity[],
  boxes?: Box[],
  hidden?: boolean[],
): { index: number; detail: string } | undefined {
  if (!step.reveal) return undefined;
  const found = matchLocator(step.reveal, nodes, boxes, hidden);
  if (!found) return undefined;
  return { index: found.index, detail: `recorded ${found.detail}` };
}

/** A known overlay's dismiss control. Absent when the page has no overlay. */
export function overlayClose(nodes: Identity[]): Identity | undefined {
  const overlay = nodes.some((node) => node.role === "dialog" || node.testId === "overlay" || node.testId === "overlay-close");
  if (!overlay) return undefined;
  return nodes.find((node) => node.testId === "overlay-close" || /^(dismiss|close|not now|no thanks)$/i.test(shown(node)));
}

export function intentText(step: WorkflowStep): string {
  const raw = step.intent || step.label || "";
  return raw.replace(/^(click|type|press|verify|upload|drop)\s+/i, "").replace(/^"|"$/g, "").replace(/"/g, "").trim();
}

function scoreNode(want: string, node: Identity, step: WorkflowStep): number {
  const role = normRole(step.identity?.role);
  if (role && normRole(node.role) && normRole(node.role) !== role) return 0;
  const texts = [node.name, node.text, node.label, node.title, node.description].filter((item): item is string => !!item);
  if (!texts.length) return 0;
  return Math.max(...texts.map((text) => textScore(want, text)));
}

function shown(node: Identity | undefined): string {
  if (!node) return "";
  return node.name || node.text || node.label || node.title || node.testId || node.role;
}

function norm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normRole(role: string | undefined): string {
  return (role || "").toLowerCase().replace(/^ax/, "");
}

function covers(shorter: string[], longer: string[]): boolean {
  if (!shorter.length || shorter.length > longer.length) return false;
  return shorter.every((word) => longer.includes(word));
}

function grams(value: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < value.length - 1; i++) out.add(value.slice(i, i + 2));
  return out;
}

function center(box: { x: number; y: number; w: number; h: number } | undefined): { x: number; y: number } | undefined {
  if (!box || box.w <= 0 || box.h <= 0) return undefined;
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

function onSide(
  origin: { x: number; y: number },
  point: { x: number; y: number },
  relation: "below" | "above" | "right" | "left",
): boolean {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  if (relation === "below") return dy > 8 && Math.abs(dx) < Math.max(160, dy * 2);
  if (relation === "above") return dy < -8 && Math.abs(dx) < Math.max(160, Math.abs(dy) * 2);
  if (relation === "right") return dx > 8 && Math.abs(dy) < Math.max(80, dx * 2);
  return dx < -8 && Math.abs(dy) < Math.max(80, Math.abs(dx) * 2);
}
