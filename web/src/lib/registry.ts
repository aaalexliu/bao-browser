import { createHash, randomBytes, randomUUID } from "node:crypto";
import Ajv from "ajv/dist/2020";
import { getPng, putPng } from "./blobstore";
import { isElementCrop } from "./png";
import { query } from "./db";
import { assertSyncSafe, type SyncShot } from "./guard";
import { applyImportAnswers, importQuestions, prepareImport, publicSamples } from "./import-sheet";
import { categoryFor, domainsOf, releaseHash, summaryOf } from "./publish";
import { runPublishGate } from "./review-gate";
import { rankHits, SEARCH_LIMIT, type RankInput } from "./rank";
import schema from "./workflow-v2.schema.json";
import { assertInviteSecret, assertOwnerEmail, assertOwnerSignIn, assertProductionAuth, magicLinkVisible } from "./owner";
import { SEED_WORKFLOWS } from "./seeds";

const ajv = new Ajv({ allErrors: true, strict: false });
const validateWorkflow = ajv.compile(schema);

export class HttpError extends Error {
  detail?: Record<string, unknown>;
  constructor(message: string, readonly status: number, detail?: Record<string, unknown>) {
    super(message);
    this.name = "HttpError";
    this.detail = detail;
  }
}

export interface Principal {
  userId: string;
  deviceId?: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  verified: boolean;
}

interface ShotIn {
  stepId?: string;
  png?: string;
  redacted?: boolean;
}

let seeded = false;

export async function ensureSeed(): Promise<void> {
  if (seeded) return;
  const user = await upsertUser("examples@bao.local", "Bao examples", true);
  for (const seed of SEED_WORKFLOWS) {
    const existing = await query(`SELECT id FROM workflows WHERE id = $1`, [seed.id]);
    if (existing.length) continue;
    const errors = workflowErrors(seed.document);
    if (errors.length) throw new Error(`seed ${seed.id}: ${errors.join("; ")}`);
    await insertOwned(user.id, seed.document, 0, null, [], user.name, seed.category);
  }
  seeded = true;
}

export async function requestMagicLink(email: string, secret?: string): Promise<{ verifyUrl?: string }> {
  const clean = email.trim().toLowerCase();
  if (!clean.includes("@")) throw new HttpError("email", 400);
  const proved = assertOwnerSignIn(clean, secret);
  const token = randomBytes(24).toString("hex");
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  await query(`INSERT INTO magic_links (token, email, expires_at) VALUES ($1, $2, $3)`, [token, clean, expires]);
  const path = `/api/auth/verify?token=${token}`;
  if (magicLinkVisible(process.env, proved)) return { verifyUrl: path };
  console.log(`bao magic link ${path}`);
  return {};
}

export async function verifyMagicLink(token: string): Promise<{ session: string; user: User }> {
  const rows = await query<{ email: string }>(
    `UPDATE magic_links SET used_at = now()
     WHERE token = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING email`,
    [token],
  );
  const email = rows[0]?.email;
  if (!email) throw new HttpError("link expired", 400);
  assertOwnerEmail(email);
  const user = await upsertUser(email, email.split("@")[0] || email, false);
  return { session: await createSession(user.id), user };
}

export async function githubStub(): Promise<{ session: string; user: User }> {
  if (process.env.NODE_ENV === "production") {
    throw new HttpError("GitHub sign-in is not available.", 501);
  }
  const user = await upsertUser("github-stub@bao.local", "GitHub stub", true);
  return { session: await createSession(user.id), user };
}

export async function userFromSession(token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const rows = await query<{ id: string; email: string; name: string; verified: boolean }>(
    `SELECT u.id, u.email, u.name, u.verified
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1`,
    [token],
  );
  return rows[0] ?? null;
}

export async function logout(token: string | undefined): Promise<void> {
  if (token) await query(`DELETE FROM sessions WHERE token = $1`, [token]);
}

export async function principalFrom(authorization: string | null, session: string | undefined): Promise<Principal | null> {
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice(7).trim();
    const rows = await query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM devices WHERE token_hash = $1`,
      [hash(token)],
    );
    const row = rows[0];
    if (!row) return null;
    await query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [row.id]);
    return { userId: row.user_id, deviceId: row.id };
  }
  const user = await userFromSession(session);
  return user ? { userId: user.id } : null;
}

export async function issuePairCode(userId: string): Promise<{ code: string; expiresAt: string }> {
  const code = pairCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await query(`INSERT INTO pair_codes (code, user_id, expires_at) VALUES ($1, $2, $3)`, [code, userId, expiresAt]);
  return { code, expiresAt };
}

export async function activePairCode(userId: string): Promise<{ code: string; expiresAt: string } | null> {
  const rows = await query<{ code: string; expires_at: string }>(
    `SELECT code, expires_at FROM pair_codes
     WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()
     ORDER BY expires_at DESC LIMIT 1`,
    [userId],
  );
  const row = rows[0];
  return row ? { code: row.code, expiresAt: String(row.expires_at) } : null;
}

export async function claimPairCode(code: string, name: string, secret?: string): Promise<{ deviceToken: string; deviceId: string; name: string }> {
  assertInviteSecret(secret);
  const rows = await query<{ user_id: string }>(
    `UPDATE pair_codes SET used_at = now()
     WHERE code = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [code.trim().toUpperCase()],
  );
  const userId = rows[0]?.user_id;
  if (!userId) throw new HttpError("code expired", 400);
  const deviceId = `dev-${randomUUID()}`;
  const deviceToken = randomBytes(32).toString("hex");
  const deviceName = name.trim() || "device";
  await query(
    `INSERT INTO devices (id, user_id, name, token_hash, last_seen_at) VALUES ($1, $2, $3, $4, now())`,
    [deviceId, userId, deviceName, hash(deviceToken)],
  );
  return { deviceToken, deviceId, name: deviceName };
}

