// Hermetic relay. No browser, no registry process, no real Chrome profile.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { workflowDriver } from "../../src/extension/protocol";
import { createRemoteAgent, remoteRunAllowed } from "../../src/v1/remote-agent";
import { relayPath, saveRelay } from "../../src/v1/relay-link";
import { remoteDriverKind } from "../../src/v1/remote-run";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { MemoryJobStore } from "../../../web/src/lib/relay-job";
import { createRelay, listenRelay, MemoryDirectory } from "../../../web/src/lib/relay";
import { openWebSocket, type LiteSocket } from "../../../web/src/lib/ws-lite";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ";

class CountingDirectory extends MemoryDirectory {
  lookups = 0;
  override async relayFromToken(token: string) {
    this.lookups += 1;
    return super.relayFromToken(token);
  }
}

test("a short code pairs one device, expires, and does not bind someone else's device", async () => {
  let now = 1_700_000_000_000;
  const directory = new MemoryDirectory();
  directory.addDevice("dev-a", "user-a", "Mac A");
  directory.addDevice("dev-b", "user-b", "Mac B");
  const relay = createRelay({ store: new MemoryJobStore(), directory, enabled: () => true, now: () => now });
  const server = await listenRelay(relay, { principal: principalOf });
  try {
    const fresh = await claim(server.origin, "user-a", "dev-a");
    assert.match(fresh.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    assert.equal(Date.parse(fresh.expiresAt) - now, 120_000);
    assert.match(fresh.token, /^bao_rt_/);
    assert.equal(fresh.deviceId, "dev-a");

    const again = await issue(server.origin, "user-a");
    const lower = await post(`${server.origin}/api/agent/pair/claim`, { code: again.code.toLowerCase(), deviceId: "dev-a", name: "Mac A" });
    assert.equal(lower.status, 200, JSON.stringify(lower.body));
    assert.equal((lower.body as { deviceId: string }).deviceId, "dev-a");

    const foreignCode = await issue(server.origin, "user-a");
    const foreign = await post(`${server.origin}/api/agent/pair/claim`, { code: foreignCode.code, deviceId: "dev-b" });
    assert.equal(foreign.status, 404);
    const missing = await post(`${server.origin}/api/agent/pair/claim`, { code: foreignCode.code, name: "Mac A" });
    assert.equal(missing.status, 400);
    const recovered = await post(`${server.origin}/api/agent/pair/claim`, { code: foreignCode.code, deviceId: "dev-a", name: "Mac A" });
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));

    const once = await issue(server.origin, "user-a");
    const first = await post(`${server.origin}/api/agent/pair/claim`, { code: once.code, deviceId: "dev-a", name: "Mac A" });
    assert.equal(first.status, 200);
    const second = await post(`${server.origin}/api/agent/pair/claim`, { code: once.code, deviceId: "dev-a", name: "Mac A" });
    assert.equal(second.status, 400);

    const expiring = await issue(server.origin, "user-a");
    now += 120_001;
    const expired = await post(`${server.origin}/api/agent/pair/claim`, { code: expiring.code, deviceId: "dev-a", name: "Mac A" });
    assert.equal(expired.status, 400);
    assert.match(JSON.stringify(expired.body), /expired/);
  } finally {
    await server.close();
  }
});

test("revoking the relay token closes the socket and the next call is device_offline", async () => {
  const { server, directory } = await up();
  try {
    directory.addDevice("dev-a", "user-a");
    const paired = await claim(server.origin, "user-a", "dev-a");
    const agent = await directory.mintAgent("user-a", paired.deviceId);
    assert.ok(agent);
    const socket = await openWebSocket(`${server.origin}/api/agent/relay`, { Authorization: `Bearer ${paired.token}` });
    let closed = false;
    socket.handlers.close = () => { closed = true; };
    const revoked = await fetch(`${server.origin}/api/agent/pair/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${paired.token}` },
    });
    assert.equal(revoked.status, 200);
    await waitFor(() => closed);
    await assert.rejects(
      openWebSocket(`${server.origin}/api/agent/relay`, { Authorization: `Bearer ${paired.token}` }),
      /401/,
    );
    const offline = await tool(server.origin, agent.token, "run_workflow", { id: "books" });
    assert.equal(offline.status, 200);
    assert.equal(offline.json.outcome, "device_offline");
  } finally {
    await server.close();
  }
});

