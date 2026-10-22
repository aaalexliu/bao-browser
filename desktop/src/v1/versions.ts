// Drafts sit beside the live workflow file. Replay reads the live file.
// A heal, an edit, or a restore adds a draft. Promote is what replaces the live file.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validateWorkflow, type WorkflowV2 } from "./schema";
import { Library } from "./store";

export type VersionRole = "live" | "draft" | "past";
export type VersionSource = "saved" | "heal" | "edit" | "restore";

export interface WorkflowVersion {
  n: number;
  role: VersionRole;
  source: VersionSource;
  createdAt: number;
  document: WorkflowV2;
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

export interface VersionSummary {
  n: number;
  role: VersionRole;
  source: VersionSource;
  createdAt: number;
  locator?: HeldLocator;
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

function seed(library: Library, id: string): WorkflowVersion[] {
  const existing = readBook(library, id);
  if (existing.length) return existing;
  const document = library.read(id);
  const row: WorkflowVersion = {
    n: 1,
    role: "live",
    source: "saved",
    createdAt: document.updatedAt || document.createdAt || Date.now(),
    document,
  };
  writeBook(library, id, [row]);
  return [row];
}

export function summarize(row: WorkflowVersion): VersionSummary {
  return {
    n: row.n,
    role: row.role,
    source: row.source,
    createdAt: row.createdAt,
    locator: locatorHeld(row.document),
  };
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
    at: document.createdAt || document.updatedAt || Date.now(),
    score: 100,
    changed: [],
  };
}

export function listVersions(library: Library, id: string): VersionSummary[] {
  return seed(library, id).map(summarize);
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

/** A past or live version becomes a new draft. The live file stays. */
export function restoreVersion(library: Library, id: string, n: number): WorkflowVersion {
  const source = versionDocument(library, id, n);
  return draftVersion(library, { ...source, id, updatedAt: Date.now() }, "restore");
}