export async function listDevices(userId: string) {
  return query<{
    id: string;
    name: string;
    created_at: string;
    last_seen_at: string | null;
    last_synced_at: string | null;
    workflow_count: number;
  }>(
    `SELECT id, name, created_at, last_seen_at, last_synced_at, workflow_count
     FROM devices WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
}

export async function unpairDevice(userId: string, deviceId: string): Promise<void> {
  if (!/^dev-[\w-]+$/.test(deviceId)) throw new HttpError("not found", 404);
  const rows = await query<{ id: string }>(
    `DELETE FROM devices WHERE id = $1 AND user_id = $2 RETURNING id`,
    [deviceId, userId],
  );
  if (!rows.length) throw new HttpError("not found", 404);
}

async function noteDeviceSync(principal: Principal): Promise<void> {
  if (!principal.deviceId) return;
  const owned = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM workflows WHERE owner_id = $1`,
    [principal.userId],
  );
  const pushed = await query<{ count: number }>(
    `SELECT count(DISTINCT workflow_id)::int AS count FROM workflow_versions WHERE device_id = $1`,
    [principal.deviceId],
  );
  const count = Math.max(Number(owned[0]?.count ?? 0), Number(pushed[0]?.count ?? 0));
  await query(
    `UPDATE devices SET last_synced_at = now(), workflow_count = $2 WHERE id = $1 AND user_id = $3`,
    [principal.deviceId, count, principal.userId],
  );
}

export async function categoryCounts(userId: string) {
  return query<{ category: string; count: number }>(
    `SELECT category, count(*)::int AS count FROM workflows WHERE owner_id = $1 GROUP BY category ORDER BY category`,
    [userId],
  );
}

const SETTINGS_KEYS = ["heal", "promoteAfter", "actTimeoutMs", "circuitLimit", "circuitWindowMs", "backupSchedule"] as const;

export async function syncSnapshot(principal: Principal) {
  const workflows = await ownedRows(principal.userId);
  const runs = await query<{ id: string; workflow_id: string; status: string; at: string; steps: unknown }>(
    `SELECT r.id, r.workflow_id, r.status, r.at, r.steps
     FROM runs r JOIN workflows w ON w.id = r.workflow_id
     WHERE w.owner_id = $1 ORDER BY r.at`,
    [principal.userId],
  );
  const heals = await query<{ workflow_id: string; version: number; heal: unknown }>(
    `SELECT v.workflow_id, v.version, v.heal
     FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id
     WHERE w.owner_id = $1 AND v.heal IS NOT NULL
     ORDER BY v.workflow_id, v.version`,
    [principal.userId],
  );
  const stored = await query<{ document: unknown; updated_at: string }>(
    `SELECT document, updated_at FROM account_settings WHERE user_id = $1`,
    [principal.userId],
  );
  const settings = stored[0] ? pickAccountSettings(json(stored[0].document)) : null;
  await noteDeviceSync(principal);
  return {
    counts: {
      workflows: workflows.length,
      "run history": runs.length,
      "heal records": heals.length,
      settings: settings ? 1 : 0,
    },
    runs: runs.map((run) => ({
      id: run.id,
      workflowId: run.workflow_id,
      status: run.status,
      at: run.at,
      steps: json(run.steps),
    })),
    heals: heals.map((heal) => ({
      id: `heal-${heal.workflow_id}-v${heal.version}`,
      workflowId: heal.workflow_id,
      heal: json(heal.heal),
    })),
    settings,
    settingsUpdatedAt: stored[0]?.updated_at ?? null,
  };
}

export async function saveAccountSettings(principal: Principal, document: unknown) {
  const clean = pickAccountSettings(document);
  await query(
    `INSERT INTO account_settings (user_id, document, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (user_id) DO UPDATE SET document = EXCLUDED.document, updated_at = now()`,
    [principal.userId, JSON.stringify(clean)],
  );
  return { ok: true };
}

function pickAccountSettings(document: unknown): Record<string, unknown> {
  const source = document && typeof document === "object" ? document as Record<string, unknown> : {};
  const picked: Record<string, unknown> = {};
  for (const key of SETTINGS_KEYS) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  if (picked.backupSchedule !== "off" && picked.backupSchedule !== "daily" && picked.backupSchedule !== "weekly") {
    delete picked.backupSchedule;
  }
  if (picked.heal !== "auto" && picked.heal !== "approve") delete picked.heal;
  return picked;
}