test("one user's agent cannot reach another user's device", async () => {
  const { server, directory } = await up();
  try {
    directory.addDevice("dev-a", "user-a");
    directory.addDevice("dev-b", "user-b");
    const a = await claim(server.origin, "user-a", "dev-a");
    const b = await claim(server.origin, "user-b", "dev-b");
    const agentA = await directory.mintAgent("user-a", a.deviceId);
    const agentB = await directory.mintAgent("user-b", b.deviceId);
    assert.ok(agentA && agentB);
    const seenA: string[] = [];
    const seenB: string[] = [];
    const sockA = await connect(server.origin, a.token, (jobId) => seenA.push(jobId));
    const sockB = await connect(server.origin, b.token, (jobId) => seenB.push(jobId));
    const mismatch = await tool(server.origin, agentA.token, "run_workflow", { id: "books", deviceId: b.deviceId });
    assert.equal(mismatch.status, 403);
    const header = await tool(server.origin, agentA.token, "describe_workflow", { id: "books" }, { "x-bao-device": b.deviceId });
    assert.equal(header.status, 403);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(seenA, []);
    assert.deepEqual(seenB, []);

    const running = tool(server.origin, agentA.token, "search_workflows", { query: "books" });
    await waitFor(() => seenA.length === 1);
    assert.deepEqual(seenB, []);
    sockA.send(JSON.stringify({ type: "result", jobId: seenA[0], result: { outcome: "ok", hits: [] } }));
    sockA.send(JSON.stringify({ type: "ready" }));
    const done = await running;
    assert.equal(done.json.outcome, "ok");
    const stream = await fetch(`${server.origin}/api/agent/jobs/${seenA[0]}/stream`, {
      headers: { authorization: `Bearer ${agentB.token}` },
    });
    assert.equal(stream.status, 404);
    sockA.close();
    sockB.close();
  } finally {
    await server.close();
  }
});

test("a dropped socket receives the running job again and the call finishes", async () => {
  const { server, directory } = await up();
  try {
    directory.addDevice("dev-a", "user-a");
    const paired = await claim(server.origin, "user-a", "dev-a");
    const agent = await directory.mintAgent("user-a", paired.deviceId);
    assert.ok(agent);
    const first = await openWebSocket(`${server.origin}/api/agent/relay`, { Authorization: `Bearer ${paired.token}` });
    let jobId = "";
    first.handlers.message = (text) => {
      const message = JSON.parse(text) as { type?: string; job?: { id: string } };
      if (message.type === "job" && message.job) jobId = message.job.id;
    };
    first.send(JSON.stringify({ type: "ready" }));
    const pending = tool(server.origin, agent.token, "run_workflow", { id: "books" });
    await waitFor(() => jobId !== "");
    first.close();
    const second = await openWebSocket(`${server.origin}/api/agent/relay`, { Authorization: `Bearer ${paired.token}` });
    let resumed = false;
    second.handlers.message = (text) => {
      const message = JSON.parse(text) as { type?: string; delivery?: string; job?: { id: string } };
      if (message.type !== "job" || !message.job) return;
      resumed = message.delivery === "again" && message.job.id === jobId;
      second.send(JSON.stringify({ type: "result", jobId: message.job.id, result: { outcome: "ok", title: "resumed" } }));
    };
    const done = await pending;
    assert.equal(resumed, true);
    assert.equal(done.json.outcome, "ok");
    assert.equal(done.json.title, "resumed");
    second.close();
  } finally {
    await server.close();
  }
});

