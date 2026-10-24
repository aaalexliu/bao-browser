// Remote MCP jobs. A cloud client calls /mcp with an agent token. The token
// is bound to one device. That Mac long-polls with its device token. The
// extension never calls this server.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { redactAudit } from "./audit-redact";
import { query } from "./db";
import { boot, HttpError } from "./registry";
import { REMOTE_POLICY } from "./remote-policy";

const TOOLS = [
  {
    name: "search_workflows",
    description: "Search workflows saved on the paired Mac. At most 5 hits, each with its input schema.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, deviceId: { type: "string" } } },
  },
  {
    name: "describe_workflow",
    description: "Steps, input schema, and bao:// link for one workflow on the paired Mac. Secret defaults are omitted.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, deviceId: { type: "string" } }, required: ["id"] },
  },
  {
    name: "run_workflow",
    description: "Ask the paired Mac to run a saved workflow. The Mac must approve before anything runs. A confirm step cannot be approved from here.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        inputs: { type: "object" },
        deviceId: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "resume_workflow",
    description: "Continue a paused run. A confirm, payment, send, login, or bot wall can only be approved on the Mac. This call cannot approve those.",
    inputSchema: {
      type: "object",
      properties: { resume: { type: "string" }, deviceId: { type: "string" } },
      required: ["resume"],
    },
  },
] as const;

const TOOL_NAMES = new Set<string>(TOOLS.map((tool) => tool.name));
const JOB_WAIT_MS = 55_000;

interface AgentRow {
  id: string;
  user_id: string;
  device_id: string;
  revoked_at: string | null;
}

interface JobRow {
  id: string;
  tool: string;
  workflow_id: string | null;
  policy: unknown;
  args: unknown;
  status: string;
  outcome: string | null;
  result: unknown;
}

interface Hub {
  args: Map<string, Record<string, unknown>>;
  waiters: Map<string, (value: Record<string, unknown>) => void>;
}