export async function pushVersion(
  principal: Principal,
  id: string,
  body: { baseVersion?: number; document?: unknown; heal?: unknown; shots?: ShotIn[]; category?: string },
) {
  assertId(id);
  assertSyncSafe(body);
  const document = body.document;
  const errors = workflowErrors(document);
  if (errors.length) throw new HttpError(errors.join("; "), 400);
  const doc = document as { id?: string; name?: string };
  if (doc.id !== id) throw new HttpError("id", 400);
  const user = await mustUser(principal.userId);
  const category = categoryFor(document, body.category);
  const site = domainsOf(document)[0] || "";
  const summary = summaryOf(document);
  const base = Number(body.baseVersion ?? 0);
  const existing = await query<{ owner_id: string; head_version: number }>(
    `SELECT owner_id, head_version FROM workflows WHERE id = $1`,
    [id],
  );
  if (!existing.length) {
    if (base !== 0) throw new HttpError("conflict", 409);
    await insertOwned(principal.userId, document, base, body.heal, body.shots ?? [], user.name, category, undefined, principal.deviceId ?? null);
    await noteDeviceSync(principal);
    return { version: 1, created: true };
  }
  if (existing[0]?.owner_id !== principal.userId) throw new HttpError("not found", 404);
  const bumped = await acceptVersion(id, principal.userId, {
    name: doc.name || id,
    summary,
    site,
    category,
    base,
    document,
    heal: body.heal,
    deviceId: principal.deviceId ?? null,
  });
  const version = bumped?.version;
  if (!version) {
    const draft = await insertConflict(id, principal.userId, base, document, body.heal, principal.deviceId ?? null);
    if (draft) await writeShots(id, draft, body.shots ?? []);
    const current = await pull(principal, id);
    await noteDeviceSync(principal);
    throw new HttpError("conflict", 409, {
      ...(draft ? { draft: { version: draft, parent: base } } : {}),
      current,
    });
  }
  await writeShots(id, version, body.shots ?? []);
  await noteDeviceSync(principal);
  return { version, created: false };
}

export async function pull(principal: Principal, id: string, version?: number) {
  const row = await readable(principal, id);
  const ver = version ?? row.head_version;
  const versions = await query<{
    version: number;
    document: unknown;
    heal: unknown;
    created_at: string;
    device_id: string | null;
    parent_version: number | null;
    device_name: string | null;
  }>(
    `SELECT v.version, v.document, v.heal, v.created_at, v.device_id, v.parent_version, d.name AS device_name
     FROM workflow_versions v
     LEFT JOIN devices d ON d.id = v.device_id
     WHERE v.workflow_id = $1 AND v.version = $2`,
    [id, ver],
  );
  const found = versions[0];
  if (!found) throw new HttpError("not found", 404);
  const shots = await shotUrls(id, ver);
  return {
    id,
    version: found.version,
    document: json(found.document),
    heal: json(found.heal),
    shots,
    category: row.category,
    site: row.site,
    author: row.author_name,
    verified: row.verified,
    visibility: row.visibility,
    lastGreenAt: row.last_green_at,
    link: `bao://workflow/${id}`,
    importLink: `bao://import/${id}`,
    domains: domainsOf(json(found.document)),
    passRate: await passRate(id),
    deviceId: found.device_id,
    deviceName: found.device_name,
    forkedFrom: row.forked_from,
    owned: row.owner_id === principal.userId,
    parentVersion: found.parent_version,
  };
}

export async function listVersions(principal: Principal, id: string) {
  await readable(principal, id);
  return query<{ version: number; created_at: string; heal: unknown; parent_version: number | null; device_id: string | null; kind: string; device_name: string | null }>(
    `SELECT v.version, v.created_at, v.heal, v.parent_version, v.device_id, COALESCE(v.kind, 'version') AS kind, d.name AS device_name
     FROM workflow_versions v
     LEFT JOIN devices d ON d.id = v.device_id
     WHERE v.workflow_id = $1
     ORDER BY v.version`,
    [id],
  );
}

export async function listLibrary(userId: string, q: string) {
  const rows = await ownedRows(userId);
  return rankLibrary(rows, q, "mine");
}

export async function pushRun(principal: Principal, workflowId: string, body: {
  id?: string;
  status?: string;
  at?: number;
  steps?: { id?: string; status?: string }[];
  shots?: ShotIn[];
}) {
  assertSyncSafe(body);
  await readable(principal, workflowId);
  const id = String(body.id || "");
  if (!id) throw new HttpError("run id", 400);
  const status = String(body.status || "");
  const steps = (body.steps ?? []).map((step) => ({ id: String(step.id || ""), status: String(step.status || "") }));
  const at = new Date(body.at || Date.now()).toISOString();
  await query(
    `INSERT INTO runs (id, workflow_id, device_id, status, at, steps)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [id, workflowId, principal.deviceId ?? null, status, at, JSON.stringify(steps)],
  );
  if (status === "passed" || status === "ok") {
    await query(
      `UPDATE workflows SET last_green_at = GREATEST(last_green_at, $2::timestamptz) WHERE id = $1`,
      [workflowId, at],
    );
  }
  for (const shot of body.shots ?? []) {
    if (shot.redacted !== true || !shot.stepId || !shot.png) continue;
    const bytes = Buffer.from(shot.png, "base64");
    if (!isElementCrop(bytes)) continue;
    const key = `runs/${id}/${shot.stepId}.png`;
    await putPng(key, bytes);
    await query(
      `INSERT INTO run_shots (run_id, step_id, blob_key) VALUES ($1, $2, $3)
       ON CONFLICT (run_id, step_id) DO NOTHING`,
      [id, shot.stepId, key],
    );
  }
  await noteDeviceSync(principal);
  return { id, status };
}

export async function listRuns(principal: Principal, workflowId: string) {
  await readable(principal, workflowId);
  const runs = await query<{ id: string; status: string; at: string; steps: unknown; device_id: string | null }>(
    `SELECT id, status, at, steps, device_id FROM runs WHERE workflow_id = $1 ORDER BY at DESC`,
    [workflowId],
  );
  const out = [];
  for (const run of runs) {
    const shots = await query<{ step_id: string; blob_key: string }>(
      `SELECT step_id, blob_key FROM run_shots WHERE run_id = $1`,
      [run.id],
    );
    const visible = [];
    for (const shot of shots) {
      const bytes = await getPng(shot.blob_key);
      if (!bytes || !isElementCrop(bytes)) continue;
      visible.push({ stepId: shot.step_id, url: `/api/blobs/${shot.blob_key}` });
    }
    out.push({
      id: run.id,
      status: run.status,
      at: run.at,
      steps: json(run.steps),
      deviceId: run.device_id,
      shots: visible,
    });
  }
  return out;
}

export async function createShare(principal: Principal, workflowId: string, permission: string) {
  if (permission !== "view" && permission !== "fork") throw new HttpError("permission", 400);
  const head = await pull(principal, workflowId);
  const released = prepareImport(head.document);
  const token = randomBytes(18).toString("hex");
  await query(
    `INSERT INTO shares (token, workflow_id, permission, document) VALUES ($1, $2, $3, $4::jsonb)`,
    [token, workflowId, permission, JSON.stringify(released.document)],
  );
  return { token, permission, changes: released.changes, domains: domainsOf(released.document) };
}

export async function getShare(token: string) {
  const rows = await query<{ workflow_id: string; permission: string; document: unknown }>(
    `SELECT workflow_id, permission, document FROM shares WHERE token = $1`,
    [token],
  );
  const row = rows[0];
  if (!row) throw new HttpError("not found", 404);
  const document = json(row.document);
  return {
    token,
    workflowId: row.workflow_id,
    permission: row.permission,
    document,
    questions: questions(document),
    domains: domainsOf(document),
    link: `bao://workflow/${row.workflow_id}`,
    importLink: `bao://import/${row.workflow_id}`,
  };
}

