import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { frameRpc } from "../../src/mcp/frame";
import { liveSessionDir, SessionLog } from "../../src/cdp-live/audit";
import { startApp } from "../../src/app/server";
import { resolveHome } from "../../src/home";

const cli = path.join(process.cwd(), "desktop/dist/desktop/src/app/cli.js");
const darwinPreload = path.join(process.cwd(), "desktop/test/unit/force-darwin.cjs");
const observeHook = path.join(process.cwd(), "desktop/mcp/claude/hooks/observe.mjs");

function childEnv(userHome: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: userHome };
  delete env.BAO_HOME;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function runCli(args: string[], env: NodeJS.ProcessEnv, cwd: string, forceDarwin = false): Promise<{ code: number; stdout: string; stderr: string }> {
  const nodeArgs = forceDarwin ? ["--require", darwinPreload] : [];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, cli, ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function runStatus(args: string[], env: NodeJS.ProcessEnv, cwd: string, forceDarwin = false): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCli(["status", ...args], env, cwd, forceDarwin);
}

function workflowJson(id: string): string {
  return `${JSON.stringify({
    schema: "bao.workflow/v2",
    version: 2,
    id,
    name: id,
    startUrl: "https://example.com/",
    inputs: [],
    steps: [],
    createdAt: 1,
  })}\n`;
}

function plantWorkflow(dir: string, id: string): void {
  mkdirSync(path.join(dir, "workflows"), { recursive: true });
  writeFileSync(path.join(dir, "workflows", `${id}.json`), workflowJson(id));
}

function hasWorkflowFile(dir: string): boolean {
  const folder = path.join(dir, "workflows");
  try {
    return readdirSync(folder).some((name) => name.endsWith(".json") && statSync(path.join(folder, name)).isFile());
  } catch {
    return false;
  }
}

interface ToolReply {
  id?: number;
  result?: { content?: { text?: string }[]; isError?: boolean };
}

function mcpCall(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  tool: string,
  toolArgs: Record<string, unknown>,
  forceDarwin = false,
): Promise<{ payload: Record<string, unknown>; stderr: string }> {
  const nodeArgs = forceDarwin ? ["--require", darwinPreload] : [];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, cli, "mcp", ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let stderr = "";
    const messages: ToolReply[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      let nl = out.indexOf("\n");
      while (nl >= 0) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (line.startsWith("{")) messages.push(JSON.parse(line) as ToolReply);
        nl = out.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    const send = (msg: unknown) => child.stdin.write(frameRpc(msg, "json"));
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "home", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: toolArgs } });
    const start = Date.now();
    const timer = setInterval(() => {
      const hit = messages.find((msg) => msg.id === 2);
      if (!hit && Date.now() - start < 5000) return;
      clearInterval(timer);
      child.kill();
      if (!hit) {
        reject(new Error(`no tool reply\n${stderr}`));
        return;
      }
      const text = hit.result?.content?.[0]?.text || "";
      if (hit.result?.isError) {
        reject(new Error(text));
        return;
      }
      resolve({ payload: JSON.parse(text) as Record<string, unknown>, stderr });
    }, 20);
  });
}

function layout(): { root: string; user: string; flagged: string; fromEnv: string; cwdA: string; cwdB: string } {
  const root = mkdtempSync(path.join(tmpdir(), "bao-home-"));
  const dirs = {
    root,
    user: path.join(root, "user"),
    flagged: path.join(root, "flagged"),
    fromEnv: path.join(root, "from-env"),
    cwdA: path.join(root, "cwd-a"),
    cwdB: path.join(root, "cwd-b"),
  };
  for (const dir of Object.values(dirs)) {
    if (dir !== root) mkdirSync(dir);
  }
  mkdirSync(root, { recursive: true });
  return dirs;
}

