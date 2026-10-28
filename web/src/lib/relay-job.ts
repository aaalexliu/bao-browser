// Job is the row. Settle is the only write from queued or running into done.
// A screenshot, resume, or resume_token cannot be stored on that row.

import { redactAudit } from "./audit-redact";
import { REMOTE_POLICY, type RemotePolicy } from "./remote-policy";
import { isToolName, JOB_ID, type ToolName } from "./relay-tools";

const OUTCOMES = ["ok", "denied", "failed", "cancelled", "needs_human", "forbidden", "device_offline"] as const;

export type Outcome = (typeof OUTCOMES)[number];

export function isOutcome(value: unknown): value is Outcome {
  return typeof value === "string" && (OUTCOMES as readonly string[]).includes(value);
}

export type UserId = string & { readonly __brand: "UserId" };
export type DeviceId = string & { readonly __brand: "DeviceId" };
export type JobId = string & { readonly __brand: "JobId" };

declare const redacted: unique symbol;
export type Redacted = Record<string, unknown> & { readonly [redacted]: typeof redacted };

export type Png = string & { readonly __brand: "Png" };

export type DeviceScope = {
  readonly __brand: "DeviceScope";
  userId: UserId;
  deviceId: DeviceId;
};

/** What agent_jobs.result holds. screenshot and resume cannot be set. */
export type DurableResult = {
  outcome: Outcome;
  reason?: string;
  screenshot?: never;
  resume?: never;
  resume_token?: never;
} & Record<string, unknown>;

export type RelayEvent = {
  at: string;
  type: string;
  phase?: string;
  outcome?: string;
};

type JobBase = {
  id: JobId;
  scope: DeviceScope;
  tokenId: string;
  tool: ToolName;
  workflowId: string | null;
  policy: RemotePolicy;
  args: Redacted;
  events: RelayEvent[];
  createdAt: string;
};

export type QueuedJob = JobBase & {
  status: "queued";
  outcome: null;
  result: null;
  claimedAt: null;
  finishedAt: null;
};

export type RunningJob = JobBase & {
  status: "running";
  outcome: null;
  result: null;
  claimedAt: string;
  finishedAt: null;
};

export type DoneJob = JobBase & {
  status: "done";
  outcome: Outcome;
  result: DurableResult;
  claimedAt: string | null;
  finishedAt: string;
};

export type Job = QueuedJob | RunningJob | DoneJob;

export type Settle =
  | { kind: "wrote"; job: DoneJob }
  | { kind: "lost"; job: DoneJob }
  | { kind: "missing" };

export function deviceScope(userId: string, deviceId: string): DeviceScope {
  return { userId: userId as UserId, deviceId: deviceId as DeviceId } as DeviceScope;
}

export function asJobId(value: string): JobId | null {
  if (!JOB_ID.test(value)) return null;
  return value as JobId;
}

export interface JobStore {
  insert(job: QueuedJob | DoneJob): Promise<void>;
  get(id: JobId): Promise<Job | null>;
  oldestQueued(scope: DeviceScope): Promise<QueuedJob | null>;
  oldestRunning(scope: DeviceScope): Promise<RunningJob | null>;
  claim(scope: DeviceScope, id: JobId): Promise<RunningJob | null>;
  appendEvent(scope: DeviceScope, id: JobId, event: RelayEvent): Promise<Job | null>;
  settle(scope: DeviceScope, id: JobId, outcome: Outcome, result: DurableResult): Promise<Settle>;
  wait(id: JobId, timeoutMs: number): Promise<Job | null>;
  subscribe(id: JobId, fn: (job: Job) => void): () => void;
}

