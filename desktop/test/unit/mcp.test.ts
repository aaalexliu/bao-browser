import { fixtureDoc, fixtureInput, fixtureStep, withStep } from "../support/fixture-step";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { McpClient } from "../../src/eval/mcp-client";
import { runWorkflow, withHeldPage } from "../../src/mcp/catalog";
import type { LibraryIdentity } from "../../src/home";
import { frameRpc } from "../../src/mcp/frame";
import { launchOwnedChrome, pidsForDataDir } from "../../src/launch";
import { TOOL_NAMES, TOOLS } from "../../src/mcp/server";
import { createMcpVersionCheck, McpVersionError } from "../../src/mcp/version";
import { UI_EXTENSION, VIEWER_MIME, VIEWER_URI } from "../../src/mcp/viewer";
import { VIEWER_TOOLS } from "../../src/mcp/viewer-tools";
import type { BrowserToolCard } from "../../src/mcp/tool-card";
import { Library } from "../../src/v1/store";
import type { WorkflowV2 } from "../../src/v1/schema";

interface HistoryPayload {
  library: LibraryIdentity;
  runs: { id: string }[];
}

const names = ["search_workflows", "describe_workflow", "run_workflow", "get_run", "list_runs", "agent_browser", "finish_task"];
const retired = ["live_session_start", "live_snapshot", "live_click", "live_type", "live_key", "live_select", "live_scroll", "live_navigate", "live_read", "live_screenshot", "live_tabs", "live_switch_tab", "live_stop"];
const workflow: WorkflowV2 = fixtureDoc({ schema: "bao.workflow/v4", version: 2, id: "saved", name: "Saved workflow", createdAt: 1, startUrl: "https://example.test/", inputs: [], steps: [] });

