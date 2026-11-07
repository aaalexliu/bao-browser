import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { McpClient } from "../../src/eval/mcp-client";
import { frameRpc } from "../../src/mcp/frame";
import { TOOL_NAMES, TOOLS } from "../../src/mcp/server";
import { UI_EXTENSION, VIEWER_MIME, VIEWER_URI } from "../../src/mcp/viewer";
import { VIEWER_TOOLS } from "../../src/mcp/viewer-tools";
import { Library } from "../../src/v1/store";
import type { WorkflowV2 } from "../../src/v1/schema";

const names = ["search_workflows", "describe_workflow", "run_workflow", "get_run", "agent_browser"];
const retired = ["live_session_start", "live_snapshot", "live_click", "live_type", "live_key", "live_select", "live_scroll", "live_navigate", "live_read", "live_screenshot", "live_tabs", "live_switch_tab", "live_stop"];
const workflow: WorkflowV2 = { schema: "bao.workflow/v2", version: 2, id: "saved", name: "Saved workflow", createdAt: 1, startUrl: "https://example.test/", inputs: [], steps: [] };

async function fixture(run: (client: McpClient, library: Library) => Promise<void>): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), "bao-mcp-test-"));
  const client = McpClient.start({ ...process.env, HOME: home, BAO_HOME: home, BAO_HEAL_CURSOR_ACCOUNT: "0" });
  try { await run(client, new Library(home)); }
  finally { await client.close(); rmSync(home, { recursive: true, force: true }); }
}

test("MCP advertises only catalog and pass-through tools, even after saving a workflow", async () => {
  await fixture(async (client, library) => {
    assert.deepEqual(await client.handshake(), names);
    library.save(workflow);
    assert.deepEqual((await client.request("tools/list", {})).tools?.map((tool) => tool.name), names);
    const result = await client.call("search_workflows", { query: "Saved" });
    assert.equal(result.isError, false);
    assert.equal((JSON.parse(result.text) as { hits: { id: string }[] }).hits[0]?.id, workflow.id);
  });
});

test("retired tools fail without contacting an app or starting Chrome", async () => {
  await fixture(async (client, library) => {
    await client.handshake();
    for (const name of retired) {
      const result = await client.call(name, {});
      assert.equal(result.isError, true, name);
      assert.equal(result.text, "unknown tool", name);
    }
    assert.deepEqual(library.listRuns(), []);
  });
});

test("MCP rejects retired workflow replay with a clear reason", async () => {
  await fixture(async (client, library) => {
    library.save({ ...workflow, driver: "cdp-live" });
    await client.handshake();
    const result = await client.call("run_workflow", { id: workflow.id });
    const outcome = JSON.parse(result.text) as { outcome: string; reason: string };
    assert.equal(outcome.outcome, "failed");
    assert.equal(outcome.reason, "this workflow used the retired live driver");
    assert.deepEqual(library.listRuns(), []);
  });
});

test("closing stdin completes a queued catalog request with newline replies to header framing", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-mcp-framing-"));
  const child = spawn(process.execPath, [path.resolve(__dirname, "../../src/app/cli.js"), "mcp"], {
    env: { ...process.env, HOME: home, BAO_HOME: home, BAO_HEAL_CURSOR_ACCOUNT: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (bytes: Buffer) => { output += bytes.toString(); });
  child.stderr.on("data", (bytes: Buffer) => { errors += bytes.toString(); });
  try {
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    child.stdin.end(frameRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "headers"));
    assert.equal(await exited, 0, errors);
    const reply = JSON.parse(output.trim()) as { result: { tools: { name: string }[] } };
    assert.deepEqual(reply.result.tools.map((tool) => tool.name), names);
  } finally { child.kill(); rmSync(home, { recursive: true, force: true }); }
});

const cli = path.resolve(__dirname, "../../src/app/cli.js");

function frame(msg: unknown): Buffer {
  return Buffer.from(frameRpc(msg, "json"));
}

interface Reply {
  id?: number;
  error?: { code: number; message: string };
  result?: {
    capabilities?: Record<string, unknown>;
    resources?: { uri: string; mimeType: string }[];
    contents?: { uri: string; mimeType: string; text: string; _meta?: unknown }[];
    _meta?: { baoViewer?: { run?: { id: string; modelCalls: number | null }; runs?: { id: string }[] }; baoPictures?: { pictures: unknown[] } };
    tools?: { name: string; description?: string; _meta?: { ui?: { resourceUri?: string; visibility?: string[] } } }[];
    instructions?: string;
    serverInfo?: { name?: string };
    content?: { text?: string }[];
    isError?: boolean;
  };
}