export async function rememberGrant(userId: string, token: string) {
  const share = await getShare(token);
  await query(
    `INSERT INTO grants (workflow_id, user_id, permission) VALUES ($1, $2, $3)
     ON CONFLICT (workflow_id, user_id) DO UPDATE SET permission = EXCLUDED.permission`,
    [share.workflowId, userId, share.permission],
  );
  return share;
}

export async function boot(): Promise<void> {
  assertProductionAuth();
  const { ready } = await import("./db");
  await ready();
  await ensureSeed();
}

export async function installShare(principal: Principal, token: string, answers: Record<string, unknown>) {
  assertSyncSafe({ answers });
  const share = await getShare(token);
  rejectSecretAnswers(share.document, answers);
  if (share.permission !== "fork") throw new HttpError("this link is view only", 403);
  const user = await mustUser(principal.userId);
  const installed = answered(share.document, answers);
  const id = `wf-${randomUUID()}`;
  const doc = { ...(installed as Record<string, unknown>), id, name: `Fork of ${(installed as { name?: string }).name || "workflow"}` };
  const errors = workflowErrors(doc);
  if (errors.length) throw new HttpError(errors.join("; "), 400);
  await insertOwned(principal.userId, doc, 0, null, [], user.name, categoryFor(doc), undefined, principal.deviceId ?? null);
  return { id };
}

export async function previewPublication(principal: Principal, id: string) {
  const head = await pull(principal, id);
  const released = prepareImport(head.document);
  const documentHash = releaseHash(released.document);
  const gate = await gateRow(id);
  const reviewed = await query(
    `SELECT at FROM reviews WHERE workflow_id = $1 AND document_hash = $2`,
    [id, documentHash],
  );
  return {
    id,
    version: head.version,
    changes: released.changes,
    document: released.document,
    documentHash,
    domains: domainsOf(released.document),
    author: head.author,
    verified: head.verified,
    lastGreenAt: head.lastGreenAt,
    reviewed: reviewed.length > 0,
    link: head.link,
    importLink: `bao://import/${id}`,
    gateStep: gate.gate_step,
    gateReason: gate.gate_reason,
    ciVerified: Boolean(gate.ci_verified),
  };
}

export async function recordReview(
  principal: Principal,
  id: string,
  documentHash: string,
  shots: ShotIn[] = [],
  samples: Record<string, unknown> = {},
) {
  const preview = await previewPublication(principal, id);
  if (preview.documentHash !== documentHash) throw new HttpError("replay the public preview, then review that hash", 409);
  const real = shots.filter((shot) => shot.redacted === true && shot.stepId && shot.png && isElementCrop(Buffer.from(shot.png, "base64")));
  if (real.length) await writeShots(id, preview.version, real);
  await query(
    `INSERT INTO reviews (workflow_id, document_hash, samples) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (workflow_id, document_hash) DO UPDATE SET at = now(), samples = EXCLUDED.samples`,
    [id, documentHash, JSON.stringify(publicSamples(samples))],
  );
  await query(`UPDATE workflows SET reviewed_hash = $2 WHERE id = $1`, [id, documentHash]);
  return { ok: true };
}

