// Derives a receipt outline from recorded actions and page changes.
// Chapter titles and result lists come from the record. A missing signal
// stays missing: no fixed phase names, no invented retries, no verified claim.

export interface OutlineStep {
  id?: string;
  status?: string;
  label?: string;
  reason?: string;
  startedAt?: number;
  endedAt?: number;
  afterShot?: string;
  /** Why the kept picture is not of the active tab. */
  shotNote?: string;
  summary?: { text?: string; page?: { title?: string; url?: string } };
  native?: {
    command?: string;
    args?: string[];
    error?: string;
    results?: { stdout?: string; stderr?: string; exitCode?: number }[];
  };
}

export interface OutlineRun {
  id?: string;
  status?: string;
  at?: number;
  task?: string;
  done?: string[];
  receipts?: { stepId?: string; source?: string; expected?: string; actual?: string; pass?: boolean }[];
  envelope?: { status?: string; reason?: string; ask?: string };
  failure?: { reason?: string };
  steps?: OutlineStep[];
}

export interface ReceiptChapter {
  title: string;
  start: number;
  end: number;
}

export interface ReceiptProblem {
  step: number;
  label: string;
  error: string;
  page?: string;
  later?: { step: number; label: string };
}

export interface ReceiptShot {
  label: string;
  file: string;
}

export interface ReceiptField {
  label: string;
  value: string;
  masked: boolean;
}

export interface ReceiptItem {
  name: string;
  state: "selected" | "not confirmed" | "clicked";
}

export type ReceiptProof =
  | {
    kind: "list";
    name?: string;
    quoted?: string;
    items: ReceiptItem[];
  }
  | {
    kind: "form";
    state: string;
    confirmation?: string;
    fields: ReceiptField[];
  }
  | { kind: "text" };

export interface ReceiptOutline {
  claim?: string;
  listed: string[];
  recorded: string;
  recordedLines: string[];
  proof: ReceiptProof;
  problems: ReceiptProblem[];
  chapters: ReceiptChapter[];
  shots: ReceiptShot[];
}

const READ_COMMANDS = new Set(["snapshot", "tab", "scroll", "wait_for_owner", "screenshot", "press"]);
const STOP_WORDS = new Set([
  "type", "into", "click", "search", "place", "places", "private", "google", "maps",
  "the", "text", "field", "note", "add", "show", "saved", "list", "with", "from",
  "this", "that", "best", "page", "open",
]);

function stepsOf(run: OutlineRun): OutlineStep[] {
  return run.steps || [];
}

function command(step: OutlineStep): string {
  return step.native?.command || "";
}

function cleanLabel(value: string): string {
  return value.replace(/[\uE000-\uF8FF]/g, "").replace(/\s+/g, " ").trim();
}

function displayLabel(value: string): string {
  const cleaned = cleanLabel(value);
  const quoted = /^Click "(.+)"$/.exec(cleaned);
  return (quoted?.[1] || cleaned).replace(/^Click\s+/, "");
}

function fieldLabel(step: OutlineStep): string {
  const label = cleanLabel(step.label || "");
  const into = /^Type into "(.+)"$/.exec(label);
  if (into?.[1]) return into[1];
  if (label === "Type") return "the text field";
  return label || "field";
}

function fieldKey(step: OutlineStep): string {
  const ref = step.native?.args?.[0];
  const control = ref?.startsWith("@") ? ref : "";
  return `${pageKey(step) || ""}|${control}|${fieldLabel(step)}`;
}

function fillValue(step: OutlineStep): string | undefined {
  if (step.status !== "passed") return undefined;
  if (command(step) !== "fill") return undefined;
  const args = step.native?.args || [];
  const value = args.length >= 2 ? args[args.length - 1] : args[0];
  return typeof value === "string" ? value : undefined;
}

function pageOf(step: OutlineStep): { title?: string; url?: string } | undefined {
  return step.summary?.page;
}

function titleStem(title: string | undefined): string {
  return (title || "").split(" - ")[0]?.trim() || "";
}

function pagePath(url: string | undefined): { host: string; path: string } | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/@.*/, "").replace(/\/$/, "") || "/";
    return { host: parsed.hostname, path };
  } catch {
    return undefined;
  }
}

