import { createHash, randomBytes, randomUUID } from "node:crypto";
import Ajv from "ajv/dist/2020";
import { getPng, putPng } from "./blobstore";
import { redactedPng } from "./png";
import { query } from "./db";
import { assertSyncSafe, type SyncShot } from "./guard";
import { categoryFor, domainsOf, redactForRelease, releaseHash, summaryOf } from "./publish";
import { rankHits, SEARCH_LIMIT, type RankInput } from "./rank";
import schema from "./workflow-v2.schema.json";
import { SEED_WORKFLOWS } from "./seeds";

const ajv = new Ajv({ allErrors: true, strict: false });
const validateWorkflow = ajv.compile(schema);

export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "HttpError";
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
    const steps = (seed.document.steps as { id: string }[]) || [];
    const shots = steps.map((step, index) => ({
      stepId: step.id,
      png: redactedPng(index + 1).toString("base64"),
      redacted: true as const,
    }));
    await insertOwned(user.id, seed.document, 0, null, shots, user.name, seed.category);
  }
  seeded = true;
}

export async function requestMagicLink(email: string): Promise<{ verifyUrl?: string }> {
  const clean = email.trim().toLowerCase();
  if (!clean.includes("@")) throw new HttpError("email", 400);
  const token = randomBytes(24).toString("hex");
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  await query(`INSERT INTO magic_links (token, email, expires_at) VALUES ($1, $2, $3)`, [token, clean, expires]);
  const path = `/api/auth/verify?token=${token}`;
  if (process.env.BAO_AUTH_STUB === "1" || process.env.NODE_ENV !== "production") return { verifyUrl: path };
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
  const user = await upsertUser(email, email.split("@")[0] || email, false);
  return { session: await createSession(user.id), user };
}

export async function githubStub(): Promise<{ session: string; user: User }> {
  if (process.env.BAO_AUTH_STUB !== "1" && process.env.NODE_ENV === "production") {
    throw new HttpError("GitHub sign-in is a stub. Set BAO_AUTH_STUB=1 on the project.", 501);
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

export async function claimPairCode(code: string, name: string): Promise<{ deviceToken: string; deviceId: string; name: string }> {
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
    `INSERT INTO devices (id, user_id, name, token_hash) VALUES ($1, $2, $3, $4)`,
    [deviceId, userId, deviceName, hash(deviceToken)],
  );
  return { deviceToken, deviceId, name: deviceName };
}

export async function listDevices(userId: string) {
  return query<{ id: string; name: string; created_at: string }>(
    `SELECT id, name, created_at FROM devices WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
}

export async function categoryCounts(userId: string) {
  return query<{ category: string; count: number }>(
    `SELECT category, count(*)::int AS count FROM workflows WHERE owner_id = $1 GROUP BY category ORDER BY category`,
    [userId],
  );
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
    await insertOwned(principal.userId, document, base, body.heal, body.shots ?? [], user.name, category);
    return { version: 1, created: true };
  }
  if (existing[0]?.owner_id !== principal.userId) throw new HttpError("not found", 404);
  const bumped = await query<{ version: number }>(
    `WITH upd AS (
       UPDATE workflows
       SET head_version = head_version + 1, name = $3, summary = $4, site = $5, category = $6, updated_at = now()
       WHERE id = $1 AND owner_id = $2 AND head_version = $7
       RETURNING head_version
     )
     INSERT INTO workflow_versions (workflow_id, version, document, heal, device_id)
     SELECT $1, upd.head_version, $8::jsonb, $9::jsonb, $10 FROM upd
     RETURNING version`,
    [id, principal.userId, doc.name, summary, site, category, base, JSON.stringify(document), body.heal ? JSON.stringify(body.heal) : null, principal.deviceId ?? null],
  );
  const version = bumped[0]?.version;
  if (!version) {
    const current = await pull(principal, id);
    throw Object.assign(new HttpError("conflict", 409), { current });
  }
  await writeShots(id, version, body.shots ?? []);
  return { version, created: false };
}

export async function pull(principal: Principal, id: string, version?: number) {
  const row = await readable(principal, id);
  const ver = version ?? row.head_version;
  const versions = await query<{ version: number; document: unknown; heal: unknown; created_at: string }>(
    `SELECT version, document, heal, created_at FROM workflow_versions WHERE workflow_id = $1 AND version = $2`,
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
    domains: domainsOf(json(found.document)),
    passRate: await passRate(id),
  };
}

export async function listVersions(principal: Principal, id: string) {
  await readable(principal, id);
  return query<{ version: number; created_at: string; heal: unknown }>(
    `SELECT version, created_at, heal FROM workflow_versions WHERE workflow_id = $1 ORDER BY version`,
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
  await query(
    `INSERT INTO runs (id, workflow_id, device_id, status, at, steps)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [id, workflowId, principal.deviceId ?? null, status, new Date(body.at || Date.now()).toISOString(), JSON.stringify(steps)],
  );
  if (status === "passed" || status === "ok") {
    await query(`UPDATE workflows SET last_green_at = now() WHERE id = $1`, [workflowId]);
  }
  for (const shot of body.shots ?? []) {
    if (shot.redacted !== true || !shot.stepId || !shot.png) continue;
    const key = `runs/${id}/${shot.stepId}.png`;
    await putPng(key, Buffer.from(shot.png, "base64"));
    await query(
      `INSERT INTO run_shots (run_id, step_id, blob_key) VALUES ($1, $2, $3)
       ON CONFLICT (run_id, step_id) DO NOTHING`,
      [id, shot.stepId, key],
    );
  }
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
    out.push({
      id: run.id,
      status: run.status,
      at: run.at,
      steps: json(run.steps),
      deviceId: run.device_id,
      shots: shots.map((shot) => ({ stepId: shot.step_id, url: `/api/blobs/${shot.blob_key}` })),
    });
  }
  return out;
}

