import { fixtureDoc, fixtureStep, fixtureInput } from "../support/fixture-step";
// Hermetic relay. No browser, no registry process, no real Chrome profile.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import fc from "fast-check";
import { startApp } from "../../src/app/server";
import { workflowDriver } from "../../src/extension/protocol";
import { createRemoteAgent } from "../../src/v1/remote-agent";
import { replay, type Driver } from "../../src/v1/replay";
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

test("relay keeps pictures and owner data while credentials and CDP stay out", async () => {
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
          email: "ada@fixture.test",
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
      inputs: { password: "s3cret", name: "ada", email: "ada@fixture.test", path: "/Users/ada/books.csv", permissionMode: "allow" },
      cookie: "sid=1",
    });
    assert.equal(call.json.outcome, "ok");
    assert.equal(call.json.title, "Books");
    assert.equal(call.json.email, "ada@fixture.test");
    assert.equal(call.json.screenshot, undefined);
    assert.equal(call.image, PNG);
    const args = delivered[0] || {};
    const dumped = JSON.stringify(args);
    assert.equal(dumped.includes("s3cret"), false);
    assert.equal(dumped.includes("sid=1"), false);
    assert.equal(dumped.includes("permissionMode"), false);
    assert.equal((args.inputs as { name?: string } | undefined)?.name, "ada");
    assert.equal((args.inputs as { email?: string } | undefined)?.email, "ada@fixture.test");
    assert.equal((args.inputs as { path?: string } | undefined)?.path, "/Users/ada/books.csv");
    const job = store.snapshot().find((item) => item.tool === "run_workflow" && item.status === "done");
    assert.ok(job);
    const stored = JSON.stringify({ args: job.args, result: job.result, events: job.events });
    assert.equal(stored.includes("s3cret"), false);
    assert.equal(stored.includes("sid=1"), false);
    assert.equal(stored.includes("iVBORw0KGgo"), true);
    assert.equal(stored.includes(PNG), true);
    assert.equal(stored.includes("ada@fixture.test"), true);
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

test("requested remote runs start directly and keep the workflow's driver", async () => {
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
  library.save(workflow("live", "cdp-live" as unknown as WorkflowV2["driver"]));
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
    writeFileSync(path.join(root, "settings.json"), JSON.stringify({ remoteMcp: true, remotePermission: "deny" }));
    const calls = { extension: 0, live: 0, playwright: 0 };
    const runners = {
      extension: async () => { calls.extension += 1; return { outcome: "ok", via: "extension" }; },
      live: async () => { calls.live += 1; throw new Error("retired live runner called"); },
      playwright: async (_id: string, inputs: Record<string, unknown>) => {
        calls.playwright += 1;
        assert.equal(inputs.routing, "021000021");
        return { outcome: "ok", via: "playwright", readBack: inputs.routing };
      },
    };
    let extensionLinked = true;
    const auto = createRemoteAgent({ library, prompts: {}, stop() {}, clearStop() {}, runners, extensionLinked: () => extensionLinked });
    auto.start();
    try {
      const mark = directory.lookups;
      await waitFor(() => directory.lookups > mark);
      const requested = await tool(server.origin, agent.token, "run_workflow", { id: "books", inputs: { routing: "021000021" } });
      assert.equal(requested.json.outcome, "ok");
      assert.equal(requested.json.via, "playwright");
      assert.equal(requested.json.readBack, "021000021");
      assert.equal(calls.playwright, 1);
      const read = await tool(server.origin, agent.token, "get_run", { run_id: "run-1" });
      assert.equal(read.json.outcome, "ok");
      assert.equal((read.json.outputs as { value: string }[])[0]?.value, "Books");
      const found = await tool(server.origin, agent.token, "search_workflows", { query: "" });
      assert.equal(found.json.outcome, "ok");
      assert.ok((found.json.hits as { id: string }[]).some((hit) => hit.id === "ext"));
      const ext = await tool(server.origin, agent.token, "run_workflow", { id: "ext" });
      assert.equal(ext.json.via, "extension");
      library.save({ ...library.read("ext"), provenance: "fixture" });
      const hidden = await tool(server.origin, agent.token, "search_workflows", { query: "" });
      assert.equal((hidden.json.hits as { id: string }[]).some((hit) => hit.id === "ext"), false);
      const fixture = await tool(server.origin, agent.token, "run_workflow", { id: "ext" });
      assert.equal(fixture.json.via, "extension");
      library.save({ ...library.read("ext"), provenance: undefined });
      extensionLinked = false;
      const unlinked = await tool(server.origin, agent.token, "search_workflows", { query: "" });
      assert.equal((unlinked.json.hits as { id: string }[]).some((hit) => hit.id === "ext"), false);
      const disconnected = await tool(server.origin, agent.token, "run_workflow", { id: "ext" });
      assert.equal(disconnected.json.reason, "extension is not connected");
      assert.equal(calls.extension, 2);
      const live = await tool(server.origin, agent.token, "run_workflow", { id: "live" });
      assert.equal(live.json.outcome, "failed", JSON.stringify(live.json));
      assert.equal(live.json.reason, "this workflow used the retired live driver");
      assert.equal(live.json.runId, undefined);
      assert.equal(calls.live, 0);
      assert.throws(() => library.readRun("run-live"), /run not found/);
      assert.equal(calls.playwright, 1);
    } finally {
      await auto.stop();
    }

    const missing = createRemoteAgent({ library, prompts: {}, stop() {}, clearStop() {} });
    missing.start();
    try {
      const mark = directory.lookups;
      await waitFor(() => directory.lookups > mark);
      const ext = await tool(server.origin, agent.token, "run_workflow", { id: "ext" });
      assert.equal(ext.json.outcome, "failed");
      assert.match(String(ext.json.reason), /extension is not connected/);
      const live = await tool(server.origin, agent.token, "run_workflow", { id: "live" });
      assert.equal(live.json.outcome, "failed");
      assert.equal(live.json.reason, "this workflow used the retired live driver");
      assert.equal(live.json.runId, undefined);
      assert.equal(calls.live, 0);
      assert.throws(() => library.readRun("run-live"), /run not found/);
      assert.equal(calls.playwright, 1);
    } finally {
      await missing.stop();
    }
  } finally {
    await server.close();
  }
});

