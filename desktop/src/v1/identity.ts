// One scorer for DOM, macOS AX, and Linux AT-SPI.
// A match is accepted only when it clears ACCEPT and leads the runner-up by MARGIN.
// Otherwise replay refuses. Coordinates are not an input.

import type { Identity, PathSeg, Surface } from "./schema";

export type { Identity };

export const ACCEPT = 60;
export const MARGIN = 25;

const DOM_PRIORITY = [
  "testId", "id", "roleName", "label", "nameAttr", "text", "path", "cssPath", "siblingIndex",
] as const;

const AX_PRIORITY = [
  "identifier", "role", "subrole", "name", "title", "description", "value", "path",
  "windowTitle", "siblingIndex",
] as const;

export interface ScorePart {
  attr: string;
  points: number;
  matched: boolean;
}

export interface Score {
  index: number;
  score: number;
  parts: ScorePart[];
}

export interface Lookup {
  ok: boolean;
  index?: number;
  score?: number;
  margin?: number;
  reason?: "tie" | "below-threshold" | "no-candidates" | "app-mismatch";
  brokenAttr?: string;
  ranked: Score[];
}

export function normRole(role: string): string {
  let r = role.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (r.startsWith("ax")) r = r.slice(2);
  if (r === "pushbutton") return "button";
  if (r === "textfield" || r === "textbox" || r === "entry" || r === "text") return "textbox";
  if (r === "statictext" || r === "label") return "statictext";
  if (r === "popbutton") return "button";
  return r;
}

export function normText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function eq(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return normText(a) === normText(b);
}

export function unstableId(id: string): boolean {
  return /^(ember|react|mui|css-)/i.test(id)
    || /[0-9a-f]{8,}/i.test(id)
    || /:r[0-9a-z]+:/i.test(id)
    || /\d{4,}/.test(id);
}

function sameApp(query: Identity, candidate: Identity): boolean {
  if (query.bundleId && candidate.bundleId) return eq(query.bundleId, candidate.bundleId);
  if (query.app && candidate.app) return eq(query.app, candidate.app);
  return true;
}

function pathEq(a: PathSeg[], b: PathSeg[]): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  return a.every((seg, i) => {
    const other = b[i];
    if (!other) return false;
    if (normRole(seg.role) !== normRole(other.role)) return false;
    if (!seg.name && !other.name) return true;
    return eq(seg.name, other.name);
  });
}

function namesMatch(query: Identity, candidate: Identity): boolean {
  const want = query.name || query.title;
  if (!want) return false;
  return eq(want, candidate.name) || eq(want, candidate.title) || eq(want, candidate.text);
}

export function scoreIdentity(query: Identity, candidate: Identity): Omit<Score, "index"> {
  const parts: ScorePart[] = [];
  const add = (attr: string, points: number, matched: boolean) => {
    if (matched) parts.push({ attr, points, matched: true });
    else if (points > 0) parts.push({ attr, points: 0, matched: false });
  };

  if (query.surface === "dom") {
    if (query.testId) add("testId", 100, eq(query.testId, candidate.testId));
    if (query.id) add("id", unstableId(query.id) ? 15 : 80, eq(query.id, candidate.id));
    if (query.role && query.role !== "unknown" && (query.name || query.text)) {
      add("roleName", 70, normRole(query.role) === normRole(candidate.role) && (eq(query.name, candidate.name) || eq(query.text, candidate.text) || eq(query.name, candidate.text)));
    }
    if (query.label) add("label", 55, eq(query.label, candidate.label) || eq(query.label, candidate.name));
    if (query.nameAttr) add("nameAttr", 50, eq(query.nameAttr, candidate.nameAttr));
    if (query.text) add("text", 40, eq(query.text, candidate.text) || eq(query.text, candidate.name));
    if (query.path.length > 0) add("path", 20, pathEq(query.path, candidate.path));
    if (query.cssPath) add("cssPath", 12, eq(query.cssPath, candidate.cssPath));
    if (query.siblingIndex != null) add("siblingIndex", 8, query.siblingIndex === candidate.siblingIndex);
  } else {
    if (query.identifier) add("identifier", 100, eq(query.identifier, candidate.identifier));
    if (query.role) add("role", 20, normRole(query.role) === normRole(candidate.role));
    if (query.subrole) add("subrole", 15, eq(query.subrole, candidate.subrole));
    if (query.name) add("name", 50, namesMatch(query, candidate));
    if (query.title && !eq(query.title, query.name)) add("title", 40, eq(query.title, candidate.title) || eq(query.title, candidate.name));
    if (query.description) add("description", 25, eq(query.description, candidate.description));
    if (query.value && normRole(query.role) === "statictext") add("value", 55, eq(query.value, candidate.value) || eq(query.value, candidate.name));
    if (query.path.length > 0) add("path", 20, pathEq(query.path, candidate.path));
    if (query.windowTitle) add("windowTitle", 10, eq(query.windowTitle, candidate.windowTitle));
    if (query.siblingIndex != null) add("siblingIndex", 8, query.siblingIndex === candidate.siblingIndex);
  }

  const score = parts.reduce((sum, part) => sum + part.points, 0);
  return { score, parts };
}

