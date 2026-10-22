// Drafts sit beside the live workflow file. Replay reads the live file.
// A heal, an edit, or a restore adds a draft. Promote is what replaces the live file.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { migrate, validateWorkflow, type Identity, type WorkflowStep, type WorkflowV2 } from "./schema";
import { Library } from "./store";

export type VersionRole = "live" | "draft" | "past";
export type VersionSource = "saved" | "heal" | "edit" | "restore" | "conflict";

export interface WorkflowVersion {
  n: number;
  role: VersionRole;
  source: VersionSource;
  createdAt: number;
  document: WorkflowV2;
  deviceName?: string;
  conflict?: {
    mineDevice: string;
    theirsDevice: string;
    theirs: WorkflowV2;
    remoteVersion: number;
  };
}

/** The locator this workflow version holds. Recorded, heal, revert, or rollback. */
export interface HeldLocator {
  stepId: string;
  source: string;
  at: number;
  runId?: string;
  score?: number;
  changed: string[];
}

export interface VersionStepChange {
  id: string;
  label: string;
  before: string;
  after: string;
  changed: boolean;
}

export interface VersionSummary {
  n: number;
  role: VersionRole;
  source: VersionSource;
  createdAt: number;
  locator?: HeldLocator;
  /** Every locator row on this snapshot, oldest first. Times are formatted in the viewer's zone. */
  history: HeldLocator[];
  /** One line, such as `Click signed in: testId signed-in → role button "Signed in"`. */
  diff: string;
  steps: VersionStepChange[];
  deviceName?: string;
  conflict?: {
    mineDevice: string;
    theirsDevice: string;
    remoteVersion: number;
    sides: ConflictSide[];
  };
}

export interface ConflictSide {
  id: string;
  leftLabel: string;
  leftDetail: string;
  rightLabel: string;
  rightDetail: string;
  changed: boolean;
}

function bookPath(library: Library, id: string): string {
  return path.join(library.root, "versions", `${safeId(id)}.json`);
}

function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("bad workflow id");
  return id;
}

