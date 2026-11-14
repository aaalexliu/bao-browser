import { gunzipSync, gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const STEP_RECORD_SCHEMA = "bao.step-record/v1";
const WHY_LIMIT = 500;

/** One HAR 1.2 log as agent-browser or Playwright writes it. Fields we do not read stay as the tool wrote them. */
export interface HarLog {
  log: {
    version: string;
    creator: { name: string; version: string };
    entries: HarEntry[];
    [key: string]: unknown;
  };
}

export interface HarEntry {
  startedDateTime?: string;
  [key: string]: unknown;
}

export interface StepWait {
  for: string;
  ms: number;
}

export interface StepNetworkRecord {
  schema: typeof STEP_RECORD_SCHEMA;
  id: string;
  command: string;
  args: string[];
  why?: string;
  status: "pending" | "passed" | "failed";
  error?: string;
  startedAt: string;
  endedAt?: string;
  waits: StepWait[];
  network: { entries: HarEntry[] };
  /** agent-browser's `console` result at step end, as its `batch --json` returned it. */
  console?: unknown;
  /** agent-browser's `errors` result at step end, as its `batch --json` returned it. */
  errors?: unknown;
}

export interface StepPageLog {
  console: unknown;
  errors: unknown;
}

/** One native call at step end: read each buffer, then clear it so the next step reads only its own. */
export const PAGE_LOG_BATCH = ["--json", "console", "console --clear", "errors", "errors --clear"];

export function parsePageLog(stdout: string): StepPageLog {
  const results = JSON.parse(stdout) as unknown;
  if (!Array.isArray(results) || results.length !== 4) throw new Error("batch did not return four results");
  return { console: results[0], errors: results[2] };
}

export function stepWhy(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, WHY_LIMIT);
}

/** How long the step ran, and the thing it waited on. */
export function stepWait(command: string, startedAt: number, endedAt: number): StepWait {
  const ms = Math.max(0, endedAt - startedAt);
  if (command === "wait_for_owner") return { for: "owner", ms };
  return { for: command, ms };
}

export function runRecordDir(home: string, runId: string): string {
  return path.join(home, "runs", runId);
}

export function stepRecordPath(home: string, runId: string, stepId: string): string {
  return path.join(runRecordDir(home, runId), "steps", `${stepId}.json.gz`);
}

export function runHarPath(home: string, runId: string): string {
  return path.join(runRecordDir(home, runId), "run.har");
}

/**
 * Assigns each entry to the latest step that had already started. An entry before every step
 * stays on the first step. An entry with no parseable time stays in run.har and is assigned to no step.
 * CDP wall time and the step clock can disagree by a few milliseconds; that can put a boundary request on the previous step.
 */
export function assignEntries<T extends { startedDateTime?: string }>(
  entries: readonly T[],
  steps: readonly { id: string; startedAt: number }[],
): Map<string, T[]> {
  const sorted = [...steps].sort((a, b) => a.startedAt - b.startedAt);
  const out = new Map<string, T[]>(sorted.map((step) => [step.id, []]));
  if (!sorted.length) return out;
  for (const entry of entries) {
    const time = Date.parse(entry.startedDateTime ?? "");
    if (Number.isNaN(time)) continue;
    let chosen = sorted[0]!;
    for (const step of sorted) {
      if (step.startedAt <= time) chosen = step;
      else break;
    }
    out.get(chosen.id)!.push(entry);
  }
  return out;
}

/** Keeps the first log's creator and version and concatenates entries. Used only when a route move produced two files. */
export function mergeHar(parts: readonly HarLog[]): HarLog {
  const first = parts[0];
  if (!first) throw new Error("no HAR to merge");
  return { log: { ...first.log, entries: parts.flatMap((part) => part.log.entries ?? []) } };
}

export async function writeStepRecord(home: string, runId: string, record: StepNetworkRecord): Promise<void> {
  const dest = stepRecordPath(home, runId, record.id);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, gzipSync(JSON.stringify(record)));
}

export async function readStepRecord(home: string, runId: string, stepId: string): Promise<StepNetworkRecord> {
  const raw = gunzipSync(await readFile(stepRecordPath(home, runId, stepId)));
  return JSON.parse(raw.toString("utf8")) as StepNetworkRecord;
}

/** Writes the tool's bytes when there is one file. A second file is concatenated, so that run.har is not a byte copy. */
export async function writeRunHar(home: string, runId: string, parts: readonly { raw: Buffer; har: HarLog }[]): Promise<void> {
  if (!parts.length) return;
  const dest = runHarPath(home, runId);
  await mkdir(path.dirname(dest), { recursive: true });
  if (parts.length === 1) {
    await writeFile(dest, parts[0]!.raw);
    return;
  }
  await writeFile(dest, JSON.stringify(mergeHar(parts.map((part) => part.har))));
}

export function parseHar(raw: Buffer): HarLog {
  const parsed = JSON.parse(raw.toString("utf8")) as HarLog;
  if (!parsed?.log || !Array.isArray(parsed.log.entries)) throw new Error("HAR has no log.entries");
  return parsed;
}