export async function confirmPublish(principal: Principal, id: string) {
  const preview = await previewPublication(principal, id);
  if (!preview.reviewed) throw new HttpError("replay this workflow before listing it", 409);
  const samples = await reviewSamples(id, preview.documentHash);
  const gate = await runPublishGate(preview.document, samples);
  if (!gate.ok) {
    await query(
      `UPDATE workflows SET gate_step = $2, gate_reason = $3, ci_verified = false WHERE id = $1`,
      [id, gate.stepLabel || gate.stepId || "step", gate.reason || "replay failed"],
    );
    throw new HttpError(`replay failed: ${gate.stepLabel || gate.stepId || "step"}`, 409, {
      stepId: gate.stepId || "",
      stepLabel: gate.stepLabel || "",
      reason: gate.reason || "replay failed",
    });
  }
  await query(
    `UPDATE workflows SET last_green_at = now(), ci_verified = true, gate_step = NULL, gate_reason = NULL, reviewed_hash = $2 WHERE id = $1`,
    [id, preview.documentHash],
  );
  const user = await mustUser(principal.userId);
  const name = String((preview.document as { name?: string }).name || id);
  const bumped = await query<{ version: number }>(
    `WITH upd AS (
       UPDATE workflows
       SET head_version = COALESCE((SELECT MAX(version) FROM workflow_versions WHERE workflow_id = $1), 0) + 1,
           name = $3,
           summary = $4,
           site = $5,
           visibility = 'public',
           published_version = COALESCE((SELECT MAX(version) FROM workflow_versions WHERE workflow_id = $1), 0) + 1,
           author_name = $6,
           updated_at = now()
       WHERE id = $1 AND owner_id = $2 AND head_version = $7
       RETURNING head_version
     )
     INSERT INTO workflow_versions (workflow_id, version, document, device_id, parent_version, kind)
     SELECT $1, upd.head_version, $8::jsonb, $9, $7, 'version' FROM upd
     RETURNING version`,
    [
      id,
      principal.userId,
      name,
      summaryOf(preview.document),
      domainsOf(preview.document)[0] || "",
      user.name,
      preview.version,
      JSON.stringify(preview.document),
      principal.deviceId ?? null,
    ],
  );
  if (!bumped[0]) throw new HttpError("conflict", 409);
  await copyRealShots(id, preview.version, bumped[0].version);
  return { version: bumped[0].version, visibility: "public" };
}

export async function marketplace(q: string, site: string, category: string) {
  const rows = await query<WorkflowRow>(
    `SELECT w.*, u.verified
     FROM workflows w JOIN users u ON u.id = w.owner_id
     WHERE w.visibility = 'public' AND w.published_version IS NOT NULL`,
  );
  const hits = await Promise.all(rows.map((row) => toHit(row, "public")));
  return rankHits(hits, q, { site, category });
}

export async function publicWorkflow(id: string) {
  const rows = await query<WorkflowRow>(
    `SELECT w.*, u.verified FROM workflows w JOIN users u ON u.id = w.owner_id
     WHERE w.id = $1 AND w.visibility = 'public'`,
    [id],
  );
  const row = rows[0];
  if (!row || !row.published_version) throw new HttpError("not found", 404);
  const version = await query<{ document: unknown; version: number; created_at: string }>(
    `SELECT document, version, created_at FROM workflow_versions WHERE workflow_id = $1 AND version = $2`,
    [id, row.published_version],
  );
  const document = json(version[0]?.document);
  const versions = await query<{ version: number; created_at: string }>(
    `SELECT version, created_at FROM workflow_versions WHERE workflow_id = $1 AND COALESCE(kind, 'version') = 'version' ORDER BY version`,
    [id],
  );
  const reports = await query<{ count: number }>(`SELECT count(*)::int AS count FROM reports WHERE workflow_id = $1`, [id]);
  return {
    id,
    name: row.name,
    summary: row.summary,
    author: row.author_name,
    verified: row.verified,
    category: row.category,
    site: row.site,
    domains: domainsOf(document),
    lastGreenAt: row.last_green_at,
    passRate: await passRate(id),
    document,
    questions: questions(document),
    version: row.published_version,
    versions,
    shots: await shotUrls(id, row.published_version),
    reports: reports[0]?.count ?? 0,
    link: `bao://workflow/${id}`,
    importLink: `bao://import/${id}`,
    ciVerified: Boolean((await gateRow(id)).ci_verified),
  };
}

export async function forkPublic(principal: Principal, id: string, answers: Record<string, unknown>) {
  assertSyncSafe({ answers });
  const pub = await publicWorkflow(id);
  rejectSecretAnswers(pub.document, answers);
  const user = await mustUser(principal.userId);
  const installed = answered(pub.document, answers);
  const nextId = `wf-${randomUUID()}`;
  const doc = { ...(installed as Record<string, unknown>), id: nextId, name: `Fork of ${pub.name}` };
  const errors = workflowErrors(doc);
  if (errors.length) throw new HttpError(errors.join("; "), 400);
  await insertOwned(principal.userId, doc, 0, null, [], user.name, pub.category, id, principal.deviceId ?? null);
  return { id: nextId };
}

export async function reportWorkflow(principal: Principal, id: string, reason: string) {
  await publicWorkflow(id);
  if (!reason.trim()) throw new HttpError("reason", 400);
  await query(
    `INSERT INTO reports (id, workflow_id, reporter_id, reason) VALUES ($1, $2, $3, $4)`,
    [`rpt-${randomUUID()}`, id, principal.userId, reason.trim().slice(0, 500)],
  );
  return { ok: true };
}

export async function catalog(principal: Principal | null, q: string, filters: { source?: string; site?: string; category?: string }) {
  const hits: RankInput[] = [];
  if (principal && filters.source !== "public") {
    const mine = await ownedRows(principal.userId);
    hits.push(...await Promise.all(mine.map((row) => toHit(row, "mine"))));
    const team = await query<WorkflowRow>(
      `SELECT w.*, u.verified FROM grants g
       JOIN workflows w ON w.id = g.workflow_id
       JOIN users u ON u.id = w.owner_id
       WHERE g.user_id = $1 AND w.owner_id <> $1`,
      [principal.userId],
    );
    hits.push(...await Promise.all(team.map((row) => toHit(row, "team"))));
  }
  if (!filters.source || filters.source === "public") {
    const pubs = await query<WorkflowRow>(
      `SELECT w.*, u.verified FROM workflows w JOIN users u ON u.id = w.owner_id
       WHERE w.visibility = 'public'`,
    );
    for (const row of pubs) {
      if (hits.some((hit) => hit.id === row.id)) continue;
      hits.push(await toHit(row, "public"));
    }
  }
  return rankHits(hits, q, filters).slice(0, SEARCH_LIMIT);
}