interface Rpc {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

const globalHub = globalThis as { baoAgentHub?: Hub };

function hub(): Hub {
  if (!globalHub.baoAgentHub) globalHub.baoAgentHub = { args: new Map(), waiters: new Map() };
  return globalHub.baoAgentHub;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* leave empty */ }
    return {};
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

export function cursorMcpConfig(origin: string, token: string): { mcpServers: { bao: { url: string; headers: { Authorization: string } } } } {
  const base = origin.replace(/\/$/, "");
  return {
    mcpServers: {
      bao: {
        url: `${base}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
}

export async function mintAgentToken(userId: string, deviceId: string, label: string): Promise<{ id: string; token: string; deviceId: string }> {
  const rows = await query<{ id: string }>(`SELECT id FROM devices WHERE id = $1 AND user_id = $2`, [deviceId, userId]);
  if (!rows.length) throw new HttpError("device not found", 404);
  const id = `atk-${randomUUID()}`;
  const token = `bao_at_${randomBytes(32).toString("hex")}`;
  await query(
    `INSERT INTO agent_tokens (id, user_id, device_id, token_hash, label) VALUES ($1, $2, $3, $4, $5)`,
    [id, userId, deviceId, hash(token), label.trim() || "agent"],
  );
  return { id, token, deviceId };
}

export async function revokeAgentToken(userId: string, tokenId: string): Promise<void> {
  const rows = await query<{ id: string }>(
    `UPDATE agent_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
    [tokenId, userId],
  );
  if (!rows.length) throw new HttpError("not found", 404);
}

export async function listAgentAudit(userId: string): Promise<Record<string, unknown>[]> {
  return query(
    `SELECT id, token_id, device_id, tool, workflow_id, status, outcome,
            created_at, claimed_at, finished_at, args, result
     FROM agent_jobs WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
}

export async function pollAgent(deviceId: string, waitMs: number, heartbeatOnly = false): Promise<{ job: Record<string, unknown> | null }> {
  if (heartbeatOnly) {
    await query(`UPDATE devices SET agent_poll_at = now() WHERE id = $1`, [deviceId]);
    return { job: null };
  }
  const deadline = Date.now() + Math.min(Math.max(waitMs, 0), 25_000);
  do {
    await query(`UPDATE devices SET agent_poll_at = now() WHERE id = $1`, [deviceId]);
    const job = await claimJob(deviceId);
    if (job) return { job };
    if (Date.now() >= deadline) break;
    await sleep(200);
  } while (Date.now() < deadline);
  await query(`UPDATE devices SET agent_poll_at = now() WHERE id = $1`, [deviceId]);
  return { job: null };
}

export async function finishAgentJob(deviceId: string, jobId: string, body: unknown): Promise<void> {
  const rows = await query<{ id: string; status: string }>(
    `SELECT id, status FROM agent_jobs WHERE id = $1 AND device_id = $2`,
    [jobId, deviceId],
  );
  const row = rows[0];
  if (!row) throw new HttpError("not found", 404);
  if (row.status !== "running") throw new HttpError("job is not running", 409);
  const raw = asObject(body);
  const shot = typeof raw.screenshot === "string" ? raw.screenshot : undefined;
  const audit = redactAudit(raw) as Record<string, unknown>;
  delete audit.screenshot;
  const client = redactAudit(raw, { keepResume: true }) as Record<string, unknown>;
  delete client.screenshot;
  if (shot && shot.startsWith("iVBORw0KGgo")) client.screenshot = shot;
  const outcome = typeof raw.outcome === "string" ? raw.outcome : "failed";
  const workflowId = typeof raw.workflowId === "string" ? raw.workflowId : null;
  await query(
    `UPDATE agent_jobs
     SET status = 'done', outcome = $2, result = $3::jsonb, finished_at = now(),
         workflow_id = COALESCE($4, workflow_id)
     WHERE id = $1 AND device_id = $5`,
    [jobId, outcome, JSON.stringify(audit), workflowId, deviceId],
  );
  hub().args.delete(jobId);
  const waiter = hub().waiters.get(jobId);
  hub().waiters.delete(jobId);
  waiter?.(client);
}

export async function handleMcp(req: Request): Promise<Response> {
  await boot();
  const token = bearer(req.headers.get("authorization")) || req.headers.get("x-bao-agent-token") || "";
  if (!token) return unauthorized();
  const agent = await agentFromToken(token);
  if (!agent) return unauthorized();
  let message: Rpc;
  try {
    message = await req.json() as Rpc;
  } catch {
    return rpcError(null, -32700, "parse error", 400);
  }
  if (Array.isArray(message)) return rpcError(null, -32600, "one message at a time", 400);
  if (message.method === "initialize") {
    const requested = (message.params as { protocolVersion?: string } | undefined)?.protocolVersion;
    const protocolVersion = typeof requested === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(requested) ? requested : "2025-03-26";
    return rpcResult(message.id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "bao", version: "0.2.0" },
    });
  }
  if (message.method === "notifications/initialized" || message.method?.startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }
  if (message.method === "ping") return rpcResult(message.id, {});
  if (message.method === "tools/list") return rpcResult(message.id, { tools: TOOLS });
  if (message.method === "tools/call") return callTool(req, agent, message);
  if (message.id !== undefined && message.id !== null) return rpcError(message.id, -32601, "method not found");
  return new Response(null, { status: 202 });
}

async function callTool(req: Request, agent: AgentRow, message: Rpc): Promise<Response> {
  const name = message.params?.name || "";
  const args = message.params?.arguments && typeof message.params.arguments === "object" ? message.params.arguments : {};
  if (!TOOL_NAMES.has(name)) {
    return rpcResult(message.id, { content: [{ type: "text", text: "unknown tool" }], isError: true });
  }
  const headerDevice = req.headers.get("x-bao-device") || "";
  const argDevice = typeof args.deviceId === "string" ? args.deviceId : "";
  const requested = headerDevice || argDevice;
  if (requested && requested !== agent.device_id) {
    await insertJob({
      agent,
      tool: name,
      args,
      status: "done",
      outcome: "forbidden",
      workflowId: workflowIdOf(args),
    });
    return json({ error: "device mismatch" }, 403);
  }
  if (!(await deviceOnline(agent.device_id))) {
    const started = Date.now();
    await insertJob({
      agent,
      tool: name,
      args,
      status: "done",
      outcome: "device_offline",
      workflowId: workflowIdOf(args),
    });
    const text = JSON.stringify({ outcome: "device_offline", deviceId: agent.device_id, ms: Date.now() - started });
    return rpcResult(message.id, { content: [{ type: "text", text }], isError: false });
  }
  const jobId = `job-${randomUUID()}`;
  const delivered = waitForJob(jobId);
  hub().args.set(jobId, args);
  await insertJob({
    id: jobId,
    agent,
    tool: name,
    args,
    status: "queued",
    outcome: null,
    workflowId: workflowIdOf(args),
  });
  const result = await Promise.race([
    delivered,
    sleep(JOB_WAIT_MS).then(() => null),
  ]);
  if (!result) {
    await query(
      `UPDATE agent_jobs SET status = 'done', outcome = 'failed', result = $2::jsonb, finished_at = now()
       WHERE id = $1 AND status IN ('queued', 'running')`,
      [jobId, JSON.stringify({ outcome: "failed", reason: "timed out" })],
    );
    hub().waiters.delete(jobId);
    hub().args.delete(jobId);
    return rpcResult(message.id, {
      content: [{ type: "text", text: JSON.stringify({ outcome: "failed", reason: "timed out" }) }],
      isError: true,
    });
  }
  return toolResponse(message.id, result);
}

function toolResponse(id: Rpc["id"], result: Record<string, unknown>): Response {
  const shot = typeof result.screenshot === "string" ? result.screenshot : "";
  const textBody = { ...result };
  delete textBody.screenshot;
  const content: Record<string, unknown>[] = [{ type: "text", text: JSON.stringify(textBody) }];
  if (shot.startsWith("iVBORw0KGgo")) content.push({ type: "image", data: shot, mimeType: "image/png" });
  return rpcResult(id, { content, isError: false });
}

function waitForJob(jobId: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    hub().waiters.set(jobId, resolve);
  });
}

async function deviceOnline(deviceId: string): Promise<boolean> {
  const rows = await query<{ online: boolean | string }>(
    `SELECT agent_poll_at IS NOT NULL AND agent_poll_at > now() - interval '2 seconds' AS online
     FROM devices WHERE id = $1`,
    [deviceId],
  );
  const online = rows[0]?.online;
  return online === true || online === "t" || online === "true";
}

async function claimJob(deviceId: string): Promise<Record<string, unknown> | null> {
  const rows = await query<JobRow>(
    `SELECT id, tool, workflow_id, policy, args, status, outcome, result
     FROM agent_jobs WHERE device_id = $1 AND status = 'queued' ORDER BY created_at LIMIT 1`,
    [deviceId],
  );
  const row = rows[0];
  if (!row) return null;
  const claimed = await query<{ id: string }>(
    `UPDATE agent_jobs SET status = 'running', claimed_at = now() WHERE id = $1 AND status = 'queued' RETURNING id`,
    [row.id],
  );
  if (!claimed.length) return null;
  const policy = asObject(row.policy);
  const stored = asObject(row.args);
  const full = hub().args.get(row.id) || stored;
  return {
    id: row.id,
    tool: row.tool,
    workflowId: row.workflow_id,
    policy,
    args: full,
  };
}

async function insertJob(input: {
  id?: string;
  agent: AgentRow;
  tool: string;
  args: Record<string, unknown>;
  status: string;
  outcome: string | null;
  workflowId: string | null;
}): Promise<string> {
  const id = input.id || `job-${randomUUID()}`;
  const args = redactAudit(input.args) as Record<string, unknown>;
  const done = input.status === "done";
  await query(
    `INSERT INTO agent_jobs (id, token_id, user_id, device_id, tool, workflow_id, status, outcome, policy, args, result, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, CASE WHEN $7 = 'done' THEN now() ELSE NULL END)`,
    [
      id,
      input.agent.id,
      input.agent.user_id,
      input.agent.device_id,
      input.tool,
      input.workflowId,
      input.status,
      input.outcome,
      JSON.stringify(REMOTE_POLICY),
      JSON.stringify(args),
      done ? JSON.stringify({ outcome: input.outcome }) : null,
    ],
  );
  return id;
}

async function agentFromToken(token: string): Promise<AgentRow | null> {
  const rows = await query<AgentRow>(
    `SELECT id, user_id, device_id, revoked_at FROM agent_tokens WHERE token_hash = $1`,
    [hash(token)],
  );
  const row = rows[0];
  if (!row || row.revoked_at) return null;
  return row;
}

function workflowIdOf(args: Record<string, unknown>): string | null {
  return typeof args.id === "string" && args.id ? args.id : null;
}

function bearer(value: string | null): string {
  if (!value?.toLowerCase().startsWith("bearer ")) return "";
  return value.slice(7).trim();
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function rpcResult(id: Rpc["id"], result: unknown): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, result }, 200);
}

function rpcError(id: Rpc["id"], code: number, message: string, status = 200): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