test("secrets and CDP stay off the relay, and a screenshot is not stored", async () => {
  const store = new MemoryJobStore();
  const { server, directory } = await up(store);
  try {
    directory.addDevice("dev-a", "user-a");
    const paired = await claim(server.origin, "user-a", "dev-a");
    const agent = await directory.mintAgent("user-a", paired.deviceId);
    assert.ok(agent);
    const delivered: Record<string, unknown>[] = [];
    const socket = await connect(server.origin, paired.token, (_id, args) => delivered.push(args), (live, jobId) => {
      live.send(JSON.stringify({
        type: "result",
        jobId,
        result: {
          outcome: "ok",
          password: "s3cret",
          cookie: "sid=1",
          title: "Books",
          screenshot: PNG,
        },
      }));
    });
    const before = store.snapshot().length;
    const cdp = await tool(server.origin, agent.token, "run_workflow", {
      id: "books",
      method: "Runtime.evaluate",
      cookie: "sid=1",
    });
    assert.equal(cdp.body.result && (cdp.body.result as { isError?: boolean }).isError, true);
    assert.equal(store.snapshot().length, before);
    assert.match(JSON.stringify(cdp.body), /cdp is not a relay command/);

    const call = await tool(server.origin, agent.token, "run_workflow", {
      id: "books",
      permissionMode: "allow",
      autoApprove: true,
      inputs: { password: "s3cret", name: "ada", permissionMode: "allow" },
      cookie: "sid=1",
    });
    assert.equal(call.json.outcome, "ok");
    assert.equal(call.json.title, "Books");
    assert.equal(call.json.screenshot, undefined);
    assert.equal(call.image, PNG);
    const args = delivered[0] || {};
    const dumped = JSON.stringify(args);
    assert.equal(dumped.includes("s3cret"), false);
    assert.equal(dumped.includes("sid=1"), false);
    assert.equal(dumped.includes("permissionMode"), false);
    assert.equal((args.inputs as { name?: string } | undefined)?.name, "ada");
    const job = store.snapshot().find((item) => item.tool === "run_workflow" && item.status === "done");
    assert.ok(job);
    const stored = JSON.stringify({ args: job.args, result: job.result, events: job.events });
    assert.equal(stored.includes("s3cret"), false);
    assert.equal(stored.includes("sid=1"), false);
    assert.equal(stored.includes("iVBORw0KGgo"), false);
    assert.equal(stored.includes(PNG), false);
    const stream = await fetch(`${server.origin}/api/agent/jobs/${job.id}/stream`, {
      headers: { authorization: `Bearer ${agent.token}` },
    });
    const events = await stream.text();
    assert.equal(stream.status, 200);
    assert.equal(events.includes("s3cret"), false);
    assert.equal(events.includes("iVBORw0KGgo"), false);
    socket.close();
  } finally {
    await server.close();
  }
});