test("remote resume observes an explicit human step and unblocks queued runs after it completes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-relay-confirm-"));
  const library = new Library(root);
  const confirming: WorkflowV2 = fixtureDoc({ ...workflow("books"), steps: [fixtureStep({
    id: "confirm", index: 0, action: "confirm", human: true, surface: "dom", label: "Place order", timeoutMs: 0,
    postcondition: { kind: "text", match: "Placed", timeoutMs: 0 },
  })] });
  library.save(confirming);
  library.save(workflow("next"));
  const token = "confirm-token";
  let interacted = false;
  let stops = 0;
  let clears = 0;
  const resumed: string[] = [];
  const ran: string[] = [];
  const driver: Driver = {
    tree: async () => ({ nodes: [], texts: interacted ? ["Placed"] : [], values: [] }),
    snapshot: async () => ({}),
    click: async () => { assert.fail("Bao must not press the human target"); },
    fill: async () => {}, key: async () => {}, upload: async () => {}, drop: async () => {},
    digits: async () => {}, check: async () => {}, notify: async () => {},
  };
  async function confirm(humanReady: boolean): Promise<Record<string, unknown>> {
    const result = await replay(confirming, {}, driver, { yieldHuman: true, humanReady });
    assert.ok(result.status === "passed" || result.status === "paused", JSON.stringify(result));
    return result.status === "passed" ? { outcome: "ok", workflowId: "books" }
      : { outcome: "needs_human", resume: token, workflowId: "books" };
  }
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
      stop() { stops += 1; },
      clearStop() { clears += 1; },
      runners: {
        playwright: async (id) => {
          ran.push(id);
          if (id === "books") writeFileSync(path.join(root, "resumes", `${token}.json`), JSON.stringify({ kind: "confirm", deadline: Date.now() + 3000 }));
          return id === "books" ? confirm(false) : { outcome: "ok", workflowId: id };
        },
        resume: async (value) => {
          resumed.push(value);
          return confirm(true);
        },
      },
    });
    remote.start();
    try {
      await waitFor(() => directory.lookups > 0);
      const paused = await tool(server.origin, agent.token, "run_workflow", { id: "books" });
      assert.equal(paused.json.outcome, "needs_human");
      assert.equal(paused.json.resume, token);
      await waitFor(() => remote.view().phase === "waiting");
      const stillWaiting = await tool(server.origin, agent.token, "resume_workflow", { resume: token, approved: true });
      assert.equal(stillWaiting.json.outcome, "needs_human");
      assert.equal(remote.view().phase, "waiting");
      assert.deepEqual(resumed, [token]);
      assert.deepEqual(ran, ["books"]);
      const queued = tool(server.origin, agent.token, "run_workflow", { id: "next" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(ran, ["books"]);
      interacted = true;
      const completed = await tool(server.origin, agent.token, "resume_workflow", { resume: token });
      assert.equal(completed.json.outcome, "ok");
      assert.equal((await queued).json.outcome, "ok");
      assert.deepEqual(resumed, [token, token]);
      assert.deepEqual(ran, ["books", "next"]);
      assert.equal(clears, 4);
      await new Promise((resolve) => setTimeout(resolve, 3100));
      assert.equal(stops, 0);
      assert.equal(remote.view().phase, "idle");
    } finally {
      await remote.stop();
    }
  } finally {
    await server.close();
  }
});