const CDP_METHOD = /^(Network|Runtime|Target|Storage|Page|Fetch|DOM|Input|Browser|Security|Emulation|Debugger|HeapProfiler|Profiler|CSS|Overlay|Performance|Log|Console|WebAuthn|Cast|Bluetooth|SystemInfo)\./;
const CONTROL_KEY = /^(permissionMode|permission_mode|autoApprove|skipPermissions|skip_all_permission_checks|remoteMayApproveConfirm|policy|deviceId)$/i;
const SECRET_KEY = /^(cookie|cookies|set-cookie|setcookie|authorization|proxy-authorization|password|secret|passwd)$/i;
const RESUME_KEY = /^(resume|resume_token)$/i;
const SHOT_KEY = /^(screenshot|png|image|image_data)$/i;

export function durableResult(outcome: Outcome, fields: Record<string, unknown> = {}): DurableResult {
  const clean = redactAudit(fields) as Record<string, unknown>;
  delete clean.screenshot;
  delete clean.resume;
  delete clean.resume_token;
  delete clean.png;
  delete clean.image;
  delete clean.image_data;
  clean.outcome = outcome;
  return clean as DurableResult;
}

export function takePng(raw: unknown): Png | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const shot = (raw as Record<string, unknown>).screenshot;
  if (typeof shot === "string" && shot.startsWith("iVBORw0KGgo")) return shot as Png;
  return null;
}

export function argsForJob(raw: Record<string, unknown>):
  | { args: Redacted; workflowId: string | null; requestedDevice: string }
  | { error: "cdp is not a relay command" } {
  if (cdpCommand(raw)) return { error: "cdp is not a relay command" };
  const requestedDevice = typeof raw.deviceId === "string" ? raw.deviceId : "";
  const walked = walkArgs(raw, 0);
  const args = (walked && typeof walked === "object" && !Array.isArray(walked) ? walked : {}) as Record<string, unknown>;
  return {
    args: args as Redacted,
    workflowId: workflowIdOf(args),
    requestedDevice,
  };
}

export function splitResult(raw: unknown): { stored: DurableResult; callerText: Redacted; image: Png | null } {
  const record = asRecord(raw);
  if (cdpCommand(record)) {
    const failed = durableResult("failed", { reason: "cdp is not a relay command" });
    return {
      stored: failed,
      callerText: failed as unknown as Redacted,
      image: null,
    };
  }
  const image = takePng(record);
  const outcome = isOutcome(record.outcome) ? record.outcome : "failed";
  const resume = typeof record.resume === "string" ? record.resume : undefined;
  const resumeToken = typeof record.resume_token === "string" ? record.resume_token : undefined;
  const stored = durableResult(outcome, record);
  const caller = redactAudit(record) as Record<string, unknown>;
  delete caller.screenshot;
  delete caller.png;
  delete caller.image;
  delete caller.image_data;
  caller.outcome = outcome;
  if (resume !== undefined) caller.resume = resume;
  if (resumeToken !== undefined) caller.resume_token = resumeToken;
  return { stored, callerText: caller as Redacted, image };
}

export function jobPolicy(): RemotePolicy {
  return REMOTE_POLICY;
}

function cdpCommand(value: unknown): string | null {
  return walkCdp(value, 0);
}