export async function readBlob(principal: Principal | null, key: string, shareToken: string | null): Promise<Buffer> {
  const rows = await query<{ workflow_id: string }>(
    `SELECT workflow_id FROM workflow_shots WHERE blob_key = $1
     UNION SELECT r.workflow_id FROM run_shots s JOIN runs r ON r.id = s.run_id WHERE s.blob_key = $1`,
    [key],
  );
  const workflowId = rows[0]?.workflow_id;
  if (!workflowId) throw new HttpError("not found", 404);
  if (shareToken) {
    const share = await getShare(shareToken);
    if (share.workflowId === workflowId) {
      const bytes = await getPng(key);
      if (!bytes) throw new HttpError("not found", 404);
      return bytes;
    }
  }
  const pub = await query(`SELECT id FROM workflows WHERE id = $1 AND visibility = 'public'`, [workflowId]);
  if (!pub.length) {
    if (!principal) throw new HttpError("not found", 404);
    await readable(principal, workflowId);
  }
  const bytes = await getPng(key);
  if (!bytes) throw new HttpError("not found", 404);
  return bytes;
}

export function workflowErrors(document: unknown): string[] {
  const normalized = JSON.parse(JSON.stringify(document ?? null));
  if (validateWorkflow(normalized)) return [];
  return (validateWorkflow.errors ?? []).map((err) => `${err.instancePath} ${err.message}`.trim());
}

export function questions(document: unknown) {
  return importQuestions(document);
}

export async function setImportMarks(principal: Principal, id: string, names: string[]) {
  const head = await pull(principal, id);
  const doc = structuredClone(head.document) as { id?: string; inputs?: { name: string; askOnImport?: boolean }[] };
  const want = new Set(names);
  for (const input of doc.inputs ?? []) input.askOnImport = want.has(input.name);
  return pushVersion(principal, id, { baseVersion: head.version, document: doc });
}

async function acceptVersion(
  id: string,
  userId: string,
  input: {
    name: string;
    summary: string;
    site: string;
    category: string;
    base: number;
    document: unknown;
    heal?: unknown;
    deviceId: string | null;
  },
): Promise<{ version: number } | undefined> {
  const bumped = await query<{ version: number }>(
    `WITH upd AS (
       UPDATE workflows
       SET head_version = COALESCE((SELECT MAX(version) FROM workflow_versions WHERE workflow_id = $1), 0) + 1,
           name = $3, summary = $4, site = $5, category = $6, updated_at = now()
       WHERE id = $1 AND owner_id = $2 AND head_version = $7
       RETURNING head_version
     )
     INSERT INTO workflow_versions (workflow_id, version, document, heal, device_id, parent_version, kind)
     SELECT $1, upd.head_version, $8::jsonb, $9::jsonb, $10, NULLIF($7, 0), 'version' FROM upd
     RETURNING version`,
    [
      id,
      userId,
      input.name,
      input.summary,
      input.site,
      input.category,
      input.base,
      JSON.stringify(input.document),
      input.heal ? JSON.stringify(input.heal) : null,
      input.deviceId,
    ],
  );
  return bumped[0];
}

async function insertConflict(
  id: string,
  userId: string,
  parent: number,
  document: unknown,
  heal: unknown,
  deviceId: string | null,
): Promise<number | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const rows = await query<{ version: number }>(
      `INSERT INTO workflow_versions (workflow_id, version, document, heal, device_id, parent_version, kind)
       SELECT $1, COALESCE((SELECT MAX(version) FROM workflow_versions WHERE workflow_id = $1), 0) + 1,
              $2::jsonb, $3::jsonb, $4, $5, 'conflict'
       WHERE EXISTS (
         SELECT 1 FROM workflows WHERE id = $1 AND owner_id = $6 AND head_version IS DISTINCT FROM $5
       )
       ON CONFLICT (workflow_id, version) DO NOTHING
       RETURNING version`,
      [id, JSON.stringify(document), heal ? JSON.stringify(heal) : null, deviceId, parent, userId],
    );
    if (rows[0]) return rows[0].version;
  }
  return undefined;
}

export async function resolveConflict(
  principal: Principal,
  id: string,
  action: "keep-mine" | "keep-theirs" | "keep-both",
) {
  assertId(id);
  const owned = await query<{ owner_id: string; head_version: number; category: string }>(
    `SELECT owner_id, head_version, category FROM workflows WHERE id = $1`,
    [id],
  );
  if (owned[0]?.owner_id !== principal.userId) throw new HttpError("not found", 404);
  const drafts = await query<{ version: number; document: unknown; device_id: string | null }>(
    `SELECT version, document, device_id FROM workflow_versions
     WHERE workflow_id = $1 AND kind = 'conflict' ORDER BY version DESC`,
    [id],
  );
  const draft = drafts[0];
  if (!draft) throw new HttpError("no conflict", 404);
  if (action === "keep-theirs") {
    await query(`DELETE FROM workflow_versions WHERE workflow_id = $1 AND version = $2 AND kind = 'conflict'`, [id, draft.version]);
    const current = await pull(principal, id);
    return { action, version: current.version, document: current.document };
  }
  const document = json(draft.document) as { id?: string; name?: string };
  if (action === "keep-both") {
    const copyId = await freshCopyId(id);
    const copy = { ...(document as Record<string, unknown>), id: copyId, name: `Copy of ${document.name || id}` };
    const user = await mustUser(principal.userId);
    const created = await insertOwned(principal.userId, copy, 0, null, [], user.name, categoryFor(copy), undefined, draft.device_id);
    await query(`DELETE FROM workflow_versions WHERE workflow_id = $1 AND version = $2 AND kind = 'conflict'`, [id, draft.version]);
    const current = await pull(principal, id);
    return { action, version: current.version, document: current.document, copyId, copyVersion: created, copy };
  }
  const errors = workflowErrors(document);
  if (errors.length) throw new HttpError(errors.join("; "), 400);
  const head = owned[0]?.head_version ?? 0;
  const accepted = await acceptVersion(id, principal.userId, {
    name: document.name || id,
    summary: summaryOf(document),
    site: domainsOf(document)[0] || "",
    category: categoryFor(document, owned[0]?.category),
    base: head,
    document: { ...document, id },
    deviceId: draft.device_id,
  });
  if (!accepted) throw new HttpError("conflict", 409);
  await query(`DELETE FROM workflow_versions WHERE workflow_id = $1 AND version = $2 AND kind = 'conflict'`, [id, draft.version]);
  await noteDeviceSync(principal);
  return { action, version: accepted.version, document: { ...document, id } };
}

