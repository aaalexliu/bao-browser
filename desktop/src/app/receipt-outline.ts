// Derives a receipt outline from recorded actions and page changes.
// A page title is a page title. A read-back is a read-back. A click is a click.
// A missing record stays missing.

import { tabSentence } from "../v1/caption";

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
  caption?: { text?: string; citation?: { text?: string } };
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

export interface ReceiptRow {
  /** The step's place in the run, from 1. */
  step: number;
  line: string;
  status: string;
}

/** A run of steps on one recorded page. Steps before the first recorded page share one chapter with no title. */
export interface ReceiptChapter {
  title: string;
  url: string;
  start: number;
  end: number;
  fields: ReceiptField[];
  clicks: ReceiptClick[];
  rows: ReceiptRow[];
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
  if (label === "Type" || !label) return "a text field";
  return label;
}

function fillArg(step: OutlineStep): string | undefined {
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

function quoted(value: string): string {
  return `"${value}"`;
}

function fillLine(field: ReceiptField, cleared: boolean): string {
  if (cleared) return `Cleared ${field.label}`;
  if (field.masked) return `Typed a hidden value into ${field.label}`;
  return `Typed ${quoted(field.value)} into ${field.label}`;
}

function recordedName(value: string): string {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1).trim() : trimmed;
}

function citedName(step: OutlineStep): string {
  return recordedName(step.caption?.citation?.text || "");
}

function clickLine(step: OutlineStep): string {
  const named = citedName(step);
  if (named) return `Clicked ${quoted(named)}`;
  const label = cleanLabel(step.label || "");
  if (!label || label === "Click") return "Clicked";
  return label.startsWith("Click ") ? `Clicked ${label.slice("Click ".length)}` : `Clicked ${label}`;
}

function openedLine(step: OutlineStep, fallback: string): string {
  const arg = command(step) === "open" ? step.native?.args?.[0]?.trim() : "";
  const where = arg || pageTitle(step) || pageUrl(step) || fallback;
  return where ? `Opened ${where}` : cleanLabel(step.label || "") || "Opened a page";
}

function pressLine(step: OutlineStep): string {
  const key = recordedName(step.native?.args?.[0] || "");
  return key && !/^@e\d+$/.test(key) ? `Pressed ${quoted(key)}` : "Pressed a key";
}

function unchangedLine(step: OutlineStep): string | undefined {
  const cmd = command(step);
  if (cmd === "snapshot") return "Read the page";
  if (cmd === "wait_for_owner") return "Waited";
  return undefined;
}

export function readBackSentence(item: { source?: string; expected?: string; actual?: string; pass?: boolean }, mode: "saw" | "compare"): string {
  const source = item.source?.trim();
  const where = source ? `Read back from the page, ${source}` : "Read back from the page";
  if (mode === "saw") return `${where}: ${quoted(item.actual?.trim() || "")}`;
  const verdict = item.pass ? "It matches" : "It does not match";
  return `${where}: expected ${quoted(item.expected || "")}, saw ${quoted(item.actual || "")}. ${verdict}.`;
}

function siteSuffix(title: string): string | undefined {
  const cut = title.lastIndexOf(" - ");
  if (cut <= 0) return undefined;
  const suffix = title.slice(cut + 3).trim();
  return suffix || undefined;
}

function withoutRepeatedSuffix(chapters: ReceiptChapter[]): ReceiptChapter[] {
  const counts = new Map<string, number>();
  for (const chapter of chapters) {
    const suffix = siteSuffix(chapter.title);
    if (suffix) counts.set(suffix, (counts.get(suffix) || 0) + 1);
  }
  let repeated: string | undefined;
  for (const [suffix, count] of counts) {
    if (count >= 2 && (repeated === undefined || count > (counts.get(repeated) || 0))) repeated = suffix;
  }
  if (!repeated) return chapters;
  const tail = ` - ${repeated}`;
  return chapters.map((chapter) => {
    if (!chapter.title.endsWith(tail)) return chapter;
    const title = chapter.title.slice(0, -tail.length).trim();
    return title ? { ...chapter, title } : chapter;
  });
}

function shotFile(step: OutlineStep): string | undefined {
  return step.afterShot && /^[\w.-]+\.(png|jpe?g)$/.test(step.afterShot) ? step.afterShot : undefined;
}

function isClick(step: OutlineStep): boolean {
  return command(step) === "click" || /^Click\b/.test(cleanLabel(step.label || ""));
}

type StepLine = Omit<ReceiptRow, "step">;

function actionRow(step: OutlineStep, title: string): { row: StepLine; field?: ReceiptField; click?: ReceiptClick } {
  const status = step.status || "unknown";
  const value = fillArg(step);
  if (value !== undefined) {
    const field = shownField(step, value);
    return {
      row: { line: fillLine(field, value === ""), status },
      field: status === "passed" ? field : undefined,
    };
  }
  if (isClick(step)) {
    const label = cleanLabel(step.label || "") || "Click";
    return { row: { line: clickLine(step), status }, click: { label, status } };
  }
  if (command(step) === "open") return { row: { line: openedLine(step, title), status } };
  if (command(step) === "press") return { row: { line: pressLine(step), status } };
  if (command(step) === "tab") return { row: { line: tabSentence(step.native?.args), status } };
  const unchanged = unchangedLine(step);
  if (unchanged) return { row: { line: unchanged, status } };
  return { row: { line: cleanLabel(step.label || "") || "Recorded step", status } };
}

function chaptersFor(steps: OutlineStep[]): ReceiptChapter[] {
  const chapters: ReceiptChapter[] = [];
  let current: ReceiptChapter | undefined;
  steps.forEach((step, index) => {
    const url = pageUrl(step);
    if (!current || (url && url !== current.url)) {
      current = { url: url || "", title: url ? pageTitle(step) || url : "", start: index + 1, end: index + 1, fields: [], clicks: [], rows: [] };
      chapters.push(current);
    } else {
      current.end = index + 1;
      const title = pageTitle(step);
      if (title && current.url) current.title = title;
    }
    const action = actionRow(step, current.title);
    if (action.field) current.fields.push(action.field);
    if (action.click) current.clicks.push(action.click);
    current.rows.push({ step: index + 1, ...action.row });
  });
  return withoutRepeatedSuffix(chapters);
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
    if (!item.actual?.trim()) continue;
    lines.push(readBackSentence(item, "saw"));
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
      label: command(step) === "tab" ? tabSentence(step.native?.args) : cleanLabel(step.label || "") || "Step",
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