function walkCdp(value: unknown, depth: number): string | null {
  if (depth > 8 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = walkCdp(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(method|cdp|command)$/i.test(key) && typeof child === "string" && CDP_METHOD.test(child)) return child;
    const hit = walkCdp(child, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function walkArgs(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    if (value.startsWith("iVBORw0KGgo") || value.includes("iVBORw0KGgo")) return "redacted";
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => walkArgs(item, depth + 1));
  if (!value || typeof value !== "object" || depth > 8) return value;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (CONTROL_KEY.test(key) || SECRET_KEY.test(key) || RESUME_KEY.test(key) || SHOT_KEY.test(key)) continue;
    next[key] = walkArgs(child, depth + 1);
  }
  return next;
}

function workflowIdOf(args: Record<string, unknown>): string | null {
  if (typeof args.id === "string" && args.id) return args.id;
  if (typeof args.run_id === "string" && args.run_id) return args.run_id;
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

type Listener = (job: Job) => void;

export function cloneJob(job: Job): Job {
  return JSON.parse(JSON.stringify(job)) as Job;
}

export class MemoryJobStore implements JobStore {
  private jobs = new Map<string, Job>();
  private listeners = new Map<string, Set<Listener>>();

  async insert(job: QueuedJob | DoneJob): Promise<void> {
    this.jobs.set(job.id, cloneJob(job));
    this.emit(job.id);
  }

  async get(id: JobId): Promise<Job | null> {
    const job = this.jobs.get(id);
    return job ? cloneJob(job) : null;
  }

  async oldestQueued(scope: DeviceScope): Promise<QueuedJob | null> {
    return this.oldest(scope, "queued") as QueuedJob | null;
  }

  async oldestRunning(scope: DeviceScope): Promise<RunningJob | null> {
    return this.oldest(scope, "running") as RunningJob | null;
  }

  async claim(scope: DeviceScope, id: JobId): Promise<RunningJob | null> {
    const job = this.jobs.get(id);
    if (!job || !sameScope(job, scope) || job.status !== "queued") return null;
    const running: RunningJob = {
      ...job,
      status: "running",
      outcome: null,
      result: null,
      claimedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.jobs.set(id, running);
    this.emit(id);
    return cloneJob(running) as RunningJob;
  }

  async appendEvent(scope: DeviceScope, id: JobId, event: RelayEvent): Promise<Job | null> {
    const job = this.jobs.get(id);
    if (!job || !sameScope(job, scope)) return null;
    job.events.push(event);
    this.emit(id);
    return cloneJob(job);
  }

  async settle(scope: DeviceScope, id: JobId, outcome: Outcome, result: DurableResult): Promise<Settle> {
    const job = this.jobs.get(id);
    if (!job || !sameScope(job, scope)) return { kind: "missing" };
    if (job.status === "done") return { kind: "lost", job: cloneJob(job) as DoneJob };
    if (job.status !== "queued" && job.status !== "running") return { kind: "missing" };
    const finishedAt = new Date().toISOString();
    const done: DoneJob = {
      ...job,
      status: "done",
      outcome,
      result: durableResult(outcome, result),
      claimedAt: job.claimedAt,
      finishedAt,
      events: [...job.events, { at: finishedAt, type: "done", outcome }],
    };
    this.jobs.set(id, done);
    this.emit(id);
    return { kind: "wrote", job: cloneJob(done) as DoneJob };
  }

  async wait(id: JobId, timeoutMs: number): Promise<Job | null> {
    const current = await this.get(id);
    if (!current) return null;
    if (current.status === "done") return current;
    const started = Date.now();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (job: Job | null) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timer);
        stop();
        resolve(job ? cloneJob(job) : null);
      };
      const stop = this.subscribe(id, (job) => {
        if (job.status === "done") finish(job);
      });
      const poll = setInterval(() => {
        const job = this.jobs.get(id);
        if (!job) finish(null);
        else if (job.status === "done") finish(cloneJob(job));
        else if (Date.now() - started >= timeoutMs) finish(cloneJob(job));
      }, 40);
      const timer = setTimeout(() => {
        const job = this.jobs.get(id);
        finish(job ? cloneJob(job) : null);
      }, timeoutMs);
      poll.unref();
      timer.unref();
    });
  }

  snapshot(): Job[] {
    return [...this.jobs.values()].map((job) => cloneJob(job));
  }

  subscribe(id: string, fn: Listener): () => void {
    const listeners = this.bucket(id);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  private oldest(scope: DeviceScope, status: "queued" | "running"): Job | null {
    const next = [...this.jobs.values()]
      .filter((job) => sameScope(job, scope) && job.status === status)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    return next ? cloneJob(next) : null;
  }

  private bucket(id: string): Set<Listener> {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    return set;
  }

  private emit(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    const copy = cloneJob(job);
    for (const listener of this.listeners.get(id) || []) listener(copy);
  }
}

