// Push and pull against the registry. The device token stays in sync.json.
// The first sync copies the library aside before anything is sent.

import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { assertSyncSafe, buildPushBody, buildRunBody, SyncRejected } from "../../../web/src/lib/guard";
import { categoryFor } from "../../../web/src/lib/publish";
import { migrate, toJson, validateWorkflow, type WorkflowV2 } from "./schema";
import { Library, type Settings } from "./store";

export const SYNC_CATEGORIES = ["workflows", "run history", "heal records", "settings"] as const;
export type SyncCategory = (typeof SYNC_CATEGORIES)[number];
export type BackupSchedule = "off" | "daily" | "weekly";

export interface SyncBucket {
  category: SyncCategory;
  enabled: boolean;
  local: number;
  cloud: number;
}

export interface DeviceRow {
  id: string;
  name: string;
  created_at: string;
  last_seen_at?: string | null;
}

export interface CategoryCount {
  category: string;
  count: number;
}

export interface ConflictNote {
  id: string;
  remoteVersion: number;
  at: number;
  file: string;
}

export interface SyncState {
  server: string;
  deviceToken?: string;
  deviceId?: string;
  deviceName?: string;
  backedUp: boolean;
  backupPath?: string;
  lastResult?: string;
  lastSyncedAt?: string;
  workflows: Record<string, { version: number; hash: string }>;
  pushedRuns: string[];
  remoteDevices: DeviceRow[];
  remoteCategories: CategoryCount[];
  conflicts: ConflictNote[];
  categoryEnabled?: Partial<Record<SyncCategory, boolean>>;
  cloudCounts?: Partial<Record<SyncCategory, number>>;
  catchingUp?: boolean;
  lastBackupAt?: string;
  scheduledBackupPath?: string;
  settingsCloudAt?: string;
}

export interface SyncView {
  server: string;
  deviceId?: string;
  deviceName?: string;
  paired: boolean;
  backedUp: boolean;
  backupPath?: string;
  lastResult?: string;
  lastSyncedAt?: string;
  devices: DeviceRow[];
  categories: CategoryCount[];
  localCategories: CategoryCount[];
  conflicts: ConflictNote[];
  buckets: SyncBucket[];
  catchingUp: boolean;
  backupSchedule: BackupSchedule;
  lastBackupAt?: string;
  scheduledBackupPath?: string;
}

interface PullBody {
  version: number;
  document: unknown;
  shots?: { stepId: string; url: string }[];
}

export function loadState(root: string): SyncState {
  let parsed: Partial<SyncState> = {};
  try {
    parsed = JSON.parse(readFileSync(path.join(root, "sync.json"), "utf8")) as Partial<SyncState>;
  } catch {
    parsed = {};
  }
  let server = parsed.server || "";
  if (!server) {
    try {
      const settings = JSON.parse(readFileSync(path.join(root, "settings.json"), "utf8")) as { syncServer?: string };
      if (settings.syncServer) server = settings.syncServer;
    } catch {
      server = "";
    }
  }
  return {
    server: server.replace(/\/$/, ""),
    deviceToken: parsed.deviceToken,
    deviceId: parsed.deviceId,
    deviceName: parsed.deviceName,
    backedUp: Boolean(parsed.backedUp),
    backupPath: parsed.backupPath,
    lastResult: parsed.lastResult,
    lastSyncedAt: parsed.lastSyncedAt,
    workflows: parsed.workflows ?? {},
    pushedRuns: parsed.pushedRuns ?? [],
    remoteDevices: parsed.remoteDevices ?? [],
    remoteCategories: parsed.remoteCategories ?? [],
    conflicts: parsed.conflicts ?? [],
    categoryEnabled: parsed.categoryEnabled ?? {},
    cloudCounts: parsed.cloudCounts ?? {},
    catchingUp: Boolean(parsed.catchingUp),
    lastBackupAt: parsed.lastBackupAt,
    scheduledBackupPath: parsed.scheduledBackupPath,
    settingsCloudAt: parsed.settingsCloudAt,
  };
}

