// Derives a receipt outline from recorded actions and page changes.
// A page title is a page title. A read-back is a read-back. A click is a click.
// A missing record stays missing.

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

export interface ReceiptField {
  label: string;
  value: string;
  masked: boolean;
}

export interface ReceiptClick {
  label: string;
  status: string;
}

export interface ReceiptChapter {
  title: string;
  url: string;
  start: number;
  end: number;
  fields: ReceiptField[];
  clicks: ReceiptClick[];
}

export interface ReceiptShot {
  label: string;
  file: string;
  note?: string;
}

export interface ReceiptOpen {
  step: number;
  id?: string;
  label: string;
  status: string;
}

export interface ReceiptOutline {
  pageTitle?: string;
  shot?: ReceiptShot;
  readBack: string[];
  claim?: string;
  listed: string[];
  passed: number;
  failed: number;
  open: ReceiptOpen[];
  chapters: ReceiptChapter[];
}

function stepsOf(run: OutlineRun): OutlineStep[] {
  return run.steps || [];
}

function command(step: OutlineStep): string {
  return step.native?.command || "";
}

function cleanLabel(value: string): string {
  return value.replace(/[\uE000-\uF8FF]/g, "").replace(/\s+/g, " ").trim();
}

function fieldLabel(step: OutlineStep): string {
  const label = cleanLabel(step.label || "");
  const into = /^Type into "(.+)"$/.exec(label);
  if (into?.[1]) return into[1];
  if (label === "Type") return "the text field";
  return label || "field";
}

function fillValue(step: OutlineStep): string | undefined {
  if (step.status !== "passed") return undefined;
  if (command(step) !== "fill") return undefined;
  const value = step.native?.args?.[1];
  return typeof value === "string" ? value : undefined;
}

function pageOf(step: OutlineStep): { title?: string; url?: string } | undefined {
  return step.summary?.page;
}

function pageUrl(step: OutlineStep): string | undefined {
  const url = pageOf(step)?.url?.trim();
  return url || undefined;
}

function pageTitle(step: OutlineStep): string | undefined {
  const title = pageOf(step)?.title?.trim();
  return title || undefined;
}

function privateField(label: string): boolean {
  return /password|e-?mail|secret|ssn|social security|card number|cvv|cvc|\bpin\b|token/i.test(label);
}

function shownField(step: OutlineStep, value: string): ReceiptField {
  const label = fieldLabel(step);
  if (value === "") return { label, value: "Cleared", masked: false };
  if (privateField(label)) return { label, value: "Hidden", masked: true };
  return { label, value, masked: false };
}

function shotFile(step: OutlineStep): string | undefined {
  return step.afterShot && /^[\w.-]+\.(png|jpe?g)$/.test(step.afterShot) ? step.afterShot : undefined;
}

function isClick(step: OutlineStep): boolean {
  return command(step) === "click" || /^Click\b/.test(cleanLabel(step.label || ""));
}

interface DraftChapter {
  url: string;
  title: string;
  start: number;
  end: number;
  fields: ReceiptField[];
  clicks: ReceiptClick[];
}

function chaptersFor(steps: OutlineStep[]): ReceiptChapter[] {
  const chapters: DraftChapter[] = [];
  let current: DraftChapter | undefined;
  steps.forEach((step, index) => {
    const url = pageUrl(step);
    if (url && url !== current?.url) {
      current = { url, title: pageTitle(step) || url, start: index, end: index, fields: [], clicks: [] };
      chapters.push(current);
    } else if (!current) {
      return;
    } else {
      current.end = index;
      const title = pageTitle(step);
      if (title) current.title = title;
    }
    const value = fillValue(step);
    if (value !== undefined) current.fields.push(shownField(step, value));
    if (isClick(step)) current.clicks.push({ label: cleanLabel(step.label || "") || "Click", status: step.status || "unknown" });
  });
  return chapters.map((chapter) => ({
    title: chapter.title,
    url: chapter.url,
    start: chapter.start + 1,
    end: chapter.end + 1,
    fields: chapter.fields,
    clicks: chapter.clicks,
  }));
}

function lastPageShot(steps: OutlineStep[]): { title?: string; shot?: ReceiptShot } {
  for (let i = steps.length - 1; i >= 0; i--) {
    const title = pageTitle(steps[i]!);
    const url = pageUrl(steps[i]!);
    if (!title && !url) continue;
    for (let j = i; j >= 0; j--) {
      if (url && pageUrl(steps[j]!) !== url) break;
      const file = shotFile(steps[j]!);
      if (!file) continue;
      const note = steps[j]!.shotNote?.trim();
      return { title: title || url, shot: { label: note || title || url || "Recorded page", file, note: note || undefined } };
    }
    return { title: title || url };
  }
  return {};
}

function readBackLines(run: OutlineRun): string[] {
  const lines: string[] = [];
  for (const item of run.receipts || []) {
    const saw = item.actual?.trim();
    if (!saw) continue;
    lines.push(`Read back ${item.source || "value"}: ${saw}`);
  }
  return lines;
}

function openSteps(steps: OutlineStep[]): ReceiptOpen[] {
  const open: ReceiptOpen[] = [];
  steps.forEach((step, index) => {
    if (step.status === "passed") return;
    open.push({
      step: index + 1,
      id: step.id,
      label: cleanLabel(step.label || "") || "Step",
      status: step.status || "unknown",
    });
  });
  return open;
}

export function receiptOutline(run: OutlineRun): ReceiptOutline {
  const steps = stepsOf(run);
  const page = lastPageShot(steps);
  const passedRun = (run.envelope?.status || run.status) === "passed";
  const claim = passedRun ? run.envelope?.reason?.trim() : undefined;
  return {
    pageTitle: page.title,
    shot: page.shot,
    readBack: readBackLines(run),
    claim: claim || undefined,
    listed: (run.done || []).map((item) => item.trim()).filter(Boolean),
    passed: steps.filter((step) => step.status === "passed").length,
    failed: steps.filter((step) => step.status === "failed").length,
    open: openSteps(steps),
    chapters: chaptersFor(steps),
  };
}