async function freshCopyId(id: string): Promise<string> {
  const base = `${id}-copy`.slice(0, 64);
  for (let n = 0; n < 20; n += 1) {
    const candidate = n === 0 ? base : `${base}-${n + 1}`;
    assertId(candidate);
    const rows = await query(`SELECT id FROM workflows WHERE id = $1`, [candidate]);
    if (!rows.length) return candidate;
  }
  throw new HttpError("copy", 409);
}

async function insertOwned(
  userId: string,
  document: unknown,
  base: number,
  heal: unknown,
  shots: ShotIn[],
  author: string,
  category: string,
  forkedFrom?: string,
  deviceId?: string | null,
) {
  const doc = document as { id: string; name?: string };
  const site = domainsOf(document)[0] || "";
  await query(
    `INSERT INTO workflows (id, owner_id, name, summary, site, category, author_name, head_version, forked_from)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8)`,
    [doc.id, userId, doc.name || doc.id, summaryOf(document), site, category, author, forkedFrom ?? null],
  );
  const bumped = await query<{ version: number }>(
    `WITH upd AS (
       UPDATE workflows SET head_version = 1, updated_at = now()
       WHERE id = $1 AND owner_id = $2 AND head_version = $3
       RETURNING head_version
     )
     INSERT INTO workflow_versions (workflow_id, version, document, heal, device_id, parent_version, kind)
     SELECT $1, upd.head_version, $4::jsonb, $5::jsonb, $6, NULL, 'version' FROM upd
     RETURNING version`,
    [doc.id, userId, base, JSON.stringify(document), heal ? JSON.stringify(heal) : null, deviceId ?? null],
  );
  if (!bumped[0]) throw new HttpError("conflict", 409);
  await writeShots(doc.id, bumped[0].version, shots);
  return bumped[0].version;
}

async function writeShots(workflowId: string, version: number, shots: ShotIn[]) {
  for (const shot of shots) {
    if (shot.redacted !== true || !shot.stepId || !shot.png) throw new HttpError("unredacted screenshot", 400);
    const bytes = Buffer.from(shot.png, "base64");
    if (!isElementCrop(bytes)) continue;
    const key = `shots/${workflowId}/v${version}/${shot.stepId}.png`;
    await putPng(key, bytes);
    await query(
      `INSERT INTO workflow_shots (workflow_id, version, step_id, blob_key) VALUES ($1, $2, $3, $4)
       ON CONFLICT (workflow_id, version, step_id) DO UPDATE SET blob_key = EXCLUDED.blob_key`,
      [workflowId, version, shot.stepId, key],
    );
  }
}

async function shotUrls(workflowId: string, version: number) {
  const visible = [];
  for (const shot of await listShotRows(workflowId, version)) {
    const bytes = await getPng(shot.blob_key);
    if (!bytes || !isElementCrop(bytes)) continue;
    visible.push({ stepId: shot.step_id, url: `/api/blobs/${shot.blob_key}` });
  }
  return visible;
}

async function listShotRows(workflowId: string, version: number) {
  return query<{ step_id: string; blob_key: string }>(
    `SELECT step_id, blob_key FROM workflow_shots WHERE workflow_id = $1 AND version = $2 ORDER BY step_id`,
    [workflowId, version],
  );
}

async function copyRealShots(workflowId: string, fromVersion: number, toVersion: number) {
  for (const row of await listShotRows(workflowId, fromVersion)) {
    const bytes = await getPng(row.blob_key);
    if (!bytes || !isElementCrop(bytes)) continue;
    await writeShots(workflowId, toVersion, [{ stepId: row.step_id, png: bytes.toString("base64"), redacted: true }]);
  }
}

async function pickThumbnail(document: unknown, workflowId: string, version: number): Promise<string> {
  const rows = await listShotRows(workflowId, version);
  const byId = new Map(rows.map((row) => [row.step_id, row.blob_key]));
  const doc = document && typeof document === "object" ? document as {
    inputs?: { name?: string; type?: string }[];
    steps?: { id?: string; sensitive?: boolean; input?: string }[];
  } : {};
  const secrets = new Set((doc.inputs ?? []).filter((input) => input.type === "secret" && input.name).map((input) => String(input.name)));
  const steps = (doc.steps && doc.steps.length ? doc.steps : [...byId.keys()].map((id) => ({ id }))) as { id?: string; sensitive?: boolean; input?: string }[];
  for (const step of steps) {
    if (step.sensitive) continue;
    if (step.input && secrets.has(step.input)) continue;
    const key = byId.get(String(step.id ?? ""));
    if (!key) continue;
    const bytes = await getPng(key);
    if (!bytes || !isElementCrop(bytes)) continue;
    return `/api/blobs/${key}`;
  }
  return "";
}

