import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { McpClient } from "../../src/eval/mcp-client";
import { frameRpc } from "../../src/mcp/frame";
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
