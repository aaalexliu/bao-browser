import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { frameRpc } from "../../src/mcp/frame";
import { liveSessionDir, SessionLog } from "../../src/cdp-live/audit";
import { resolveHome } from "../../src/home";

const cli = path.join(process.cwd(), "desktop/dist/desktop/src/app/cli.js");

function childEnv(userHome: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: userHome };
  delete env.BAO_HOME;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function runStatus(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "status", ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
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
): Promise<{ payload: Record<string, unknown>; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "mcp", ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
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

test("status names a legacy library and leaves it in place", async () => {
  const dirs = layout();
  const legacy = path.join(dirs.cwdA, ".bao-mcp");
  mkdirSync(path.join(legacy, "workflows"), { recursive: true });
  writeFileSync(path.join(legacy, "workflows", "keep.json"), "{\"id\":\"keep\"}\n");
  const old = path.join(dirs.user, ".local", "share", "bao");
  mkdirSync(path.join(old, "runs"), { recursive: true });
  writeFileSync(path.join(old, "runs", "run-1.json"), "{}\n");

  const warned = await runStatus(["--home", dirs.flagged], childEnv(dirs.user), dirs.cwdA);
  assert.equal(warned.code, 0);
  assert.deepEqual(JSON.parse(warned.stdout), { home: dirs.flagged });
  const lines = warned.stderr.trim().split("\n");
  assert.deepEqual(lines, [
    `bao: library data is at ${old}; using ${dirs.flagged}`,
    `bao: library data is at ${legacy}; using ${dirs.flagged}`,
  ]);
  assert.equal(readFileSync(path.join(legacy, "workflows", "keep.json"), "utf8"), "{\"id\":\"keep\"}\n");
  assert.equal(readFileSync(path.join(old, "runs", "run-1.json"), "utf8"), "{}\n");
  assert.equal(existsSync(path.join(dirs.flagged, "workflows", "keep.json")), false);
  assert.equal(existsSync(path.join(dirs.flagged, "runs", "run-1.json")), false);
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

test("bao mcp passes --home through and reports it on a run record", async () => {
  const dirs = layout();
  const called = await mcpCall(dirs.cwdA, ["--home", dirs.flagged], childEnv(dirs.user, { BAO_HOME: dirs.fromEnv }), "run_workflow", {});
  assert.equal(called.payload.home, dirs.flagged);
  assert.equal(called.payload.outcome, "failed");
  assert.equal(existsSync(path.join(dirs.cwdA, ".bao-mcp")), false);
  assert.equal(existsSync(path.join(dirs.fromEnv, "workflows")), false);
  assert.equal(existsSync(path.join(dirs.flagged, "workflows")), true);

  const left = await mcpCall(dirs.cwdA, [], childEnv(dirs.user), "run_workflow", {});
  const right = await mcpCall(dirs.cwdB, [], childEnv(dirs.user), "run_workflow", {});
  const expected = path.join(dirs.user, ".local", "share", "bao");
  assert.equal(left.payload.home, expected);
  assert.equal(right.payload.home, expected);
  assert.equal(existsSync(path.join(dirs.cwdA, ".bao-mcp")), false);
  assert.equal(existsSync(path.join(dirs.cwdB, ".bao-mcp")), false);
});

test("get_run returns the resolved home with the stored run", async () => {
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
  assert.equal(called.payload.home, dirs.flagged);
  assert.equal(called.payload.status, "ok");
  assert.equal(called.payload.runId, "run-1");
  assert.equal(JSON.parse(readFileSync(path.join(dirs.flagged, "reports", "run-1.json"), "utf8")).home, undefined);
});

test("mcp warns about a legacy library and does not merge it", async () => {
  const dirs = layout();
  const legacy = path.join(dirs.cwdA, ".bao-mcp", "workflows");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, "keep.json"), "{\"id\":\"keep\"}\n");
  const called = await mcpCall(dirs.cwdA, ["--home", dirs.flagged], childEnv(dirs.user), "run_workflow", {});
  assert.equal(called.payload.home, dirs.flagged);
  assert.ok(called.stderr.includes(`bao: library data is at ${path.join(dirs.cwdA, ".bao-mcp")}; using ${dirs.flagged}`));
  assert.equal(readFileSync(path.join(legacy, "keep.json"), "utf8"), "{\"id\":\"keep\"}\n");
  assert.equal(existsSync(path.join(dirs.flagged, "workflows", "keep.json")), false);
});

test("live audit writes the session under the resolved home", async () => {
  const dirs = layout();
  const previousHome = process.env.BAO_HOME;
  const previousCwd = process.cwd();
  process.env.BAO_HOME = dirs.flagged;
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

test("resolver warns once and does not copy a legacy library", () => {
  const dirs = layout();
  const legacy = path.join(dirs.cwdA, ".bao-mcp");
  mkdirSync(legacy);
  writeFileSync(path.join(legacy, "settings.json"), "{}\n");
  const lines: string[] = [];
  const home = resolveHome({
    args: ["--home", dirs.flagged],
    env: {},
    platform: "linux",
    userHome: dirs.user,
    cwd: dirs.cwdA,
    warn: (line) => lines.push(line),
  });
  resolveHome({
    args: ["--home", dirs.flagged],
    env: {},
    platform: "linux",
    userHome: dirs.user,
    cwd: dirs.cwdA,
    warn: (line) => lines.push(line),
  });
  assert.equal(home, dirs.flagged);
  assert.deepEqual(lines, [`bao: library data is at ${legacy}; using ${dirs.flagged}`]);
  assert.equal(readFileSync(path.join(legacy, "settings.json"), "utf8"), "{}\n");
  assert.equal(existsSync(dirs.flagged), false);
});
