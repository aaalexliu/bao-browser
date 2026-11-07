import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRemoteAgent } from "../../src/v1/remote-agent";
import { saveRelay } from "../../src/v1/relay-link";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { MemoryJobStore } from "../../../web/src/lib/relay-job";
import { createRelay, listenRelay, MemoryDirectory } from "../../../web/src/lib/relay";

test("production remote resume never repeats a completed order from a non-held run", { timeout: 60_000 }, async () => {
  process.env.BAO_CHROME_NO_SANDBOX = "1";
  const home = mkdtempSync(path.join(tmpdir(), "bao-remote-resume-"));
  const library = new Library(home);
  let orders = 0;
  const site = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/order") {
      orders += 1;
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<button id="place" onclick="fetch('/order',{method:'POST'}).then(()=>document.getElementById('status').textContent='Placed')">Place order</button><p id="status"></p>`);
  });
  const directory = new MemoryDirectory();
  directory.addDevice("dev-resume", "user-resume");
  const relay = createRelay({ store: new MemoryJobStore(), directory, enabled: () => true });
  const server = await listenRelay(relay, { principal: () => ({ userId: "user-resume" }) });
  let stopped = false;
  const remote = createRemoteAgent({
    library, prompts: { shouldStop: () => stopped },
    stop() { stopped = true; }, clearStop() { stopped = false; },
  });
  async function post(route: string, body: unknown, token?: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${server.origin}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const json = await res.json() as Record<string, unknown>;
    assert.equal(res.status, 200, JSON.stringify(json));
    return json;
  }
  try {
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    const address = site.address();
    assert.ok(address && typeof address === "object");
    const placed: WorkflowV2["steps"][number] = {
      id: "place", index: 0, action: "click", label: "Place order", surface: "dom", timeoutMs: 1000, heal: "never",
      identity: { surface: "dom", role: "button", id: "place", name: "Place order", path: [] },
      postcondition: { kind: "text", match: "Placed", timeoutMs: 3000 },
    };
    const workflow: WorkflowV2 = {
      schema: "bao.workflow/v2", version: 2, id: "failed-order", name: "Synthetic order", createdAt: 1,
      startUrl: `http://127.0.0.1:${address.port}/`, inputs: [], steps: [placed, {
        id: "missing", index: 1, action: "click", label: "Missing follow-up", surface: "dom", timeoutMs: 0, heal: "never",
        identity: { surface: "dom", role: "button", id: "missing", name: "Missing follow-up", path: [] },
      }],
    };
    library.save(workflow);
    library.updateSettings({ remoteMcp: true });
    const issued = await post("/api/agent/pair", {});
    const paired = await post("/api/agent/pair/claim", { code: issued.code, name: "Synthetic Mac", deviceId: "dev-resume" });
    const agent = await directory.mintAgent("user-resume", "dev-resume");
    assert.ok(agent);
    saveRelay(home, { server: server.origin, token: String(paired.token), deviceId: String(paired.deviceId), tokenId: String(paired.tokenId) });
    async function tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const body = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, agent!.token);
      const result = body.result as { content?: { type: string; text?: string }[] };
      const text = result.content?.find((item) => item.type === "text")?.text;
      assert.ok(text, JSON.stringify(body));
      return JSON.parse(text) as Record<string, unknown>;
    }
    remote.start();
    let online = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if ((await tool("search_workflows", { query: "Synthetic" })).outcome === "ok") { online = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(online, "remote worker did not connect");
    const first = await tool("run_workflow", { id: workflow.id });
    assert.equal(first.outcome, "failed", JSON.stringify(first));
    assert.equal(orders, 1);
    assert.equal(library.readRun(String(first.runId || first.run_id)).modelCalls, 0);
    const token = String(first.resume || first.resume_token || "");
    assert.ok(token);
    const rejected = await tool("resume_workflow", { resume: token });
    assert.equal(rejected.outcome, "failed");
    assert.match(String(rejected.reason), /run_workflow/);
    assert.equal(orders, 1, "remote resume repeated the completed order");

    const gone = `r_${"a".repeat(32)}`;
    const goneFile = path.join(home, "resumes", `${gone}.json`);
    mkdirSync(path.dirname(goneFile), { recursive: true });
    writeFileSync(goneFile, JSON.stringify({ workflowId: workflow.id, stepId: "missing", publicInputs: {}, kind: "confirm" }));
    const missingBrowser = await tool("resume_workflow", { resume: gone });
    assert.equal(missingBrowser.outcome, "failed");
    assert.match(String(missingBrowser.reason), /browser is gone/);
    assert.equal(existsSync(goneFile), false);
    assert.equal(orders, 1);

    library.save({ ...workflow, id: "held-order", steps: [placed, {
      id: "confirm", index: 1, action: "confirm", human: true, label: "Finish on the site", surface: "dom", timeoutMs: 5000,
    }] });
    const held = await tool("run_workflow", { id: "held-order" });
    assert.equal(held.outcome, "needs_human");
    assert.equal(orders, 2);
    const resumed = await tool("resume_workflow", { resume: held.resume || held.resume_token });
    assert.equal(resumed.outcome, "ok", JSON.stringify(resumed));
    assert.equal(orders, 2, "held resume restarted its completed first step");
  } finally {
    await remote.stop();
    await server.close();
    await new Promise<void>((resolve) => site.close(() => resolve()));
  }
});