interface JobColumns {
  id: string;
  token_id: string;
  user_id: string;
  device_id: string;
  tool: string;
  workflow_id: string | null;
  status: string;
  outcome: string | null;
  policy: unknown;
  args: unknown;
  result: unknown;
  events: unknown;
  created_at: unknown;
  claimed_at: unknown;
  finished_at: unknown;
}

const COLUMNS = `id, token_id, user_id, device_id, tool, workflow_id, status, outcome, policy, args, result, events, created_at, claimed_at, finished_at`;

async function sql<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const { query } = await import("./db");
  return query<T>(text, params);
}

export class PgJobStore implements JobStore {
  private listeners = new Map<string, Set<Listener>>();

  async insert(job: QueuedJob | DoneJob): Promise<void> {
    await sql(
      `INSERT INTO agent_jobs (id, token_id, user_id, device_id, tool, workflow_id, status, outcome, policy, args, result, events, created_at, claimed_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14, $15)`,
      [
        job.id,
        job.tokenId,
        job.scope.userId,
        job.scope.deviceId,
        job.tool,
        job.workflowId,
        job.status,
        job.outcome,
        JSON.stringify(job.policy),
        JSON.stringify(job.args),
        job.result ? JSON.stringify(job.result) : null,
        JSON.stringify(job.events),
        job.createdAt,
        job.claimedAt,
        job.finishedAt,
      ],
    );
    this.emit(job);
  }

  async get(id: JobId): Promise<Job | null> {
    const rows = await sql<JobColumns>(`SELECT ${COLUMNS} FROM agent_jobs WHERE id = $1`, [id]);
    return rows[0] ? mapJob(rows[0]) : null;
  }

  async oldestQueued(scope: DeviceScope): Promise<QueuedJob | null> {
    const rows = await sql<JobColumns>(
      `SELECT ${COLUMNS} FROM agent_jobs
       WHERE user_id = $1 AND device_id = $2 AND status = 'queued'
       ORDER BY created_at LIMIT 1`,
      [scope.userId, scope.deviceId],
    );
    const job = rows[0] ? mapJob(rows[0]) : null;
    return job?.status === "queued" ? job : null;
  }

  async oldestRunning(scope: DeviceScope): Promise<RunningJob | null> {
    const rows = await sql<JobColumns>(
      `SELECT ${COLUMNS} FROM agent_jobs
       WHERE user_id = $1 AND device_id = $2 AND status = 'running'
       ORDER BY created_at LIMIT 1`,
      [scope.userId, scope.deviceId],
    );
    const job = rows[0] ? mapJob(rows[0]) : null;
    return job?.status === "running" ? job : null;
  }

  async claim(scope: DeviceScope, id: JobId): Promise<RunningJob | null> {
    const rows = await sql<JobColumns>(
      `UPDATE agent_jobs SET status = 'running', claimed_at = now()
       WHERE id = $1 AND user_id = $2 AND device_id = $3 AND status = 'queued'
       RETURNING ${COLUMNS}`,
      [id, scope.userId, scope.deviceId],
    );
    const job = rows[0] ? mapJob(rows[0]) : null;
    if (!job || job.status !== "running") return null;
    this.emit(job);
    return job;
  }

  async appendEvent(scope: DeviceScope, id: JobId, event: RelayEvent): Promise<Job | null> {
    const rows = await sql<JobColumns>(
      `UPDATE agent_jobs
       SET events = COALESCE(events, '[]'::jsonb) || $4::jsonb
       WHERE id = $1 AND user_id = $2 AND device_id = $3
       RETURNING ${COLUMNS}`,
      [id, scope.userId, scope.deviceId, JSON.stringify([event])],
    );
    const job = rows[0] ? mapJob(rows[0]) : null;
    if (job) this.emit(job);
    return job;
  }

