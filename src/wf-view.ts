// Framework-free view helpers shared by the two workflow surfaces: the side panel
// (live capture, T15) and the full-page dashboard (library/edit/history, T16). Pure
// functions only — no DOM, no chrome APIs — so both bundles import them without pulling
// in each other's UI, and the library groups/labels identically on both.
import type { Step, WorkflowSummary } from "./types";

export const domainOf = (u: string) => { try { return new URL(u).hostname || "other"; } catch (_) { return "other"; } };

export const dateFmt = (ts: number) =>
  new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function relTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)}d ago`;
  return dateFmt(ts);
}

export const stepLabel = (s: Step) => `${s.label}${s.value ? ` = "${s.value}"` : ""}`;

export const nSteps = (n: number) => `${n} step${n === 1 ? "" : "s"}`;

export const slugify = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workflow";

// The library's ordering, factored so both surfaces group identically: a pinned section
// (recency-sorted) first, then site groups ordered by their newest workflow, newest
// first within each group.
export interface GroupedWorkflows {
  pinned: WorkflowSummary[];
  groups: [string, WorkflowSummary[]][];
}
export function groupWorkflows(items: WorkflowSummary[]): GroupedWorkflows {
  const pinned = items.filter((w) => w.pinned).sort((a, b) => b.createdAt - a.createdAt);
  const groups = new Map<string, WorkflowSummary[]>();
  for (const w of items.filter((w) => !w.pinned)) {
    const d = domainOf(w.startUrl);
    (groups.get(d) || groups.set(d, []).get(d)!).push(w);
  }
  for (const ws of groups.values()) ws.sort((a, b) => b.createdAt - a.createdAt);
  const groupsOrdered = [...groups.entries()].sort(
    (a, b) => Math.max(...b[1].map((w) => w.createdAt)) - Math.max(...a[1].map((w) => w.createdAt)));
  return { pinned, groups: groupsOrdered };
}