test("status resolves --home, then BAO_HOME, then the platform default", async () => {
  const dirs = layout();
  const flagged = await runStatus(["--home", dirs.flagged], childEnv(dirs.user, { BAO_HOME: dirs.fromEnv }), dirs.cwdA);
  assert.equal(flagged.code, 0);
  assert.deepEqual(JSON.parse(flagged.stdout), { home: dirs.flagged });

  const fromEnv = await runStatus([], childEnv(dirs.user, { BAO_HOME: dirs.fromEnv }), dirs.cwdB);
  assert.equal(fromEnv.code, 0);
  assert.deepEqual(JSON.parse(fromEnv.stdout), { home: dirs.fromEnv });

  const emptyEnv = await runStatus([], childEnv(dirs.user, { BAO_HOME: "" }), dirs.cwdA);
  assert.deepEqual(JSON.parse(emptyEnv.stdout), { home: path.join(dirs.user, ".local", "share", "bao") });

  const left = await runStatus([], childEnv(dirs.user), dirs.cwdA);
  const right = await runStatus([], childEnv(dirs.user), dirs.cwdB);
  const expected = path.join(dirs.user, ".local", "share", "bao");
  assert.deepEqual(JSON.parse(left.stdout), { home: expected });
  assert.equal(left.stdout, right.stdout);
  assert.equal(existsSync(expected), false);
});

test("status keeps a legacy workflow directory and does not copy it", async () => {
  const dirs = layout();
  const legacy = path.join(dirs.cwdA, ".bao-mcp");
  mkdirSync(path.join(legacy, "workflows"), { recursive: true });
  writeFileSync(path.join(legacy, "workflows", "keep.json"), "{\"id\":\"keep\"}\n");
  const old = path.join(dirs.user, ".local", "share", "bao");
  mkdirSync(path.join(old, "runs"), { recursive: true });
  writeFileSync(path.join(old, "runs", "run-1.json"), "{}\n");

  const warned = await runStatus(["--home", dirs.flagged], childEnv(dirs.user), dirs.cwdA);
  assert.equal(warned.code, 0);
  assert.deepEqual(JSON.parse(warned.stdout), { home: legacy });
  assert.equal(warned.stderr.trim(), `bao: no workflows in ${dirs.flagged}; using ${legacy}`);
  assert.equal(readFileSync(path.join(legacy, "workflows", "keep.json"), "utf8"), "{\"id\":\"keep\"}\n");
  assert.equal(readFileSync(path.join(old, "runs", "run-1.json"), "utf8"), "{}\n");
  assert.equal(existsSync(path.join(dirs.flagged, "workflows")), false);
  assert.equal(existsSync(path.join(dirs.flagged, "runs")), false);
});

test("status stays quiet when the resolved home is the only library", async () => {
  const dirs = layout();
  const home = path.join(dirs.user, ".local", "share", "bao");
  mkdirSync(path.join(home, "workflows"), { recursive: true });
  writeFileSync(path.join(home, "workflows", "mine.json"), "{}\n");
  const quiet = await runStatus([], childEnv(dirs.user), dirs.cwdA);
  assert.equal(quiet.stderr, "");
  assert.deepEqual(JSON.parse(quiet.stdout), { home });
});

test("bao mcp passes --home through without putting the directory on the tool result", async () => {
  const dirs = layout();
  const called = await mcpCall(dirs.cwdA, ["--home", dirs.flagged], childEnv(dirs.user, { BAO_HOME: dirs.fromEnv }), "run_workflow", {});
  assert.equal("home" in called.payload, false);
  assert.equal(called.payload.outcome, "failed");
  assert.equal(existsSync(path.join(dirs.cwdA, ".bao-mcp")), false);
  assert.equal(existsSync(path.join(dirs.fromEnv, "workflows")), false);
  assert.equal(existsSync(path.join(dirs.flagged, "workflows")), true);

  const left = await mcpCall(dirs.cwdA, [], childEnv(dirs.user), "run_workflow", {});
  const right = await mcpCall(dirs.cwdB, [], childEnv(dirs.user), "run_workflow", {});
  const expected = path.join(dirs.user, ".local", "share", "bao");
  assert.equal("home" in left.payload, false);
  assert.equal("home" in right.payload, false);
  assert.equal(existsSync(path.join(expected, "workflows")), true);
  assert.equal(existsSync(path.join(dirs.cwdA, ".bao-mcp")), false);
  assert.equal(existsSync(path.join(dirs.cwdB, ".bao-mcp")), false);
});