export async function createShare(principal: Principal, workflowId: string, permission: string) {
  if (permission !== "view" && permission !== "fork") throw new HttpError("permission", 400);
  const head = await pull(principal, workflowId);
  const released = redactForRelease(head.document);
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
  const installed = applyAnswers(share.document, answers);
  const id = `wf-${randomUUID()}`;
  const doc = { ...(installed as Record<string, unknown>), id, name: `Fork of ${(installed as { name?: string }).name || "workflow"}` };
  const errors = workflowErrors(doc);
  if (errors.length) throw new HttpError(errors.join("; "), 400);
  await insertOwned(principal.userId, doc, 0, null, [], user.name, categoryFor(doc));
  return { id };
}

export async function previewPublication(principal: Principal, id: string) {
  const head = await pull(principal, id);
  const released = redactForRelease(head.document);
  const documentHash = releaseHash(released.document);
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
  };
}

export async function recordReview(principal: Principal, id: string, documentHash: string) {
  const preview = await previewPublication(principal, id);
  if (preview.documentHash !== documentHash) throw new HttpError("replay the public preview, then review that hash", 409);
  await query(
    `INSERT INTO reviews (workflow_id, document_hash) VALUES ($1, $2)
     ON CONFLICT (workflow_id, document_hash) DO UPDATE SET at = now()`,
    [id, documentHash],
  );
  await query(
    `UPDATE workflows SET reviewed_hash = $2, last_green_at = now() WHERE id = $1`,
    [id, documentHash],
  );
  return { ok: true, lastGreenAt: new Date().toISOString() };
}

