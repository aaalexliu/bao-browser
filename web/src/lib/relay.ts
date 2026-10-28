// Outbound relay. A paired Mac dials in. A cloud agent calls /mcp.
// The session map is the only online signal. A result moves the session to
// waiting, and the next claim waits for a ready frame.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Duplex } from "node:stream";
import { remoteMcpEnabled } from "./remote-flag";
import { RELAY_CODE_TTL_MS, RELAY_TOOLS, SERVER_VERSION, isToolName, pairCode, type ToolName } from "./relay-tools";
import {
  argsForJob,
  asJobId,
  deviceScope,
  durableResult,
  jobPolicy,
  splitResult,
  PgJobStore,
  type DoneJob,
  type DurableResult,
  type Job,
  type JobId,
  type JobStore,
  type Outcome,
  type Png,
  type QueuedJob,
  type Redacted,
  type RunningJob,
} from "./relay-job";
import { acceptUpgrade, bearerHeader, rejectUpgrade, type LiteSocket } from "./ws-lite";

const JOB_WAIT_MS = 55_000;
const PAIR_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const UPGRADE_FLAG = Symbol.for("bao.relayUpgrade");

type Availability =
  | { state: "waiting" }
  | { state: "ready" }
  | { state: "busy"; jobId: JobId };

interface AgentPrincipal {
  id: string;
  userId: string;
  deviceId: string;
}

interface RelayPrincipal {
  tokenId: string;
  userId: string;
  deviceId: string;
}

interface Directory {
  agentFromToken(token: string): Promise<AgentPrincipal | null>;
  relayFromToken(token: string): Promise<RelayPrincipal | null>;
  issueCode(userId: string, now: number): Promise<{ code: string; expiresAt: string }>;
  claimCode(code: string, name: string, deviceId: string): Promise<{ token: string; tokenId: string; deviceId: string; userId: string }>;
  revokeRelay(token: string): Promise<boolean>;
  mintAgent(userId: string, deviceId: string, label: string): Promise<{ id: string; token: string; deviceId: string } | null>;
  revokeAgent(userId: string, tokenId: string): Promise<boolean>;
  deleteDevice(userId: string, deviceId: string): Promise<boolean>;
}

interface Session {
  principal: RelayPrincipal;
  socket: LiteSocket;
  lastInbound: number;
  availability: Availability;
  chain: Promise<void>;
}

interface Rpc {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string };
}

interface SignedIn {
  userId: string;
  deviceId?: string;
}

type HeldReply = { outcome: Outcome; text: Record<string, unknown>; image: Png | null };

export interface Relay {
  handle(req: Request, principal: SignedIn | null): Promise<Response>;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  unpair(userId: string, deviceId: string): Promise<boolean>;
  close(): void;
}