  async settle(scope: DeviceScope, id: JobId, outcome: Outcome, result: DurableResult): Promise<Settle> {
    const stored = durableResult(outcome, result);
    const event = { at: new Date().toISOString(), type: "done", outcome };
    const rows = await sql<JobColumns>(
      `UPDATE agent_jobs
       SET status = 'done', outcome = $4, result = $5::jsonb, finished_at = now(),
           events = COALESCE(events, '[]'::jsonb) || $6::jsonb
       WHERE id = $1 AND user_id = $2 AND device_id = $3 AND status IN ('queued', 'running')
       RETURNING ${COLUMNS}`,
      [id, scope.userId, scope.deviceId, outcome, JSON.stringify(stored), JSON.stringify([event])],
    );
    if (rows[0]) {
      const job = mapJob(rows[0]);
      if (job?.status === "done") {
        this.emit(job);
        return { kind: "wrote", job };
      }
    }
    const current = await this.get(id);
    if (current?.status === "done" && sameScope(current, scope)) return { kind: "lost", job: current };
    return { kind: "missing" };
  }

  async wait(id: JobId, timeoutMs: number): Promise<Job | null> {
    const current = await this.get(id);
    if (!current) return null;
    if (current.status === "done") return current;
    const started = Date.now();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (job: Job | null) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timer);
        stop();
        resolve(job);
      };
      const stop = this.subscribe(id, (job) => {
        if (job.status === "done") finish(job);
      });
      const poll = setInterval(() => {
        void this.get(id).then((job) => {
          if (!job) finish(null);
          else if (job.status === "done") finish(job);
          else if (Date.now() - started >= timeoutMs) finish(job);
        }).catch(() => undefined);
      }, 40);
      const timer = setTimeout(() => {
        void this.get(id).then((job) => finish(job)).catch(() => finish(null));
      }, timeoutMs);
      poll.unref();
      timer.unref();
    });
  }

  subscribe(id: string, fn: Listener): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  private emit(job: Job): void {
    const copy = cloneJob(job);
    for (const listener of this.listeners.get(job.id) || []) listener(copy);
  }
}

function sameScope(job: Job, scope: DeviceScope): boolean {
  return job.scope.userId === scope.userId && job.scope.deviceId === scope.deviceId;
}

function mapJob(row: JobColumns): Job | null {
  if (!JOB_ID.test(row.id)) return null;
  if (!isToolName(row.tool)) return null;
  const tool = row.tool;
  const policy = jsonValue(row.policy);
  if (!policy || typeof policy !== "object") return null;
  const policyRow = policy as Record<string, unknown>;
  if (policyRow.version !== 1 || policyRow.requireLocalApproval !== true || policyRow.confirmLocalOnly !== true || policyRow.remoteMayApproveConfirm !== false) {
    return null;
  }
  const base: JobBase = {
    id: row.id as JobId,
    scope: deviceScope(row.user_id, row.device_id),
    tokenId: row.token_id,
    tool,
    workflowId: row.workflow_id,
    policy: policy as RemotePolicy,
    args: asRecord(jsonValue(row.args)) as Redacted,
    events: asEvents(row.events),
    createdAt: instant(row.created_at),
  };
  if (row.status === "queued") {
    return { ...base, status: "queued", outcome: null, result: null, claimedAt: null, finishedAt: null };
  }
  if (row.status === "running") {
    return {
      ...base,
      status: "running",
      outcome: null,
      result: null,
      claimedAt: row.claimed_at == null ? base.createdAt : instant(row.claimed_at),
      finishedAt: null,
    };
  }
  if (row.status === "done") {
    const outcome = isOutcome(row.outcome) ? row.outcome : "failed";
    return {
      ...base,
      status: "done",
      outcome,
      result: durableResult(outcome, asRecord(jsonValue(row.result))),
      claimedAt: row.claimed_at == null ? null : instant(row.claimed_at),
      finishedAt: row.finished_at == null ? base.createdAt : instant(row.finished_at),
    };
  }
  return null;
}

function jsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    try { return JSON.parse(value) as unknown; } catch { return value; }
  }
  return value;
}

function asEvents(value: unknown): RelayEvent[] {
  const parsed = jsonValue(value);
  return Array.isArray(parsed) ? parsed as RelayEvent[] : [];
}

function instant(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}