export async function confirmPublish(principal: Principal, id: string) {
  const preview = await previewPublication(principal, id);
  if (!preview.reviewed) throw new HttpError("replay this workflow before listing it", 409);
  const user = await mustUser(principal.userId);
  const name = String((preview.document as { name?: string }).name || id);
  const bumped = await query<{ version: number }>(
    `WITH upd AS (
       UPDATE workflows
       SET head_version = head_version + 1,
           name = $3,
           summary = $4,
           site = $5,
           visibility = 'public',
           published_version = head_version + 1,
           author_name = $6,
           updated_at = now()
       WHERE id = $1 AND owner_id = $2 AND head_version = $7
       RETURNING head_version
     )
     INSERT INTO workflow_versions (workflow_id, version, document, device_id)
     SELECT $1, upd.head_version, $8::jsonb, $9 FROM upd
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
  const steps = ((preview.document as { steps?: { id?: string }[] }).steps ?? []);
  await writeShots(id, bumped[0].version, steps.map((step, index) => ({
    stepId: String(step.id ?? index),
    png: redactedPng(index + 1).toString("base64"),
    redacted: true,
  })));
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
    `SELECT version, created_at FROM workflow_versions WHERE workflow_id = $1 ORDER BY version`,
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
  };
}

export async function forkPublic(principal: Principal, id: string, answers: Record<string, unknown>) {
  assertSyncSafe({ answers });
  const pub = await publicWorkflow(id);
  rejectSecretAnswers(pub.document, answers);
  const user = await mustUser(principal.userId);
  const installed = applyAnswers(pub.document, answers);
  const nextId = `wf-${randomUUID()}`;
  const doc = { ...(installed as Record<string, unknown>), id: nextId, name: `Fork of ${pub.name}` };
  const errors = workflowErrors(doc);
  if (errors.length) throw new HttpError(errors.join("; "), 400);
  await insertOwned(principal.userId, doc, 0, null, [], user.name, pub.category, id);
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
  const inputs = (document as { inputs?: { name: string; type: string; label?: string; required?: boolean; choices?: string[] }[] }).inputs ?? [];
  return inputs.map((input) => ({
    name: input.name,
    type: input.type,
    label: input.label || input.name,
    required: input.required !== false,
    choices: input.choices,
    prompt: input.type === "secret" ? "You enter this on your device. It is not saved here." : `What should ${input.label || input.name} be?`,
  }));
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
     INSERT INTO workflow_versions (workflow_id, version, document, heal)
     SELECT $1, upd.head_version, $4::jsonb, $5::jsonb FROM upd
     RETURNING version`,
    [doc.id, userId, base, JSON.stringify(document), heal ? JSON.stringify(heal) : null],
  );
  if (!bumped[0]) throw new HttpError("conflict", 409);
  await writeShots(doc.id, bumped[0].version, shots);
}

async function writeShots(workflowId: string, version: number, shots: ShotIn[]) {
  for (const shot of shots) {
    if (shot.redacted !== true || !shot.stepId || !shot.png) throw new HttpError("unredacted screenshot", 400);
    const key = `shots/${workflowId}/v${version}/${shot.stepId}.png`;
    await putPng(key, Buffer.from(shot.png, "base64"));
    await query(
      `INSERT INTO workflow_shots (workflow_id, version, step_id, blob_key) VALUES ($1, $2, $3, $4)
       ON CONFLICT (workflow_id, version, step_id) DO UPDATE SET blob_key = EXCLUDED.blob_key`,
      [workflowId, version, shot.stepId, key],
    );
  }
}

async function shotUrls(workflowId: string, version: number) {
  const shots = await query<{ step_id: string; blob_key: string }>(
    `SELECT step_id, blob_key FROM workflow_shots WHERE workflow_id = $1 AND version = $2`,
    [workflowId, version],
  );
  return shots.map((shot) => ({ stepId: shot.step_id, url: `/api/blobs/${shot.blob_key}` }));
}

interface WorkflowRow extends RankInput {
  owner_id: string;
  author_name: string;
  verified: boolean;
  visibility: string;
  head_version: number;
  published_version: number | null;
  last_green_at: string | null;
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
  link: string;
  domains: string[];
}> {
  const ver = source === "public" && row.published_version ? row.published_version : row.head_version;
  const versions = await query<{ document: unknown }>(
    `SELECT document FROM workflow_versions WHERE workflow_id = $1 AND version = $2`,
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
    link: `bao://workflow/${row.id}`,
    domains: domainsOf(document),
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

function applyAnswers(document: unknown, answers: Record<string, unknown>) {
  const doc = structuredClone(document) as { inputs?: { name: string; type: string; default?: string }[] };
  for (const input of doc.inputs ?? []) {
    if (input.type === "secret" || input.type === "file") {
      delete input.default;
      continue;
    }
    const answer = answers[input.name];
    if (typeof answer === "string" && answer && !looksPersonal(answer)) input.default = answer;
    else delete input.default;
  }
  return doc;
}

function looksPersonal(value: string): boolean {
  return /@/.test(value) || /\d{3}-\d{2}-\d{4}/.test(value) || /(?:\d[ -]?){13,19}/.test(value);
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
