// The library is files under one directory. Sync state lives beside it, not in here.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { HealSettings } from "./heal";
import { DEFAULT_ACT_TIMEOUT_MS } from "./human-ask";
import { DEFAULT_PROMOTE_AFTER } from "./promote";
import { DEFAULT_CIRCUIT_LIMIT, DEFAULT_CIRCUIT_WINDOW_MS } from "./triage";
import type { HealMode, WorkflowV2 } from "./schema";
import { migrate, toJson, validateWorkflow } from "./schema";

export interface Settings extends HealSettings {
  heal: HealMode;
  promoteAfter: number;
  actTimeoutMs: number;
  circuitLimit: number;
  circuitWindowMs: number;
  syncServer?: string;
  /** Scheduled library export. Absent means off. */
  backupSchedule?: "off" | "daily" | "weekly";
}

export interface StoredRun {
  id: string;
  workflowId: string;
  status: string;
  at: number;
  heals: unknown[];
  /** Keep/revert choices, appended after the heal. The heal record stays as it was. */
  decisions?: { ts: number; healId: string; decision: "keep" | "revert" }[];
  failure?: unknown;
  steps: unknown[];
  /** Heal proposals that named a model. */
  modelCalls?: number;
  /** Secrets are masked. File values are names, not paths. */
  inputs?: Record<string, string>;
  video?: string;
  videoStartedAt?: number;
  repairs?: unknown[];
  receipts?: unknown[];
  promotion?: unknown;
  precondition?: unknown;
  trail?: unknown[];
  trajectory?: unknown[];
}

const DEFAULT_SETTINGS: Settings = {
  heal: "auto",
  promoteAfter: DEFAULT_PROMOTE_AFTER,
  actTimeoutMs: DEFAULT_ACT_TIMEOUT_MS,
  circuitLimit: DEFAULT_CIRCUIT_LIMIT,
  circuitWindowMs: DEFAULT_CIRCUIT_WINDOW_MS,
};

export class Library {
  constructor(readonly root: string) {
    mkdirSync(path.join(root, "workflows"), { recursive: true });
    mkdirSync(path.join(root, "trails"), { recursive: true });
    mkdirSync(path.join(root, "runs"), { recursive: true });
    mkdirSync(path.join(root, "shots"), { recursive: true });
    mkdirSync(path.join(root, "promotions"), { recursive: true });
  }

