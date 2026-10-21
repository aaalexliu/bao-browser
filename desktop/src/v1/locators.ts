// Ordered locators, tried before the repair tiers.
// A locator hits only when exactly one node matches. Two matches are a miss.

import { normRole, normText } from "./identity";
import type { Box } from "./repair";
import type { Identity, StepLocator } from "./schema";

export function locatorsFromIdentity(identity: Identity | undefined): StepLocator[] | undefined {
  if (!identity) return undefined;
  const list = buildLocators(identity, [identity]);
  return list.length ? list : undefined;
}

/** role, text, test id, css, xpath, then a relative anchor when the boxes are real. */
export function buildLocators(
  target: Identity,
  nodes: Identity[],
  boxes?: Box[],
  targetIndex?: number,
): StepLocator[] {
  const out: StepLocator[] = [];
  const roleName = target.name || target.label || target.text;
  if (target.role && target.role !== "unknown" && roleName) {
    out.push({ kind: "role", role: target.role, name: roleName });
  } else if (target.role && /text/i.test(target.role)) {
    out.push({ kind: "role", role: target.role, name: "" });
  }
  const text = target.text || target.name;
  if (text && text.length <= 80) out.push({ kind: "text", value: text });
  if (target.testId) out.push({ kind: "testid", value: target.testId });
  const css = stableCss(target);
  if (css) out.push({ kind: "css", value: css });
  const xpath = target.xpath || stableXPath(target);
  if (xpath) out.push({ kind: "xpath", value: xpath });
  const anchor = anchorLocator(target, nodes, boxes, targetIndex);
  if (anchor) out.push(anchor);
  return out;
}

export function matchLocator(
  locator: StepLocator,
  nodes: Identity[],
  boxes?: Box[],
): { index: number; detail: string } | undefined {
  if (locator.kind === "anchor") return matchAnchor(locator, nodes, boxes);
  const hits: number[] = [];
  nodes.forEach((node, index) => {
    if (boxes && collapsed(boxes[index])) return;
    if (nodeMatches(locator, node)) hits.push(index);
  });
  if (hits.length !== 1) return undefined;
  const index = hits[0]!;
  const node = nodes[index];
  return { index, detail: `${locator.kind} ${shown(node)}` };
}

function collapsed(box: Box | undefined): boolean {
  return !!box && box.w <= 0 && box.h <= 0;
}

function nodeMatches(locator: StepLocator, node: Identity): boolean {
  if (locator.kind === "role") return roleMatches(locator, node);
  if (locator.kind === "text") return !!locator.value && same(locator.value, node.text, node.name, node.label);
  if (locator.kind === "testid") return !!locator.value && same(locator.value, node.testId);
  if (locator.kind === "css") return !!locator.value && cssMatches(locator.value, node);
  if (locator.kind === "xpath") return !!locator.value && xpathMatches(locator.value, node);
  return false;
}

function roleMatches(locator: StepLocator, node: Identity): boolean {
  if (!locator.role || locator.name == null) return false;
  if (normRole(locator.role) !== normRole(node.role)) return false;
  if (locator.name === "") {
    return !normText(node.name || "") && !normText(node.text || "") && !normText(node.label || "");
  }
  return same(locator.name, node.name, node.text, node.label, node.title);
}

function cssMatches(selector: string, node: Identity): boolean {
  if (node.cssPath && node.cssPath === selector) return true;
  if (selector.startsWith("#") && node.id === cssUnescape(selector.slice(1))) return true;
  const test = selector.match(/^\[data-testid="([^"]+)"\]$/);
  if (test && node.testId === test[1]) return true;
  const named = selector.match(/^(?:[a-z0-9]+)?\[name="([^"]+)"\]$/);
  return !!named && node.nameAttr === named[1];
}

function xpathMatches(selector: string, node: Identity): boolean {
  if (node.xpath && node.xpath === selector) return true;
  const id = selector.match(/^\/\/\*\[@id="([^"]+)"\]$/);
  if (id && node.id === id[1]) return true;
  const named = selector.match(/^\/\/([a-z0-9]+)\[@name="([^"]+)"\]$/);
  return !!named && node.tag === named[1] && node.nameAttr === named[2];
}

function stableCss(node: Identity): string | undefined {
  if (node.id && !unstable(node.id)) return `#${cssEscape(node.id)}`;
  if (node.testId) return `[data-testid="${cssAttr(node.testId)}"]`;
  if (node.nameAttr && node.tag) return `${node.tag}[name="${cssAttr(node.nameAttr)}"]`;
  if (node.nameAttr) return `[name="${cssAttr(node.nameAttr)}"]`;
  return node.cssPath;
}

function stableXPath(node: Identity): string | undefined {
  if (node.id && !unstable(node.id)) return `//*[@id="${node.id.replace(/"/g, "")}"]`;
  if (node.nameAttr && node.tag) return `//${node.tag}[@name="${node.nameAttr.replace(/"/g, "")}"]`;
  return undefined;
}