export function saveState(root: string, state: SyncState): void {
  const file = path.join(root, "sync.json");
  writeFileSync(file, JSON.stringify(state, null, 2));
  chmodSync(file, 0o600);
}

export function syncStatus(library: Library): SyncView {
  const state = loadState(library.root);
  const buckets = syncBuckets(library, state);
  const catchingUp = Boolean(state.catchingUp) || buckets.some((bucket) => bucket.enabled && bucket.local < bucket.cloud);
  return {
    server: state.server,
    deviceId: state.deviceId,
    deviceName: state.deviceName,
    paired: Boolean(state.deviceToken),
    backedUp: state.backedUp,
    backupPath: state.backupPath,
    lastResult: state.lastResult,
    lastSyncedAt: state.lastSyncedAt,
    devices: state.remoteDevices,
    categories: state.remoteCategories,
    localCategories: localCategoryCounts(library),
    conflicts: state.conflicts,
    buckets,
    catchingUp,
    backupSchedule: library.settings().backupSchedule ?? "off",
    lastBackupAt: state.lastBackupAt,
    scheduledBackupPath: state.scheduledBackupPath,
  };
}

export async function pairDevice(
  library: Library,
  opts: { code: string; server: string; name?: string },
): Promise<SyncView> {
  const state = loadState(library.root);
  state.server = opts.server.replace(/\/$/, "");
  const claimed = await request<{ deviceToken: string; deviceId: string; name: string }>(
    state,
    "POST",
    "/api/pair/claim",
    { code: opts.code, name: opts.name || hostname() },
    false,
  );
  state.deviceToken = claimed.deviceToken;
  state.deviceId = claimed.deviceId;
  state.deviceName = claimed.name;
  state.lastResult = `Paired ${claimed.name}`;
  saveState(library.root, state);
  library.setSyncServer(state.server);
  return syncStatus(library);
}

export async function syncAll(library: Library, mode: "sync" | "push" | "pull" = "sync"): Promise<SyncView> {
  const state = loadState(library.root);
  if (!state.server || !state.deviceToken) throw new Error("pair this Mac first");
  ensureBackup(library, state);
  runScheduledBackup(library);
  try {
    return await syncOnline(library, mode);
  } catch (err) {
    if (!isOffline(err)) throw err;
    const current = loadState(library.root);
    current.catchingUp = true;
    current.lastResult = "Offline. This Mac will catch up when it reconnects.";
    saveState(library.root, current);
    throw err;
  }
}

async function syncOnline(library: Library, mode: "sync" | "push" | "pull"): Promise<SyncView> {
  const state = loadState(library.root);
  const snapshot = await loadSnapshot(state);
  if (snapshot) {
    state.cloudCounts = normalizeCounts(snapshot.counts);
    state.catchingUp = true;
    saveState(library.root, state);
  }
  let pushed = 0;
  let pulled = 0;
  if (mode !== "push" && categoryOn(state, "workflows")) {
    pulled = (await pullRemote(library, state)).pulled;
  }
  if (mode !== "push" && snapshot) applyCatchUp(library, state, snapshot);
  let refused = "";
  if (mode !== "pull" && categoryOn(state, "workflows")) {
    const outgoing = await pushLocal(library, state);
    pushed = outgoing.pushed;
    refused = outgoing.refused;
  }
  if (mode !== "pull" && !refused && categoryOn(state, "run history")) await pushRuns(library, state);
  if (mode !== "pull" && !refused && snapshot && categoryOn(state, "settings")) {
    await pushSettings(library, state);
  }
  await refreshAccount(state);
  const local = localSyncCounts(library);
  state.catchingUp = SYNC_CATEGORIES.some((category) => categoryOn(state, category) && local[category] < (state.cloudCounts?.[category] ?? 0));
  state.lastSyncedAt = new Date().toISOString();
  state.lastResult = refused
    ? `Push refused: ${refused}`
    : `pushed ${pushed}, pulled ${pulled}, conflicts ${state.conflicts.length}`;
  saveState(library.root, state);
  return syncStatus(library);
}