test("get_run returns the stored run without a home path", async () => {
  const dirs = layout();
  const stored = {
    outcome: "ok",
    status: "ok",
    workflowId: "wf",
    runId: "run-1",
    receipts: [],
    stops: [],
    link: "bao://workflow/wf",
  };
  mkdirSync(path.join(dirs.flagged, "reports"), { recursive: true });
  writeFileSync(path.join(dirs.flagged, "reports", "run-1.json"), `${JSON.stringify(stored)}\n`);
  const called = await mcpCall(dirs.cwdA, ["--home", dirs.flagged], childEnv(dirs.user), "get_run", { run_id: "run-1" });
  assert.equal("home" in called.payload, false);
  assert.equal(called.payload.status, "ok");
  assert.equal(called.payload.runId, "run-1");
  assert.equal(JSON.parse(readFileSync(path.join(dirs.flagged, "reports", "run-1.json"), "utf8")).home, undefined);
});

test("mcp keeps a legacy workflow directory and does not merge it into --home", async () => {
  const dirs = layout();
  const legacy = path.join(dirs.cwdA, ".bao-mcp");
  mkdirSync(path.join(legacy, "workflows"), { recursive: true });
  writeFileSync(path.join(legacy, "workflows", "keep.json"), "{\"id\":\"keep\"}\n");
  const called = await mcpCall(dirs.cwdA, ["--home", dirs.flagged], childEnv(dirs.user), "run_workflow", {});
  assert.equal("home" in called.payload, false);
  assert.equal(called.stderr.trim(), `bao: no workflows in ${dirs.flagged}; using ${legacy}`);
  assert.equal(readFileSync(path.join(legacy, "workflows", "keep.json"), "utf8"), "{\"id\":\"keep\"}\n");
  assert.equal(existsSync(path.join(dirs.flagged, "workflows")), false);
  assert.equal(existsSync(path.join(dirs.flagged, "runs")), false);
  assert.equal(existsSync(path.join(dirs.flagged, "shots")), false);
  assert.equal(existsSync(path.join(legacy, "workflows", "keep.json")), true);
});

test("live audit writes the session under the resolved home", async () => {
  const dirs = layout();
  const previousHome = process.env.BAO_HOME;
  const previousUser = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.BAO_HOME = dirs.flagged;
  process.env.HOME = dirs.user;
  process.chdir(dirs.cwdA);
  try {
    const dir = liveSessionDir();
    assert.equal(dir, path.join(dirs.flagged, "live-session"));
    const log = new SessionLog(dir, "Check the library");
    await log.flush("running");
    assert.equal(existsSync(path.join(dirs.flagged, "live-session", "session.json")), true);
    assert.equal(existsSync(path.join(dirs.cwdA, "live-session")), false);
    assert.equal(existsSync(path.join(dirs.cwdA, ".bao-mcp")), false);
    process.chdir(dirs.cwdB);
    assert.equal(liveSessionDir(), dir);
  } finally {
    process.chdir(previousCwd);
    process.env.HOME = previousUser;
    if (previousHome === undefined) delete process.env.BAO_HOME;
    else process.env.BAO_HOME = previousHome;
  }
});