test("the device enforces ask or deny, and the driver follows the workflow", async () => {
  assert.equal(remoteRunAllowed("deny"), "deny");
  assert.equal(remoteRunAllowed("ask"), "ask");
  assert.equal(remoteRunAllowed(undefined), "ask");
  assert.equal(workflowDriver({}), "playwright");
  assert.equal(workflowDriver({ driver: "cdp-live" }), "playwright");
  assert.equal(workflowDriver({ driver: "extension" }), "extension");
  assert.equal(remoteDriverKind(undefined), "playwright");
  assert.equal(remoteDriverKind("cdp-live"), "cdp-live");
  assert.equal(remoteDriverKind("extension"), "extension");

  const root = mkdtempSync(path.join(tmpdir(), "bao-relay-device-"));
  const library = new Library(root);
  library.save(workflow("books"));
  library.save(workflow("ext", "extension"));
  library.save(workflow("live", "cdp-live"));
  library.saveRun({
    id: "run-1",
    workflowId: "books",
    status: "passed",
    at: 1,
    heals: [],
    steps: [],
    inputs: { password: "s3cret" },
    outputs: [{ name: "title", type: "text", value: "Books" }],
  });
  const { server, directory } = await up();
  try {
    directory.addDevice("dev-a", "user-a");
    const paired = await claim(server.origin, "user-a", "dev-a");
    const agent = await directory.mintAgent("user-a", paired.deviceId);
    assert.ok(agent);
    saveRelay(root, { server: server.origin, token: paired.token, deviceId: paired.deviceId, tokenId: paired.tokenId });
    library.updateSettings({ remoteMcp: true, remotePermission: "deny" });
    const calls = { extension: 0, cdpLive: 0, playwright: 0 };
    const runners = {
      extension: async () => { calls.extension += 1; return { outcome: "ok", via: "extension" }; },
      cdpLive: async () => { calls.cdpLive += 1; return { outcome: "ok", via: "cdp-live" }; },
      playwright: async () => { calls.playwright += 1; return { outcome: "ok", via: "playwright" }; },
    };
    const denied = createRemoteAgent({ library, prompts: {}, stop() {}, clearStop() {}, runners, autoAllow: true });
    denied.start();
    try {
      await waitFor(() => directory.lookups > 0);
      const blocked = await tool(server.origin, agent.token, "run_workflow", {
        id: "books",
        permissionMode: "allow",
        inputs: { permissionMode: "allow" },
      });
      assert.equal(blocked.json.outcome, "denied");
      assert.equal(calls.playwright, 0);
      const read = await tool(server.origin, agent.token, "get_run", { run_id: "run-1" });
      assert.equal(read.json.outcome, "ok");
      assert.equal(JSON.stringify(read.json).includes("s3cret"), false);
      assert.equal((read.json.outputs as { value: string }[])[0]?.value, "Books");
      const found = await tool(server.origin, agent.token, "search_workflows", { query: "books" });
      assert.equal(found.json.outcome, "ok");
    } finally {
      await denied.stop();
    }

    library.updateSettings({ remotePermission: "ask" });
    const asked = createRemoteAgent({ library, prompts: {}, stop() {}, clearStop() {}, runners });
    asked.start();
    try {
      const mark = directory.lookups;
      await waitFor(() => directory.lookups > mark);
      const pending = tool(server.origin, agent.token, "run_workflow", { id: "books", permissionMode: "deny", autoApprove: true });
      await waitFor(() => asked.view().phase === "approval");
      assert.equal(calls.playwright, 0);
      asked.allow();
      const allowed = await pending;
      assert.equal(allowed.json.outcome, "ok");
      assert.equal(allowed.json.via, "playwright");
      assert.equal(calls.playwright, 1);
    } finally {
      await asked.stop();
    }

    const auto = createRemoteAgent({ library, prompts: {}, stop() {}, clearStop() {}, runners, autoAllow: true });
    auto.start();
    try {
      const mark = directory.lookups;
      await waitFor(() => directory.lookups > mark);
      const ext = await tool(server.origin, agent.token, "run_workflow", { id: "ext" });
      assert.equal(ext.json.via, "extension");
      const live = await tool(server.origin, agent.token, "run_workflow", { id: "live" });
      assert.equal(live.json.via, "cdp-live");
      assert.equal(calls.playwright, 1);
    } finally {
      await auto.stop();
    }

    const missing = createRemoteAgent({ library, prompts: {}, stop() {}, clearStop() {}, autoAllow: true });
    missing.start();
    try {
      const mark = directory.lookups;
      await waitFor(() => directory.lookups > mark);
      const ext = await tool(server.origin, agent.token, "run_workflow", { id: "ext" });
      assert.equal(ext.json.outcome, "failed");
      assert.match(String(ext.json.reason), /extension is not connected/);
      const live = await tool(server.origin, agent.token, "run_workflow", { id: "live" });
      assert.equal(live.json.outcome, "failed");
      assert.match(String(live.json.reason), /live attach/);
    } finally {
      await missing.stop();
    }
  } finally {
    await server.close();
  }
});

test("resume_workflow during a local confirm returns needs_human and leaves the confirm up", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-relay-confirm-"));
  const library = new Library(root);
  library.save(workflow("books"));
  const token = "confirm-token";
  mkdirSync(path.join(root, "resumes"));
  writeFileSync(path.join(root, "resumes", `${token}.json`), JSON.stringify({ kind: "confirm" }));
  const { server, directory } = await up();
  try {
    directory.addDevice("dev-a", "user-a");
    const paired = await claim(server.origin, "user-a", "dev-a");
    const agent = await directory.mintAgent("user-a", paired.deviceId);
    assert.ok(agent);
    saveRelay(root, { server: server.origin, token: paired.token, deviceId: paired.deviceId, tokenId: paired.tokenId });
    library.updateSettings({ remoteMcp: true });
    const remote = createRemoteAgent({
      library,
      prompts: {},
      stop() {},
      clearStop() {},
      autoAllow: true,
      runners: {
        playwright: async () => ({ outcome: "needs_human", resume: token, workflowId: "books" }),
      },
    });
    remote.start();
    try {
      await waitFor(() => directory.lookups > 0);
      const paused = await tool(server.origin, agent.token, "run_workflow", { id: "books" });
      assert.equal(paused.json.outcome, "needs_human");
      assert.equal(paused.json.resume, token);
      await waitFor(() => remote.view().phase === "confirm");
      const started = Date.now();
      const refused = await tool(server.origin, agent.token, "resume_workflow", { resume: token, approved: true });
      assert.ok(Date.now() - started < 5_000);
      assert.equal(refused.json.outcome, "needs_human");
      assert.match(String(refused.json.reason), /Mac/);
      assert.equal(remote.view().phase, "confirm");
    } finally {
      await remote.stop();
    }
  } finally {
    await server.close();
  }
});