function priority(surface: Surface): readonly string[] {
  return surface === "dom" ? DOM_PRIORITY : AX_PRIORITY;
}

function firstMissed(query: Identity, best: Score | undefined): string {
  const order = priority(query.surface);
  if (!best) return order[0] || "identity";
  for (const attr of order) {
    const part = best.parts.find((item) => item.attr === attr);
    if (part && !part.matched) return attr;
  }
  return "identity";
}

function tieAttr(best: Score, second: Score): string {
  const seen = new Set(best.parts.filter((part) => part.matched).map((part) => part.attr));
  for (const part of second.parts) {
    if (part.matched && !seen.has(part.attr)) return part.attr;
  }
  for (const part of best.parts) {
    const other = second.parts.find((item) => item.attr === part.attr);
    if (part.matched !== !!other?.matched) return part.attr;
  }
  return "ambiguous";
}

export function lookup(query: Identity, candidates: Identity[]): Lookup {
  const gated: { candidate: Identity; index: number }[] = [];
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (!candidate) continue;
    if (sameApp(query, candidate)) gated.push({ candidate, index });
  }
  if ((query.app || query.bundleId) && gated.length === 0) {
    return {
      ok: false,
      reason: "app-mismatch",
      brokenAttr: query.bundleId ? "bundleId" : "app",
      ranked: [],
    };
  }
  const ranked = gated
    .map(({ candidate, index }) => ({ index, ...scoreIdentity(query, candidate) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (ranked.length === 0) {
    return { ok: false, reason: "no-candidates", brokenAttr: firstMissed(query, undefined), ranked };
  }
  const best = ranked[0]!;
  const second = ranked[1];
  const margin = second ? best.score - second.score : best.score;
  if (best.score < ACCEPT) {
    return {
      ok: false,
      reason: "below-threshold",
      index: best.index,
      score: best.score,
      margin,
      brokenAttr: firstMissed(query, best),
      ranked,
    };
  }
  if (second && margin < MARGIN) {
    return {
      ok: false,
      reason: "tie",
      score: best.score,
      margin,
      brokenAttr: tieAttr(best, second),
      ranked,
    };
  }
  return { ok: true, index: best.index, score: best.score, margin, ranked };
}

/** Sibling index among the same role under the same parent path. */
export function assignSiblingIndex(nodes: Identity[]): Identity[] {
  const groups = new Map<string, number>();
  return nodes.map((node) => {
    const parent = node.path.map((seg) => `${normRole(seg.role)}:${seg.name || ""}`).join("/");
    const key = `${node.app || node.bundleId || ""}|${parent}|${normRole(node.role)}`;
    const siblingIndex = groups.get(key) ?? 0;
    groups.set(key, siblingIndex + 1);
    return { ...node, siblingIndex };
  });
}

export interface AxDumpNode {
  role: string;
  subrole?: string;
  title?: string;
  description?: string;
  identifier?: string;
  name?: string;
  value?: string;
  path?: PathSeg[];
  app?: string;
}

export function fromAxNode(node: AxDumpNode, extra?: { bundleId?: string; windowTitle?: string }): Identity {
  return {
    surface: "ax",
    role: node.role,
    subrole: node.subrole || undefined,
    identifier: node.identifier || undefined,
    name: node.name || node.title || undefined,
    title: node.title || undefined,
    description: node.description || undefined,
    value: node.value || undefined,
    app: node.app,
    bundleId: extra?.bundleId,
    windowTitle: extra?.windowTitle,
    path: node.path || [],
  };
}

export interface AtspiDumpNode {
  app: string;
  role: string;
  name: string;
  path: PathSeg[];
}

export function fromAtspiNode(node: AtspiDumpNode): Identity {
  return {
    surface: "atspi",
    role: node.role,
    name: node.name || undefined,
    app: node.app,
    path: node.path || [],
  };
}
