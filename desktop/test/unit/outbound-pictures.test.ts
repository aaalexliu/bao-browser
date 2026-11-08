import { targetFor, testWorkflow,  } from "../support/workflow";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";
import test from "node:test";
import { hasPrivatePictureInput } from "../../../shared/outbound-secrets";
import { MemoryJobStore } from "../../../web/src/lib/relay-job";
import { createRelay, listenRelay, MemoryDirectory } from "../../../web/src/lib/relay";
import { createRemoteAgent } from "../../src/v1/remote-agent";
import { saveRelay } from "../../src/v1/relay-link";
import { blankPng } from "../../src/v1/redacted-png";
import type { Identity, WorkflowStep, WorkflowV2 } from "../../src/v1/schema";
import { shotFile, workflowShotName } from "../../src/v1/shots";
import { Library } from "../../src/v1/store";
import { saveState, syncAll } from "../../src/v1/sync";

function typeStep(id: string, index: number, node: Identity): WorkflowStep {
  return { id, index, timeoutMs: 1000, caption: { text: "Click Pay" }, action: "type", target: targetFor(node), text: { literal: "" } };
}

function workflow(id: string): WorkflowV2 {
  return testWorkflow({
    schema: "bao.workflow/v4", id, name: "Synthetic picture upload", createdAt: 1,
    startUrl: "http://127.0.0.1:9/fixture", inputs: [],
    steps: [{
      id: "go",
      index: 0,
      timeoutMs: 1000,
      caption: { text: "Click Pay" },
      action: "click",
      target: { locators: [{ kind: "role", role: "button", name: "Click Pay" }] },
    }],
  });
}

test("the shared outbound picture rule recognizes private input kinds and nested field identities", () => {
  for (const name of ["password", "card", "cc-exp", "one time code", "SSN", "CVV", "routing number", "PIN"]) {
    const doc = workflow("declaration");
    doc.inputs = [{ name: "answer", type: "text", label: name, supply: "must" }];
    assert.equal(hasPrivatePictureInput(doc), true, name);
    doc.inputs = [{ name: name, type: "text", label: name, supply: "must" }];
    assert.equal(hasPrivatePictureInput(doc), true, name);
  }
  const secret = workflow("secret");
  secret.inputs = [{ name: "answer", type: "secret", label: "answer", supply: "must" }];
  assert.equal(hasPrivatePictureInput(secret), true);
  const hints: Partial<Identity>[] = [
    { inputType: "password" },
    ...["current-password", "new-password", "cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-name", "one-time-code"].map((autocomplete) => ({ autocomplete })),
    { nameAttr: "ssn" }, { id: "pin" }, { label: "Routing number" }, { placeholder: "CVV" },
    { name: "Card number", nameAttr: "answer" },
  ];
  for (const hint of hints) {
    const doc = workflow("field");
    const typed = typeStep("go", 0, { surface: "dom", role: "textbox", tag: "input", path: [], ...hint });
    doc.steps = [typed];
    assert.equal(hasPrivatePictureInput(doc), true, JSON.stringify(hint));
    doc.steps = [{ id: "go", index: 0, timeoutMs: 1000, caption: { text: "Click Pay" }, action: "for_each", forEach: { over: { kind: "input", name: "rows" }, steps: [typed] } }];
    assert.equal(hasPrivatePictureInput(doc), true, `nested ${JSON.stringify(hint)}`);
  }
  const ordinary = workflow("ordinary");
  ordinary.inputs = [{ name: "email", type: "text", label: "email", supply: "must" }, { name: "attachment", type: "file", label: "attachment", supply: "must" }];
  assert.equal(hasPrivatePictureInput(ordinary), false);
});