interface Mcp {
  home: string;
  child: ChildProcessWithoutNullStreams;
  request(method: string, params?: unknown): Promise<Reply>;
  tool(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

// The child gets its own HOME, so it never reads or writes the person's library.
function startMcp(prefix: string, cmd = "mcp"): Mcp {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const home = path.join(root, "library");
  const user = path.join(root, "user");
  mkdirSync(user);
  const child = spawn(process.execPath, [cli, cmd], {
    env: { ...process.env, HOME: user, BAO_HOME: home, BAO_HEAL_CURSOR_ACCOUNT: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: Reply[] = [];
  let buf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith("{")) messages.push(JSON.parse(line) as Reply);
      nl = buf.indexOf("\n");
    }
  });
  let nextId = 1;
  const request = async (method: string, params?: unknown): Promise<Reply> => {
    const id = nextId++;
    child.stdin.write(frame({ jsonrpc: "2.0", id, method, params }));
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const hit = messages.find((msg) => msg.id === id);
      if (hit) return hit;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no reply ${id}`);
  };
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await request("tools/call", { name, arguments: args });
    return { text: reply.result?.content?.[0]?.text || "", isError: reply.result?.isError === true };
  };
  child.once("exit", () => rmSync(root, { recursive: true, force: true }));
  return { home, child, request, tool };
}

async function initialize(mcp: Mcp): Promise<Reply> {
  const reply = await mcp.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "scripted", version: "0" } });
  mcp.child.stdin.write(frame({ jsonrpc: "2.0", method: "notifications/initialized" }));
  return reply;
}

test("non-UI clients retain exactly the existing catalog and results, including unsupported UI MIME types", async () => {
  const legacy = startMcp("bao-mcp-no-ui-");
  const unsupported = startMcp("bao-mcp-unsupported-ui-");
  try {
    const first = await initialize(legacy);
    const other = await unsupported.request("initialize", { capabilities: { extensions: { [UI_EXTENSION]: { mimeTypes: ["text/plain"] } } } });
    assert.deepEqual(first.result?.capabilities, { tools: {} });
    assert.deepEqual(other.result?.capabilities, first.result?.capabilities);
    assert.deepEqual((await legacy.request("tools/list")).result?.tools, TOOLS);
    assert.deepEqual((await unsupported.request("tools/list")).result?.tools, TOOLS);
    assert.deepEqual(await legacy.tool("search_workflows", { query: "missing" }), { text: '{"damagedWorkflows":[],"hits":[]}', isError: false });
    assert.equal((await legacy.tool("list_runs")).isError, true);
    assert.equal((await legacy.request("resources/list")).error?.code, -32601);
    assert.equal((await legacy.request("resources/read", { uri: VIEWER_URI })).error?.code, -32601);
  } finally { legacy.child.kill(); unsupported.child.kill(); }
});

test("UI clients negotiate one bundled resource, read history/receipt, and keep images out of model results", async () => {
  const mcp = startMcp("bao-mcp-ui-");
  const legacy = startMcp("bao-mcp-ui-compare-");
  try {
    const init = await mcp.request("initialize", { capabilities: { extensions: { [UI_EXTENSION]: { mimeTypes: [VIEWER_MIME] } } } });
    await initialize(legacy);
    assert.deepEqual(init.result?.capabilities, { tools: {}, resources: {}, extensions: { [UI_EXTENSION]: { mimeTypes: [VIEWER_MIME] } } });
    const tools = (await mcp.request("tools/list")).result?.tools || [];
    assert.deepEqual(tools.map((tool) => tool.name), [...TOOL_NAMES, ...VIEWER_TOOLS.map((tool) => tool.name)]);
    for (const name of TOOL_NAMES) assert.deepEqual(tools.find((tool) => tool.name === name)?._meta?.ui?.visibility, ["model"], `${name} cannot be called by the read-only iframe`);
    assert.deepEqual(tools.find((tool) => tool.name === "open_step_pictures")?._meta?.ui?.visibility, ["app"]);
    const resources = await mcp.request("resources/list");
    assert.equal(resources.result?.resources?.length, 1);
    assert.equal(resources.result?.resources?.[0]?.uri, VIEWER_URI);
    const resource = await mcp.request("resources/read", { uri: VIEWER_URI });
    assert.equal(resource.result?.contents?.[0]?.mimeType, VIEWER_MIME);
    assert.match(resource.result?.contents?.[0]?.text || "", /^<!doctype html>/);
    assert.equal((await mcp.request("resources/read", { uri: "file:///etc/passwd" })).error?.code, -32002);
    const run = { id: "run-ui", workflowId: "wf-shelf", at: 1, steps: [], heals: [], status: "passed" };
    for (const home of [mcp.home, legacy.home]) {
      const library = new Library(home);
      library.save(JSON.parse(shelfWorkflow) as WorkflowV2); library.saveRun(run);
    }
    const history = await mcp.request("tools/call", { name: "list_runs", arguments: {} });
    assert.equal(history.result?._meta?.baoViewer?.runs?.[0]?.id, run.id);
    assert.match(history.result?.content?.[0]?.text || "", /run-ui/);
    const receipt = await mcp.request("tools/call", { name: "get_run", arguments: { run_id: run.id } });
    assert.deepEqual(receipt.result?.content, (await legacy.request("tools/call", { name: "get_run", arguments: { run_id: run.id } })).result?.content);
    assert.equal(receipt.result?._meta?.baoViewer?.run?.modelCalls, null);
    const detail = await mcp.request("tools/call", { name: "inspect_run", arguments: { run_id: run.id } });
    assert.equal(detail.result?._meta?.baoViewer?.run?.id, run.id);
    assert.equal(detail.result?._meta?.baoPictures, undefined);
    const invalid = await mcp.request("tools/call", { name: "inspect_run", arguments: { run_id: "../outside" } });
    assert.equal(invalid.result?.isError, true);
    assert.doesNotMatch(invalid.result?.content?.[0]?.text || "", new RegExp(mcp.home));
    const startedAt = 1_700_000_000_000;
    for (const [template, reason] of [
      ["{{report.name}}", "ZXQLEFTZXQRIGHT.txt"],
      ["report.csv", "open /Users/owner/private/report.csv"],
    ] as const) {
      const workflow: WorkflowV2 = { ...JSON.parse(shelfWorkflow) as WorkflowV2, version: 3, filesDates: 1, inputs: [{ name: "password", type: "secret" }], steps: [
        { id: "source", index: 0, action: "download", label: "Source", surface: "dom", timeoutMs: 1000, download: { output: "report", name: "{{password}}.txt" } },
        { id: "preview", index: 1, action: "download", label: "Report", surface: "dom", timeoutMs: 1000, download: { output: "copy", name: template } },
      ] };
      for (const home of [mcp.home, legacy.home]) {
        const library = new Library(home);
        library.save(workflow);
        utimesSync(path.join(home, "workflows", `${workflow.id}.json`), (startedAt - 10_000) / 1000, (startedAt - 10_000) / 1000);
        library.saveRun({ ...run, at: startedAt + 1000, videoStartedAt: startedAt, status: "failed", steps: [{ id: "preview", status: "failed", startedAt, reason }], failure: { stepId: "preview", reason }, envelope: { status: "failed", step: "preview", reason, ask: reason } });
      }
      const projected = await mcp.request("tools/call", { name: "get_run", arguments: { run_id: run.id } });
      const plain = await legacy.request("tools/call", { name: "get_run", arguments: { run_id: run.id } });
      assert.deepEqual(projected.result?.content, plain.result?.content);
      assert.ok(projected.result?.content?.[0]?.text?.includes(reason));
      const metadata = projected.result?._meta?.baoViewer as { reason?: string; handoff?: { ask?: string }; steps: { reason?: string; picturesAllowed: boolean }[] };
      assert.ok(metadata);
      assert.equal(metadata.reason, reason);
      assert.equal(metadata.steps[0]?.reason, reason);
      assert.equal(metadata.steps[0]?.picturesAllowed, true);
      assert.equal(metadata.handoff?.ask, reason);
      const inspected = await mcp.request("tools/call", { name: "inspect_run", arguments: { run_id: run.id } });
      assert.deepEqual(inspected.result?._meta?.baoViewer, metadata);
      assert.deepEqual(JSON.parse(inspected.result?.content?.[0]?.text || "null"), metadata);
    }
  } finally { mcp.child.kill(); legacy.child.kill(); }
});

const shelfWorkflow = `{
  "schema": "bao.workflow/v2",
  "version": 2,
  "id": "wf-shelf",
  "name": "Shelf",
  "startUrl": "https://example.test/",
  "createdAt": 1,
  "inputs": [],
  "steps": []
}
`;