export function openConflict(library: Library, id: string): { id: string; name: string; steps: string[] } {
  const state = loadState(library.root);
  const note = state.conflicts.find((item) => item.id === id);
  if (!note || !existsSync(note.file)) throw new Error("no conflict");
  const doc = migrate(JSON.parse(readFileSync(note.file, "utf8")));
  return { id: doc.id, name: doc.name, steps: doc.steps.map((step) => step.label) };
}

export async function keepMine(library: Library, id: string): Promise<SyncView> {
  const state = loadState(library.root);
  if (!state.server || !state.deviceToken) throw new Error("pair this Mac first");
  const note = state.conflicts.find((item) => item.id === id);
  if (!note || !existsSync(note.file)) throw new Error("no conflict");
  const local = migrate(JSON.parse(readFileSync(note.file, "utf8")));
  const errors = validateWorkflow(local);
  if (errors.length) throw new Error(errors.join(", "));
  library.save(local);
  const result = await pushDocument(library, state, local);
  if (result.kind === "refused") state.lastResult = `Push refused: ${result.message || "secret param"}`;
  else if (result.kind === "conflict") state.lastResult = `Still in conflict on ${id}`;
  else {
    state.conflicts = state.conflicts.filter((item) => item.id !== id);
    state.lastResult = `Kept ${local.name}`;
  }
  state.lastSyncedAt = new Date().toISOString();
  await refreshAccount(state).catch(() => undefined);
  saveState(library.root, state);
  return syncStatus(library);
}

function ensureBackup(library: Library, state: SyncState): void {
  if (state.backedUp) return;
  const dest = path.join(library.root, "backups", `before-sync-${Date.now()}`);
  mkdirSync(dest, { recursive: true });
  cpSync(path.join(library.root, "workflows"), path.join(dest, "workflows"), { recursive: true });
  cpSync(path.join(library.root, "runs"), path.join(dest, "runs"), { recursive: true });
  const settings = path.join(library.root, "settings.json");
  if (existsSync(settings)) cpSync(settings, path.join(dest, "settings.json"));
  state.backedUp = true;
  state.backupPath = dest;
  saveState(library.root, state);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SETTINGS_KEYS = ["heal", "promoteAfter", "actTimeoutMs", "circuitLimit", "circuitWindowMs", "backupSchedule"] as const;

export function setCategoryEnabled(library: Library, category: string, enabled: boolean): SyncView {
  if (!isSyncCategory(category)) throw new Error("category");
  const state = loadState(library.root);
  state.categoryEnabled = { ...state.categoryEnabled, [category]: enabled };
  saveState(library.root, state);
  return syncStatus(library);
}

export function setBackupSchedule(library: Library, schedule: string): SyncView {
  if (schedule !== "off" && schedule !== "daily" && schedule !== "weekly") throw new Error("schedule");
  library.updateSettings({ backupSchedule: schedule });
  runScheduledBackup(library);
  return syncStatus(library);
}

export function runScheduledBackup(library: Library, now = Date.now()): { ran: boolean; path?: string } {
  const schedule = library.settings().backupSchedule ?? "off";
  if (schedule !== "daily" && schedule !== "weekly") return { ran: false };
  const state = loadState(library.root);
  const last = state.lastBackupAt ? Date.parse(state.lastBackupAt) : 0;
  const windowMs = schedule === "weekly" ? 7 * DAY_MS : DAY_MS;
  if (last && Number.isFinite(last) && now - last < windowMs) return { ran: false };
  const dest = path.join(library.root, "backups", `scheduled-${now}`);
  copyLibrary(library.root, dest);
  state.lastBackupAt = new Date(now).toISOString();
  state.scheduledBackupPath = dest;
  saveState(library.root, state);
  return { ran: true, path: dest };
}

/** The folder Reveal in Finder opens. It has to live under this library's backups. */
export function revealBackup(library: Library): string {
  const state = loadState(library.root);
  const target = state.scheduledBackupPath || state.backupPath;
  if (!target) throw new Error("no backup");
  assertBackup(library.root, target);
  if (!existsSync(target)) throw new Error("no backup");
  return target;
}

export function restoreScheduledBackup(library: Library): SyncView {
  const state = loadState(library.root);
  const dest = state.scheduledBackupPath;
  if (!dest) throw new Error("no scheduled backup");
  assertBackup(library.root, dest);
  if (!existsSync(dest)) throw new Error("no scheduled backup");
  for (const name of ["workflows", "runs", "promotions", "heals", "versions"] as const) {
    const from = path.join(dest, name);
    const to = path.join(library.root, name);
    if (!existsSync(from)) continue;
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
  }
  const settings = path.join(dest, "settings.json");
  if (existsSync(settings)) cpSync(settings, path.join(library.root, "settings.json"));
  state.lastResult = `Restored ${dest}`;
  saveState(library.root, state);
  return syncStatus(library);
}

function copyLibrary(root: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const name of ["workflows", "runs", "promotions", "heals", "versions"]) {
    const from = path.join(root, name);
    if (existsSync(from)) cpSync(from, path.join(dest, name), { recursive: true });
  }
  const settings = path.join(root, "settings.json");
  if (existsSync(settings)) cpSync(settings, path.join(dest, "settings.json"));
}

