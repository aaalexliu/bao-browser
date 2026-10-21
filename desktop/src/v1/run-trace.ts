// Turns a lookup into the table the run viewer shows.

import type { CandidateView, IdentityView } from "../app/view-types";
import { lookup, type Lookup } from "./identity";
import type { Identity } from "./schema";

function recorded(query: Identity, attr: string): string {
  if (attr === "roleName") return [query.role, query.name || query.text || ""].filter(Boolean).join(" ");
  if (attr === "id") return query.id || "";
  if (attr === "testId") return query.testId || "";
  if (attr === "text") return query.text || "";
  if (attr === "name") return query.name || "";
  if (attr === "label") return query.label || "";
  if (attr === "nameAttr") return query.nameAttr || "";
  if (attr === "role") return query.role || "";
  return "";
}

function live(node: Identity | undefined, attr: string): string {
  if (!node) return "";
  if (attr === "roleName") return [node.role, node.name || node.text || ""].filter(Boolean).join(" ");
  if (attr === "id") return node.id || "";
  if (attr === "testId") return node.testId || "";
  if (attr === "text") return node.text || "";
  if (attr === "name") return node.name || node.text || "";
  if (attr === "label") return node.label || "";
  if (attr === "nameAttr") return node.nameAttr || "";
  if (attr === "role") return node.role || "";
  return "";
}

function labelOf(node: Identity | undefined, place: number): string {
  if (!node) return `candidate ${place}`;
  return node.name || node.text || node.testId || node.id || `candidate ${place}`;
}

function changedLine(query: Identity, node: Identity | undefined, brokenAttr: string | undefined): string | undefined {
  if (!node || !brokenAttr) return undefined;
  const recordedName = query.name || query.text || "";
  const liveName = node.name || node.text || "";
  if (brokenAttr === "roleName" || brokenAttr === "name" || brokenAttr === "text") {
    if (!recordedName || recordedName === liveName) return undefined;
    return `name "${recordedName}" → "${liveName}"`;
  }
  const left = recorded(query, brokenAttr);
  const right = live(node, brokenAttr);
  if (!left || left === right) return undefined;
  return `${brokenAttr} "${left}" → "${right}"`;
}

export function identityView(query: Identity, nodes: Identity[], hit: Lookup): IdentityView {
  const ranked = hit.ranked.slice(0, 3);
  const candidates: CandidateView[] = ranked.map((score, index) => {
    const node = nodes[score.index];
    const attrs = score.parts.map((part) => ({
      attr: part.attr,
      recorded: recorded(query, part.attr),
      live: live(node, part.attr),
      matched: part.matched,
    }));
    return { label: labelOf(node, index + 1), score: score.score, attrs };
  });
  const best = ranked[0] ? nodes[ranked[0].index] : undefined;
  return {
    accepted: hit.ok,
    score: hit.score,
    lead: hit.margin,
    reason: hit.reason,
    brokenAttr: hit.brokenAttr,
    changed: changedLine(query, best, hit.brokenAttr),
    candidates,
  };
}

export function viewFromLookup(query: Identity, nodes: Identity[]): IdentityView {
  return identityView(query, nodes, lookup(query, nodes));
}