  list(): WorkflowV2[] {
    return readdirSync(path.join(this.root, "workflows"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.read(name.replace(/\.json$/, "")))
      .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
  }

  read(id: string): WorkflowV2 {
    const raw = JSON.parse(readFileSync(this.file(id), "utf8")) as unknown;
    const doc = migrate(raw);
    const errors = validateWorkflow(doc);
    if (errors.length) throw new Error(`workflow ${id} is invalid: ${errors.join(", ")}`);
    return doc;
  }

  save(doc: WorkflowV2): void {
    const errors = validateWorkflow(doc);
    if (errors.length) throw new Error(errors.join(", "));
    writeFileSync(this.file(doc.id), toJson(doc));
  }

  rename(id: string, name: string): WorkflowV2 {
    const doc = { ...this.read(id), name, updatedAt: Date.now() };
    this.save(doc);
    return doc;
  }

  remove(id: string): void {
    rmSync(this.file(id));
  }

  importJson(raw: string): WorkflowV2 {
    const doc = migrate(JSON.parse(raw) as unknown);
    const errors = validateWorkflow(doc);
    if (errors.length) throw new Error(errors.join(", "));
    this.save(doc);
    return doc;
  }

  exportJson(id: string): string {
    return toJson(this.read(id));
  }

  saveTrail(id: string, events: unknown): void {
    writeFileSync(path.join(this.root, "trails", `${id}.json`), JSON.stringify(events, null, 2));
  }

  appendTrail(id: string, event: unknown): unknown[] {
    const file = path.join(this.root, "trails", `${id}.json`);
    let events: unknown[] = [];
    try {
      const current = JSON.parse(readFileSync(file, "utf8")) as unknown;
      events = Array.isArray(current) ? current : [current];
    } catch { /* first event */ }
    events.push(event);
    writeFileSync(file, JSON.stringify(events, null, 2));
    return events;
  }

  savePromotion(promotion: unknown & { workflowId: string }): void {
    mkdirSync(path.join(this.root, "promotions"), { recursive: true });
    writeFileSync(path.join(this.root, "promotions", `${promotion.workflowId}.json`), JSON.stringify(promotion, null, 2));
  }

  readPromotion(workflowId: string): { workflowId: string; status: string; drift: string; replays: number; healId: string; stepId: string; patch: unknown; before: unknown; reason?: string; version?: number } | undefined {
    try {
      return JSON.parse(readFileSync(path.join(this.root, "promotions", `${workflowId}.json`), "utf8")) as {
        workflowId: string; status: string; drift: string; replays: number; healId: string; stepId: string; patch: unknown; before: unknown; reason?: string;
      };
    } catch {
      return undefined;
    }
  }

  readTrail(id: string): unknown {
    return JSON.parse(readFileSync(path.join(this.root, "trails", `${id}.json`), "utf8")) as unknown;
  }

  listTrails(): string[] {
    return readdirSync(path.join(this.root, "trails")).filter((name) => name.endsWith(".json")).map((name) => name.replace(/\.json$/, ""));
  }

  saveRun(run: StoredRun): void {
    writeFileSync(path.join(this.root, "runs", `${run.id}.json`), JSON.stringify(run, null, 2));
  }

  readRun(id: string): StoredRun {
    return JSON.parse(readFileSync(path.join(this.root, "runs", `${id}.json`), "utf8")) as StoredRun;
  }

  appendDecision(runId: string, decision: NonNullable<StoredRun["decisions"]>[number]): StoredRun {
    const run = this.readRun(runId);
    const next: StoredRun = {
      ...run,
      heals: run.heals,
      decisions: [...(run.decisions ?? []), decision],
    };
    this.saveRun(next);
    return next;
  }

  listRuns(): StoredRun[] {
    return readdirSync(path.join(this.root, "runs"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.readRun(name.replace(/\.json$/, "")));
  }

  settings(): Settings {
    const file = path.join(this.root, "settings.json");
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(file, "utf8")) as Settings };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  setHeal(heal: HealMode): Settings {
    return this.updateSettings({ heal });
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const settings: Settings = { ...DEFAULT_SETTINGS, ...this.settings(), ...patch };
    writeFileSync(path.join(this.root, "settings.json"), JSON.stringify(settings, null, 2));
    return settings;
  }

  setSyncServer(syncServer: string): Settings {
    return this.updateSettings({ syncServer });
  }

  savePublicInputs(id: string, inputs: Record<string, string | number>): void {
    mkdirSync(path.join(this.root, "inputs"), { recursive: true });
    writeFileSync(path.join(this.root, "inputs", `${this.safe(id)}.json`), JSON.stringify(inputs, null, 2));
  }

  readPublicInputs(id: string): Record<string, string | number> {
    try {
      return JSON.parse(readFileSync(path.join(this.root, "inputs", `${this.safe(id)}.json`), "utf8")) as Record<string, string | number>;
    } catch {
      return {};
    }
  }

  /** Kept heal for the next sync push. Separate from the promotion tracker. */
  noteHealPromotion(id: string, heal: unknown): void {
    mkdirSync(path.join(this.root, "promotions"), { recursive: true });
    writeFileSync(path.join(this.root, "promotions", `${this.safe(id)}.heal.json`), JSON.stringify(withoutShots(heal), null, 2));
  }

  readKeptHeal(id: string): unknown {
    try {
      return JSON.parse(readFileSync(path.join(this.root, "promotions", `${this.safe(id)}.heal.json`), "utf8")) as unknown;
    } catch {
      return undefined;
    }
  }

  clearKeptHeal(id: string): void {
    rmSync(path.join(this.root, "promotions", `${this.safe(id)}.heal.json`), { force: true });
  }

  readBounds(id: string): { x: number; y: number; width: number; height: number } | null {
    try {
      const raw = JSON.parse(readFileSync(this.boundsFile(id), "utf8")) as { x?: number; y?: number; width?: number; height?: number };
      if (typeof raw.x !== "number" || typeof raw.y !== "number" || typeof raw.width !== "number" || typeof raw.height !== "number") return null;
      return { x: raw.x, y: raw.y, width: raw.width, height: raw.height };
    } catch {
      return null;
    }
  }

  writeBounds(id: string, bounds: { x: number; y: number; width: number; height: number }): void {
    mkdirSync(path.join(this.root, "bounds"), { recursive: true });
    writeFileSync(this.boundsFile(id), JSON.stringify(bounds));
  }

  private file(id: string): string {
    if (id.includes("/") || id.includes("..")) throw new Error("bad workflow id");
    return path.join(this.root, "workflows", `${id}.json`);
  }

  private boundsFile(id: string): string {
    if (id.includes("/") || id.includes("..")) throw new Error("bad workflow id");
    return path.join(this.root, "bounds", `${id}.json`);
  }

  private safe(id: string): string {
    if (id.includes("/") || id.includes("..") || id.includes("\\")) throw new Error("bad workflow id");
    return id;
  }
}

function withoutShots(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutShots);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "screenshot") continue;
    out[key] = withoutShots(child);
  }
  return out;
}

export function emptyDir(root: string): void {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
}

export function archiveWorkflow(root: string, id: string): void {
  const from = path.join(root, "workflows", `${id}.json`);
  const dest = path.join(root, "workflows", `${id}.deleted.json`);
  renameSync(from, dest);
}