function assertBackup(root: string, target: string): void {
  const resolved = path.resolve(target);
  const backups = path.resolve(root, "backups");
  if (resolved !== backups && !resolved.startsWith(`${backups}${path.sep}`)) throw new Error("bad backup path");
}

interface SyncSnapshot {
  counts?: Partial<Record<SyncCategory, number>>;
  runs?: { id?: string; workflowId?: string; status?: string; at?: string | number; steps?: unknown[] }[];
  heals?: { id?: string; workflowId?: string; heal?: unknown }[];
  settings?: Partial<Settings> | null;
  settingsUpdatedAt?: string | null;
}

async function loadSnapshot(state: SyncState): Promise<SyncSnapshot | null> {
  try {
    return await request<SyncSnapshot>(state, "GET", "/api/sync/snapshot");
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

function applyCatchUp(library: Library, state: SyncState, snapshot: SyncSnapshot): void {
  if (categoryOn(state, "run history")) {
    for (const run of snapshot.runs ?? []) {
      const id = String(run.id || "");
      const workflowId = String(run.workflowId || "");
      if (!id || !workflowId || !safeKey(id) || !safeKey(workflowId)) continue;
      try {
        library.readRun(id);
        continue;
      } catch { /* missing on this device */ }
      const at = typeof run.at === "number" ? run.at : Date.parse(String(run.at || ""));
      library.saveRun({
        id,
        workflowId,
        status: String(run.status || ""),
        at: Number.isFinite(at) ? at : Date.now(),
        heals: [],
        steps: Array.isArray(run.steps) ? run.steps : [],
      });
    }
  }
  if (categoryOn(state, "heal records")) {
    const dir = path.join(library.root, "heals");
    mkdirSync(dir, { recursive: true });
    for (const heal of snapshot.heals ?? []) {
      const id = String(heal.id || "");
      if (!safeKey(id) || existsSync(path.join(dir, `${id}.json`))) continue;
      writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, workflowId: heal.workflowId, heal: heal.heal ?? null }, null, 2));
    }
  }
  if (categoryOn(state, "settings") && snapshot.settings && snapshot.settingsUpdatedAt && snapshot.settingsUpdatedAt !== state.settingsCloudAt) {
    library.updateSettings(pickSettings(snapshot.settings));
    state.settingsCloudAt = snapshot.settingsUpdatedAt;
  }
}

async function pushSettings(library: Library, state: SyncState): Promise<void> {
  try {
    await request(state, "POST", "/api/sync/settings", pickSettings(library.settings()));
  } catch (err) {
    if ((err as { status?: number }).status === 404) return;
    throw err;
  }
}

