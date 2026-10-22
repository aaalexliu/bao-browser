// Push and pull against the registry. The device token stays in sync.json.
// The first sync copies the library aside before anything is sent.

import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { assertSyncSafe, buildPushBody, buildRunBody, SyncRejected } from "../../../web/src/lib/guard";
import { categoryFor } from "../../../web/src/lib/publish";
import { migrate, toJson, validateWorkflow, type WorkflowV2 } from "./schema";
import { Library } from "./store";

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
  };
}

export function saveState(root: string, state: SyncState): void {
  const file = path.join(root, "sync.json");
  writeFileSync(file, JSON.stringify(state, null, 2));
  chmodSync(file, 0o600);
}

export function syncStatus(library: Library): SyncView {
  const state = loadState(library.root);
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
  let pushed = 0;
  let pulled = 0;
  if (mode !== "push") {
    pulled = (await pullRemote(library, state)).pulled;
  }
  let refused = "";
  if (mode !== "pull") {
    const outgoing = await pushLocal(library, state);
    pushed = outgoing.pushed;
    refused = outgoing.refused;
    if (!refused) await pushRuns(library, state);
  }
  await refreshAccount(state);
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