export function createRelay(opts: {
  store: JobStore;
  directory: Directory;
  enabled: () => boolean;
  now?: () => number;
  boot?: () => Promise<void>;
}): Relay {
  const store = opts.store;
  const directory = opts.directory;
  const now = opts.now ?? (() => Date.now());
  if (directory instanceof MemoryDirectory) directory.useClock(now);
  const sessions = new Map<string, Session>();
  const held = new Map<string, HeldReply>();
  const sweep = setInterval(() => {
    const at = now();
    for (const session of sessions.values()) {
      if (!opts.enabled() || at - session.lastInbound > 25_000) session.socket.close();
    }
  }, 1000);
  sweep.unref();

  return { handle, handleUpgrade, unpair, close };

  function key(userId: string, deviceId: string): string {
    return `${userId}\n${deviceId}`;
  }

  // deliver runs on session.chain. A caller already on that chain must invoke it directly.
  function enqueue(session: Session, work: () => Promise<void>): void {
    session.chain = session.chain.then(work).then(() => undefined, () => undefined);
  }

  function dropSession(userId: string, deviceId: string): void {
    const id = key(userId, deviceId);
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    session.socket.close();
  }

  function close(): void {
    clearInterval(sweep);
    for (const session of sessions.values()) session.socket.close();
    sessions.clear();
  }

  async function unpair(userId: string, deviceId: string): Promise<boolean> {
    dropSession(userId, deviceId);
    return directory.deleteDevice(userId, deviceId);
  }

  async function handle(req: Request, principal: SignedIn | null): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;
    if (!agentSurface(pathname)) return json({ error: "not found" }, 404);
    if (!opts.enabled()) return json({ error: "remote_disabled" }, 404);
    if (opts.boot) await opts.boot();
    try {
      return await route(req, principal, pathname);
    } catch (err) {
      const status = err instanceof RelayError ? err.status : 500;
      return json({ error: err instanceof Error ? err.message : "relay" }, status);
    }
  }

  async function route(req: Request, principal: SignedIn | null, pathname: string): Promise<Response> {
    const method = req.method;
    if (pathname === "/mcp" && method === "POST") return handleMcp(req);
    if (pathname === "/mcp" && method === "GET") {
      return new Response(JSON.stringify({ error: "method not allowed" }), {
        status: 405,
        headers: { allow: "POST", "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    if (pathname === "/mcp" && method === "DELETE") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    if (pathname === "/mcp") {
      return new Response(JSON.stringify({ error: "method not allowed" }), {
        status: 405,
        headers: { allow: "POST", "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    if (pathname === "/api/agent/pair" && method === "POST") return issue(principal);
    if (pathname === "/api/agent/pair/claim" && method === "POST") return claim(req);
    if (pathname === "/api/agent/pair/revoke" && method === "POST") return revoke(req);
    if (pathname === "/api/agent/relay" && (method === "GET" || method === "POST")) return json({ error: "upgrade_required" }, 426);
    if (pathname === "/api/agent/tokens" && method === "POST") return mint(req, principal);
    const tokenRevoke = pathname.match(/^\/api\/agent\/tokens\/([^/]+)\/revoke$/);
    if (tokenRevoke && method === "POST") return revokeMint(principal, decodeURIComponent(tokenRevoke[1] || ""));
    if (pathname === "/api/agent/audit" && method === "GET") return audit(principal);
    const stream = pathname.match(/^\/api\/agent\/jobs\/([^/]+)\/stream$/);
    if (stream && method === "GET") return events(req, decodeURIComponent(stream[1] || ""));
    return json({ error: "not found" }, 404);
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!isUpgrade(req.url)) {
      rejectUpgrade(socket, 404, { error: "not found" });
      return;
    }
    if (!opts.enabled()) {
      rejectUpgrade(socket, 404, { error: "remote_disabled" });
      return;
    }
    const token = bearerHeader(req);
    void directory.relayFromToken(token).then((principal) => {
      if (!opts.enabled()) {
        rejectUpgrade(socket, 404, { error: "remote_disabled" });
        return;
      }
      if (!principal) {
        rejectUpgrade(socket, 401, { error: "unauthorized" });
        return;
      }
      const client = acceptUpgrade(req, socket, head);
      if (!client) {
        rejectUpgrade(socket, 400, { error: "upgrade" });
        return;
      }
      adopt(principal, client);
    }).catch(() => {
      rejectUpgrade(socket, 500, { error: "relay" });
    });
  }

  function adopt(principal: RelayPrincipal, client: LiteSocket): void {
    if (!opts.enabled()) {
      client.close();
      return;
    }
    const id = key(principal.userId, principal.deviceId);
    const session: Session = {
      principal,
      socket: client,
      lastInbound: now(),
      availability: { state: "waiting" },
      chain: Promise.resolve(),
    };
    const previous = sessions.get(id);
    sessions.set(id, session);
    if (previous) previous.socket.close();
    client.handlers.close = () => {
      if (sessions.get(id)?.socket === client) sessions.delete(id);
    };
    client.handlers.message = (text) => {
      session.chain = session.chain.then(() => onDevice(session, text)).then(() => undefined, () => undefined);
    };
    enqueue(session, () => deliverBody(session));
  }

  async function deliverBody(session: Session): Promise<void> {
    const scope = deviceScope(session.principal.userId, session.principal.deviceId);
    const availability = session.availability;
    if (availability.state === "busy") {
      const job = await store.get(availability.jobId);
      if (job?.status === "running" && job.scope.userId === scope.userId && job.scope.deviceId === scope.deviceId) {
        sendJob(session, job, "again");
        return;
      }
      session.availability = { state: "waiting" };
      return;
    }
    if (availability.state === "waiting") {
      const running = await store.oldestRunning(scope);
      if (running) {
        session.availability = { state: "busy", jobId: running.id };
        sendJob(session, running, "again");
        return;
      }
      // A local confirm has not sent ready. resume_workflow only refuses, so it
      // can answer without letting a run start.
      const queued = await store.oldestQueued(scope);
      if (queued?.tool !== "resume_workflow") return;
      const claimed = await store.claim(scope, queued.id);
      if (!claimed) return;
      session.availability = { state: "busy", jobId: claimed.id };
      sendJob(session, claimed, "fresh");
      return;
    }
    const running = await store.oldestRunning(scope);
    if (running) {
      session.availability = { state: "busy", jobId: running.id };
      sendJob(session, running, "again");
      return;
    }
    const queued = await store.oldestQueued(scope);
    if (!queued) return;
    const claimed = await store.claim(scope, queued.id);
    if (!claimed) return;
    session.availability = { state: "busy", jobId: claimed.id };
    sendJob(session, claimed, "fresh");
  }

  function sendJob(session: Session, job: RunningJob, delivery: "fresh" | "again"): void {
    if (job.scope.userId !== session.principal.userId || job.scope.deviceId !== session.principal.deviceId) return;
    session.socket.send(JSON.stringify({
      type: "job",
      delivery,
      job: {
        id: job.id,
        tool: job.tool,
        workflowId: job.workflowId,
        policy: job.policy,
        args: job.args,
      },
    }));
  }

  async function onDevice(session: Session, text: string): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    session.lastInbound = now();
    if (message.type === "ping") {
      session.socket.send(JSON.stringify({ type: "pong" }));
      if (session.availability.state === "busy") await deliverBody(session);
      return;
    }
    if (message.type === "ready") {
      if (session.availability.state !== "waiting") return;
      session.availability = { state: "ready" };
      await deliverBody(session);
      return;
    }
    const jobId = asJobId(typeof message.jobId === "string" ? message.jobId : "");
    if (!jobId) return;
    const scope = deviceScope(session.principal.userId, session.principal.deviceId);
    if (message.type === "status") {
      const phase = typeof message.phase === "string" ? message.phase : "status";
      await store.appendEvent(scope, jobId, { at: new Date(now()).toISOString(), type: "status", phase });
      return;
    }
    if (message.type === "result") await acceptResult(session, jobId, message.result);
  }

  async function acceptResult(session: Session, jobId: JobId, raw: unknown): Promise<void> {
    const parts = splitResult(raw);
    const scope = deviceScope(session.principal.userId, session.principal.deviceId);
    const settled = await store.settle(scope, jobId, parts.stored.outcome, parts.stored);
    if (settled.kind === "missing") return;
    if (settled.kind === "wrote") {
      held.set(jobId, {
        outcome: parts.stored.outcome,
        text: parts.callerText as unknown as Record<string, unknown>,
        image: parts.image,
      });
    }
    const reason = typeof settled.job.result.reason === "string" ? settled.job.result.reason : null;
    session.socket.send(JSON.stringify({
      type: "settled",
      jobId,
      outcome: settled.job.outcome,
      reason,
    }));
    if (session.availability.state === "busy" && session.availability.jobId === jobId) {
      session.availability = { state: "waiting" };
    }
  }

  async function handleMcp(req: Request): Promise<Response> {
    const token = bearer(req) || req.headers.get("x-bao-agent-token") || "";
    const agent = await directory.agentFromToken(token);
    if (!agent) return json({ error: "unauthorized" }, 401);
    let message: Rpc;
    try {
      const parsed = await readJson(req);
      if (Array.isArray(parsed)) {
        return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "one message at a time" } }, 400);
      }
      message = (parsed && typeof parsed === "object" ? parsed : {}) as Rpc;
    } catch (err) {
      if (err instanceof RelayError) {
        return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
      }
      throw err;
    }
    if (message.method === "initialize") {
      const requested = message.params?.protocolVersion;
      const protocolVersion = typeof requested === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(requested) ? requested : "2025-03-26";
      return rpc(message.id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "bao", version: SERVER_VERSION },
      });
    }
    if (message.method === "notifications/initialized" || message.method?.startsWith("notifications/")) {
      return new Response(null, { status: 202 });
    }
    if (message.method === "ping") return rpc(message.id, {});
    if (message.method === "tools/list") return rpc(message.id, { tools: RELAY_TOOLS });
    if (message.method === "tools/call") return callTool(req, agent, message);
    if (message.id !== undefined && message.id !== null) {
      return json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } }, 200);
    }
    return new Response(null, { status: 202 });
  }

  async function callTool(req: Request, agent: AgentPrincipal, message: Rpc): Promise<Response> {
    const name = message.params?.name || "";
    const raw = message.params?.arguments && typeof message.params.arguments === "object" ? message.params.arguments : {};
    if (!isToolName(name)) {
      return rpc(message.id, { content: [{ type: "text", text: "unknown tool" }], isError: true });
    }
    const prepared = argsForJob(raw);
    if ("error" in prepared) {
      return rpc(message.id, {
        content: [{ type: "text", text: JSON.stringify({ outcome: "failed", reason: prepared.error }) }],
        isError: true,
      });
    }
    const headerDevice = req.headers.get("x-bao-device") || "";
    const headerMismatch = headerDevice !== "" && headerDevice !== agent.deviceId;
    const bodyMismatch = prepared.requestedDevice !== "" && prepared.requestedDevice !== agent.deviceId;
    if (headerMismatch || bodyMismatch) {
      await insertDone(agent, name, prepared.args, "forbidden", prepared.workflowId);
      return json({ error: "device mismatch" }, 403);
    }
    const scope = deviceScope(agent.userId, agent.deviceId);
    if (!sessions.has(key(agent.userId, agent.deviceId))) {
      const started = now();
      await insertDone(agent, name, prepared.args, "device_offline", prepared.workflowId);
      const text = JSON.stringify({ outcome: "device_offline", deviceId: agent.deviceId, ms: Math.max(0, now() - started) });
      return rpc(message.id, { content: [{ type: "text", text }], isError: false });
    }
    const job = queuedJob(agent, name, prepared.args, prepared.workflowId);
    await store.insert(job);
    const live = sessions.get(key(agent.userId, agent.deviceId));
    if (live) enqueue(live, () => deliverBody(live));
    try {
      const done = await store.wait(job.id, JOB_WAIT_MS);
      let winner: DoneJob;
      if (!done || done.status !== "done") {
        const settled = await store.settle(scope, job.id, "failed", durableResult("failed", { reason: "timed out" }));
        if (settled.kind === "missing") return json({ error: "not found" }, 404);
        winner = settled.job;
        if (settled.kind === "wrote") notifyTimeout(agent, job.id);
      } else {
        winner = done;
      }
      const frame = held.get(job.id);
      const match = frame && frame.outcome === winner.outcome ? frame : null;
      const timedOut = winner.outcome === "failed" && winner.result.reason === "timed out";
      return toolResponse(message.id, match ? match.text : winner.result, match?.image ?? null, timedOut);
    } finally {
      held.delete(job.id);
    }
  }

  function notifyTimeout(agent: AgentPrincipal, jobId: JobId): void {
    const session = sessions.get(key(agent.userId, agent.deviceId));
    if (!session) return;
    enqueue(session, async () => {
      session.socket.send(JSON.stringify({ type: "settled", jobId, outcome: "failed", reason: "timed out" }));
      if (session.availability.state === "busy" && session.availability.jobId === jobId) {
        session.availability = { state: "waiting" };
      }
    });
  }

  function queuedJob(agent: AgentPrincipal, tool: ToolName, args: Redacted, workflowId: string | null): QueuedJob {
    const at = new Date(now()).toISOString();
    return {
      id: freshId(),
      scope: deviceScope(agent.userId, agent.deviceId),
      tokenId: agent.id,
      tool,
      workflowId,
      policy: jobPolicy(),
      args,
      events: [{ at, type: "queued" }],
      createdAt: at,
      status: "queued",
      outcome: null,
      result: null,
      claimedAt: null,
      finishedAt: null,
    };
  }

  async function insertDone(agent: AgentPrincipal, tool: ToolName, args: Redacted, outcome: Outcome, workflowId: string | null): Promise<void> {
    const at = new Date(now()).toISOString();
    const job: DoneJob = {
      id: freshId(),
      scope: deviceScope(agent.userId, agent.deviceId),
      tokenId: agent.id,
      tool,
      workflowId,
      policy: jobPolicy(),
      args,
      events: [{ at, type: "done", outcome }],
      createdAt: at,
      status: "done",
      outcome,
      result: durableResult(outcome),
      claimedAt: null,
      finishedAt: at,
    };
    await store.insert(job);
  }

  async function issue(principal: SignedIn | null): Promise<Response> {
    if (!principal?.userId || principal.deviceId) throw new RelayError("sign in", 401);
    return json(await directory.issueCode(principal.userId, now()), 200);
  }

  async function claim(req: Request): Promise<Response> {
    const body = await readJson(req) as { code?: string; name?: string; deviceId?: string };
    const claimed = await directory.claimCode(
      String(body.code || ""),
      String(body.name || "device"),
      typeof body.deviceId === "string" ? body.deviceId : "",
    );
    return json({ token: claimed.token, tokenId: claimed.tokenId, deviceId: claimed.deviceId }, 200);
  }

  async function revoke(req: Request): Promise<Response> {
    const token = bearer(req);
    const relayPrincipal = token ? await directory.relayFromToken(token) : null;
    const ok = token ? await directory.revokeRelay(token) : false;
    if (!ok) return json({ error: "unauthorized" }, 401);
    if (relayPrincipal) dropSession(relayPrincipal.userId, relayPrincipal.deviceId);
    return json({ ok: true }, 200);
  }

  async function mint(req: Request, principal: SignedIn | null): Promise<Response> {
    if (!principal?.userId || principal.deviceId) throw new RelayError("sign in", 401);
    const body = await readJson(req) as { deviceId?: string; label?: string };
    const minted = await directory.mintAgent(principal.userId, String(body.deviceId || ""), String(body.label || "agent"));
    if (!minted) throw new RelayError("device not found", 404);
    const origin = new URL(req.url).origin;
    return json({ ...minted, mcp: cursorMcpConfig(origin, minted.token) }, 200);
  }

  async function revokeMint(principal: SignedIn | null, tokenId: string): Promise<Response> {
    if (!principal?.userId || principal.deviceId) throw new RelayError("sign in", 401);
    const ok = await directory.revokeAgent(principal.userId, tokenId);
    if (!ok) throw new RelayError("not found", 404);
    return json({ ok: true }, 200);
  }

  async function audit(principal: SignedIn | null): Promise<Response> {
    if (!principal?.userId || principal.deviceId) throw new RelayError("sign in", 401);
    const rows = await sql(
      `SELECT id, token_id, device_id, tool, workflow_id, status, outcome,
              created_at, claimed_at, finished_at, args, result
       FROM agent_jobs WHERE user_id = $1 ORDER BY created_at`,
      [principal.userId],
    );
    return json({ jobs: rows }, 200);
  }

  async function events(req: Request, jobId: string): Promise<Response> {
    const token = bearer(req) || req.headers.get("x-bao-agent-token") || "";
    const agent = await directory.agentFromToken(token);
    if (!agent) return json({ error: "unauthorized" }, 401);
    const id = asJobId(jobId);
    if (!id) return json({ error: "not found" }, 404);
    const job = await store.get(id);
    if (!job || job.scope.userId !== agent.userId || job.scope.deviceId !== agent.deviceId) {
      return json({ error: "not found" }, 404);
    }
    const encoder = new TextEncoder();
    let sent = 0;
    const stream = new ReadableStream({
      start(controller) {
        const write = (current: Job) => {
          if (current.scope.userId !== agent.userId || current.scope.deviceId !== agent.deviceId) return;
          while (sent < current.events.length) {
            const event = current.events[sent];
            sent += 1;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
          if (current.status === "done") {
            stop();
            controller.close();
          }
        };
        const stop = store.subscribe(id, write);
        write(job);
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    });
  }
}

export class MemoryDirectory implements Directory {
  private agents = new Map<string, AgentPrincipal & { revoked: boolean }>();
  private relays = new Map<string, RelayPrincipal & { revoked: boolean }>();
  private codes = new Map<string, { userId: string; expiresAt: number; used: boolean }>();
  private devices = new Map<string, { userId: string; name: string }>();
  private clock: () => number = Date.now;

  useClock(now: () => number): void {
    this.clock = now;
  }

  addDevice(id: string, userId: string, name = "device"): void {
    this.devices.set(id, { userId, name });
  }

  async mintAgent(userId: string, deviceId: string, _label = "agent"): Promise<{ id: string; token: string; deviceId: string } | null> {
    const device = this.devices.get(deviceId);
    if (!device || device.userId !== userId) return null;
    const token = `bao_at_${randomBytes(32).toString("hex")}`;
    const id = `atk-${randomUUID()}`;
    this.agents.set(token, { id, userId, deviceId, revoked: false });
    return { id, token, deviceId };
  }

  async agentFromToken(token: string): Promise<AgentPrincipal | null> {
    if (!token.startsWith("bao_at_")) return null;
    const row = this.agents.get(token);
    if (!row || row.revoked) return null;
    return { id: row.id, userId: row.userId, deviceId: row.deviceId };
  }

  async relayFromToken(token: string): Promise<RelayPrincipal | null> {
    if (!token.startsWith("bao_rt_")) return null;
    const row = this.relays.get(token);
    if (!row || row.revoked) return null;
    return { tokenId: row.tokenId, userId: row.userId, deviceId: row.deviceId };
  }

  async issueCode(userId: string, at: number): Promise<{ code: string; expiresAt: string }> {
    const code = pairCode();
    const expiresAt = at + RELAY_CODE_TTL_MS;
    this.codes.set(code, { userId, expiresAt, used: false });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  async claimCode(code: string, name: string, deviceId: string): Promise<{ token: string; tokenId: string; deviceId: string; userId: string }> {
    void name;
    const parsed = parsePairCode(code);
    if (!parsed) throw new RelayError("code expired", 400);
    const id = deviceId.trim();
    if (!id) throw new RelayError("device id", 400);
    const row = this.codes.get(parsed);
    if (!row || row.used || row.expiresAt <= this.clock()) throw new RelayError("code expired", 400);
    const device = this.devices.get(id);
    if (!device || device.userId !== row.userId) throw new RelayError("device not found", 404);
    row.used = true;
    const token = `bao_rt_${randomBytes(32).toString("hex")}`;
    const tokenId = `rtk-${randomUUID()}`;
    this.relays.set(token, { tokenId, userId: row.userId, deviceId: id, revoked: false });
    return { token, tokenId, deviceId: id, userId: row.userId };
  }

  async revokeRelay(token: string): Promise<boolean> {
    if (!token.startsWith("bao_rt_")) return false;
    const row = this.relays.get(token);
    if (!row || row.revoked) return false;
    row.revoked = true;
    return true;
  }

  async revokeAgent(userId: string, tokenId: string): Promise<boolean> {
    for (const row of this.agents.values()) {
      if (row.id === tokenId && row.userId === userId && !row.revoked) {
        row.revoked = true;
        return true;
      }
    }
    return false;
  }

  async deleteDevice(userId: string, deviceId: string): Promise<boolean> {
    if (!/^dev-[\w-]+$/.test(deviceId)) return false;
    const device = this.devices.get(deviceId);
    if (!device || device.userId !== userId) return false;
    this.devices.delete(deviceId);
    for (const [token, row] of this.relays) {
      if (row.deviceId === deviceId) this.relays.delete(token);
    }
    for (const [token, row] of this.agents) {
      if (row.deviceId === deviceId) this.agents.delete(token);
    }
    return true;
  }
}

export class PgDirectory implements Directory {
  async agentFromToken(token: string): Promise<AgentPrincipal | null> {
    if (!token.startsWith("bao_at_")) return null;
    const rows = await sql<{ id: string; user_id: string; device_id: string; revoked_at: string | null }>(
      `SELECT id, user_id, device_id, revoked_at FROM agent_tokens WHERE token_hash = $1`,
      [hash(token)],
    );
    const row = rows[0];
    if (!row || row.revoked_at) return null;
    return { id: row.id, userId: row.user_id, deviceId: row.device_id };
  }

  async relayFromToken(token: string): Promise<RelayPrincipal | null> {
    if (!token.startsWith("bao_rt_")) return null;
    const rows = await sql<{ id: string; user_id: string; device_id: string; revoked_at: string | null }>(
      `SELECT id, user_id, device_id, revoked_at FROM relay_tokens WHERE token_hash = $1`,
      [hash(token)],
    );
    const row = rows[0];
    if (!row || row.revoked_at) return null;
    return { tokenId: row.id, userId: row.user_id, deviceId: row.device_id };
  }

  async issueCode(userId: string, _now: number): Promise<{ code: string; expiresAt: string }> {
    const code = pairCode();
    const rows = await sql<{ expires_at: unknown }>(
      `INSERT INTO relay_pair_codes (code, user_id, expires_at)
       VALUES ($1, $2, now() + ($3::text || ' milliseconds')::interval)
       RETURNING expires_at`,
      [code, userId, String(RELAY_CODE_TTL_MS)],
    );
    return { code, expiresAt: instant(rows[0]?.expires_at) };
  }

  async claimCode(code: string, name: string, deviceId: string): Promise<{ token: string; tokenId: string; deviceId: string; userId: string }> {
    void name;
    const parsed = parsePairCode(code);
    if (!parsed) throw new RelayError("code expired", 400);
    const id = deviceId.trim();
    if (!id) throw new RelayError("device id", 400);
    const pending = await sql<{ user_id: string }>(
      `SELECT user_id FROM relay_pair_codes
       WHERE code = $1 AND used_at IS NULL AND expires_at > now()`,
      [parsed],
    );
    const userId = pending[0]?.user_id;
    if (!userId) throw new RelayError("code expired", 400);
    const owned = await sql<{ id: string }>(`SELECT id FROM devices WHERE id = $1 AND user_id = $2`, [id, userId]);
    if (!owned.length) throw new RelayError("device not found", 404);
    const taken = await sql<{ user_id: string }>(
      `UPDATE relay_pair_codes SET used_at = now()
       WHERE code = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [parsed],
    );
    if (!taken[0]?.user_id) throw new RelayError("code expired", 400);
    const token = `bao_rt_${randomBytes(32).toString("hex")}`;
    const tokenId = `rtk-${randomUUID()}`;
    await sql(
      `INSERT INTO relay_tokens (id, user_id, device_id, token_hash) VALUES ($1, $2, $3, $4)`,
      [tokenId, userId, id, hash(token)],
    );
    return { token, tokenId, deviceId: id, userId };
  }

  async revokeRelay(token: string): Promise<boolean> {
    if (!token.startsWith("bao_rt_")) return false;
    const rows = await sql<{ id: string }>(
      `UPDATE relay_tokens SET revoked_at = now()
       WHERE token_hash = $1 AND revoked_at IS NULL
       RETURNING id`,
      [hash(token)],
    );
    return rows.length > 0;
  }

  async mintAgent(userId: string, deviceId: string, label = "agent"): Promise<{ id: string; token: string; deviceId: string } | null> {
    const owned = await sql<{ id: string }>(`SELECT id FROM devices WHERE id = $1 AND user_id = $2`, [deviceId, userId]);
    if (!owned.length) return null;
    const id = `atk-${randomUUID()}`;
    const token = `bao_at_${randomBytes(32).toString("hex")}`;
    await sql(
      `INSERT INTO agent_tokens (id, user_id, device_id, token_hash, label) VALUES ($1, $2, $3, $4, $5)`,
      [id, userId, deviceId, hash(token), label.trim() || "agent"],
    );
    return { id, token, deviceId };
  }

  async revokeAgent(userId: string, tokenId: string): Promise<boolean> {
    const rows = await sql<{ id: string }>(
      `UPDATE agent_tokens SET revoked_at = now()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
       RETURNING id`,
      [tokenId, userId],
    );
    return rows.length > 0;
  }

  async deleteDevice(userId: string, deviceId: string): Promise<boolean> {
    if (!/^dev-[\w-]+$/.test(deviceId)) return false;
    const rows = await sql<{ id: string }>(
      `DELETE FROM devices WHERE id = $1 AND user_id = $2 RETURNING id`,
      [deviceId, userId],
    );
    return rows.length > 0;
  }
}

// Next compiles the upgrade hook and the /mcp route as two copies of this
// module. A module-local variable would give each copy its own socket map.
type RelaySlot = typeof globalThis & {
  baoRelay?: Relay;
  baoRelayBoot?: () => Promise<void>;
};

function relaySlot(): RelaySlot {
  return globalThis as RelaySlot;
}

export function setRelayBoot(fn: () => Promise<void>): void {
  relaySlot().baoRelayBoot = fn;
}

export function registryRelay(): Relay {
  const slot = relaySlot();
  if (!slot.baoRelay) {
    slot.baoRelay = createRelay({
      store: new PgJobStore(),
      directory: new PgDirectory(),
      enabled: () => remoteMcpEnabled(),
      boot: () => (slot.baoRelayBoot ?? (async () => {}))(),
    });
  }
  return slot.baoRelay;
}

export function installRelayUpgrade(): void {
  const proto = Server.prototype as ServerPrototype;
  if (proto[UPGRADE_FLAG]) return;
  const original = proto.emit;
  proto.emit = function (this: Server, event: string | symbol, ...args: unknown[]): boolean {
    if (event === "upgrade" && isUpgrade((args[0] as IncomingMessage | undefined)?.url)) {
      const req = args[0] as IncomingMessage;
      const socket = args[1] as Duplex;
      const head = (args[2] as Buffer | undefined) || Buffer.alloc(0);
      registryRelay().handleUpgrade(req, socket, head);
      return true;
    }
    return original.apply(this, [event, ...args]);
  };
  proto[UPGRADE_FLAG] = true;
}

export function listenRelay(
  relay: Relay,
  opts?: { principal?: (req: IncomingMessage) => SignedIn | null },
): Promise<{ origin: string; port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const principal = opts?.principal?.(req) ?? null;
    void asRequest(req)
      .then((request) => relay.handle(request, principal))
      .then((response) => writeNode(res, response))
      .catch((err) => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        const body = JSON.stringify({ error: err instanceof Error ? err.message : "relay" });
        res.writeHead(500, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        res.end(body);
      });
  });
  server.on("upgrade", (req, socket, head) => relay.handleUpgrade(req, socket, head));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        port,
        close: () => new Promise((done) => {
          relay.close();
          server.close(() => done());
        }),
      });
    });
  });
}

export function assertRelayBoundary(root = process.cwd()): void {
  const files = walk(path.join(root, "web/src"));
  const allowed = new Set([
    path.normalize("web/src/lib/relay.ts"),
    path.normalize("web/src/lib/relay-job.test.ts"),
  ]);
  for (const file of files) {
    const rel = path.normalize(path.relative(root, file));
    const text = readFileSync(file, "utf8");
    if (importsRelayJob(text) && !allowed.has(rel)) {
      throw new Error(`${rel} imports relay-job`);
    }
  }
  const watched = [
    "web/src/app/mcp/route.ts",
    "web/src/lib/dispatch.ts",
    "web/src/instrumentation.ts",
    "web/src/lib/registry.ts",
  ];
  const names = ["createRelay", "listenRelay", "MemoryJobStore", "PgJobStore", "MemoryDirectory", "PgDirectory"];
  for (const rel of watched) {
    const text = readFileSync(path.join(root, rel), "utf8");
    for (const name of names) {
      if (new RegExp(`\\b${name}\\b`).test(text)) throw new Error(`${rel} names ${name}`);
    }
  }
  const relayText = readFileSync(path.join(root, "web/src/lib/relay.ts"), "utf8");
  const banned = ["x", "test", "user"].join("-");
  if (relayText.includes(banned) || relayText.includes(banned.slice(2))) {
    throw new Error("relay.ts names a test user header");
  }
}

class RelayError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "RelayError";
  }
}

type ServerPrototype = {
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
  [UPGRADE_FLAG]?: boolean;
};

function agentSurface(pathname: string): boolean {
  return pathname === "/mcp" || pathname === "/api/agent" || pathname.startsWith("/api/agent/");
}

function isUpgrade(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url, "http://127.0.0.1").pathname === "/api/agent/relay";
  } catch {
    return false;
  }
}

function freshId(): JobId {
  const id = asJobId(`job-${randomUUID()}`);
  if (!id) throw new RelayError("job id", 500);
  return id;
}

function parsePairCode(value: string): string | null {
  const code = value.trim().toUpperCase();
  return PAIR_CODE.test(code) ? code : null;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cursorMcpConfig(origin: string, token: string): { mcpServers: { bao: { url: string; headers: { Authorization: string } } } } {
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

function bearer(req: Request): string {
  const value = req.headers.get("authorization") || "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}

function toolResponse(id: Rpc["id"], text: Record<string, unknown> | DurableResult, image: Png | null, isError: boolean): Response {
  const body = { ...text } as Record<string, unknown>;
  delete body.screenshot;
  delete body.png;
  delete body.image;
  delete body.image_data;
  const content: Record<string, unknown>[] = [{ type: "text", text: JSON.stringify(body) }];
  if (image) content.push({ type: "image", data: image, mimeType: "image/png" });
  return rpc(id, { content, isError });
}

function rpc(id: Rpc["id"], result: unknown): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, result }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RelayError("parse error", 400);
  }
}

async function sql<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const { query } = await import("./db");
  return query<T>(text, params);
}

function instant(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value ?? ""));
  return Number.isNaN(parsed.getTime()) ? String(value ?? "") : parsed.toISOString();
}

function importsRelayJob(text: string): boolean {
  return /(?:from\s*|import\s*\()\s*["'][^"']*relay-job(?:\.ts)?["']/.test(text);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: { name: string; isDirectory: () => boolean }[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function readRaw(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function asRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host || "127.0.0.1";
  const url = `http://${host}${req.url || "/"}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  const method = req.method || "GET";
  if (method === "GET" || method === "HEAD") return new Request(url, { method, headers });
  const body = await readRaw(req);
  // Node requires duplex when a Request is constructed with a body.
  return new Request(url, { method, headers, body, duplex: "half" } as RequestInit);
}

async function writeNode(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (key === "content-length" || key === "transfer-encoding") return;
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      if (step.value) res.write(Buffer.from(step.value));
    }
    res.end();
  } catch {
    res.destroy();
  }
}