test("a websocket round trip delivers the job without a long-poll", async () => {
  const { server, directory } = await up();
  try {
    directory.addDevice("dev-a", "user-a");
    const paired = await claim(server.origin, "user-a", "dev-a");
    const agent = await directory.mintAgent("user-a", paired.deviceId);
    assert.ok(agent);
    for (const pathName of ["/api/agent/poll", "/api/agent/jobs/job-1/result"]) {
      const res = await fetch(`${server.origin}${pathName}`, {
        method: "POST",
        headers: { authorization: `Bearer ${paired.token}`, "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(res.status, 404, pathName);
      assert.deepEqual(await res.json(), { error: "not found" });
    }
    const wsRounds: number[] = [];
    const wsDeliveries: number[] = [];
    const socket = await openWebSocket(`${server.origin}/api/agent/relay`, { Authorization: `Bearer ${paired.token}` });
    let slot: { t0: number; delivery: number } | null = null;
    socket.handlers.message = (text) => {
      const message = JSON.parse(text) as { type?: string; job?: { id: string } };
      if (message.type !== "job" || !message.job || !slot) return;
      if (slot.delivery === 0) slot.delivery = Date.now() - slot.t0;
      socket.send(JSON.stringify({ type: "result", jobId: message.job.id, result: { outcome: "ok" } }));
      socket.send(JSON.stringify({ type: "ready" }));
    };
    socket.send(JSON.stringify({ type: "ready" }));
    for (let i = 0; i < 5; i += 1) {
      const t0 = Date.now();
      slot = { t0, delivery: 0 };
      const done = await tool(server.origin, agent.token, "run_workflow", { id: "books" });
      assert.equal(done.json.outcome, "ok");
      wsRounds.push(Date.now() - t0);
      wsDeliveries.push(slot.delivery);
    }
    socket.close();
    const line = `relay latency wsRoundTripMs=${median(wsRounds)} wsDeliveryMs=${median(wsDeliveries)}`;
    console.log(line);
    assert.ok(median(wsRounds) < 2000, line);
  } finally {
    await server.close();
  }
});

test("a Mac with remote MCP on and no relay.json makes no outbound request", async () => {
  const previous = process.env.BAO_REMOTE_MCP;
  delete process.env.BAO_REMOTE_MCP;
  const hits: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    hits.push(req.url || "");
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, socket) => {
    hits.push(req.url || "");
    socket.destroy();
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  const root = mkdtempSync(path.join(tmpdir(), "bao-relay-nodial-"));
  writeFileSync(path.join(root, "sync.json"), JSON.stringify({
    server: `http://127.0.0.1:${port}`,
    deviceToken: "fixture-device-token",
    deviceId: "dev-nodial",
  }));
  const library = new Library(root);
  library.updateSettings({ remoteMcp: true });
  const agent = createRemoteAgent({ library, prompts: {}, stop() {}, clearStop() {} });
  agent.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 1800));
    assert.equal(hits.length, 0);
    assert.equal(agent.view().phase, "idle");
  } finally {
    await agent.stop();
    if (previous === undefined) delete process.env.BAO_REMOTE_MCP;
    else process.env.BAO_REMOTE_MCP = previous;
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test("the relay answers 404 when the flag is off, including the websocket upgrade", async () => {
  const relay = createRelay({ store: new MemoryJobStore(), directory: new MemoryDirectory(), enabled: () => false });
  const server = await listenRelay(relay);
  try {
    for (const pathName of ["/mcp", "/api/agent/pair", "/api/agent/pair/claim", "/api/agent/pair/revoke", "/api/agent/poll", "/api/agent/relay", "/api/agent/jobs/job-x/stream", "/api/agent/jobs/job-x/result"]) {
      const res = await fetch(`${server.origin}${pathName}`, {
        method: pathName.endsWith("/stream") || pathName.endsWith("/relay") ? "GET" : "POST",
        headers: { "content-type": "application/json", authorization: "Bearer bao_rt_nope" },
        body: pathName.endsWith("/stream") || pathName.endsWith("/relay") ? undefined : "{}",
      });
      assert.equal(res.status, 404, pathName);
      assert.deepEqual(await res.json(), { error: "remote_disabled" });
    }
    await assert.rejects(
      openWebSocket(`${server.origin}/api/agent/relay`, { Authorization: "Bearer bao_rt_nope" }),
      /404|remote_disabled/,
    );
  } finally {
    await server.close();
  }
});

test("Settings pairs and revokes without putting the token in /api/state", { timeout: 60_000 }, async () => {
  const previous = process.env.BAO_REMOTE_MCP;
  const previousChrome = process.env.BAO_CHROME_USER_DATA;
  delete process.env.BAO_REMOTE_MCP;
  const home = mkdtempSync(path.join(tmpdir(), "bao-relay-settings-"));
  process.env.BAO_CHROME_USER_DATA = path.join(home, "no-chrome");
  const { server, directory } = await up();
  directory.addDevice("dev-settings", "user-settings");
  const app = await startApp({ home });
  try {
    writeFileSync(path.join(home, "sync.json"), JSON.stringify({
      deviceId: "dev-settings",
      deviceName: "Settings Mac",
    }));
    const issued = await issue(server.origin, "user-settings");
    const saved = await fetch(`http://127.0.0.1:${app.port}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ syncServer: server.origin, remotePermission: "deny", remoteMcp: false }),
    });
    assert.equal(saved.status, 200, await saved.clone().text());
    const paired = await fetch(`http://127.0.0.1:${app.port}/api/remote/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: issued.code }),
    });
    assert.equal(paired.status, 200, await paired.clone().text());
    const pairedBody = await paired.json() as { paired?: boolean; token?: string; deviceId?: string };
    assert.equal(pairedBody.paired, true);
    assert.equal(pairedBody.token, undefined);
    assert.equal(pairedBody.deviceId, "dev-settings");
    const file = statSync(relayPath(home));
    assert.equal(file.mode & 0o777, 0o600);
    const state = await fetch(`http://127.0.0.1:${app.port}/api/state`).then((res) => res.json()) as { relay?: { paired?: boolean; deviceId?: string }; settings?: { remotePermission?: string } };
    assert.equal(state.relay?.paired, true);
    assert.equal(state.relay?.deviceId, pairedBody.deviceId);
    assert.equal(state.settings?.remotePermission, "deny");
    assert.equal(JSON.stringify(state).includes("bao_rt_"), false);
    const js = await fetch(`http://127.0.0.1:${app.port}/app.js`).then((res) => res.text());
    assert.match(js, /Let a remote agent run workflows on this Mac/);
    assert.match(js, /id="relay-pair"/);
    assert.match(js, /id="remote-permission"/);
    const link = JSON.parse(readFileSync(relayPath(home), "utf8")) as { token: string };
    const mark = directory.lookups;
    const on = await fetch(`http://127.0.0.1:${app.port}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remoteMcp: true }),
    });
    assert.equal(on.status, 200);
    await waitFor(() => directory.lookups > mark);
    const revoked = await fetch(`http://127.0.0.1:${app.port}/api/remote/revoke`, { method: "POST" });
    assert.equal(revoked.status, 200);
    await assert.rejects(
      openWebSocket(`${server.origin}/api/agent/relay`, { Authorization: `Bearer ${link.token}` }),
      /401/,
    );
    const after = await fetch(`http://127.0.0.1:${app.port}/api/state`).then((res) => res.json()) as { relay?: { paired?: boolean } };
    assert.equal(after.relay?.paired, false);
    assert.equal(JSON.stringify(after).includes("bao_rt_"), false);
  } finally {
    await app.close();
    await server.close();
    if (previous === undefined) delete process.env.BAO_REMOTE_MCP;
    else process.env.BAO_REMOTE_MCP = previous;
    if (previousChrome === undefined) delete process.env.BAO_CHROME_USER_DATA;
    else process.env.BAO_CHROME_USER_DATA = previousChrome;
  }
});

test("a longer upgrade path is not swallowed by the relay hook", async () => {
  const relayJs = path.join(process.cwd(), "desktop/dist/web/src/lib/relay.js");
  const script = `
    const { createServer } = require("node:http");
    const { connect } = require("node:net");
    const { installRelayUpgrade } = require(${JSON.stringify(relayJs)});
    installRelayUpgrade();
    const hits = [];
    const server = createServer();
    server.on("upgrade", (req, socket) => {
      hits.push(new URL(req.url || "/", "http://127.0.0.1").pathname);
      socket.end("HTTP/1.1 404 no\\r\\nConnection: close\\r\\n\\r\\n");
    });
    function raw(port, pathname) {
      return new Promise((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port });
        const timer = setTimeout(() => { socket.destroy(); reject(new Error("upgrade timed out " + pathname)); }, 2000);
        socket.on("error", (err) => { clearTimeout(timer); reject(err); });
        socket.on("data", () => { clearTimeout(timer); socket.end(); resolve(); });
        socket.on("connect", () => {
          socket.write([
            "GET " + pathname + " HTTP/1.1",
            "Host: 127.0.0.1:" + port,
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version: 13",
            "",
            "",
          ].join("\\r\\n"));
        });
      });
    }
    (async () => {
      const port = await new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
      });
      await raw(port, "/api/agent/relay/extra");
      await raw(port, "/api/other");
      if (JSON.stringify(hits) !== JSON.stringify(["/api/agent/relay/extra", "/api/other"])) {
        console.error(JSON.stringify(hits));
        process.exit(1);
      }
      await new Promise((resolve) => server.close(resolve));
    })().catch((err) => {
      console.error(err);
      process.exit(1);
    });
  `;
  const child = spawn(process.execPath, ["-e", script], { cwd: process.cwd() });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (status) => resolve(status ?? 1));
  });
  assert.equal(code, 0, stderr);
});