for (const pause of ["signin", "wall", "deadline", "kill"] as const) {
  test(`remote ${pause} pause releases the slot`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bao-relay-release-"));
    const library = new Library(root);
    library.save(workflow("books"));
    library.save(workflow("next"));
    const token = "held-token";
    const file = path.join(root, "resumes", `${token}.json`);
    const { server, directory } = await up();
    let stops = 0;
    let clears = 0;
    try {
      directory.addDevice("dev-a", "user-a");
      const paired = await claim(server.origin, "user-a", "dev-a");
      const agent = await directory.mintAgent("user-a", paired.deviceId);
      assert.ok(agent);
      saveRelay(root, { server: server.origin, token: paired.token, deviceId: paired.deviceId, tokenId: paired.tokenId });
      library.updateSettings({ remoteMcp: true });
      const remote = createRemoteAgent({
        library, prompts: {}, stop() { stops += 1; }, clearStop() { clears += 1; },
        runners: { playwright: async (id) => {
          if (id !== "books") return { outcome: "ok" };
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, JSON.stringify({ workflowId: id, kind: pause === "signin" || pause === "wall" ? pause : "confirm", deadline: pause === "deadline" ? Date.now() + 1000 : null }));
          return { outcome: "needs_human", resume: token };
        } },
      });
      remote.start();
      try {
        await waitFor(() => directory.lookups > 0);
        const paused = await tool(server.origin, agent.token, "run_workflow", { id: "books" });
        assert.equal(paused.json.outcome, "needs_human");
        if (pause === "deadline" || pause === "kill") {
          assert.equal(remote.view().phase, "waiting");
          const local = replay(fixtureDoc({ ...workflow("local"), steps: [fixtureStep({
            id: "go", index: 0, action: "click", label: "Go", surface: "dom", timeoutMs: 0,
            identity: { surface: "dom", role: "button", name: "Go", path: [] },
            postcondition: { kind: "text", match: "Done", timeoutMs: 5000 },
          })] }), {}, {
            tree: async () => ({ nodes: [{ surface: "dom", role: "button", name: "Go", path: [] }], texts: remote.view().phase === "idle" ? ["Done"] : [], values: [] }),
            snapshot: async () => ({}), click: async () => {}, fill: async () => {}, key: async () => {},
            upload: async () => {}, drop: async () => {}, digits: async () => {}, check: async () => {}, notify: async () => {},
            shouldStop: () => stops > 0,
            sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); },
          });
          if (pause === "kill") remote.kill();
          await waitFor(() => remote.view().phase === "idle");
          assert.equal((await local).status, "passed");
          assert.equal(existsSync(file), false);
          assert.equal(stops, 0);
        } else {
          assert.equal(remote.view().phase, "idle");
        }
        const next = await tool(server.origin, agent.token, "run_workflow", { id: "next" });
        assert.equal(next.json.outcome, "ok");
        assert.equal(clears, 2);
      } finally {
        await remote.stop();
      }
    } finally {
      await server.close();
    }
  });
}

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
    assert.equal(state.settings?.remotePermission, undefined);
    assert.equal(JSON.stringify(state).includes("bao_rt_"), false);
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
  return fixtureDoc({
    schema: "bao.workflow/v4",
    version: 2,
    id,
    name: id,
    startUrl: "https://books.toscrape.com/",
    inputs: [],
    createdAt: 1,
    steps: [fixtureStep({ id: "note", index: 0, action: "note", label: "Note", surface: "dom", timeoutMs: 0 })],
    ...(driver ? { driver } : {}),
  });
}