function anchorLocator(
  target: Identity,
  nodes: Identity[],
  boxes: Box[] | undefined,
  targetIndex: number | undefined,
): StepLocator | undefined {
  if (!boxes || !usable(boxes)) return undefined;
  const index = targetIndex ?? nodes.indexOf(target);
  const origin = center(boxes[index]);
  if (!origin) return undefined;
  let best: { index: number; distance: number; relation: StepLocator["relation"] } | undefined;
  nodes.forEach((node, i) => {
    if (i === index || !stableNeighbor(node)) return;
    const point = center(boxes[i]);
    if (!point) return;
    const relation = relationOf(origin, point);
    if (!relation) return;
    const distance = Math.hypot(point.x - origin.x, point.y - origin.y);
    if (!best || distance < best.distance) best = { index: i, distance, relation };
  });
  if (!best) return undefined;
  const neighbor = nodes[best.index];
  if (!neighbor) return undefined;
  return {
    kind: "anchor",
    role: target.role,
    relation: best.relation,
    anchor: {
      surface: neighbor.surface,
      role: neighbor.role,
      name: neighbor.name,
      text: neighbor.text,
      testId: neighbor.testId,
      id: neighbor.id,
      path: [],
    },
  };
}

function matchAnchor(
  locator: StepLocator,
  nodes: Identity[],
  boxes: Box[] | undefined,
): { index: number; detail: string } | undefined {
  if (!locator.anchor || !locator.relation || !boxes) return undefined;
  let anchorAt = -1;
  nodes.forEach((node, index) => {
    if (anchorAt >= 0) return;
    if (sameNode(locator.anchor!, node)) anchorAt = index;
  });
  if (anchorAt < 0) return undefined;
  const origin = center(boxes[anchorAt]);
  if (!origin) return undefined;
  const role = locator.role ? normRole(locator.role) : "";
  const hits: number[] = [];
  nodes.forEach((node, index) => {
    if (index === anchorAt) return;
    if (role && normRole(node.role) !== role) return;
    const point = center(boxes[index]);
    if (!point || !onSide(origin, point, locator.relation!)) return;
    hits.push(index);
  });
  if (hits.length !== 1) return undefined;
  const index = hits[0]!;
  return { index, detail: `${locator.relation} ${shown(nodes[index])}` };
}

function sameNode(query: Identity, node: Identity): boolean {
  if (query.testId && node.testId === query.testId) return true;
  if (query.id && node.id === query.id) return true;
  if (query.role && normRole(query.role) === normRole(node.role) && query.text && same(query.text, node.text, node.name)) return true;
  if (query.role && normRole(query.role) === normRole(node.role) && query.name && same(query.name, node.name, node.text, node.label)) return true;
  return false;
}

function stableNeighbor(node: Identity): boolean {
  if (node.testId) return true;
  if (node.id && !unstable(node.id)) return true;
  return normRole(node.role) === "heading" && !!(node.text || node.name);
}

function usable(boxes: Box[]): boolean {
  const real = boxes.filter((box) => box.w > 0 && box.h > 0 && (box.x !== 0 || box.y !== 0));
  return real.length >= 2;
}

function relationOf(
  target: { x: number; y: number },
  neighbor: { x: number; y: number },
): StepLocator["relation"] | undefined {
  const dx = target.x - neighbor.x;
  const dy = target.y - neighbor.y;
  if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return undefined;
  if (Math.abs(dy) >= Math.abs(dx)) return dy > 0 ? "below" : "above";
  return dx > 0 ? "right" : "left";
}

function onSide(
  origin: { x: number; y: number },
  point: { x: number; y: number },
  relation: NonNullable<StepLocator["relation"]>,
): boolean {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  if (relation === "below") return dy > 8 && Math.abs(dx) < Math.max(160, dy * 2);
  if (relation === "above") return dy < -8 && Math.abs(dx) < Math.max(160, Math.abs(dy) * 2);
  if (relation === "right") return dx > 8 && Math.abs(dy) < Math.max(80, dx * 2);
  return dx < -8 && Math.abs(dy) < Math.max(80, Math.abs(dx) * 2);
}

function center(box: Box | undefined): { x: number; y: number } | undefined {
  if (!box || box.w <= 0 || box.h <= 0) return undefined;
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

function same(want: string, ...values: (string | undefined)[]): boolean {
  const left = normText(want);
  if (!left) return false;
  return values.some((value) => !!value && normText(value) === left);
}

function shown(node: Identity | undefined): string {
  if (!node) return "";
  return node.name || node.text || node.label || node.testId || node.id || node.role;
}

function unstable(id: string): boolean {
  return /^(ember|react|mui|css-)/i.test(id) || /[0-9a-f]{8,}/i.test(id) || /:r[0-9a-z]+:/i.test(id) || /\d{4,}/.test(id);
}

function cssEscape(value: string): string {
  return value.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

function cssUnescape(value: string): string {
  return value.replace(/\\(.)/g, "$1");
}

function cssAttr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