test("sync omits private-workflow step pictures from versions and runs without changing local crops", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-outbound-pictures-"));
  const library = new Library(root);
  const sent = new Map<string, { shots: { stepId: string; png: string }[] }>();
  const server = createServer((req, res) => {
    if (req.url === "/api/sync/snapshot") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    void text(req).then((body) => {
      if (req.method === "POST") sent.set(req.url!, JSON.parse(body) as { shots: { stepId: string; png: string }[] });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/api/devices" ? { devices: [], categories: [] } : { version: 1, ok: true }));
    }).catch((error: unknown) => { res.writeHead(500); res.end(String(error)); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    saveState(root, {
      server: `http://127.0.0.1:${address.port}`, deviceToken: "fixture-token", deviceId: "fixture", deviceName: "Fixture",
      backedUp: true, workflows: {}, pushedRuns: [], remoteDevices: [], remoteCategories: [], conflicts: [],
    });
    const png = blankPng(120, 60);
    const localFiles: string[] = [];
    for (const id of ["private-declared", "private-field", "ordinary"]) {
      const doc = workflow(id);
      if (id === "private-declared") doc.inputs = [{ name: "PIN", type: "text", label: "PIN", supply: "must" }];
      if (id === "private-field") doc.steps.push(typeStep("card", 1, { surface: "dom", role: "textbox", tag: "input", autocomplete: "cc-number", path: [] }));
      library.save(doc);
      const runId = `run-${id}`;
      library.saveRun({ id: runId, workflowId: id, status: "passed", at: 1, heals: [], steps: doc.steps.map((step) => ({ id: step.id, status: "passed" })) });
      for (const step of doc.steps) {
        const files = [
          path.join(root, "shots", "workflows", id, workflowShotName(step.id)),
          path.join(root, "shots", "runs", runId, shotFile(step.id, "after")),
        ];
        for (const file of files) {
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, png);
          localFiles.push(file);
        }
      }
    }
    for (const id of ["missing", "deleted", "damaged"]) {
      if (id === "deleted") { library.save(workflow(id)); library.remove(id); }
      if (id === "damaged") writeFileSync(path.join(root, "workflows", `${id}.json`), "{invalid");
      library.saveRun({ id: `run-${id}`, workflowId: id, status: "passed", at: 1, heals: [], steps: [{ id: "go", status: "passed" }] });
      const file = path.join(root, "shots", "runs", `run-${id}`, shotFile("go", "after"));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, png);
      localFiles.push(file);
    }
    await syncAll(library, "push");
    for (const id of ["missing", "deleted", "damaged"]) {
      const body = sent.get(`/api/workflows/${id}/runs`);
      assert.ok(body, id);
      assert.deepEqual(body.shots, [], id);
      assert.equal(sent.has(`/api/workflows/${id}/versions`), false, id);
    }
    for (const id of ["private-declared", "private-field", "ordinary"]) {
      for (const suffix of ["versions", "runs"]) {
        const body = sent.get(`/api/workflows/${id}/${suffix}`);
        assert.ok(body, `${id}/${suffix}`);
        assert.deepEqual(body.shots.map((shot) => shot.stepId), id === "ordinary" ? ["go"] : [], `${id}/${suffix}`);
      }
    }
    for (const file of localFiles) assert.deepEqual(readFileSync(file), png);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("relay run results omit private-input pictures and reject unreadable workflows while retaining ordinary pictures", { timeout: 60000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-relay-pictures-"));
  const library = new Library(root);
  const site = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end('<input id="pin" value="482731"><button id="go">Continue</button>');
  });
  const directory = new MemoryDirectory();
  directory.addDevice("picture-device", "picture-owner");
  const relay = createRelay({ store: new MemoryJobStore(), directory, enabled: () => true });
  const server = await listenRelay(relay, { principal: () => ({ userId: "picture-owner" }) });
  let stopped = false;
  const remote = createRemoteAgent({
    library, prompts: { shouldStop: () => stopped },
    stop() { stopped = true; }, clearStop() { stopped = false; },
  });
  const post = async (route: string, body: unknown, token?: string): Promise<Record<string, unknown>> => {
    const response = await fetch(`${server.origin}${route}`, {
      method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const result = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  try {
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    const address = site.address();
    assert.ok(address && typeof address !== "string");
    for (const id of ["private", "ordinary"]) {
      const doc = workflow(id);
      doc.startUrl = `http://127.0.0.1:${address.port}/`;
      if (id === "private") doc.inputs = [{ name: "PIN", type: "text", label: "PIN", supply: "must" }];
      const go = doc.steps[0]!;
      if (go.action === "click") go.target = targetFor({ surface: "dom", role: "button", tag: "button", id: "go", path: [] });
      doc.steps[0]!.heal = "never";
      library.save(doc);
    }
    writeFileSync(path.join(root, "workflows", "damaged.json"), "{invalid");
    library.updateSettings({ remoteMcp: true, pageEngine: "old" });
    const issued = await post("/api/agent/pair", {});
    const paired = await post("/api/agent/pair/claim", { code: issued.code, name: "Synthetic Mac", deviceId: "picture-device" });
    const agent = await directory.mintAgent("picture-owner", "picture-device");
    assert.ok(agent);
    saveRelay(root, { server: server.origin, token: String(paired.token), deviceId: String(paired.deviceId), tokenId: String(paired.tokenId) });
    const tool = async (name: string, args: Record<string, unknown>) => {
      const body = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, agent.token);
      const result = body.result as { content: { type: string; text?: string }[] };
      const output = result.content.find((item) => item.type === "text")?.text;
      assert.ok(output, JSON.stringify(body));
      return { output: JSON.parse(output) as Record<string, unknown>, images: result.content.filter((item) => item.type === "image") };
    };
    remote.start();
    let online = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if ((await tool("search_workflows", { query: "Synthetic" })).output.outcome === "ok") { online = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(online, "remote worker did not connect");
    for (const id of ["private", "ordinary", "missing", "damaged"]) {
      const result = await tool("run_workflow", { id, inputs: id === "private" ? { PIN: "482731" } : {} });
      const readable = id === "private" || id === "ordinary";
      assert.equal(result.output.outcome, readable ? "ok" : "failed", JSON.stringify(result.output));
      assert.equal(result.images.length, id === "ordinary" ? 1 : 0, id);
      if (readable) {
        const runId = String(result.output.runId || result.output.run_id);
        const png = readFileSync(path.join(root, "shots", "runs", runId, shotFile("go", "after")));
        assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      }
    }
  } finally {
    await remote.stop();
    await server.close();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