function syncBuckets(library: Library, state: SyncState): SyncBucket[] {
  const local = localSyncCounts(library);
  return SYNC_CATEGORIES.map((category) => ({
    category,
    enabled: categoryOn(state, category),
    local: local[category],
    cloud: Number(state.cloudCounts?.[category] ?? 0) || 0,
  }));
}

function localSyncCounts(library: Library): Record<SyncCategory, number> {
  return {
    workflows: library.list().length,
    "run history": library.listRuns().length,
    "heal records": countJson(path.join(library.root, "heals")),
    settings: existsSync(path.join(library.root, "settings.json")) ? 1 : 0,
  };
}

function countJson(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((name) => name.endsWith(".json")).length;
}

function categoryOn(state: SyncState, category: SyncCategory): boolean {
  return state.categoryEnabled?.[category] !== false;
}

function isSyncCategory(category: string): category is SyncCategory {
  return (SYNC_CATEGORIES as readonly string[]).includes(category);
}

function normalizeCounts(raw: Partial<Record<SyncCategory, number>> | undefined): Record<SyncCategory, number> {
  const counts = {} as Record<SyncCategory, number>;
  for (const category of SYNC_CATEGORIES) counts[category] = Number(raw?.[category] ?? 0) || 0;
  return counts;
}

function pickSettings(settings: Partial<Settings>): Partial<Settings> {
  const picked: Partial<Settings> = {};
  for (const key of SETTINGS_KEYS) {
    if (settings[key] !== undefined) picked[key] = settings[key] as never;
  }
  return picked;
}