function workflow(id: string, driver?: WorkflowV2["driver"]): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id,
    name: id,
    startUrl: "https://books.toscrape.com/",
    inputs: [],
    createdAt: 1,
    steps: [{ id: "note", index: 0, action: "note", label: "Note", surface: "dom", timeoutMs: 0 }],
    ...(driver ? { driver } : {}),
  };
}

function principalOf(req: IncomingMessage): { userId: string } | null {
  const user = req.headers["x-test-user"];
  return typeof user === "string" && user ? { userId: user } : null;
}

async function up(store = new MemoryJobStore()): Promise<{ server: { origin: string; close: () => Promise<void> }; directory: CountingDirectory }> {
  const directory = new CountingDirectory();
  const relay = createRelay({ store, directory, enabled: () => true });
  const server = await listenRelay(relay, { principal: principalOf });
  return { server, directory };
}

async function issue(origin: string, userId: string): Promise<{ code: string; expiresAt: string }> {
  const res = await fetch(`${origin}/api/agent/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": userId },
    body: "{}",
  });
  const body = await res.json() as { code?: string; expiresAt?: string };
  assert.equal(res.status, 200, JSON.stringify(body));
  return body as { code: string; expiresAt: string };
}

async function claim(origin: string, userId: string, deviceId: string): Promise<{ code: string; expiresAt: string; token: string; tokenId: string; deviceId: string }> {
  const issued = await issue(origin, userId);
  const res = await post(`${origin}/api/agent/pair/claim`, { code: issued.code, name: "Mac", deviceId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as { token: string; tokenId: string; deviceId: string };
  return { ...issued, ...body };
}

async function post(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function tool(origin: string, token: string, name: string, args: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ status: number; body: { result?: { content?: { type?: string; text?: string; data?: string }[]; isError?: boolean } }; json: Record<string, unknown>; image: string }> {
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json() as { result?: { content?: { type?: string; text?: string; data?: string }[]; isError?: boolean } };
  const text = body.result?.content?.find((item) => item.type === "text")?.text || "";
  let json: Record<string, unknown> = {};
  if (text) {
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { text }; }
  }
  const image = body.result?.content?.find((item) => item.type === "image")?.data || "";
  return { status: res.status, body, json, image };
}

function connect(origin: string, token: string, onJob: (jobId: string, args: Record<string, unknown>) => void, reply?: (socket: LiteSocket, jobId: string) => void): Promise<LiteSocket> {
  return openWebSocket(`${origin}/api/agent/relay`, { Authorization: `Bearer ${token}` }).then((socket) => {
    socket.handlers.message = (text) => {
      const message = JSON.parse(text) as { type?: string; job?: { id: string; args?: Record<string, unknown> } };
      if (message.type !== "job" || !message.job) return;
      onJob(message.job.id, message.job.args || {});
      reply?.(socket, message.job.id);
      socket.send(JSON.stringify({ type: "ready" }));
    };
    socket.send(JSON.stringify({ type: "ready" }));
    return socket;
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid] || 0;
  return ((sorted[mid - 1] || 0) + (sorted[mid] || 0)) / 2;
}

function waitFor(ready: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (ready()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > ms) {
        clearInterval(timer);
        reject(new Error("timed out"));
      }
    }, 15);
  });
}