function pageKey(step: OutlineStep): string | undefined {
  const page = pageOf(step);
  if (!page?.url && !page?.title) return undefined;
  const parsed = pagePath(page.url);
  return `${parsed?.host || ""}${parsed?.path || ""}|${titleStem(page.title)}`;
}

function tokens(value: string): string[] {
  return [...value.matchAll(/[A-Za-z][A-Za-z']{3,}/g)]
    .map((match) => match[0].toLowerCase())
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
}

function numberTokens(value: string): string[] {
  return [...value.matchAll(/\d+(?:-\d+)*/g)].map((match) => match[0]);
}

function tokenOverlap(typed: string, label: string): number {
  const wanted = new Set(tokens(typed));
  let shared = 0;
  for (const word of tokens(label)) if (wanted.has(word)) shared += 1;
  return shared;
}

function countClick(label: string): boolean {
  return /\d+\s+(?:places|items)\b/i.test(displayLabel(label));
}

function sharesSelection(typed: string, label: string): boolean {
  if (countClick(label)) return false;
  const wantedNumbers = numberTokens(typed);
  const clickedNumbers = new Set(numberTokens(label));
  if (wantedNumbers.some((number) => !clickedNumbers.has(number))) return false;
  const wanted = typed.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const clicked = displayLabel(label).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return wanted.length >= 6 && clicked.includes(wanted);
}

function stderrLine(step: OutlineStep): string | undefined {
  for (const result of step.native?.results || []) {
    const line = result.stderr?.replace(/^[✗✓]\s*/, "").trim();
    if (line) return line.split("\n")[0];
  }
  const error = step.native?.error?.trim();
  return error || undefined;
}

function clickTarget(step: OutlineStep): string | undefined {
  if (command(step) !== "click" && !/^Click /.test(step.label || "")) return undefined;
  const label = displayLabel(step.label || "");
  return label && label !== "Click" ? label : undefined;
}

function shotFile(step: OutlineStep): string | undefined {
  if (step.shotNote?.trim()) return undefined;
  return step.afterShot && /^[\w.-]+\.(png|jpe?g)$/.test(step.afterShot) ? step.afterShot : undefined;
}

function lastPageTitle(steps: OutlineStep[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const title = pageOf(steps[i]!)?.title?.trim();
    if (title) return title;
  }
  return undefined;
}

interface Fill {
  index: number;
  field: string;
  key: string;
  value: string;
}

function fillsOf(steps: OutlineStep[]): Fill[] {
  const fills: Fill[] = [];
  steps.forEach((step, index) => {
    const value = fillValue(step);
    if (value !== undefined) fills.push({ index, field: fieldLabel(step), key: fieldKey(step), value });
  });
  return fills;
}

function privateField(label: string): boolean {
  return /password|e-?mail|secret|ssn|social security|card number|cvv|cvc|\bpin\b|token/i.test(label);
}

interface QuotedCount {
  quote: string;
  name?: string;
}

function quotedCounts(steps: OutlineStep[]): QuotedCount | undefined {
  let found: QuotedCount | undefined;
  for (const step of steps) {
    if (step.status !== "passed") continue;
    const label = displayLabel(step.label || "").replace(/^Click\s+/, "");
    if (!/\d+\s+(?:places|items)\b/i.test(label)) continue;
    const name = label.split(" · ")[0]?.replace(/\s+Private$/i, "").trim();
    found = { quote: label, name: name && name !== label ? name : undefined };
  }
  return found;
}

function listNameFill(steps: OutlineStep[], fill: Fill): boolean {
  return steps.slice(fill.index + 1).some((step) => titleStem(pageOf(step)?.title).toLowerCase() === fill.value.toLowerCase());
}

function listName(steps: OutlineStep[], fills: Fill[], repeatedField: string | undefined, quoted: QuotedCount | undefined): string | undefined {
  if (quoted?.name) return quoted.name;
  for (const fill of fills) {
    if (fill.field === repeatedField) continue;
    for (let i = fill.index + 1; i < steps.length; i++) {
      if (titleStem(pageOf(steps[i]!)?.title).toLowerCase() === fill.value.toLowerCase()) return fill.value;
    }
  }
  return quoted?.name;
}

interface SelectionList {
  field: string;
  items: ReceiptItem[];
  shots: ReceiptShot[];
}

function selectionList(steps: OutlineStep[], fills: Fill[]): SelectionList | undefined {
  if (new Set(fills.map((fill) => fill.field)).size > 1) return undefined;
  const grouped = new Map<string, Fill[]>();
  for (const fill of fills) {
    const rows = grouped.get(fill.field) || [];
    rows.push(fill);
    grouped.set(fill.field, rows);
  }
  let best: SelectionList | undefined;
  for (const [field, rows] of grouped) {
    if (rows.length < 2) continue;
    const items: ReceiptItem[] = [];
    const shots: ReceiptShot[] = [];
    for (let n = 0; n < rows.length; n++) {
      const row = rows[n]!;
      const end = rows[n + 1]?.index ?? steps.length;
      let hit: OutlineStep | undefined;
      let near = false;
      for (let i = row.index + 1; i < end; i++) {
        const step = steps[i]!;
        if (step.status !== "passed" || command(step) !== "click") continue;
        if (sharesSelection(row.value, step.label || "")) {
          hit = step;
          near = false;
          break;
        }
        if (!near && tokenOverlap(row.value, step.label || "") >= 1) near = true;
      }
      if (!hit && !near && (tokens(row.value).length < 2 || listNameFill(steps, row))) continue;
      if (!hit) {
        items.push({ name: row.value, state: "not confirmed" });
        continue;
      }
      const selectedName = displayLabel(hit.label || row.value);
      items.push({ name: selectedName, state: "selected" });
      const shot = shotForPlace(steps, row.index + 1, end, [row.value, selectedName]);
      if (shot) shots.push(shot);
    }
    const confirmed = items.filter((item) => item.state === "selected");
    if (confirmed.length < 2) continue;
    if (!best || confirmed.length > best.items.filter((item) => item.state === "selected").length) {
      best = { field, items: exceptionsFirst(items), shots: withFinal(steps, pickShots(shots)) };
    }
  }
  return best;
}

function pickShots(shots: ReceiptShot[]): ReceiptShot[] {
  if (shots.length <= 3) return shots;
  const middle = shots[Math.floor(shots.length / 2)]!;
  return [shots[0]!, middle, shots[shots.length - 1]!];
}

function relatedStems(left: string, right: string): boolean {
  const a = left.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const b = right.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return a === b || a.startsWith(b) || b.startsWith(a);
}

interface PageVisit {
  stem: string;
  title: string;
  clicked: boolean;
  shot?: string;
  shotTitle?: string;
}

function pageIsPlace(title: string | undefined, names: string[]): boolean {
  const stem = titleStem(title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (stem.length < 4) return false;
  return names.some((name) => {
    const wanted = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    return wanted === stem || wanted.startsWith(`${stem} `);
  });
}

function shotForPlace(steps: OutlineStep[], start: number, end: number, names: string[]): ReceiptShot | undefined {
  for (let i = start; i < end; i++) {
    const step = steps[i]!;
    const file = shotFile(step);
    const title = pageOf(step)?.title?.trim();
    if (!file || !title || !pageIsPlace(title, names)) continue;
    return { label: title, file };
  }
  return undefined;
}

function pageVisits(steps: OutlineStep[]): PageVisit[] {
  const visits: PageVisit[] = [];
  for (const step of steps) {
    const title = pageOf(step)?.title || "";
    if (!title.includes(" - ")) continue;
    const stem = titleStem(title);
    if (!stem) continue;
    let visit = visits.find((item) => item.stem === stem);
    if (!visit) {
      visit = { stem, title, clicked: false };
      visits.push(visit);
    }
    if (step.status === "passed" && command(step) === "click") visit.clicked = true;
    const file = shotFile(step);
    if (file && !visit.shot) {
      visit.shot = file;
      visit.shotTitle = title.trim();
    }
  }
  return visits;
}

function pageList(steps: OutlineStep[], name: string | undefined): { items: ReceiptItem[]; shots: ReceiptShot[] } | undefined {
  if (!quotedCounts(steps)) return undefined;
  const visits = pageVisits(steps);
  const named = name?.toLowerCase();
  const clicked = visits.filter((visit) => visit.clicked && visit.stem.toLowerCase() !== named);
  const items: ReceiptItem[] = [
    ...visits
      .filter((visit) => !visit.clicked && visit.stem.toLowerCase() !== named && !clicked.some((item) => relatedStems(item.stem, visit.stem)))
      .map((visit) => ({ name: visit.stem, state: "not confirmed" as const })),
    ...clicked.map((visit) => ({ name: visit.stem, state: "clicked" as const })),
  ];
  if (!items.length) return undefined;
  const shots = withFinal(steps, pickShots(clicked.flatMap((visit) => visit.shot ? [{ label: visit.shotTitle || visit.title, file: visit.shot }] : [])));
  return { items, shots };
}

function exceptionsFirst(items: ReceiptItem[]): ReceiptItem[] {
  return [...items.filter((item) => item.state === "not confirmed"), ...items.filter((item) => item.state === "selected")];
}

function withFinal(steps: OutlineStep[], shots: ReceiptShot[]): ReceiptShot[] {
  const final = finalShot(steps)[0];
  if (!final || shots.some((shot) => shot.file === final.file)) return shots;
  return [...shots.slice(0, 2), final];
}

const SUBMIT = /\b(submit|send|place order|sign up|confirm)\b|\bsave\b/i;
const CONFIRM = /\b(?:thank you|order number|confirmation number|confirmation code|reference number|reference code|submitted|saved draft|draft saved)\b/gi;
const NEGATED = /\b(?:not|no|never|wasn'?t|isn'?t|aren'?t|didn'?t|cannot|can't|could not|failed|unable|without)\b/i;

function positiveConfirmation(text: string): boolean {
  for (const match of text.matchAll(new RegExp(CONFIRM.source, "gi"))) {
    const before = text.slice(Math.max(0, match.index - 48), match.index);
    if (NEGATED.test(before)) continue;
    return true;
  }
  return false;
}

function actionDescription(text: string): boolean {
  return /^(?:Typed|Clicked|Could not|Pressed|Scrolled|Went to|Read |Filled|Ran |Opened|Closed|Listed|Took |Switched|The wait|This wait|This run|Your Chrome|Bao)\b/.test(text)
    || /\bTyped\s+"/.test(text);
}

function confirmationOf(step: OutlineStep): string | undefined {
  const title = pageOf(step)?.title?.trim();
  if (title && positiveConfirmation(title)) return title;
  const summary = step.summary?.text?.trim();
  if (summary && !actionDescription(summary) && positiveConfirmation(summary)) return summary;
  return undefined;
}

function formProof(steps: OutlineStep[], fills: Fill[]): Extract<ReceiptProof, { kind: "form" }> | undefined {
  const fields = new Map<string, Fill>();
  for (const fill of fills) fields.set(fill.key, fill);
  if (fields.size < 2) return undefined;
  let submitAt = -1;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.status === "passed" && command(step) === "click" && SUBMIT.test(step.label || "")) {
      submitAt = i;
    }
  }
  let confirmation: string | undefined;
  if (submitAt >= 0) {
    for (let i = submitAt + 1; i < steps.length; i++) {
      const found = confirmationOf(steps[i]!);
      if (!found) continue;
      confirmation = found;
      break;
    }
  }
  const draft = /draft/i.test(confirmation || "");
  const state = submitAt < 0
    ? "Submission was not observed."
    : !confirmation
      ? "A submit click passed. Confirmation was not captured."
      : draft
        ? "Saved draft."
        : "Submitted";
  return {
    kind: "form",
    state,
    confirmation,
    fields: [...fields.values()].map((fill) => ({
      label: fill.field,
      value: fill.value && privateField(fill.field) ? "Hidden" : fill.value,
      masked: Boolean(fill.value) && privateField(fill.field),
    })),
  };
}

function proofFor(steps: OutlineStep[]): { proof: ReceiptProof; shots: ReceiptShot[]; recordedExtra: string[] } {
  const fills = fillsOf(steps);
  const selected = selectionList(steps, fills);
  if (selected) {
    const quoted = quotedCounts(steps);
    const name = listName(steps, fills, selected.field, quoted);
    const confirmed = selected.items.filter((item) => item.state === "selected").length;
    const missed = selected.items.length - confirmed;
    return {
      proof: { kind: "list", name, quoted: quoted?.quote, items: selected.items },
      shots: selected.shots,
      recordedExtra: recordedListLines(name, quoted, agreedCount(quoted, confirmed) ? `${confirmed} ${confirmed === 1 ? "entry was" : "entries were"} selected.` : undefined, missed),
    };
  }
  const quoted = quotedCounts(steps);
  const pages = pageList(steps, quoted?.name);
  if (pages) {
    const name = listName(steps, fills, undefined, quoted);
    const confirmed = pages.items.filter((item) => item.state !== "not confirmed").length;
    const missed = pages.items.length - confirmed;
    const countLine = agreedCount(quoted, confirmed)
      ? `${confirmed} place ${confirmed === 1 ? "page was" : "pages were"} opened.`
      : undefined;
    return {
      proof: { kind: "list", name, quoted: quoted?.quote, items: pages.items },
      shots: pages.shots.length ? pages.shots : finalShot(steps),
      recordedExtra: recordedListLines(name, quoted, countLine, missed),
    };
  }
  const form = formProof(steps, fills);
  if (form) return { proof: form, shots: finalShot(steps), recordedExtra: [] };
  return { proof: { kind: "text" }, shots: finalShot(steps), recordedExtra: [] };
}

function agreedCount(quoted: QuotedCount | undefined, count: number): boolean {
  const match = /(\d+)\s+(?:places|items)\b/i.exec(quoted?.quote || "");
  return !match || Number(match[1]) === count;
}

function recordedListLines(name: string | undefined, quoted: QuotedCount | undefined, countLine: string | undefined, missed: number): string[] {
  const lines: string[] = [];
  if (name) lines.push(`List name recorded as “${name}”.`);
  if (quoted) lines.push(`The page said “${quoted.quote}”.`);
  if (countLine) lines.push(countLine);
  if (missed) lines.push(`${missed} ${missed === 1 ? "entry was" : "entries were"} not confirmed.`);
  return lines;
}

function finalShot(steps: OutlineStep[]): ReceiptShot[] {
  for (let i = steps.length - 1; i >= 0; i--) {
    const file = shotFile(steps[i]!);
    if (!file) continue;
    const title = pageOf(steps[i]!)?.title?.trim();
    return [{ label: title || displayLabel(steps[i]!.label || "Final recorded page"), file }];
  }
  return [];
}

function readBackLines(run: OutlineRun): string[] {
  const lines: string[] = [];
  for (const item of run.receipts || []) {
    const saw = item.actual?.trim();
    if (!saw) continue;
    const text = /[.!?]$/.test(saw) ? saw : `${saw}.`;
    lines.push(`Read back ${item.source || "value"}: ${text}`);
  }
  return lines;
}

function recordedLines(steps: OutlineStep[], extra: string[], readBack: string[]): string[] {
  const lines: string[] = [];
  const title = lastPageTitle(steps);
  if (title) lines.push(`Last recorded page: ${title}.`);
  lines.push(...extra, ...readBack);
  if (!lines.length) lines.push("No page title or confirmation was recorded.");
  return lines;
}

function problemsFor(steps: OutlineStep[]): ReceiptProblem[] {
  const problems: ReceiptProblem[] = [];
  steps.forEach((step, index) => {
    if (step.status !== "failed") return;
    const target = clickTarget(step);
    let later: ReceiptProblem["later"];
    if (target) {
      for (let j = index + 1; j < steps.length; j++) {
        const next = steps[j]!;
        if (next.status !== "passed" || clickTarget(next) !== target) continue;
        later = { step: j + 1, label: displayLabel(next.label || target) };
        break;
      }
    }
    problems.push({
      step: index + 1,
      label: cleanLabel(step.label || "Step"),
      error: stderrLine(step) || step.reason || "Failed",
      page: pageOf(step)?.title,
      later,
    });
  });
  return problems;
}

interface Range {
  start: number;
  end: number;
  title: string;
}

function rangeTitle(steps: OutlineStep[], start: number, end: number): string {
  for (let i = start; i <= end; i++) {
    const title = pageOf(steps[i]!)?.title?.trim();
    if (title) return title;
  }
  for (let i = start; i <= end; i++) {
    const step = steps[i]!;
    if (command(step) !== "open") continue;
    const url = step.native?.args?.[0];
    if (url) return url;
  }
  for (let i = start; i <= end; i++) {
    const step = steps[i]!;
    if (READ_COMMANDS.has(command(step)) || !step.label) continue;
    return displayLabel(step.label);
  }
  return "Recorded actions";
}

function quietRange(steps: OutlineStep[], start: number, end: number): boolean {
  for (let i = start; i <= end; i++) {
    const step = steps[i]!;
    if (step.status === "failed") return false;
    if (!READ_COMMANDS.has(command(step)) && command(step) !== "open") return false;
  }
  return true;
}

function chaptersFor(steps: OutlineStep[]): ReceiptChapter[] {
  if (!steps.some((step) => pageKey(step) || command(step) === "open")) return [];
  const ranges: Range[] = [];
  let start = 0;
  for (let i = 1; i <= steps.length; i++) {
    const boundary = i === steps.length
      || Boolean(pageKey(steps[i]!) && pageKey(steps[i]!) !== pageKey(steps[i - 1]!))
      || command(steps[i]!) === "open";
    if (!boundary) continue;
    ranges.push({ start, end: i - 1, title: rangeTitle(steps, start, i - 1) });
    start = i;
  }
  const split = splitRepeated(steps, ranges);
  const merged = mergeQuiet(steps, split);
  if (merged.length < 2) return [];
  return merged.map((range) => ({ title: range.title, start: range.start + 1, end: range.end + 1 }));
}

function splitRepeated(steps: OutlineStep[], ranges: Range[]): Range[] {
  const out: Range[] = [];
  for (const range of ranges) {
    if (range.end - range.start < 7) {
      out.push(range);
      continue;
    }
    const counts = new Map<string, number[]>();
    for (let i = range.start; i <= range.end; i++) {
      const value = fillValue(steps[i]!);
      if (!value) continue;
      const field = fieldLabel(steps[i]!);
      const rows = counts.get(field) || [];
      rows.push(i);
      counts.set(field, rows);
    }
    let field = "";
    let indexes: number[] = [];
    for (const [name, rows] of counts) {
      if (rows.length >= 2 && rows.length > indexes.length) {
        field = name;
        indexes = rows;
      }
    }
    const first = indexes[0];
    if (first === undefined || first <= range.start) {
      out.push(range);
      continue;
    }
    out.push({ start: range.start, end: first - 1, title: range.title });
    out.push({ start: first, end: range.end, title: field });
  }
  return out;
}

function untitledQuiet(steps: OutlineStep[], range: Range): boolean {
  return range.end === range.start && quietRange(steps, range.start, range.end) && !pageOf(steps[range.start]!)?.title;
}

function mergeQuiet(steps: OutlineStep[], ranges: Range[]): Range[] {
  const merged: Range[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && untitledQuiet(steps, range)) {
      previous.end = range.end;
      continue;
    }
    if (previous && untitledQuiet(steps, previous)) {
      range.start = previous.start;
      merged[merged.length - 1] = range;
      continue;
    }
    merged.push({ ...range });
  }
  return mergeThin(merged.filter((range) => range.end >= range.start));
}

function mergeThin(ranges: Range[]): Range[] {
  const merged: Range[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    const generic = range.end === range.start && !range.title.includes(" - ");
    const previousGeneric = previous && previous.end === previous.start && !previous.title.includes(" - ");
    const previousRelated = previous && previous.end === previous.start && relatedStems(titleStem(previous.title), titleStem(range.title));
    if (previous && generic) {
      previous.end = range.end;
      continue;
    }
    if (previousGeneric || previousRelated) {
      range.start = previous.start;
      merged[merged.length - 1] = range;
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

export function receiptOutline(run: OutlineRun): ReceiptOutline {
  const steps = stepsOf(run);
  const { proof, shots, recordedExtra } = proofFor(steps);
  const lines = recordedLines(steps, recordedExtra, readBackLines(run));
  const claim = run.envelope?.reason?.trim();
  return {
    claim: claim || undefined,
    listed: (run.done || []).map((item) => item.trim()).filter(Boolean),
    recordedLines: lines,
    recorded: lines.join(" "),
    proof,
    problems: problemsFor(steps),
    chapters: chaptersFor(steps),
    shots,
  };
}