function safeKey(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

function isOffline(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  return status === undefined || status >= 500;
}

async function pullRemote(library: Library, state: SyncState): Promise<{ pulled: number; conflicts: number }> {
  const listed = await request<{ workflows: { id: string }[] }>(state, "GET", "/api/workflows");
  let pulled = 0;
  let conflicts = 0;
  for (const hit of listed.workflows ?? []) {
    const remote = await request<PullBody>(state, "GET", `/api/workflows/${encodeURIComponent(hit.id)}`);
    const adopted = adoptIfNeeded(library, state, hit.id, remote);
    if (adopted === "conflict") conflicts += 1;
    if (adopted !== "skip") {
      pulled += 1;
      await saveShots(library, state, hit.id, remote.shots ?? []);
    }
  }
  return { pulled, conflicts };
}

async function pushLocal(library: Library, state: SyncState): Promise<{ pushed: number; conflicts: number; refused: string }> {
  let pushed = 0;
  let conflicts = 0;
  let refused = "";
  for (const doc of library.list()) {
    const result = await pushDocument(library, state, doc);
    if (result.kind === "pushed") pushed += 1;
    if (result.kind === "conflict") conflicts += 1;
    if (result.kind === "refused") refused = result.message || "secret param";
  }
  return { pushed, conflicts, refused };
}

async function pushDocument(
  library: Library,
  state: SyncState,
  doc: WorkflowV2,
): Promise<{ kind: "pushed" | "conflict" | "skip" | "refused"; message?: string }> {
  const hash = docHash(doc);
  const known = state.workflows[doc.id];
  if (known && known.hash === hash) return { kind: "skip" };
  const heal = library.readKeptHeal(doc.id);
  let body: ReturnType<typeof buildPushBody>;
  try {
    assertSyncSafe({ document: doc, heal });
    body = buildPushBody(doc, {
      baseVersion: known?.version ?? 0,
      heal,
      category: categoryFor(doc),
    });
  } catch (err) {
    if (err instanceof SyncRejected) return { kind: "refused", message: err.message };
    throw err;
  }
  try {
    const result = await request<{ version: number }>(state, "POST", `/api/workflows/${encodeURIComponent(doc.id)}/versions`, body);
    state.workflows[doc.id] = { version: result.version, hash };
    library.clearKeptHeal(doc.id);
    return { kind: "pushed" };
  } catch (err) {
    const conflict = err as Error & { status?: number; current?: PullBody };
    if (conflict.status === 409 && conflict.current?.document) {
      stash(library, state, doc, conflict.current);
      return { kind: "conflict" };
    }
    if (conflict.status === 400 || err instanceof SyncRejected) return { kind: "refused", message: conflict.message };
    throw err;
  }
}

async function pushRuns(library: Library, state: SyncState): Promise<void> {
  for (const run of library.listRuns()) {
    if (state.pushedRuns.includes(run.id)) continue;
    const body = buildRunBody({
      id: run.id,
      status: run.status,
      at: run.at,
      steps: (run.steps as { id?: string; status?: string }[]) ?? [],
    });
    await request(state, "POST", `/api/workflows/${encodeURIComponent(run.workflowId)}/runs`, body);
    state.pushedRuns.push(run.id);
  }
}

function adoptIfNeeded(library: Library, state: SyncState, id: string, remote: PullBody): "pulled" | "conflict" | "skip" {
  const known = state.workflows[id];
  let local: WorkflowV2 | undefined;
  try {
    local = library.read(id);
  } catch {
    local = undefined;
  }
  const dirty = local ? !known || known.hash !== docHash(local) : false;
  const remoteNewer = remote.version > (known?.version ?? 0);
  if (dirty && remoteNewer && local) {
    stash(library, state, local, remote);
    return "conflict";
  }
  if (!local || remoteNewer) {
    writeRemote(library, state, remote);
    return "pulled";
  }
  return "skip";
}

function stash(library: Library, state: SyncState, local: WorkflowV2, remote: PullBody): void {
  const file = path.join(library.root, "conflicts", `${safeId(local.id)}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, toJson(local));
  writeRemote(library, state, remote);
  state.conflicts = [
    { id: local.id, remoteVersion: remote.version, at: Date.now(), file },
    ...state.conflicts.filter((item) => item.id !== local.id),
  ];
}

function writeRemote(library: Library, state: SyncState, remote: PullBody): void {
  const doc = migrate(remote.document);
  const errors = validateWorkflow(doc);
  if (errors.length) throw new Error(errors.join(", "));
  library.save(doc);
  state.workflows[doc.id] = { version: remote.version, hash: docHash(doc) };
}

async function saveShots(
  library: Library,
  state: SyncState,
  id: string,
  shots: { stepId: string; url: string }[],
): Promise<void> {
  for (const shot of shots) {
    const res = await fetch(new URL(shot.url, state.server), { headers: authHeaders(state) });
    if (!res.ok) continue;
    const dest = path.join(library.root, "shots", safeId(id), `${safeId(shot.stepId)}.png`);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  }
}

async function refreshAccount(state: SyncState): Promise<void> {
  const body = await request<{ devices: DeviceRow[]; categories: CategoryCount[] }>(state, "GET", "/api/devices");
  state.remoteDevices = body.devices ?? [];
  state.remoteCategories = (body.categories ?? []).map((row) => ({
    category: row.category,
    count: Number(row.count),
  }));
}

function localCategoryCounts(library: Library): CategoryCount[] {
  const counts = new Map<string, number>();
  for (const doc of library.list()) {
    const category = categoryFor(doc);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => a.category.localeCompare(b.category));
}

function docHash(doc: WorkflowV2): string {
  return createHash("sha256").update(toJson(doc)).digest("hex");
}

function safeId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("bad id");
  return id;
}

function authHeaders(state: SyncState): Record<string, string> {
  if (!state.deviceToken) throw new Error("pair this Mac first");
  return { authorization: `Bearer ${state.deviceToken}` };
}

async function request<T>(state: SyncState, method: string, pathname: string, body?: unknown, auth = true): Promise<T> {
  if (!state.server) throw new Error("set a sync server");
  const headers: Record<string, string> = auth ? authHeaders(state) : {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${state.server}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: { error?: string; current?: PullBody } = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as { error?: string; current?: PullBody };
    } catch {
      parsed = { error: text.slice(0, 200) };
    }
  }
  if (!res.ok) {
    const err = new Error(parsed.error || `sync ${res.status}`) as Error & { status?: number; current?: PullBody };
    err.status = res.status;
    err.current = parsed.current;
    throw err;
  }
  return parsed as T;
}