test("live audit uses one default home from different working directories", () => {
  const dirs = layout();
  const previousHome = process.env.HOME;
  const previousBao = process.env.BAO_HOME;
  const previousCwd = process.cwd();
  process.env.HOME = dirs.user;
  delete process.env.BAO_HOME;
  try {
    process.chdir(dirs.cwdA);
    const left = liveSessionDir();
    process.chdir(dirs.cwdB);
    const right = liveSessionDir();
    assert.equal(left, right);
    assert.equal(left, path.join(dirs.user, ".local", "share", "bao", "live-session"));
    assert.equal(left.startsWith(dirs.cwdA), false);
    assert.equal(right.startsWith(dirs.cwdB), false);
  } finally {
    process.chdir(previousCwd);
    process.env.HOME = previousHome;
    if (previousBao === undefined) delete process.env.BAO_HOME;
    else process.env.BAO_HOME = previousBao;
  }
});

test("resolver precedence matches the installed macOS home", () => {
  const dirs = layout();
  const user = path.join(dirs.user, "Alex");
  const quiet = () => {};
  assert.equal(
    resolveHome({ args: ["--home", dirs.flagged], env: { BAO_HOME: dirs.fromEnv }, platform: "darwin", userHome: user, cwd: dirs.cwdA, warn: quiet }),
    dirs.flagged,
  );
  assert.equal(
    resolveHome({ env: { BAO_HOME: dirs.fromEnv }, platform: "darwin", userHome: user, cwd: dirs.cwdB, warn: quiet }),
    dirs.fromEnv,
  );
  assert.equal(
    resolveHome({ env: { BAO_HOME: "" }, platform: "darwin", userHome: user, cwd: dirs.cwdA, warn: quiet }),
    path.join(user, "Library", "Application Support", "bao"),
  );
  assert.equal(
    resolveHome({ env: {}, platform: "linux", userHome: user, cwd: dirs.cwdA, warn: quiet }),
    path.join(user, ".local", "share", "bao"),
  );
  assert.equal(
    resolveHome({ env: {}, platform: "linux", userHome: user, cwd: dirs.cwdB, warn: quiet }),
    path.join(user, ".local", "share", "bao"),
  );
});

test("resolver warns once when both directories hold workflows and does not copy", () => {
  const dirs = layout();
  const legacy = path.join(dirs.cwdA, ".bao-mcp");
  const chosen = path.join(dirs.root, "chosen");
  plantWorkflow(legacy, "keep");
  plantWorkflow(chosen, "fresh");
  const lines: string[] = [];
  const home = resolveHome({
    args: ["--home", chosen],
    env: {},
    platform: "linux",
    userHome: dirs.user,
    cwd: dirs.cwdA,
    warn: (line) => lines.push(line),
  });
  resolveHome({
    args: ["--home", chosen],
    env: {},
    platform: "linux",
    userHome: dirs.user,
    cwd: dirs.cwdA,
    warn: (line) => lines.push(line),
  });
  assert.equal(home, path.resolve(chosen));
  assert.deepEqual(lines, [`bao: library data is at ${path.resolve(legacy)}; using ${path.resolve(chosen)}`]);
  assert.equal(readFileSync(path.join(legacy, "workflows", "keep.json"), "utf8"), workflowJson("keep"));
  assert.equal(existsSync(path.join(chosen, "workflows", "keep.json")), false);
});

test("a legacy directory whose only entry is .DS_Store is empty", () => {
  const dirs = layout();
  const legacy = path.join(dirs.cwdA, ".bao-mcp");
  const chosen = path.join(dirs.root, "chosen");
  mkdirSync(legacy);
  writeFileSync(path.join(legacy, ".DS_Store"), "junk");
  const lines: string[] = [];
  const home = resolveHome({
    args: ["--home", chosen],
    env: {},
    platform: "linux",
    userHome: dirs.user,
    cwd: dirs.cwdA,
    warn: (line) => lines.push(line),
  });
  assert.equal(home, path.resolve(chosen));
  assert.deepEqual(lines, []);
  assert.equal(existsSync(chosen), false);
});

