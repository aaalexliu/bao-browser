import { testWorkflow } from "../support/workflow";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { McpClient } from "../../src/eval/mcp-client";
import { runWorkflow, withHeldPage } from "../../src/mcp/catalog";
import { frameRpc } from "../../src/mcp/frame";
import { launchOwnedChrome, pidsForDataDir } from "../../src/launch";
import { TOOLS } from "../../src/mcp/server";
import type { BrowserToolCard } from "../../src/mcp/tool-card";
import { Library } from "../../src/v1/store";
import type { WorkflowStep, WorkflowV2 } from "../../src/v1/schema";
import { scaledMs } from "../runtime";
const workflow: WorkflowV2 = testWorkflow({ schema: "bao.workflow/v4", id: "saved", name: "Saved workflow", createdAt: 1, startUrl: "https://example.test/", inputs: [], steps: [] });

async function fixture(run: (client: McpClient, library: Library) => Promise<void>): Promise<void> {
  const home = mkdtempSync(path.join(tmpdir(), "bao-mcp-test-"));
  const sourceRoot = path.join(home, "chrome-source");
  mkdirSync(path.join(sourceRoot, "Default"), { recursive: true });
  writeFileSync(path.join(sourceRoot, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Fixture" } } } }));
  const client = McpClient.start({ ...process.env, HOME: home, BAO_HOME: home, BAO_AGENT_BROWSER_PROFILE_ROOT: sourceRoot, BAO_HEAL_CURSOR_ACCOUNT: "0" });
  try { await run(client, new Library(home)); }
  finally { await client.close(); rmSync(home, { recursive: true, force: true }); }
}

test("run_workflow with several Chrome profiles and none named or picked lists them and gives the exact call to retry with one", async () => {
  await fixture(async (client, library) => {
    const source = path.join(library.root, "chrome-source");
    mkdirSync(path.join(source, "Profile 2"), { recursive: true });
    writeFileSync(path.join(source, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Fixture", user_name: "fixture@example.test" }, "Profile 2": { name: "Work" } } } }));
    library.save(workflow);
    await client.handshake();
    const asked = JSON.parse((await client.call("run_workflow", { id: workflow.id, browser: "copy" })).text) as { outcome: string; reason: string };
    assert.equal(asked.outcome, "failed");
    assert.equal(asked.reason, `Chrome has 2 profiles in ${source}, so Bao opened nothing. Choose one: "Default" (Fixture, fixture@example.test); "Profile 2" (Work). `
      + 'To continue, call run_workflow again with the folder of the profile you choose: {"id":"saved","browser":"copy","profile":"Default"} Pass the same inputs.');
    library.save(testWorkflow({ id: "files", startUrl: "https://example.test/", steps: [
      { id: "save", index: 0, timeoutMs: 1000, caption: { text: "Save the report" }, action: "download", download: { output: "report", name: "report.txt" } },
    ] }));
    const files = JSON.parse((await client.call("run_workflow", { id: "files" })).text) as { outcome: string; reason: string };
    assert.equal(files.outcome, "failed");
    assert.ok(files.reason.endsWith('call run_workflow again with the folder of the profile you choose: {"id":"files","profile":"Default"} Pass the same inputs.'),
      `a run that named no browser retries without one, so it keeps the default route: ${files.reason}`);
    const missing = JSON.parse((await client.call("run_workflow", { id: workflow.id, browser: "copy", profile: "Profile 9" })).text) as { outcome: string; reason: string };
    assert.equal(missing.outcome, "failed");
    assert.match(missing.reason, /^Chrome has no profile "Profile 9" in .+\. Choose one of: "Default" \(Fixture, fixture@example\.test\); "Profile 2" \(Work\)\.$/);
    const blank = await client.call("run_workflow", { id: workflow.id, profile: " " });
    assert.equal(blank.isError, true);
    assert.match(blank.text, /profile must be a Chrome profile folder/);
  });
});

test("a run_workflow resume keeps the Chrome profile the agent named, not the Settings pick", async () => {
  await fixture(async (client, library) => {
    library.updateSettings({ chromeProfile: "Default" });
    library.save(workflow);
    await client.handshake();
    const first = JSON.parse((await client.call("run_workflow", { id: workflow.id, browser: "copy", profile: "Profile 9" })).text) as { outcome: string; reason: string; resume_token?: string };
    assert.equal(first.outcome, "failed");
    assert.match(first.reason, /^Chrome has no profile "Profile 9" in /);
    assert.ok(first.resume_token);
    const resumed = JSON.parse((await client.call("run_workflow", { resume: first.resume_token })).text) as { outcome: string; reason: string; resume_token?: string };
    assert.equal(resumed.outcome, "failed");
    assert.match(resumed.reason, /^Chrome has no profile "Profile 9" in /, "the resumed run did not fall back to the Settings pick");
    assert.ok(resumed.resume_token);
    const again = JSON.parse((await client.call("run_workflow", { resume: resumed.resume_token, profile: "Profile 8" })).text) as { reason: string };
    assert.match(again.reason, /^Chrome has no profile "Profile 8" in /, "a profile on the resume call wins");
  });
});

test("MCP search and describe mark the owner's saved inputs optional", async () => {
  await fixture(async (client, library) => {
    const inputs: WorkflowV2["inputs"] = [
      { name: "credential", type: "secret", label: "Password", supply: "saved", default: "fixture-password" },
      { name: "display", type: "text", label: "display", supply: "saved", default: "Ada" },
      { name: "count", type: "number", label: "count", supply: "saved", default: "0" },
      { name: "missing", type: "secret", label: "missing", supply: "must" },
      { name: "empty", type: "secret", label: "empty", supply: "must" },
      { name: "stripped", type: "secret", label: "stripped", supply: "must", default: "[secret stripped]" },
      { name: "invalid", type: "number", label: "invalid", supply: "saved", default: "not a number" },
      { name: "attachment", type: "file", label: "attachment", supply: "must" },
      { name: "optional", type: "text", label: "optional", supply: "must" },
      { name: "code", type: "secret", label: "Verification code", supply: "saved", default: "123456" },
      { name: "taughtCode", type: "secret", label: "taughtCode", supply: "saved", default: "482913" },
      { name: "card", type: "secret", label: "card", supply: "saved", default: "4111111111111111" },
      { name: "pin", type: "secret", label: "pin", supply: "saved", default: "1234" },
      { name: "password", type: "secret", label: "password", supply: "saved", default: "not-the-login-password" },
    ];
    const saved: WorkflowV2 = testWorkflow({ ...workflow, inputs, steps: [
      { id: "signin", index: 0, timeoutMs: 1000, caption: { text: "Sign in" }, action: "handoff", reason: "sign-in" },
      ...["missing", "empty", "stripped"].map((name, index): WorkflowV2["steps"][number] => ({
        id: name, index: index + 1, timeoutMs: 1000, caption: { text: name }, action: "handoff", reason: "sign-in",
      })),
      {
        id: "code",
        index: 4,
        timeoutMs: 1000,
        caption: { text: "Code" },
        action: "type",
        target: {
          locators: [{ kind: "css", value: "#code" }, { kind: "xpath", value: "//*[@id=\"code\"]" }],
          hint: { role: "textbox", surface: "dom", autocomplete: "section-login ONE-TIME-CODE", id: "code" },
        },
        text: { input: "code" },
      },
      {
        id: "taughtCode",
        index: 5,
        timeoutMs: 1000,
        caption: { text: "Code" },
        action: "type",
        target: { locators: [{ kind: "role", role: "textbox", name: "Code" }] },
        text: { input: "taughtCode" },
        sensitive: true,
      },
      {
        id: "card",
        index: 6,
        timeoutMs: 1000,
        caption: { text: "Card" },
        action: "type",
        target: { locators: [], hint: { role: "textbox", surface: "dom", autocomplete: "cc-number" } },
        text: { input: "card" },
      },
      {
        id: "pin",
        index: 7,
        timeoutMs: 1000,
        caption: { text: "PIN" },
        action: "type",
        target: {
          locators: [{ kind: "css", value: "#pin" }, { kind: "xpath", value: "//*[@id=\"pin\"]" }],
          hint: { role: "password", surface: "dom", id: "pin" },
        },
        text: { input: "pin" },
      },
    ] });
    library.save(saved);
    await client.handshake();
    const result = await client.call("describe_workflow", { id: saved.id });
    assert.equal(result.isError, false);
    const described = JSON.parse(result.text) as { workflow: WorkflowV2; inputs: { name: string; type: string; label: string; required: boolean; saved?: true }[] };
    const required = [false, false, false, true, true, true, true, true, true, true, false, false, false, false];
    const savedNames = new Set(["credential", "display", "count", "taughtCode", "card", "pin", "password"]);
    const stored = library.read(saved.id);
    assert.deepEqual(described.inputs, stored.inputs.map((input, index) => ({
      name: input.name,
      type: input.type,
      label: input.label || input.name,
      supply: input.supply,
      required: required[index],
      ...(savedNames.has(input.name) ? {
        saved: true,
        description: input.type === "secret" ? "Bao fills the saved password when omitted." : "Bao fills the saved value when omitted.",
      } : {}),
    })));
    assert.deepEqual(described.workflow.inputs.map((input) => input.supply), stored.inputs.map((input) => input.supply));
    assert.equal(described.workflow.inputs[0]?.default, undefined);
    assert.equal(result.text.includes("fixture-password"), false);
    assert.equal(stored.inputs[0]?.supply, "saved");
    assert.equal(stored.inputs[0]?.default, "fixture-password");
    const search = await client.call("search_workflows", { query: "Saved" });
    assert.equal(search.isError, false);
    const hits = JSON.parse(search.text) as { hits: { inputs: typeof described.inputs }[] };
    assert.deepEqual(hits.hits[0]?.inputs, described.inputs);
    library.save(testWorkflow({ ...saved, steps: [saved.steps[0]!] }));
    const fallback = await client.call("describe_workflow", { id: saved.id });
    const selected = JSON.parse(fallback.text) as typeof described;
    assert.equal(selected.inputs[0]?.required, false);
    assert.equal(selected.inputs.at(-1)?.required, false);
    library.save(testWorkflow({ ...saved, steps: saved.steps.filter((step) => !(step.action === "handoff" && step.reason === "sign-in")).map((step, index) => ({ ...step, index })) }));
    const withoutLogin = await client.call("describe_workflow", { id: saved.id });
    const ordinary = JSON.parse(withoutLogin.text) as typeof described;
    assert.equal(ordinary.inputs[0]?.required, false);
    assert.equal(ordinary.workflow.inputs[0]?.supply, "saved");
  });
});

test("MCP run omits a saved login password but still requires a fresh OTP", { timeout: scaledMs(60_000) }, async () => {
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
      const saved: WorkflowV2 = testWorkflow({
        ...workflow, startUrl: `http://127.0.0.1:${address.port}/`,
        inputs: [
          { name: "credential", type: "secret", label: "Password", supply: "saved", default: "fixture-password" },
          { name: "code", type: "secret", label: "Verification code", supply: "saved", default: "123456" },
        ],
        steps: [
          {
            id: "signin",
            index: 0,
            timeoutMs: 5000,
            caption: { text: "Sign in" },
            heal: "never",
            action: "handoff",
            reason: "sign-in",
            check: { kind: "text", match: "Submitted", timeoutMs: 5000 },
          },
          {
            id: "code",
            index: 1,
            timeoutMs: 5000,
            caption: { text: "Code" },
            when: { absent: "Submitted" },
            heal: "never",
            action: "type",
            target: {
              locators: [{ kind: "css", value: "#code" }, { kind: "xpath", value: "//*[@id=\"code\"]" }],
              hint: { role: "textbox", surface: "dom", autocomplete: "one-time-code", id: "code" },
            },
            text: { input: "code" },
          },
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

test("MCP run fills an owner's saved name, email, and password and lists them", { timeout: scaledMs(60_000) }, async () => {
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
          { name: "name", type: "text", label: "Name", supply: "saved", default: "Ada" },
          { name: "email", type: "text", label: "Email", supply: "saved", default: "ada@example.com" },
          { name: "password", type: "secret", label: "Password", supply: "saved", default: "fixture-password" },
        ],
        steps: [
          {
            id: "name",
            index: 0,
            timeoutMs: 5000,
            caption: { text: "Name" },
            heal: "never",
            action: "type",
            target: { locators: [{ kind: "css", value: "#name" }], hint: { role: "textbox", surface: "dom", id: "name" } },
            text: { input: "name" },
          },
          {
            id: "email",
            index: 1,
            timeoutMs: 5000,
            caption: { text: "Email" },
            heal: "never",
            action: "type",
            target: { locators: [{ kind: "css", value: "#email" }], hint: { role: "textbox", surface: "dom", id: "email" } },
            text: { input: "email" },
          },
          {
            id: "password",
            index: 2,
            timeoutMs: 5000,
            caption: { text: "Password" },
            heal: "never",
            action: "type",
            target: {
              locators: [{ kind: "css", value: "#password" }],
              hint: { role: "textbox", surface: "dom", id: "password" },
            },
            text: { input: "password" },
            sensitive: true,
          },
          {
            id: "save",
            index: 3,
            timeoutMs: 5000,
            caption: { text: "Save" },
            heal: "never",
            action: "click",
            target: { locators: [{ kind: "css", value: "#save" }], hint: { role: "button", surface: "dom", id: "save" } },
            check: { kind: "text", match: "Saved", timeoutMs: 5000 },
          },
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
        { name: "name", type: "text", label: "Name", supply: "saved", default: "Author" },
        { name: "email", type: "text", label: "Email", supply: "saved", default: "author@example.com" },
        { name: "password", type: "secret", label: "Password", supply: "saved", default: "author-password" },
        { name: "note", type: "text", label: "Note", supply: "saved", default: "mine", ownerSaved: true },
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

test("a cdp-live driver is rejected and is not replayed", async () => {
  await fixture(async (client, library) => {
    assert.throws(() => library.save({ ...workflow, driver: "cdp-live" as unknown as WorkflowV2["driver"] }), /driver/);
    assert.equal(library.list().workflows.some((doc) => doc.id === workflow.id), false);
    library.save({ ...workflow, id: "owner", name: "Saved owner workflow" });
    library.save({ ...workflow, id: "fixture", provenance: "fixture" });
    await client.handshake();
    const search = await client.call("search_workflows", { query: "Saved" });
    assert.deepEqual((JSON.parse(search.text) as { hits: { id: string }[] }).hits.map((hit) => hit.id), ["owner"]);
    assert.deepEqual(library.listRuns(), []);
  });
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
    while (Date.now() - start < scaledMs(timeoutMs)) {
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

test("input resumes preserve the browser choice and allow explicit overrides", { timeout: scaledMs(90_000) }, async () => {
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
    library.save(testWorkflow({
      ...workflow, id: "input-browser", startUrl: site,
      inputs: [{ name: "password", type: "secret", label: "Password", supply: "must" }],
      steps: [{
        id: "account",
        index: 0,
        timeoutMs: 1000,
        caption: { text: "Read account" },
        action: "verify",
        check: { kind: "text", match: "Account fixture", timeoutMs: 1000 },
      }],
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

test("replay failure and continued held-run tokens preserve a named browser", { timeout: scaledMs(90_000) }, async (t) => {
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
  const check: WorkflowStep = { id: "check", index: 0, timeoutMs: 100, caption: { text: "Check account" }, action: "verify", check: { kind: "text", match: "Not ready", timeoutMs: 100 } };
  const doc: WorkflowV2 = testWorkflow({ ...workflow, id: "resume-writers", startUrl: site, steps: [check] });
  for (const held of [false, true]) {
    library.save(testWorkflow({ ...doc, steps: held ? [
      {
        id: "signin",
        index: 0,
        timeoutMs: 1000,
        caption: { text: "Sign in" },
        action: "handoff",
        reason: "sign-in",
        check: { kind: "text", match: "Signed in", timeoutMs: 1000 },
      },
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
    library.save(testWorkflow({ ...doc, steps: [{
      id: "check",
      index: 0,
      timeoutMs: 100,
      caption: { text: "Check account" },
      action: "verify",
      check: { kind: "text", match: "Ready", timeoutMs: 1000 },
    }] }));
    seen.length = 0;
    const resumed = await runWorkflow(library, { resume: token });
    assert.equal(resumed.outcome, "ok", resumed.reason);
    assert.equal(seen.at(-1), "copy", "retry keeps the source-copy account instead of either lasting profile");
    token = "";
  }
});

test("a held replay blocks update stops and supports resume and cancel after replacement", { timeout: scaledMs(60_000) }, async () => {
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
    library.save(testWorkflow({
      ...workflow,
      id: "held-signin",
      startUrl: `http://127.0.0.1:${address.port}/`,
      steps: [{ id: "signin", index: 0, timeoutMs: 1000, caption: { text: "Sign in" }, action: "handoff", reason: "sign-in" }],
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