interface WorkflowRow extends RankInput {
  owner_id: string;
  author_name: string;
  verified: boolean;
  visibility: string;
  head_version: number;
  published_version: number | null;
  last_green_at: string | null;
  forked_from: string | null;
  ci_verified: boolean | null;
  summary: string;
  name: string;
  site: string;
  category: string;
}

async function ownedRows(userId: string) {
  return query<WorkflowRow>(
    `SELECT w.*, u.verified FROM workflows w JOIN users u ON u.id = w.owner_id WHERE w.owner_id = $1`,
    [userId],
  );
}

async function toHit(row: WorkflowRow, source: RankInput["source"]): Promise<RankInput & {
  inputs: unknown;
  passRate: { passed: number; total: number };
  author: string;
  verified: boolean;
  lastGreenAt: string | null;
  deviceName: string | null;
  forkedFrom: string | null;
  ciVerified: boolean;
  link: string;
  importLink: string;
  domains: string[];
  thumbnail: string;
}> {
  const ver = source === "public" && row.published_version ? row.published_version : row.head_version;
  const versions = await query<{ document: unknown; device_name: string | null }>(
    `SELECT v.document, d.name AS device_name
     FROM workflow_versions v
     LEFT JOIN devices d ON d.id = v.device_id
     WHERE v.workflow_id = $1 AND v.version = $2`,
    [row.id, ver],
  );
  const parsed = json(versions[0]?.document);
  const document = parsed && typeof parsed === "object" ? parsed as { inputs?: unknown; steps?: { label?: string }[] } : { steps: [] };
  const steps = (document.steps ?? []).map((step) => step.label || "");
  return {
    id: row.id,
    title: row.name,
    summary: row.summary || steps.join(", "),
    site: row.site,
    category: row.category,
    steps,
    source,
    inputs: questions(document),
    passRate: await passRate(row.id),
    author: row.author_name,
    verified: row.verified,
    lastGreenAt: row.last_green_at,
    deviceName: versions[0]?.device_name ?? null,
    forkedFrom: row.forked_from,
    ciVerified: Boolean(row.ci_verified),
    link: `bao://workflow/${row.id}`,
    importLink: `bao://import/${row.id}`,
    domains: domainsOf(document),
    thumbnail: await pickThumbnail(parsed, row.id, ver),
  };
}

function rankLibrary(rows: WorkflowRow[], q: string, source: RankInput["source"]) {
  return Promise.all(rows.map((row) => toHit(row, source))).then((hits) => rankHits(hits, q));
}

async function passRate(workflowId: string) {
  const rows = await query<{ passed: number; total: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status IN ('passed', 'ok'))::int AS passed
     FROM runs WHERE workflow_id = $1`,
    [workflowId],
  );
  return { passed: rows[0]?.passed ?? 0, total: rows[0]?.total ?? 0 };
}

async function readable(principal: Principal, id: string) {
  const rows = await query<WorkflowRow>(
    `SELECT w.*, u.verified FROM workflows w JOIN users u ON u.id = w.owner_id WHERE w.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new HttpError("not found", 404);
  if (row.owner_id === principal.userId || row.visibility === "public") return row;
  const grants = await query(
    `SELECT workflow_id FROM grants WHERE workflow_id = $1 AND user_id = $2`,
    [id, principal.userId],
  );
  if (!grants.length) throw new HttpError("not found", 404);
  return row;
}

function rejectSecretAnswers(document: unknown, answers: Record<string, unknown>) {
  const secret = new Set(questions(document).filter((item) => item.type === "secret").map((item) => item.name));
  for (const [name, value] of Object.entries(answers)) {
    if (secret.has(name) && value) throw new HttpError("secret param", 400);
  }
}

function answered(document: unknown, answers: Record<string, unknown>) {
  try {
    return applyImportAnswers(document, answers);
  } catch (err) {
    throw new HttpError(err instanceof Error ? err.message : "answer the import questions", 400);
  }
}

async function gateRow(id: string) {
  const rows = await query<{ gate_step: string | null; gate_reason: string | null; ci_verified: boolean | null }>(
    `SELECT gate_step, gate_reason, ci_verified FROM workflows WHERE id = $1`,
    [id],
  );
  return rows[0] || { gate_step: null, gate_reason: null, ci_verified: false };
}

async function reviewSamples(id: string, documentHash: string): Promise<Record<string, string>> {
  const rows = await query<{ samples: unknown }>(
    `SELECT samples FROM reviews WHERE workflow_id = $1 AND document_hash = $2`,
    [id, documentHash],
  );
  const value = json(rows[0]?.samples);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string" && item) out[key] = item;
  }
  return out;
}

async function upsertUser(email: string, name: string, verified: boolean): Promise<User> {
  const rows = await query<User>(
    `INSERT INTO users (id, email, name, verified) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, verified = users.verified OR EXCLUDED.verified
     RETURNING id, email, name, verified`,
    [`usr-${randomUUID()}`, email, name, verified],
  );
  const user = rows[0];
  if (!user) throw new HttpError("user", 500);
  return user;
}

async function mustUser(id: string): Promise<User> {
  const rows = await query<User>(`SELECT id, email, name, verified FROM users WHERE id = $1`, [id]);
  const user = rows[0];
  if (!user) throw new HttpError("user", 401);
  return user;
}

async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await query(`INSERT INTO sessions (token, user_id) VALUES ($1, $2)`, [token, userId]);
  return token;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pairCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

function assertId(id: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new HttpError("bad id", 400);
}

function json(value: unknown): unknown {
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

export type { SyncShot };