test("darwin status keeps ~/.local/share/bao/workflows/keep.json and warns", async () => {
  const dirs = layout();
  const legacy = path.join(dirs.user, ".local", "share", "bao");
  mkdirSync(path.join(legacy, "workflows"), { recursive: true });
  writeFileSync(path.join(legacy, "workflows", "keep.json"), "{\"id\":\"keep\"}\n");
  const fresh = path.join(dirs.user, "Library", "Application Support", "bao");
  const status = await runStatus([], childEnv(dirs.user), dirs.cwdA, true);
  assert.equal(status.code, 0);
  assert.deepEqual(JSON.parse(status.stdout), { home: legacy });
  assert.equal(status.stderr.trim(), `bao: no workflows in ${fresh}; using ${legacy}`);
  assert.equal(existsSync(path.join(fresh, "workflows")), false);
  assert.equal(existsSync(path.join(fresh, "runs")), false);
  assert.equal(existsSync(path.join(fresh, "shots")), false);
  assert.equal(existsSync(path.join(fresh, "trails")), false);
  assert.equal(existsSync(path.join(fresh, "promotions")), false);
});

test("darwin bao open reads server.json from the legacy library", async () => {
  const dirs = layout();
  const legacy = path.join(dirs.user, ".local", "share", "bao");
  plantWorkflow(legacy, "keep");
  const hits = { n: 0 };
  const server = createServer((_req, res) => {
    hits.n += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  writeFileSync(path.join(legacy, "server.json"), `${JSON.stringify({ port })}\n`);
  try {
    const opened = await runCli(["open", "bao://workflow/keep"], childEnv(dirs.user), dirs.cwdA, true);
    assert.equal(opened.code, 0, opened.stderr);
    assert.equal(opened.stderr.includes("start Bao first"), false);
    assert.deepEqual(JSON.parse(opened.stdout), { ok: true });
    assert.equal(hits.n, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test("darwin bao open finds server.json that exists only under the legacy directory", async () => {
  const dirs = layout();
  const legacy = path.join(dirs.user, ".local", "share", "bao");
  mkdirSync(legacy, { recursive: true });
  const hits = { n: 0 };
  const server = createServer((_req, res) => {
    hits.n += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  writeFileSync(path.join(legacy, "server.json"), `${JSON.stringify({ port })}\n`);
  try {
    const opened = await runCli(["open", "bao://workflow/keep"], childEnv(dirs.user), dirs.cwdA, true);
    assert.equal(opened.code, 0, opened.stderr);
    assert.equal(opened.stderr.includes("start Bao first"), false);
    assert.equal(opened.stderr.includes("library data"), false);
    assert.deepEqual(JSON.parse(opened.stdout), { ok: true });
    assert.equal(hits.n, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test("darwin mcp search reads the legacy workflow and does not create the new library", async () => {
  const dirs = layout();
  const legacy = path.join(dirs.user, ".local", "share", "bao");
  plantWorkflow(legacy, "keep");
  const fresh = path.join(dirs.user, "Library", "Application Support", "bao");
  const called = await mcpCall(dirs.cwdA, [], childEnv(dirs.user), "search_workflows", { query: "keep" }, true);
  const hits = called.payload.hits as { id: string }[];
  assert.ok(hits.some((hit) => hit.id === "keep"));
  assert.equal("home" in called.payload, false);
  assert.equal(JSON.stringify(called.payload).includes(dirs.user), false);
  for (const name of ["workflows", "runs", "shots", "trails", "promotions"]) {
    assert.equal(existsSync(path.join(fresh, name)), false, name);
  }
});

test("darwin tool results name both libraries with a tilde when each holds workflows", async () => {
  const dirs = layout();
  const legacy = path.join(dirs.user, ".local", "share", "bao");
  const fresh = path.join(dirs.user, "Library", "Application Support", "bao");
  plantWorkflow(legacy, "keep");
  plantWorkflow(fresh, "fresh");
  mkdirSync(path.join(fresh, "reports"), { recursive: true });
  writeFileSync(path.join(fresh, "reports", "run-1.json"), `${JSON.stringify({
    outcome: "ok",
    status: "ok",
    workflowId: "fresh",
    runId: "run-1",
    receipts: [],
    stops: [],
    link: "bao://workflow/fresh",
  })}\n`);
  const env = childEnv(dirs.user);
  const search = await mcpCall(dirs.cwdA, [], env, "search_workflows", { query: "fresh" }, true);
  const run = await mcpCall(dirs.cwdA, [], env, "run_workflow", {}, true);
  const got = await mcpCall(dirs.cwdA, [], env, "get_run", { run_id: "run-1" }, true);
  const expected = ["~/Library/Application Support/bao", "~/.local/share/bao"];
  for (const called of [search, run, got]) {
    assert.equal("home" in called.payload, false);
    assert.deepEqual(called.payload.libraries, expected);
    assert.equal(JSON.stringify(called.payload).includes(dirs.user), false);
  }
  const hits = search.payload.hits as { id: string }[];
  assert.ok(hits.some((hit) => hit.id === "fresh"));
  assert.equal(hits.some((hit) => hit.id === "keep"), false);
});

test("the window lists a workflow kept from the legacy library", async () => {
  const dirs = layout();
  const legacy = path.join(dirs.user, ".local", "share", "bao");
  plantWorkflow(legacy, "keep");
  const previousHome = process.env.HOME;
  const previousBao = process.env.BAO_HOME;
  process.env.HOME = dirs.user;
  delete process.env.BAO_HOME;
  const home = resolveHome({ env: { HOME: dirs.user }, platform: "darwin", userHome: dirs.user, cwd: dirs.cwdA, warn: () => {} });
  const app = await startApp({ home, port: 0 });
  try {
    const state = await (await fetch(`http://127.0.0.1:${app.port}/api/state`)).json() as { workflows?: { id: string }[] };
    assert.ok(state.workflows?.some((item) => item.id === "keep"));
    assert.equal(existsSync(path.join(dirs.user, "Library", "Application Support", "bao", "workflows")), false);
  } finally {
    await app.close();
    process.env.HOME = previousHome;
    if (previousBao === undefined) delete process.env.BAO_HOME;
    else process.env.BAO_HOME = previousBao;
  }
});

test("the window names both libraries when each holds workflows", async () => {
  const dirs = layout();
  const legacy = path.join(dirs.user, ".local", "share", "bao");
  const fresh = path.join(dirs.user, "Library", "Application Support", "bao");
  plantWorkflow(legacy, "keep");
  plantWorkflow(fresh, "fresh");
  const previousHome = process.env.HOME;
  const previousBao = process.env.BAO_HOME;
  const previousCwd = process.cwd();
  process.env.HOME = dirs.user;
  delete process.env.BAO_HOME;
  process.chdir(dirs.cwdA);
  const home = resolveHome({ env: { HOME: dirs.user }, platform: "darwin", userHome: dirs.user, cwd: dirs.cwdA, warn: () => {} });
  const app = await startApp({ home, port: 0 });
  try {
    assert.equal(home, fresh);
    const state = await (await fetch(`http://127.0.0.1:${app.port}/api/state`)).json() as { librarySplits?: string[] };
    const splits = state.librarySplits || [];
    assert.ok(splits.some((line) => line.includes(legacy) && line.includes(fresh)));
  } finally {
    await app.close();
    process.chdir(previousCwd);
    process.env.HOME = previousHome;
    if (previousBao === undefined) delete process.env.BAO_HOME;
    else process.env.BAO_HOME = previousBao;
  }
});

test("--home= accepts a directory, rejects a missing value, and resolves a relative path", async () => {
  const dirs = layout();
  const env = childEnv(dirs.user);
  const equals = await runStatus(["--home=/x"], env, dirs.cwdA);
  assert.equal(equals.code, 0);
  assert.deepEqual(JSON.parse(equals.stdout), { home: "/x" });

  const relative = await runStatus(["--home", "rel-lib"], env, dirs.cwdA);
  assert.equal(relative.code, 0);
  assert.deepEqual(JSON.parse(relative.stdout), { home: path.resolve(dirs.cwdA, "rel-lib") });

  const tilde = await runStatus(["--home=~/box"], env, dirs.cwdA);
  assert.equal(tilde.code, 0);
  assert.deepEqual(JSON.parse(tilde.stdout), { home: path.join(dirs.user, "box") });

  const fromEnv = await runStatus([], childEnv(dirs.user, { BAO_HOME: "rel-lib" }), dirs.cwdB);
  assert.deepEqual(JSON.parse(fromEnv.stdout), { home: path.resolve(dirs.cwdB, "rel-lib") });

  const missing = await runStatus(["--home"], env, dirs.cwdA);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /--home needs a directory/);

  const stolen = await runStatus(["--home", "--port"], env, dirs.cwdA);
  assert.equal(stolen.code, 1);
  assert.match(stolen.stderr, /--home needs a directory/);
});

test("resolveHome rejects a null byte before touching the filesystem", () => {
  const dirs = layout();
  assert.throws(
    () => resolveHome({ args: ["--home", "bad\0dir"], env: {}, platform: "linux", userHome: dirs.user, cwd: dirs.cwdA, warn: () => {} }),
    /null byte/,
  );
  assert.throws(
    () => resolveHome({ env: { BAO_HOME: "bad\0dir" }, platform: "linux", userHome: dirs.user, cwd: dirs.cwdA, warn: () => {} }),
    /null byte/,
  );
});

test("an empty HOME uses /tmp, matching the macOS launcher", () => {
  const home = resolveHome({ env: { HOME: "" }, platform: "darwin", cwd: "/tmp", warn: () => {} });
  const real = homedir();
  if (real !== "/tmp") assert.equal(home.startsWith(`${real}${path.sep}`), false);
  assert.equal(home.startsWith("/tmp/"), true);
  const legacy = path.join("/tmp", ".local", "share", "bao");
  const fallback = path.join("/tmp", "Library", "Application Support", "bao");
  assert.equal(home, hasWorkflowFile(legacy) && !hasWorkflowFile(fallback) ? legacy : fallback);
});

test("liveSessionDir follows the home bao serve binds", async () => {
  const dirs = layout();
  const custom = path.join(dirs.root, "custom");
  const previousHome = process.env.HOME;
  const previousBao = process.env.BAO_HOME;
  process.env.HOME = dirs.user;
  delete process.env.BAO_HOME;
  const resolved = resolveHome({
    args: ["--home", custom],
    env: { HOME: dirs.user },
    platform: "linux",
    userHome: dirs.user,
    cwd: dirs.root,
    warn: () => {},
  });
  const app = await startApp({ home: resolved, port: 0 });
  try {
    assert.equal(resolved, custom);
    assert.equal(process.env.BAO_HOME, custom);
    assert.equal(liveSessionDir(), path.join(custom, "live-session"));
  } finally {
    await app.close();
    process.env.HOME = previousHome;
    if (previousBao === undefined) delete process.env.BAO_HOME;
    else process.env.BAO_HOME = previousBao;
  }
});

test("the observer hook writes under the macOS library", async () => {
  const dirs = layout();
  const child = spawn(process.execPath, ["--require", darwinPreload, observeHook], {
    cwd: dirs.cwdA,
    env: childEnv(dirs.user),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const done = new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, stderr }));
  });
  child.stdin.end("{}\n");
  const result = await done;
  assert.equal(result.code, 0, result.stderr);
  const trail = path.join(dirs.user, "Library", "Application Support", "bao", "observer", "trail.jsonl");
  assert.equal(existsSync(trail), true);
  assert.equal(existsSync(path.join(dirs.user, ".local", "share", "bao", "observer", "trail.jsonl")), false);
});