async function fixture(run: (client: McpClient, library: Library) => Promise<void>): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), "bao-mcp-test-"));
  const sourceRoot = path.join(home, "chrome-source");
  mkdirSync(path.join(sourceRoot, "Default"), { recursive: true });
  writeFileSync(path.join(sourceRoot, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Fixture" } } } }));
  const client = McpClient.start({ ...process.env, HOME: home, BAO_HOME: home, BAO_AGENT_BROWSER_PROFILE_ROOT: sourceRoot, BAO_HEAL_CURSOR_ACCOUNT: "0" });
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

test("MCP search and describe mark the owner's saved inputs optional", async () => {
  await fixture(async (client, library) => {
    const inputs: WorkflowV2["inputs"] = [
      fixtureInput({ name: "credential", type: "secret", label: "Password", required: true, default: "fixture-password" }),
      fixtureInput({ name: "display", type: "text", default: "Ada" }),
      fixtureInput({ name: "count", type: "number", default: "0" }),
      fixtureInput({ name: "missing", type: "secret" }),
      fixtureInput({ name: "empty", type: "secret", default: "" }),
      fixtureInput({ name: "stripped", type: "secret", default: "[secret stripped]" }),
      fixtureInput({ name: "invalid", type: "number", default: "not a number" }),
      fixtureInput({ name: "attachment", type: "file" }),
      fixtureInput({ name: "optional", type: "text", required: false }),
      fixtureInput({ name: "code", type: "secret", label: "Verification code", required: true, default: "123456" }),
      fixtureInput({ name: "taughtCode", type: "secret", default: "482913" }),
      fixtureInput({ name: "card", type: "secret", default: "4111111111111111" }),
      fixtureInput({ name: "pin", type: "secret", default: "1234" }),
      fixtureInput({ name: "password", type: "secret", default: "not-the-login-password" }),
    ];
    const saved: WorkflowV2 = fixtureDoc({ ...workflow, inputs, steps: [
      fixtureStep({ id: "signin", index: 0, action: "login", label: "Sign in", input: "credential", surface: "dom", timeoutMs: 1000 }),
      ...["missing", "empty", "stripped"].map((name, index): WorkflowV2["steps"][number] => (fixtureStep({
        id: name, index: index + 1, action: "login", label: name, input: name, surface: "dom", timeoutMs: 1000,
      }))),
      fixtureStep({ id: "code", index: 4, action: "type", label: "Code", input: "code", value: "{{code}}", surface: "dom", timeoutMs: 1000,
        identity: { surface: "dom", role: "textbox", id: "code", autocomplete: "section-login ONE-TIME-CODE", path: [] } }),
      fixtureStep({ id: "taughtCode", index: 5, action: "type", label: "Code", input: "taughtCode", value: "{{taughtCode}}", sensitive: true, surface: "dom", timeoutMs: 1000 }),
      fixtureStep({ id: "card", index: 6, action: "type", label: "Card", input: "card", value: "{{card}}", surface: "dom", timeoutMs: 1000,
        identity: { surface: "dom", role: "textbox", autocomplete: "cc-number", path: [] } }),
      fixtureStep({ id: "pin", index: 7, action: "type", label: "PIN", input: "pin", value: "{{pin}}", surface: "dom", timeoutMs: 1000,
        identity: { surface: "dom", role: "password", id: "pin", path: [] } }),
    ] });
    library.save(saved);
    await client.handshake();
    const result = await client.call("describe_workflow", { id: saved.id });
    assert.equal(result.isError, false);
    const described = JSON.parse(result.text) as { workflow: WorkflowV2; inputs: { name: string; type: string; label: string; required: boolean; saved?: true }[] };
    const required = [false, false, false, true, true, true, true, true, false, true, false, false, false, false];
    const savedNames = new Set(["credential", "display", "count", "taughtCode", "card", "pin", "password"]);
    assert.deepEqual(described.inputs, inputs.map((input, index) => ({
      name: input.name,
      type: input.type,
      label: input.label || input.name,
      required: required[index],
      ...(savedNames.has(input.name) ? {
        saved: true,
        description: input.type === "secret" ? "Bao fills the saved password when omitted." : "Bao fills the saved value when omitted.",
      } : {}),
    })));
    assert.deepEqual(described.workflow.inputs.map((input) => input.supply === "must"), required);
    assert.equal(described.workflow.inputs[0]?.default, undefined);
    assert.equal(result.text.includes("fixture-password"), false);
    assert.equal(library.read(saved.id).inputs[0]?.supply, "must");
    assert.equal(library.read(saved.id).inputs[0]?.default, "fixture-password");
    const search = await client.call("search_workflows", { query: "Saved" });
    assert.equal(search.isError, false);
    const hits = JSON.parse(search.text) as { hits: { inputs: typeof described.inputs }[] };
    assert.deepEqual(hits.hits[0]?.inputs, described.inputs);
    library.save(fixtureDoc({ ...saved, steps: [withStep(saved.steps[0]!, { input: undefined })] }));
    const fallback = await client.call("describe_workflow", { id: saved.id });
    const selected = JSON.parse(fallback.text) as typeof described;
    assert.equal(selected.inputs[0]?.required, false);
    assert.equal(selected.inputs.at(-1)?.required, false);
    library.save(fixtureDoc({ ...saved, steps: saved.steps.filter((step) => !(step.action === "handoff" && step.reason === "sign-in")).map((step, index) => ({ ...step, index })) }));
    const withoutLogin = await client.call("describe_workflow", { id: saved.id });
    const ordinary = JSON.parse(withoutLogin.text) as typeof described;
    assert.equal(ordinary.inputs[0]?.required, true);
    assert.equal(ordinary.workflow.inputs[0]?.supply, "must");
  });
});

test("MCP run omits a saved login password but still requires a fresh OTP", { timeout: 60_000 }, async () => {
  const submissions: Record<string, string>[] = [];
  const passwords: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    res.setHeader("content-type", "text/html");
    if (url.pathname === "/submit") {
      submissions.push({ password: passwords.at(-1) || "", ...Object.fromEntries(url.searchParams) });
      res.end("<!doctype html><p>Submitted</p>");
      return;
    }
    if (url.pathname === "/password") {
      passwords.push(url.searchParams.get("password") || "");
      res.end(`<!doctype html><form action="/submit">
        <label>Code <input id="code" name="code" autocomplete="one-time-code"></label>
        <button id="verify" type="submit">Verify</button></form>`);
      return;
    }
    res.end(`<!doctype html><form action="/password">
      <label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label>
      <button id="signin" type="submit">Sign in</button></form>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await fixture(async (client, library) => {
      const saved: WorkflowV2 = fixtureDoc({
        ...workflow, startUrl: `http://127.0.0.1:${address.port}/`,
        inputs: [
          fixtureInput({ name: "credential", type: "secret", label: "Password", required: true, default: "fixture-password" }),
          fixtureInput({ name: "code", type: "secret", label: "Verification code", required: true, default: "123456" }),
        ],
        steps: [
          fixtureStep({ id: "signin", index: 0, action: "login", label: "Sign in", surface: "dom", timeoutMs: 5000, heal: "never",
            input: "credential", postcondition: { kind: "text", match: "Submitted", timeoutMs: 5000 } }),
          fixtureStep({ id: "code", index: 1, action: "type", label: "Code", surface: "dom", timeoutMs: 5000, heal: "never",
            input: "code", value: "{{code}}", when: { absent: "Submitted" },
            identity: { surface: "dom", role: "textbox", id: "code", path: [], autocomplete: "one-time-code" } }),
        ],
      });
      library.save(saved);
      await client.handshake();
      const missing = await client.call("run_workflow", { id: saved.id });
      assert.equal(missing.isError, false);
      const handoff = JSON.parse(missing.text) as { outcome: string; reason: string };
      assert.equal(handoff.outcome, "needs_human");
      assert.equal(handoff.reason, "Enter Verification code on this device");
      assert.deepEqual(submissions, []);
      assert.deepEqual(passwords, []);
      const description = await client.call("describe_workflow", { id: saved.id });
      assert.equal(description.isError, false);
      const described = JSON.parse(description.text) as { inputs: { name: string; required: boolean }[] };
      assert.deepEqual(described.inputs.map(({ name, required }) => ({ name, required })), [
        { name: "credential", required: false }, { name: "code", required: true },
      ]);
      const result = await client.call("run_workflow", { id: saved.id, inputs: { code: "654321" } });
      assert.equal(result.isError, false);
      const outcome = JSON.parse(result.text) as { outcome: string; reason?: string; runId: string; savedValues?: string };
      assert.equal(outcome.outcome, "ok", outcome.reason);
      assert.deepEqual(passwords, ["fixture-password"]);
      assert.deepEqual(submissions, [{ password: "fixture-password", code: "654321" }]);
      assert.match(outcome.savedValues || "", /credential: saved password/);
      assert.equal((outcome.savedValues || "").includes("fixture-password"), false);
      assert.equal(library.readRun(outcome.runId).savedValues, outcome.savedValues);
      assert.equal(library.readRun(outcome.runId).modelCalls, 0);
    });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("MCP run fills an owner's saved name, email, and password and lists them", { timeout: 60_000 }, async () => {
  const seen: Record<string, string>[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    res.setHeader("content-type", "text/html");
    if (url.pathname === "/submit") {
      seen.push(Object.fromEntries(url.searchParams));
      res.end("<!doctype html><p id=\"done\">Saved</p>");
      return;
    }
    res.end(`<!doctype html><form action="/submit">
      <label>Name <input id="name" name="name"></label>
      <label>Email <input id="email" name="email"></label>
      <label>Password <input id="password" name="password" type="password"></label>
      <button id="save" type="submit">Save</button></form>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await fixture(async (client, library) => {
      const saved: WorkflowV2 = {
        ...workflow,
        id: "form",
        name: "Fill the form",
        startUrl: `http://127.0.0.1:${address.port}/`,
        inputs: [
          { name: "name", type: "text", label: "Name", required: true, default: "Ada" },
          { name: "email", type: "text", label: "Email", required: true, default: "ada@example.com" },
          { name: "password", type: "secret", label: "Password", required: true, default: "fixture-password" },
        ],
        steps: [
          { id: "name", index: 0, action: "type", label: "Name", surface: "dom", timeoutMs: 5000, heal: "never",
            input: "name", value: "{{name}}", identity: { surface: "dom", role: "textbox", id: "name", path: [] },
            locators: [{ kind: "css", value: "#name" }] },
          { id: "email", index: 1, action: "type", label: "Email", surface: "dom", timeoutMs: 5000, heal: "never",
            input: "email", value: "{{email}}", identity: { surface: "dom", role: "textbox", id: "email", path: [] },
            locators: [{ kind: "css", value: "#email" }] },
          { id: "password", index: 2, action: "type", label: "Password", surface: "dom", timeoutMs: 5000, heal: "never",
            input: "password", value: "{{password}}", sensitive: true, identity: { surface: "dom", role: "textbox", id: "password", path: [] },
            locators: [{ kind: "css", value: "#password" }] },
          { id: "save", index: 3, action: "click", label: "Save", surface: "dom", timeoutMs: 5000, heal: "never",
            identity: { surface: "dom", role: "button", id: "save", path: [] },
            locators: [{ kind: "css", value: "#save" }],
            postcondition: { kind: "text", match: "Saved", timeoutMs: 5000 } },
        ],
      };
      library.save(saved);
      await client.handshake();
      const described = JSON.parse((await client.call("describe_workflow", { id: saved.id })).text) as {
        inputs: { name: string; required: boolean; saved?: boolean; description?: string }[];
      };
      assert.deepEqual(described.inputs.map((input) => ({ name: input.name, required: input.required, saved: input.saved })), [
        { name: "name", required: false, saved: true },
        { name: "email", required: false, saved: true },
        { name: "password", required: false, saved: true },
      ]);
      assert.equal(JSON.stringify(described.inputs).includes("fixture-password"), false);
      assert.equal(JSON.stringify(described.inputs).includes("ada@example.com"), false);
      const result = await client.call("run_workflow", { id: saved.id });
      const outcome = JSON.parse(result.text) as { outcome: string; reason?: string; savedValues?: string; runId: string };
      assert.equal(outcome.outcome, "ok", outcome.reason);
      assert.equal(outcome.savedValues, "Saved values used: name: Ada · email: ada@example.com · password: saved password");
      assert.equal((outcome.savedValues || "").includes("fixture-password"), false);
      assert.deepEqual(seen, [{ name: "Ada", email: "ada@example.com", password: "fixture-password" }]);
      assert.equal(library.readRun(outcome.runId).savedValues, outcome.savedValues);
    });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("MCP keeps an imported workflow's author values required", async () => {
  await fixture(async (client, library) => {
    const saved: WorkflowV2 = {
      ...workflow,
      id: "imported-form",
      name: "Imported form",
      imported: true,
      inputs: [
        { name: "name", type: "text", label: "Name", required: true, default: "Author" },
        { name: "email", type: "text", label: "Email", required: true, default: "author@example.com" },
        { name: "password", type: "secret", label: "Password", required: true, default: "author-password" },
        { name: "note", type: "text", label: "Note", required: true, default: "mine", ownerSaved: true },
      ],
      steps: [],
    };
    library.save(saved);
    await client.handshake();
    const described = JSON.parse((await client.call("describe_workflow", { id: saved.id })).text) as {
      inputs: { name: string; required: boolean; saved?: boolean }[];
    };
    assert.deepEqual(described.inputs.map((input) => ({ name: input.name, required: input.required, saved: input.saved })), [
      { name: "name", required: true, saved: undefined },
      { name: "email", required: true, saved: undefined },
      { name: "password", required: true, saved: undefined },
      { name: "note", required: false, saved: true },
    ]);
    assert.equal(JSON.stringify(described).includes("author-password"), false);
    const missing = JSON.parse((await client.call("run_workflow", { id: saved.id })).text) as { outcome: string; reason?: string; savedValues?: string };
    assert.equal(missing.outcome, "needs_human");
    assert.match(missing.reason || "", /Name/);
    assert.equal(missing.savedValues, undefined);
    assert.equal(library.listRuns().length, 0);
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
    library.save({ ...workflow, driver: "cdp-live" as unknown as WorkflowV2["driver"] });
    library.save({ ...workflow, id: "owner", name: "Saved owner workflow" });
    library.save({ ...workflow, id: "fixture", provenance: "fixture" });
    await client.handshake();
    const result = await client.call("run_workflow", { id: workflow.id });
    const outcome = JSON.parse(result.text) as { outcome: string; reason: string };
    assert.equal(outcome.outcome, "failed");
    assert.equal(outcome.reason, "this workflow used the retired live driver");
    const search = await client.call("search_workflows", { query: "Saved" });
    assert.deepEqual((JSON.parse(search.text) as { hits: { id: string }[] }).hits.map((hit) => hit.id), ["owner"]);
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
    structuredContent?: { command: string; status: string; error?: string; run_id: string | null; step_id: string | null };
    _meta?: { baoToolCard?: BrowserToolCard; baoViewer?: { run?: { id: string; modelCalls: number | null }; runs?: { id: string }[] }; baoPictures?: { pictures: unknown[] } };
    tools?: { name: string; description?: string; outputSchema?: { required: string[]; properties: Record<string, unknown> }; _meta?: { ui?: { resourceUri?: string; visibility?: string[] } } }[];
    instructions?: string;
    serverInfo?: { name?: string };
    content?: { text?: string }[];
    isError?: boolean;
  };
}

interface Mcp {
  home: string;
  child: ChildProcessWithoutNullStreams;
  request(method: string, params?: unknown, timeoutMs?: number): Promise<Reply>;
  tool(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

// The child gets its own HOME, so it never reads or writes the person's library.
function startMcp(prefix: string, cmd = "mcp", setup?: (user: string, home: string) => void, automatic = false, bootstrap?: string): Mcp {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const user = path.join(root, "user");
  const home = automatic
    ? path.join(user, ...(process.platform === "darwin" ? ["Library", "Application Support", "bao"] : [".local", "share", "bao"]))
    : path.join(root, "library");
  mkdirSync(user);
  const sourceRoot = path.join(root, "chrome-source");
  mkdirSync(path.join(sourceRoot, "Default"), { recursive: true });
  writeFileSync(path.join(sourceRoot, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Fixture" } } } }));
  setup?.(user, home);
  const child = spawn(process.execPath, bootstrap ? ["-e", bootstrap] : [cli, cmd], {
    cwd: root,
    env: { ...process.env, HOME: user, BAO_HOME: automatic ? undefined : home, BAO_AGENT_BROWSER_PROFILE_ROOT: sourceRoot, BAO_HEAL_CURSOR_ACCOUNT: "0" },
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
  const request = async (method: string, params?: unknown, timeoutMs = 5000): Promise<Reply> => {
    const id = nextId++;
    child.stdin.write(frame({ jsonrpc: "2.0", id, method, params }));
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
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

function receiptPayload(home: string, reply: Reply): Record<string, unknown> {
  const { library, ...outcome } = JSON.parse(reply.result?.content?.[0]?.text || "null") as Record<string, unknown>;
  assert.deepEqual(library, { active: { path: home }, inactive: [] });
  return outcome;
}

test("non-UI clients retain the catalog and identify their active Library, including unsupported UI MIME types", async () => {
  const legacy = startMcp("bao-mcp-no-ui-");
  const unsupported = startMcp("bao-mcp-unsupported-ui-");
  try {
    const first = await initialize(legacy);
    const other = await unsupported.request("initialize", { capabilities: { extensions: { [UI_EXTENSION]: { mimeTypes: ["text/plain"] } } } });
    assert.deepEqual(first.result?.capabilities, { tools: {} });
    assert.deepEqual(other.result?.capabilities, first.result?.capabilities);
    const advertised = (await legacy.request("tools/list")).result?.tools;
    assert.deepEqual(advertised, TOOLS);
    assert.deepEqual((await unsupported.request("tools/list")).result?.tools, TOOLS);
    for (const guidance of [first.result?.instructions, advertised?.find(tool => tool.name === "agent_browser")?.description]) {
      assert.match(guidance!, /For browser=copy, [^.]+signed-in copied tab with tab <id>/);
      assert.match(guidance!, /task tab, which shares the owner's sign-ins; use another tab only when the owner asks/);
      assert.match(guidance!, /native daemon restart opens a new task tab[^.]+navigate that task tab again/);
    }
    const search = await legacy.tool("search_workflows", { query: "missing" });
    assert.equal(search.isError, false);
    assert.deepEqual(JSON.parse(search.text), { damagedWorkflows: [], hits: [], library: { active: { path: legacy.home }, inactive: [] } });
    assert.match(first.result?.instructions || "", /Use Bao's tools to find and read runs and workflows, not filesystem browsing/);
    assert.match(first.result?.instructions || "", /Bao does not use or search those roots/);
    for (const client of [legacy, unsupported]) {
      const run = { id: "run-capture", workflowId: "agent-browser", kind: "capture" as const, at: 1_700_000_000_000, steps: [], heals: [], status: "passed" };
      new Library(client.home).saveRun(run);
      const history = await client.request("tools/call", { name: "list_runs", arguments: {} });
      assert.equal(history.result?.isError, false);
      assert.equal(history.result?._meta, undefined);
      const data = JSON.parse(history.result?.content?.[0]?.text || "null") as HistoryPayload;
      assert.deepEqual(data.library, { active: { path: client.home }, inactive: [] });
      assert.equal(data.runs.length, 1);
      assert.deepEqual(data.runs[0], { id: run.id, workflowId: run.workflowId, name: "Browser capture", status: "passed", at: run.at, kind: "capture", stepCount: 0, modelCalls: null, healCount: 0 });
      const receipt = await client.request("tools/call", { name: "get_run", arguments: { run_id: data.runs[0].id } });
      assert.equal(receipt.result?.isError, false);
      assert.equal(receiptPayload(client.home, receipt).run_id, run.id);
      for (const name of ["inspect_run", "open_step_pictures"]) assert.equal((await client.tool(name)).text, "unknown tool");
    }
    assert.deepEqual(await legacy.tool("agent_browser", { command: "snapshot" }), { text: "start agent-browser with open before sending commands", isError: true });
    assert.equal((await legacy.request("resources/list")).error?.code, -32601);
    assert.equal((await legacy.request("resources/read", { uri: VIEWER_URI })).error?.code, -32601);
  } finally { legacy.child.kill(); unsupported.child.kill(); }
});

test("catalog errors identify the active Library and unsearched legacy data for every client", async () => {
  const updatedAt = new Date("2026-10-28T12:00:00.000Z");
  let inactivePath = "";
  const mcp = startMcp("bao-mcp-error-identity-", "mcp", (user, home) => {
    new Library(home).save(workflow);
    inactivePath = path.join(path.dirname(user), ".bao-mcp");
    const library = new Library(inactivePath);
    library.save({ ...workflow, id: "inactive-only" });
    inactivePath = realpathSync(inactivePath);
    utimesSync(path.join(library.root, "workflows", "inactive-only.json"), updatedAt, updatedAt);
  }, true);
  try {
    for (const capabilities of [{}, { extensions: { [UI_EXTENSION]: { mimeTypes: [VIEWER_MIME] } } }]) {
      await mcp.request("initialize", { capabilities });
      for (const [name, args, message] of [
        ["describe_workflow", { id: "inactive-only" }, "workflow not found"],
        ["run_workflow", { id: "inactive-only" }, "workflow not found"],
        ["get_run", { run_id: "missing" }, "run not found"],
        ["list_runs", { offset: -1 }, "Invalid viewer page"],
      ] as const) {
        const result = await mcp.tool(name, args);
        assert.equal(result.isError, true, name);
        const expectedMessage = name === "list_runs" && "extensions" in capabilities
          ? "Bao viewer data unavailable: invalid request, missing, linked, or oversized record. Open Bao desktop for local details."
          : message;
        assert.deepEqual(JSON.parse(result.text), { error: expectedMessage, library: {
          active: { path: process.platform === "darwin" ? "~/Library/Application Support/bao" : "~/.local/share/bao" },
          inactive: [{ path: inactivePath, state: "not_used_or_searched", contents: { workflows: 1 }, lastUpdated: updatedAt.toISOString() }],
        } }, name);
      }
    }
  } finally { mcp.child.kill(); }
});

test("get_run attaches a bounded exact-run view for a capture larger than two MiB", async () => {
  const mcp = startMcp("bao-mcp-large-capture-");
  try {
    await mcp.request("initialize", { capabilities: { extensions: { [UI_EXTENSION]: { mimeTypes: [VIEWER_MIME] } } } });
    new Library(mcp.home).saveRun({
      id: "run-large-capture", kind: "capture", workflowId: "agent-browser", status: "recording", at: Date.now(), heals: [],
      steps: [{ id: "command-1", status: "passed", native: { command: "snapshot", results: [{ stdout: "large snapshot content ".repeat(150000), stderr: "", exitCode: 0 }] } }],
    });
    const reply = await mcp.request("tools/call", { name: "get_run", arguments: { run_id: "run-large-capture" } });
    assert.equal(reply.result?.isError, false);
    assert.equal(reply.result?._meta?.baoViewer?.run?.id, "run-large-capture");
    const receipt = JSON.parse(reply.result!.content![0]!.text!) as { outcome: string; status: string; link?: string };
    assert.equal(receipt.outcome, "recording");
    assert.equal(receipt.status, "recording");
    assert.equal(receipt.link, "bao://receipt/run-large-capture");
    assert.ok(JSON.stringify(reply).length < 10000);
  } finally { mcp.child.kill(); }
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
    for (const name of TOOL_NAMES) assert.deepEqual(tools.find((tool) => tool.name === name)?._meta?.ui?.visibility, name === "list_runs" ? ["model", "app"] : ["model"]);
    assert.equal(tools.find((tool) => tool.name === "list_runs")?._meta?.ui?.resourceUri, VIEWER_URI);
    assert.deepEqual(tools.find((tool) => tool.name === "open_step_pictures")?._meta?.ui?.visibility, ["app"]);
    assert.deepEqual(tools.find((tool) => tool.name === "open_browser_picture")?._meta?.ui?.visibility, ["app"]);
    assert.equal(tools.find((tool) => tool.name === "agent_browser")?._meta?.ui?.resourceUri, VIEWER_URI);
    assert.equal(tools.find((tool) => tool.name === "finish_task")?._meta?.ui?.resourceUri, VIEWER_URI);
    assert.deepEqual(tools.find((tool) => tool.name === "open_browser_card")?._meta?.ui?.visibility, ["app"]);
    const schema = tools.find((tool) => tool.name === "agent_browser")?.outputSchema;
    assert.ok(schema);
    assert.equal(schema.required.includes("results"), false);
    assert.equal(Object.hasOwn(schema.properties, "results"), false);
    const browserError = await mcp.request("tools/call", { name: "agent_browser", arguments: { command: "snapshot" } });
    assert.equal(browserError.result?.isError, true);
    assert.equal(browserError.result?.structuredContent?.error, "start agent-browser with open before sending commands");
    assert.equal(browserError.result?._meta?.baoToolCard?.picture.kind, "unavailable");
    assert.equal(browserError.result?.structuredContent?.run_id, null);
    assert.deepEqual(JSON.parse(browserError.result!.content!.at(-1)!.text!), { run_id: null, step_id: null });
    assert.equal(Object.hasOwn(browserError.result!.structuredContent!, "results"), false);
    assert.notEqual(browserError.result?.content?.[0]?.text, browserError.result?.structuredContent?.error);
    assert.equal(browserError.result?.content?.[1]?.text, "start agent-browser with open before sending commands");
    const invalidCommand = await mcp.request("tools/call", { name: "agent_browser", arguments: { command: "retired" } });
    assert.equal(invalidCommand.result?.isError, true);
    assert.equal(invalidCommand.result?.content?.[1]?.text, invalidCommand.result?.structuredContent?.error);
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
    assert.deepEqual((JSON.parse(history.result?.content?.[0]?.text || "null") as HistoryPayload).library, { active: { path: mcp.home }, inactive: [] });
    const receipt = await mcp.request("tools/call", { name: "get_run", arguments: { run_id: run.id } });
    const plainReceipt = await legacy.request("tools/call", { name: "get_run", arguments: { run_id: run.id } });
    assert.deepEqual(receiptPayload(mcp.home, receipt), receiptPayload(legacy.home, plainReceipt));
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
      const workflow: WorkflowV2 = fixtureDoc({ ...JSON.parse(shelfWorkflow) as WorkflowV2, version: 3, filesDates: 1, inputs: [fixtureInput({ name: "password", type: "secret" })], steps: [
        fixtureStep({ id: "source", index: 0, action: "download", label: "Source", surface: "dom", timeoutMs: 1000, download: { output: "report", name: "{{password}}.txt" } }),
        fixtureStep({ id: "preview", index: 1, action: "download", label: "Report", surface: "dom", timeoutMs: 1000, download: { output: "copy", name: template } }),
      ] });
      for (const home of [mcp.home, legacy.home]) {
        const library = new Library(home);
        library.save(workflow);
        utimesSync(path.join(home, "workflows", `${workflow.id}.json`), (startedAt - 10_000) / 1000, (startedAt - 10_000) / 1000);
        library.saveRun({ ...run, at: startedAt + 1000, videoStartedAt: startedAt, status: "failed", steps: [{ id: "preview", status: "failed", startedAt, reason }], failure: { stepId: "preview", reason }, envelope: { status: "failed", step: "preview", reason, ask: reason } });
      }
      const projected = await mcp.request("tools/call", { name: "get_run", arguments: { run_id: run.id } });
      const plain = await legacy.request("tools/call", { name: "get_run", arguments: { run_id: run.id } });
      assert.deepEqual(receiptPayload(mcp.home, projected), receiptPayload(legacy.home, plain));
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

test("MCP version checks wait for stable replacement entries before reporting updates", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const home = mkdtempSync(path.join(tmpdir(), "bao-mcp-version-"));
  const entry = path.join(home, "server.js");
  writeFileSync(entry, "original");
  const check = createMcpVersionCheck(entry);
  try {
    await check();
    const loaded = statSync(entry);
    renameSync(entry, `${entry}.old`);
    await check();
    writeFileSync(entry, "original");
    utimesSync(entry, loaded.atime, loaded.mtime);
    await check();
    await check();
    now = 1999;
    await check();
    now = 2000;
    await assert.rejects(check, (error: unknown) => error instanceof McpVersionError && /Bao was updated/.test(error.message));
    const rebuilt = createMcpVersionCheck(entry);
    utimesSync(entry, loaded.atime, new Date(loaded.mtimeMs + 1000));
    await rebuilt();
    now = 4000;
    await assert.rejects(rebuilt, (error: unknown) => error instanceof McpVersionError);
    rmSync(entry);
    await check();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("changing, missing, or restored entries reset the replacement wait", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const home = mkdtempSync(path.join(tmpdir(), "bao-mcp-stable-"));
  const entry = path.join(home, "server.js");
  writeFileSync(entry, "loaded");
  const check = createMcpVersionCheck(entry);
  try {
    renameSync(entry, `${entry}.loaded`);
    writeFileSync(entry, "first replacement");
    await check();
    now = 2000;
    writeFileSync(entry, "second replacement still being copied");
    await check();
    now = 4000;
    rmSync(entry);
    await check();
    writeFileSync(entry, "complete replacement");
    await check();
    now = 6000;
    renameSync(entry, `${entry}.replacement`);
    renameSync(`${entry}.loaded`, entry);
    await check();
    renameSync(entry, `${entry}.loaded`);
    renameSync(`${entry}.replacement`, entry);
    await check();
    now = 7999;
    await check();
    now = 8000;
    await assert.rejects(check, /Bao was updated/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("update polling preserves a long in-flight call and an idle browser session", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-mcp-inflight-"));
  const entry = path.join(root, "server.js");
  const started = path.join(root, "started");
  writeFileSync(entry, "loaded");
  const bootstrap = `
    const versions = require(${JSON.stringify(path.resolve(__dirname, "../../src/mcp/version.js"))});
    const createCheck = versions.createMcpVersionCheck;
    versions.createMcpVersionCheck = () => createCheck(${JSON.stringify(entry)});
    const proxy = require(${JSON.stringify(path.resolve(__dirname, "../../src/engines/agent-browser-proxy.js"))}).AgentBrowserProxy.prototype;
    const abort = new AbortController();
    const disconnect = proxy.disconnect;
    let active = false;
    proxy.hasSession = () => active;
    proxy.disconnect = function () { abort.abort(); disconnect.call(this); };
    proxy.execute = async function (command) {
      if (command === "close") {
        active = false;
        return [{ stdout: "closed", stderr: "", exitCode: 0 }];
      }
      require("node:fs").writeFileSync(${JSON.stringify(started)}, "started");
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 6000);
        abort.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("browser operation was aborted"));
        }, { once: true });
      });
      active = true;
      return [{ stdout: "finished", stderr: "", exitCode: 0 }];
    };
    require(${JSON.stringify(path.resolve(__dirname, "../../src/mcp/server.js"))}).mcpMain();
  `;
  const mcp = startMcp("bao-mcp-inflight-home-", "mcp", undefined, false, bootstrap);
  try {
    await initialize(mcp);
    const reply = mcp.request("tools/call", { name: "agent_browser", arguments: { command: "open", args: ["https://example.test/"] } }, 12_000);
    const deadline = Date.now() + 5000;
    while (!existsSync(started) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(started), "browser operation started");
    writeFileSync(entry, "replacement installed");
    const result = await reply;
    assert.equal(result.error, undefined);
    assert.equal(result.result?.isError, false);
    assert.deepEqual(result.result?.content, [{ type: "text", text: "Went to https://example.test/." }, { type: "text", text: "finished" }]);
    await new Promise((resolve) => setTimeout(resolve, 4500));
    assert.equal(mcp.child.exitCode, null, "idle browser session prevents poll shutdown");
    const close = await mcp.tool("agent_browser", { command: "close", args: [] });
    assert.equal(close.isError, false);
    assert.equal(close.text, "Closed the Bao browser window.");
  } finally {
    if (mcp.child.exitCode === null && mcp.child.signalCode === null) {
      const exited = once(mcp.child, "exit");
      mcp.child.kill();
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("input resumes preserve the browser choice and allow explicit overrides", { timeout: 90_000 }, async () => {
  const seen: string[] = [];
  const fixture = createServer((req, res) => {
    if (req.url === "/resume-account") seen.push(req.headers.cookie?.includes("route=bao") ? "bao" : "copy");
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><h1>Account fixture</h1>");
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  assert.ok(address && typeof address !== "string");
  const site = `http://127.0.0.1:${address.port}/resume-account`;
  const bootstrap = `process.env.BAO_CHROME_NO_SANDBOX = "1"; require(${JSON.stringify(path.resolve(__dirname, "../../src/mcp/server.js"))}).mcpMain();`;
  const mcp = startMcp("bao-mcp-input-browser-", "mcp", undefined, false, bootstrap);
  try {
    const seed = await launchOwnedChrome({ userDataDir: path.join(mcp.home, "agent-browser-profile"), headless: true });
    try {
      await seed.addCookies([{ name: "route", value: "bao", url: site, expires: Date.now() / 1000 + 3600 }]);
    } finally { await seed.close(); }
    const library = new Library(mcp.home);
    library.save(fixtureDoc({
      ...workflow, id: "input-browser", startUrl: site,
      inputs: [fixtureInput({ name: "password", type: "secret", label: "Password", required: true })],
      steps: [fixtureStep({ id: "account", index: 0, action: "verify", label: "Read account", surface: "dom", timeoutMs: 1000, postcondition: { kind: "text", match: "Account fixture", timeoutMs: 1000 } })],
    }));
    await initialize(mcp);
    for (const scenario of [
      { initial: "copy", override: undefined, older: false, expected: "copy" },
      { initial: "copy", override: "bao", older: false, expected: "bao" },
      { initial: "copy", override: undefined, older: true, expected: "bao" },
      { initial: undefined, override: undefined, older: false, expected: "bao" },
    ]) {
      const first = await mcp.request("tools/call", { name: "run_workflow", arguments: { id: "input-browser", browser: scenario.initial } });
      assert.equal(first.result?.isError, false);
      const paused = JSON.parse(first.result?.content?.[0]?.text || "{}") as { status?: string; resume_token?: string };
      assert.equal(paused.status, "needs_human");
      assert.ok(paused.resume_token);
      if (scenario.older) {
        const file = path.join(mcp.home, "resumes", `${paused.resume_token}.json`);
        const record = JSON.parse(readFileSync(file, "utf8")) as { browser?: string };
        delete record.browser;
        writeFileSync(file, JSON.stringify(record));
      }
      seen.length = 0;
      const resumed = await mcp.request("tools/call", { name: "run_workflow", arguments: { resume: paused.resume_token, inputs: { password: "fixture-secret" }, browser: scenario.override } }, 20_000);
      assert.equal(resumed.result?.isError, false);
      const result = JSON.parse(resumed.result?.content?.[0]?.text || "{}") as { outcome?: string; reason?: string };
      assert.equal(result.outcome, "ok", result.reason);
      assert.equal(seen.at(-1), scenario.expected, "the resumed request uses the chosen profile, not a silent default");
    }
  } finally {
    const pids = pidsForDataDir(path.join(mcp.home, "agent-browser-profile"));
    if (mcp.child.exitCode === null && mcp.child.signalCode === null) {
      const exited = once(mcp.child, "exit");
      mcp.child.kill();
      await exited;
    }
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
  }
});

test("replay failure and continued held-run tokens preserve a named browser", { timeout: 90_000 }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-resume-writers-"));
  const sourceRoot = path.join(root, "source");
  mkdirSync(path.join(sourceRoot, "Default"), { recursive: true });
  writeFileSync(path.join(sourceRoot, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Fixture" } } } }));
  const priorSource = process.env.BAO_AGENT_BROWSER_PROFILE_ROOT;
  process.env.BAO_AGENT_BROWSER_PROFILE_ROOT = sourceRoot;
  const seen: string[] = [];
  const fixture = createServer((req, res) => {
    if (req.url === "/account") seen.push(req.headers.cookie?.includes("route=other") ? "other" : "copy");
    res.setHeader("content-type", "text/html");
    res.end('<!doctype html><h1>Ready</h1><p id="auth">Waiting</p><button onclick="document.getElementById(\'auth\').textContent = \'Signed in\'">Sign in</button>');
  });
  let token = "";
  const library = new Library(path.join(root, "library"));
  t.after(async () => {
    try {
      if (token) await runWorkflow(library, { resume: token, cancel: true });
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    } finally {
      if (priorSource === undefined) delete process.env.BAO_AGENT_BROWSER_PROFILE_ROOT; else process.env.BAO_AGENT_BROWSER_PROFILE_ROOT = priorSource;
    }
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  assert.ok(address && typeof address !== "string");
  const site = `http://127.0.0.1:${address.port}/account`;
  for (const profile of ["chrome-profile", "agent-browser-profile"]) {
    const seed = await launchOwnedChrome({ userDataDir: path.join(library.root, profile), headless: true });
    try { await seed.addCookies([{ name: "route", value: "other", url: site, expires: Date.now() / 1000 + 3600 }]); }
    finally { await seed.close(); }
  }
  const check = { id: "check", index: 0, action: "verify" as const, label: "Check account", surface: "dom" as const, timeoutMs: 100, postcondition: { kind: "text" as const, match: "Not ready", timeoutMs: 100 } };
  const doc: WorkflowV2 = fixtureDoc({ ...workflow, id: "resume-writers", startUrl: site, steps: [check] });
  for (const held of [false, true]) {
    library.save(fixtureDoc({ ...doc, steps: held ? [
      fixtureStep({ id: "signin", index: 0, action: "login", label: "Sign in", surface: "dom", timeoutMs: 1000, postcondition: { kind: "text", match: "Signed in", timeoutMs: 1000 } }),
      { ...check, index: 1 },
    ] : [check] }));
    let outcome = await runWorkflow(library, { id: doc.id, browser: "copy" });
    token = outcome.resume_token || "";
    assert.ok(token);
    if (held) {
      assert.equal(outcome.status, "needs_signin");
      const waiting = await runWorkflow(library, { resume: token });
      assert.equal(waiting.status, "needs_signin");
      assert.equal(waiting.resume_token, token, "the held session rewrites its existing token");
      await withHeldPage(token, (page) => page.getByRole("button", { name: "Sign in", exact: true }).click());
      outcome = await runWorkflow(library, { resume: token });
      assert.equal(outcome.outcome, "failed");
      assert.ok(outcome.resume_token);
      assert.notEqual(outcome.resume_token, token, "a finished held session issues a fresh retry token");
      token = outcome.resume_token!;
    } else {
      assert.equal(outcome.outcome, "failed");
    }
    library.save(fixtureDoc({ ...doc, steps: [{ ...check, postcondition: { kind: "text", match: "Ready", timeoutMs: 1000 } }] }));
    seen.length = 0;
    const resumed = await runWorkflow(library, { resume: token });
    assert.equal(resumed.outcome, "ok", resumed.reason);
    assert.equal(seen.at(-1), "copy", "retry keeps the source-copy account instead of either lasting profile");
    token = "";
  }
});

test("a held replay blocks update stops and supports resume and cancel after replacement", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-mcp-held-"));
  const entry = path.join(root, "server.js");
  writeFileSync(entry, "loaded");
  const fixture = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end('<!doctype html><p>Fixture owner handoff</p>');
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  assert.ok(address && typeof address !== "string");
  const bootstrap = `
    process.env.BAO_CHROME_NO_SANDBOX = "1";
    const versions = require(${JSON.stringify(path.resolve(__dirname, "../../src/mcp/version.js"))});
    const createCheck = versions.createMcpVersionCheck;
    versions.createMcpVersionCheck = () => createCheck(${JSON.stringify(entry)});
    require(${JSON.stringify(path.resolve(__dirname, "../../src/mcp/server.js"))}).mcpMain();
  `;
  const mcp = startMcp("bao-mcp-held-home-", "mcp", undefined, false, bootstrap);
  let token = "";
  try {
    const library = new Library(mcp.home);
    library.updateSettings({ pageEngine: "old" });
    library.save(fixtureDoc({
      ...workflow,
      id: "held-signin",
      startUrl: `http://127.0.0.1:${address.port}/`,
      steps: [fixtureStep({
        id: "signin", index: 0, action: "login", label: "Sign in", surface: "dom", timeoutMs: 1000,
      })],
    }));
    await initialize(mcp);
    const first = await mcp.request("tools/call", { name: "run_workflow", arguments: { id: "held-signin" } }, 20_000);
    assert.equal(first.error, undefined);
    assert.equal(first.result?.isError, false);
    const paused = JSON.parse(first.result?.content?.[0]?.text || "{}") as { status?: string; resume_token?: string; run_id?: string };
    token = paused.resume_token || "";
    assert.equal(paused.status, "needs_signin");
    assert.ok(paused.run_id);
    assert.ok(token);
    writeFileSync(entry, "replacement installed");
    await new Promise((resolve) => setTimeout(resolve, 6500));
    assert.equal(mcp.child.exitCode, null, "held replay prevents poll shutdown");
    assert.deepEqual((await mcp.request("tools/list")).result?.tools, TOOLS);
    const resumed = await mcp.request("tools/call", { name: "run_workflow", arguments: { resume: token } }, 15_000);
    assert.equal(resumed.error, undefined);
    assert.equal(resumed.result?.isError, false);
    const waiting = JSON.parse(resumed.result?.content?.[0]?.text || "{}") as { status?: string; run_id?: string; resume_token?: string };
    assert.equal(waiting.status, "needs_signin");
    assert.equal(waiting.run_id, paused.run_id);
    assert.equal(waiting.resume_token, token);
    assert.equal(mcp.child.exitCode, null, "resume preserves the held run and process");
    const reply = await mcp.request("tools/call", { name: "run_workflow", arguments: { resume: token, cancel: true } }, 15_000);
    assert.equal(reply.error, undefined);
    assert.equal(reply.result?.isError, false);
    const cancelled = JSON.parse(reply.result?.content?.[0]?.text || "{}") as { status?: string; reason?: string; run_id?: string };
    assert.equal(cancelled.status, "stopped");
    assert.equal(cancelled.reason, "nothing applied");
    assert.equal(cancelled.run_id, paused.run_id);
    token = "";
  } finally {
    if (token && mcp.child.exitCode === null && mcp.child.signalCode === null) {
      await mcp.request("tools/call", { name: "run_workflow", arguments: { resume: token, cancel: true } }, 15_000).catch(() => undefined);
    }
    const pids = pidsForDataDir(path.join(mcp.home, "agent-browser-profile"));
    if (mcp.child.exitCode === null && mcp.child.signalCode === null) {
      const exited = once(mcp.child, "exit");
      mcp.child.kill();
      await exited;
    }
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

const shelfWorkflow = `{
  "schema": "bao.workflow/v4",
  "version": 2,
  "id": "wf-shelf",
  "name": "Shelf",
  "startUrl": "https://example.test/",
  "createdAt": 1,
  "inputs": [],
  "steps": []
}
`;
