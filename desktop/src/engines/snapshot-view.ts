// What a snapshot result shows the agent: the nodes a find matches, or what changed since the last snapshot. A plain snapshot stays the full native tree.

export interface SnapshotFind { text?: string; role?: string }
export type SnapshotView = { kind: "find"; find: SnapshotFind } | { kind: "diff" };

/** The view an agent_browser call asked for, or undefined for the full native output. */
export function snapshotView(command: unknown, find: unknown, diff: unknown): SnapshotView | undefined {
  if (find === undefined && (diff === undefined || diff === false)) return undefined;
  if (command !== "snapshot") throw new Error("find and diff are only accepted on snapshot");
  if (find !== undefined && diff !== undefined && diff !== false) throw new Error("snapshot takes find or diff, not both");
  if (diff !== undefined && diff !== false) {
    if (diff !== true) throw new Error("diff must be true or false");
    return { kind: "diff" };
  }
  const value = find as Record<string, unknown> | null;
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : undefined;
  const text = typeof value?.text === "string" ? value.text.trim() : "";
  const role = typeof value?.role === "string" ? value.role.trim() : "";
  if (!keys || keys.some((key) => key !== "text" && key !== "role") || keys.some((key) => typeof value![key] !== "string") || !text && !role) {
    throw new Error("find must be an object with a non-empty text, role, or both, such as {\"text\":\"Sign in\",\"role\":\"button\"}");
  }
  return { kind: "find", find: { ...text ? { text } : {}, ...role ? { role } : {} } };
}

interface Line { indent: number; role: string; words: string; text: string }

const NODE = /^(\s*)- ([^\s":]+)(?: "((?:[^"\\]|\\.)*)")?(?: \[[^\]]*\])?(.*)$/;

function lines(snapshot: string): Line[] {
  return snapshot.replace(/\n+$/, "").split("\n").map((text) => {
    const match = NODE.exec(text);
    const indent = /^\s*/.exec(text)![0].length;
    if (!match) return { indent, role: "", words: text.trim().toLowerCase(), text };
    const words = `${match[3]?.replace(/\\(.)/g, "$1") ?? ""} ${match[4] ?? ""}`.replace(/\s+/g, " ").trim().toLowerCase();
    return { indent, role: match[2]!.toLowerCase(), words, text };
  });
}

/** Each chosen line and the lines that hold it: every earlier line with a smaller indent that can hold it, nearest first. */
function withParents(all: readonly { indent: number }[], chosen: Iterable<number>, canHold: (child: number, parent: number) => boolean = () => true): Set<number> {
  const shown = new Set<number>();
  for (const at of chosen) {
    shown.add(at);
    let indent = all[at]!.indent;
    for (let i = at - 1; i >= 0 && indent > 0; i--) {
      if (all[i]!.indent >= indent || !canHold(at, i)) continue;
      indent = all[i]!.indent;
      shown.add(i);
    }
  }
  return shown;
}

function describeFind(find: SnapshotFind): string {
  return [find.text !== undefined ? `text ${JSON.stringify(find.text)}` : "", find.role !== undefined ? `role ${find.role}` : ""].filter(Boolean).join(" and ");
}

/** Matching lines with their refs, the lines that hold them, and everything inside them, in page order. */
export function findView(snapshot: string, find: SnapshotFind): string {
  const all = lines(snapshot);
  const text = find.text?.replace(/\s+/g, " ").toLowerCase();
  const role = find.role?.toLowerCase();
  const matches = all.flatMap((line, at) => (!role || line.role === role) && (!text || line.words.includes(text)) ? [at] : []);
  if (!matches.length) return `No snapshot line matches ${describeFind(find)} (${all.length} lines on the page). Try a shorter text, another role, or a plain snapshot.`;
  const shown = withParents(all, matches);
  for (const at of matches) {
    for (let i = at + 1; i < all.length && all[i]!.indent > all[at]!.indent; i++) shown.add(i);
  }
  const body = [...shown].sort((a, b) => a - b).map((at) => all[at]!.text);
  return `${matches.length} of ${all.length} snapshot lines match ${describeFind(find)}. Each is shown with the lines that hold it and everything inside it.\n${body.join("\n")}`;
}

type Op = { kind: "same" | "added" | "removed"; line: Line };

/** Line operations from before to after, or undefined when the changed middle is too large to compare. */
function lineDiff(before: Line[], after: Line[]): Op[] | undefined {
  let start = 0;
  while (start < before.length && start < after.length && before[start]!.text === after[start]!.text) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end]!.text === after[after.length - 1 - end]!.text) end++;
  const a = before.slice(start, before.length - end);
  const b = after.slice(start, after.length - end);
  if (a.length * b.length > 4_000_000) return undefined;
  // Longest common subsequence over the changed middle.
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i]!.text === b[j]!.text ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const middle: Op[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i]!.text === b[j]!.text) { middle.push({ kind: "same", line: b[j]! }); i++; j++; }
    else if (j < b.length && (i === a.length || table[i * width + j + 1]! >= table[(i + 1) * width + j]!)) middle.push({ kind: "added", line: b[j++]! });
    else middle.push({ kind: "removed", line: a[i++]! });
  }
  return [...after.slice(0, start).map((line) => ({ kind: "same" as const, line })), ...middle,
    ...after.slice(after.length - end).map((line) => ({ kind: "same" as const, line }))];
}

/** What changed since the last snapshot with the same args: added and removed lines with the lines that hold them. */
export function diffView(before: string | undefined, after: string): string {
  if (before === undefined) return `No earlier snapshot with these args in this session, so this is the full snapshot.\n${after}`;
  const afterLines = lines(after);
  if (before === after) return `No change since the last snapshot (${afterLines.length} lines).`;
  const beforeLines = lines(before);
  const ops = lineDiff(beforeLines, afterLines);
  if (!ops) return `The changed part of the page is too large to compare, so this is the full snapshot.\n${after}`;
  const changed = ops.flatMap((op, at) => op.kind === "same" ? [] : [at]);
  // An added line sits under lines that are still there or also added; a removed line under lines that were there before.
  const shown = withParents(ops.map((op) => op.line), changed, (child, parent) => ops[parent]!.kind === "same" || ops[parent]!.kind === ops[child]!.kind);
  const added = ops.filter((op) => op.kind === "added").length;
  const removed = ops.filter((op) => op.kind === "removed").length;
  const mark = { same: "  ", added: "+ ", removed: "- " } as const;
  const body = [...shown].sort((a, b) => a - b).map((at) => `${mark[ops[at]!.kind]}${ops[at]!.line.text}`);
  const header = `Changed since the last snapshot: ${added} ${added === 1 ? "line" : "lines"} added (+), ${removed} removed (-). Unchanged lines are left out except the ones that hold a change.`;
  const view = `${header}\n${body.join("\n")}`;
  if (view.length < after.length) return view;
  const changedLines = Math.max(added, removed);
  const size = Math.max(beforeLines.length, afterLines.length);
  if (changedLines > size / 2) return `Most of the page changed since the last snapshot, so this is the full snapshot.\n${after}`;
  const headerBudget = header.length + 1;
  if (view.length - after.length <= headerBudget || after.length <= headerBudget && changedLines <= 2) return view;
  return `The changed lines are longer than the full snapshot, so this is the full snapshot.\n${after}`;
}