function readBook(library: Library, id: string): WorkflowVersion[] {
  try {
    const parsed = JSON.parse(readFileSync(bookPath(library, id), "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed as WorkflowVersion[] : [];
  } catch {
    return [];
  }
}

function writeBook(library: Library, id: string, versions: WorkflowVersion[]): void {
  mkdirSync(path.join(library.root, "versions"), { recursive: true });
  writeFileSync(bookPath(library, id), JSON.stringify(versions, null, 2));
}

/** A missing or epoch timestamp is not a save. Wall times are milliseconds. */
const WALL_MS = 1_000_000_000_000;

function savedAt(at: number | undefined, now = Date.now()): number {
  if (typeof at === "number" && Number.isFinite(at) && at >= WALL_MS) return at;
  return now;
}

function seed(library: Library, id: string): WorkflowVersion[] {
  const existing = readBook(library, id);
  if (existing.length) return existing;
  const document = library.read(id);
  const row: WorkflowVersion = {
    n: 1,
    role: "live",
    source: "saved",
    createdAt: savedAt(document.updatedAt || document.createdAt),
    document,
  };
  writeBook(library, id, [row]);
  return [row];
}

export function summarize(row: WorkflowVersion, previous?: WorkflowV2): VersionSummary {
  const change = versionChange(previous, row.document);
  const history = stepHistory(row.document);
  return {
    n: row.n,
    role: row.role,
    source: row.source,
    createdAt: row.createdAt,
    locator: history[history.length - 1],
    history,
    diff: change.line,
    steps: change.steps,
    deviceName: row.deviceName,
    conflict: row.conflict
      ? {
        mineDevice: row.conflict.mineDevice,
        theirsDevice: row.conflict.theirsDevice,
        remoteVersion: row.conflict.remoteVersion,
        sides: conflictSides(row.conflict.theirs, row.document),
      }
      : undefined,
  };
}

function conflictSides(theirs: WorkflowV2, mine: WorkflowV2): ConflictSide[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const step of [...theirs.steps, ...mine.steps]) {
    if (seen.has(step.id)) continue;
    seen.add(step.id);
    ids.push(step.id);
  }
  return ids.map((id) => {
    const left = theirs.steps.find((step) => step.id === id);
    const right = mine.steps.find((step) => step.id === id);
    const leftLabel = left ? stepLabel(left, id) : "—";
    const rightLabel = right ? stepLabel(right, id) : "—";
    const leftDetail = left ? identityPhrase(left.identity) : "—";
    const rightDetail = right ? identityPhrase(right.identity) : "—";
    return {
      id,
      leftLabel,
      leftDetail,
      rightLabel,
      rightDetail,
      changed: leftLabel !== rightLabel || leftDetail !== rightDetail,
    };
  });
}

/** How a step is found, in one phrase. A test id wins, then an id, then the role and its name. */
export function identityPhrase(identity: Identity | undefined): string {
  if (!identity) return "no target";
  if (identity.testId) return `testId ${identity.testId}`;
  if (identity.id) return `id ${identity.id}`;
  const quoted = identity.name || identity.text || identity.label;
  if (identity.role) return quoted ? `role ${identity.role} "${quoted}"` : `role ${identity.role}`;
  if (quoted) return `"${quoted}"`;
  return "no target";
}

function phrasePair(before: Identity | undefined, after: Identity | undefined): { before: string; after: string } {
  const left = identityPhrase(before);
  const right = identityPhrase(after);
  if (left !== right) return { before: left, after: right };
  const quoted = (identity: Identity | undefined) => identity?.name || identity?.text || identity?.label || "";
  const leftQuote = quoted(before);
  const rightQuote = quoted(after);
  if (leftQuote === rightQuote) return { before: left, after: right };
  return {
    before: leftQuote ? `${left} "${leftQuote}"` : left,
    after: rightQuote ? `${right} "${rightQuote}"` : right,
  };
}

function stepLabel(step: WorkflowStep | undefined, fallback: string): string {
  return step?.label || step?.action || fallback;
}

/** The first changed step is the line. Every step is in `steps` for the before/after list. */
export function versionChange(previous: WorkflowV2 | undefined, next: WorkflowV2): { line: string; steps: VersionStepChange[] } {
  const prior = previous?.steps ?? [];
  const used = new Set<string>();
  const steps: VersionStepChange[] = [];
  for (const step of next.steps) {
    const before = prior.find((item) => item.id === step.id);
    if (before) used.add(before.id);
    const pair = phrasePair(before?.identity, step.identity);
    const label = stepLabel(step, step.id);
    const changed = Boolean(previous) && (
      !before
      || pair.before !== pair.after
      || (before.label || "") !== (step.label || "")
      || before.action !== step.action
    );
    steps.push({
      id: step.id,
      label,
      before: before ? pair.before : previous ? "—" : "",
      after: pair.after,
      changed,
    });
  }
  for (const step of prior) {
    if (used.has(step.id)) continue;
    steps.push({
      id: step.id,
      label: stepLabel(step, step.id),
      before: identityPhrase(step.identity),
      after: "removed",
      changed: true,
    });
  }
  const changed = steps.filter((step) => step.changed);
  let line: string;
  if (!previous) {
    const first = steps[0];
    line = first ? `${first.label}: ${first.after}` : "Recorded";
  } else if (!changed.length && previous.name !== next.name) {
    line = `Name: ${previous.name} → ${next.name}`;
  } else if (!changed.length) {
    line = "No step changes";
  } else {
    const first = changed[0]!;
    const arrow = first.before && first.before !== "—" ? `${first.before} → ${first.after}` : first.after;
    const extra = changed.length > 1 ? ` · ${changed.length - 1} more` : "";
    line = `${first.label}: ${arrow}${extra}`;
  }
  return { line, steps };
}

/** Every locator row on the step that holds the newest one. */
function stepHistory(document: WorkflowV2): HeldLocator[] {
  let rows: HeldLocator[] | undefined;
  let tip = -1;
  for (const step of document.steps) {
    const history = step.history;
    if (!history?.length) continue;
    const last = history[history.length - 1];
    if (!last || last.at < tip) continue;
    tip = last.at;
    rows = history.map((row) => ({
      stepId: step.id,
      source: row.source,
      at: row.at,
      runId: row.runId,
      score: row.score,
      changed: row.changed || [],
    }));
  }
  if (rows?.length) return rows;
  const one = locatorHeld(document);
  return one ? [one] : [];
}

/** The locator version stored on this workflow snapshot. One row, not a second history. */
function locatorHeld(document: WorkflowV2): HeldLocator | undefined {
  let tip: HeldLocator | undefined;
  for (const step of document.steps) {
    const last = step.history?.[step.history.length - 1];
    if (!last) continue;
    if (!tip || last.at >= tip.at) {
      tip = {
        stepId: step.id,
        source: last.source,
        at: last.at,
        runId: last.runId,
        score: last.score,
        changed: last.changed || [],
      };
    }
  }
  if (tip) return tip;
  const step = document.steps.find((item) => item.identity);
  if (!step) return undefined;
  return {
    stepId: step.id,
    source: "recorded",
    at: savedAt(document.updatedAt || document.createdAt),
    score: 100,
    changed: [],
  };
}

export function listVersions(library: Library, id: string): VersionSummary[] {
  const rows = seed(library, id).slice().sort((a, b) => a.n - b.n);
  return rows.map((row, index) => summarize(row, index > 0 ? rows[index - 1]!.document : undefined));
}

export function versionDocument(library: Library, id: string, n: number): WorkflowV2 {
  const row = seed(library, id).find((item) => item.n === n);
  if (!row) throw new Error("no version");
  return row.document;
}

export function draftVersion(library: Library, document: WorkflowV2, source: Exclude<VersionSource, "saved">): WorkflowVersion {
  const errors = validateWorkflow(document);
  if (errors.length) throw new Error(errors.join(", "));
  const versions = seed(library, document.id);
  const row: WorkflowVersion = {
    n: versions.reduce((max, item) => Math.max(max, item.n), 0) + 1,
    role: "draft",
    source,
    createdAt: Date.now(),
    document,
  };
  versions.push(row);
  writeBook(library, document.id, versions);
  return row;
}

/** The live file changes here, and only here. */
export function promoteVersion(library: Library, id: string, n: number): WorkflowVersion {
  const versions = seed(library, id);
  const row = versions.find((item) => item.n === n);
  if (!row) throw new Error("no version");
  const document = { ...row.document, id, updatedAt: Date.now() };
  library.save(document);
  for (const item of versions) {
    if (item.n === n) {
      item.role = "live";
      item.document = document;
    } else if (item.role === "live") {
      item.role = "past";
    }
  }
  writeBook(library, id, versions);
  return { ...row, role: "live", document };
}

export interface CloudVersionRow {
  version: number;
  kind?: string;
  device_name?: string | null;
  document?: unknown;
  created_at?: string | number;
}

/** The live file stays. Theirs is the cloud head; mine is the edit that branched. */
export function noteConflict(
  library: Library,
  input: {
    mine: WorkflowV2;
    theirs: WorkflowV2;
    mineDevice: string;
    theirsDevice: string;
    remoteVersion: number;
    /** Cloud version number of the conflict draft. The desktop row uses this same number. */
    draftVersion?: number;
    /** Accepted cloud versions, so the desktop history uses the same numbers as the web. */
    history?: CloudVersionRow[];
  },
): WorkflowVersion {
  const cloud = cloudRows(input.history ?? []);
  const versions = cloud.length
    ? [...cloud, ...localDrafts(library, input.mine.id, cloud)]
    : seed(library, input.mine.id).filter((item) => item.source !== "conflict");
  const draftVersion = input.draftVersion
    ?? input.history?.find((item) => item.kind === "conflict")?.version
    ?? versions.reduce((max, item) => Math.max(max, item.n), 0) + 1;
  const row: WorkflowVersion = {
    n: draftVersion,
    role: "draft",
    source: "conflict",
    createdAt: Date.now(),
    document: input.mine,
    deviceName: input.mineDevice,
    conflict: {
      mineDevice: input.mineDevice,
      theirsDevice: input.theirsDevice,
      theirs: input.theirs,
      remoteVersion: input.remoteVersion,
    },
  };
  const book = versions.filter((item) => item.n !== row.n && item.source !== "conflict");
  book.push(row);
  book.sort((a, b) => a.n - b.n);
  writeBook(library, input.mine.id, book);
  return row;
}

function cloudRows(history: CloudVersionRow[]): WorkflowVersion[] {
  const rows: WorkflowVersion[] = [];
  for (const item of history) {
    if (item.kind === "conflict" || item.document === undefined) continue;
    const document = migrate(item.document);
    if (validateWorkflow(document).length) continue;
    rows.push({
      n: item.version,
      role: "past",
      source: "saved",
      createdAt: cloudTime(item.created_at),
      document,
      deviceName: item.device_name || undefined,
    });
  }
  return rows;
}

function localDrafts(library: Library, id: string, cloud: WorkflowVersion[]): WorkflowVersion[] {
  const taken = new Set(cloud.map((item) => item.n));
  return readBook(library, id).filter((item) => {
    if (item.source !== "heal" && item.source !== "edit" && item.source !== "restore") return false;
    return !taken.has(item.n);
  });
}

function cloudTime(value: string | number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function clearConflict(library: Library, id: string): void {
  const versions = readBook(library, id).filter((item) => item.source !== "conflict");
  if (!versions.length) return;
  writeBook(library, id, versions);
}

/** A past or live version becomes a new draft. The live file stays. */
export function restoreVersion(library: Library, id: string, n: number): WorkflowVersion {
  const source = versionDocument(library, id, n);
  return draftVersion(library, { ...source, id, updatedAt: Date.now() }, "restore");
}