for (const mode of ["extension", "playwright", "cached", "get_run"] as const) {
  test(`${mode} relay payloads scrub generated typed values without rewriting local evidence`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "bao-relay-outbound-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const library = new Library(root);
    let cachedResult: Record<string, unknown> = {};
    class CachedStore extends MemoryJobStore {
      override async claim(...args: Parameters<MemoryJobStore["claim"]>) {
        if (mode === "cached") {
          mkdirSync(path.join(root, "relay-results"), { recursive: true });
          writeFileSync(path.join(root, "relay-results", `${args[1]}.json`), JSON.stringify(cachedResult));
        }
        return super.claim(...args);
      }
    }
    const { server, directory } = await up(new CachedStore());
    t.after(() => server.close());
    directory.addDevice("dev-a", "user-a");
    const paired = await claim(server.origin, "user-a", "dev-a");
    const token = await directory.mintAgent("user-a", paired.deviceId);
    assert.ok(token);
    saveRelay(root, { server: server.origin, token: paired.token, tokenId: paired.tokenId, deviceId: paired.deviceId });
    library.updateSettings({ remoteMcp: true });
    let runnerCalls = 0;
    const runner = async (_id: string, inputs: Record<string, string | number>) => {
      runnerCalls += 1;
      assert.equal(inputs.credential, cachedResult.reason);
      return cachedResult;
    };
    const remote = createRemoteAgent({
      library, prompts: {}, stop() {}, clearStop() {},
      extensionLinked: () => mode === "extension",
      runners: { extension: runner, playwright: runner },
    });
    remote.start();
    try {
      await waitFor(() => directory.lookups > 0);
      for (const seed of fc.sample(fc.integer({ min: 1, max: 1000000 }), { seed: 739, numRuns: 3 })) {
        const secret = `relay-password-${seed}`;
        const doc = workflow(`outbound-${seed}`, mode === "extension" ? "extension" : undefined);
        doc.inputs = [fixtureInput({ name: "credential", type: "secret", label: "Credential", default: `default-${secret}` })];
        const runId = `run-${seed}`;
        const outputs = [
          { name: secret, type: "text" as const, value: secret },
          { name: "token", type: "text" as const, value: "sk-relayOutboundToken" },
          { name: "card", type: "text" as const, value: "4111111111111111" },
          { name: "prose", type: "text" as const, value: `prefix ${secret} suffix` },
          { name: "plain", type: "text" as const, value: "Keep this text" },
        ];
        library.save(doc);
        library.saveRun({ id: runId, workflowId: doc.id, status: "passed", at: 1, heals: [], steps: [], inputs: { credential: secret }, outputs });
        const runFile = path.join(root, "runs", `${runId}.json`);
        const before = readFileSync(runFile, "utf8");
        const original = library.read(doc.id);
        cachedResult = {
          outcome: "ok", workflowId: doc.id, runId, outputs, reason: secret,
          receipts: [{ id: "read", status: "passed", readBack: secret }],
          screenshot: PNG, resume: "local-resume-token", resume_token: "local-resume-token",
        };
        const raw = structuredClone(cachedResult);
        const done = await tool(server.origin, token.token, mode === "get_run" ? "get_run" : "run_workflow", mode === "get_run" ? { run_id: runId } : { id: doc.id, inputs: { credential: secret } });
        assert.equal(done.json.outcome, "ok", JSON.stringify(done.json));
        const sent = done.json.outputs as { name: string; value: string }[];
        assert.deepEqual(sent.map((output) => output.value), ["[secret stripped]", "[secret stripped]", "[secret stripped]", `prefix ${secret} suffix`, "Keep this text"]);
        assert.equal(sent[0]?.name, secret);
        if (mode !== "get_run") {
          assert.equal((done.json.receipts as { readBack: string }[])[0]?.readBack, "[secret stripped]");
          assert.equal(done.json.reason, secret);
          assert.equal(done.json.resume, "local-resume-token");
          assert.equal(done.json.resume_token, "local-resume-token");
          assert.equal(done.image, PNG);
        }
        assert.equal(readFileSync(runFile, "utf8"), before);
        assert.deepEqual(library.read(doc.id), original);
        assert.deepEqual(cachedResult, raw);
      }
      assert.equal(runnerCalls, mode === "cached" || mode === "get_run" ? 0 : 3);
    } finally {
      await remote.stop();
    }
  });
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
