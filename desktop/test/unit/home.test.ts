import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { frameRpc } from "../../src/mcp/frame";
import { liveSessionDir, SessionLog } from "../../src/cdp-live/audit";
import { startApp } from "../../src/app/server";
import { resolveHome } from "../../src/home";

const cli = path.join(process.cwd(), "desktop/dist/desktop/src/app/cli.js");
const darwinPreload = path.join(process.cwd(), "desktop/test/unit/force-darwin.cjs");
const linuxPreload = path.join(process.cwd(), "desktop/test/unit/force-linux.cjs");
const observeHook = path.join(process.cwd(), "desktop/mcp/claude/hooks/observe.mjs");

type PlatformForce = boolean | "linux" | "darwin";

function nodeArgsFor(force: PlatformForce = false): string[] {
  if (force === true || force === "darwin") return ["--require", darwinPreload];
  if (force === "linux") return ["--require", linuxPreload];
  return [];
}

function platformDefault(userHome: string, platform: "linux" | "darwin"): string {
  if (platform === "darwin") return path.join(userHome, "Library", "Application Support", "bao");
  return path.join(userHome, ".local", "share", "bao");
}

function childEnv(userHome: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: userHome };
  delete env.BAO_HOME;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function runCli(args: string[], env: NodeJS.ProcessEnv, cwd: string, forceDarwin: PlatformForce = false): Promise<{ code: number; stdout: string; stderr: string }> {
  const nodeArgs = nodeArgsFor(forceDarwin);
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

function runStatus(args: string[], env: NodeJS.ProcessEnv, cwd: string, forceDarwin: PlatformForce = false): Promise<{ code: number; stdout: string; stderr: string }> {
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
  forceDarwin: PlatformForce = false,
): Promise<{ payload: Record<string, unknown>; stderr: string }> {
  const nodeArgs = nodeArgsFor(forceDarwin);
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

// A child's cwd is a realpath (/private/var on macOS), so every path starts from one.
function layout(): { root: string; user: string; flagged: string; fromEnv: string; cwdA: string; cwdB: string } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bao-home-")));
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

  for (const platform of ["linux", "darwin"] as const) {
    const homeDirs = layout();
    const expected = platformDefault(homeDirs.user, platform);
    const emptyEnv = await runStatus([], childEnv(homeDirs.user, { BAO_HOME: "" }), homeDirs.cwdA, platform);
    assert.equal(emptyEnv.code, 0, emptyEnv.stderr);
    assert.deepEqual(JSON.parse(emptyEnv.stdout), { home: expected });
    const left = await runStatus([], childEnv(homeDirs.user), homeDirs.cwdA, platform);
    const right = await runStatus([], childEnv(homeDirs.user), homeDirs.cwdB, platform);
    assert.deepEqual(JSON.parse(left.stdout), { home: expected });
    assert.equal(left.stdout, right.stdout);
    assert.equal(existsSync(expected), false);
  }
});

test("status keeps a legacy workflow directory and does not copy it", async () => {
  const dirs = layout();
  const legacy = path.join(dirs.cwdA, ".bao-mcp");
  mkdirSync(path.join(legacy, "workflows"), { recursive: true });
  writeFileSync(path.join(legacy, "workflows", "keep.json"), "{\"id\":\"keep\"}\n");
  const old = path.join(dirs.user, ".local", "share", "bao");
  mkdirSync(path.join(old, "runs"), { recursive: true });
  writeFileSync(path.join(old, "runs", "run-1.json"), "{}\n");
  const fresh = platformDefault(dirs.user, "darwin");

  const warned = await runStatus([], childEnv(dirs.user), dirs.cwdA, "darwin");
  assert.equal(warned.code, 0);
  const warnedBody = JSON.parse(warned.stdout) as { home: string; notices?: string[] };
  assert.equal(warnedBody.home, legacy);
  assert.deepEqual(warnedBody.notices, [
    `bao: no workflows in ${fresh}; using ${legacy}`,
    `bao: library data is at ${old}; using ${legacy}`,
  ]);
  assert.equal(warned.stderr.trim(), warnedBody.notices.join("\n"));
  assert.equal(readFileSync(path.join(legacy, "workflows", "keep.json"), "utf8"), "{\"id\":\"keep\"}\n");
  assert.equal(readFileSync(path.join(old, "runs", "run-1.json"), "utf8"), "{}\n");
  assert.equal(existsSync(fresh), false);
});

test("an explicit --home or BAO_HOME wins over legacy libraries that hold data", async () => {
  for (const platform of ["linux", "darwin"] as const) {
    const dirs = layout();
    const old = path.join(dirs.user, ".local", "share", "bao");
    const cwdLegacy = path.join(dirs.cwdA, ".bao-mcp");
    plantWorkflow(old, "keep");
    plantWorkflow(cwdLegacy, "also");
    writeFileSync(path.join(old, "server.json"), "{\"port\":39999}\n");

    const flagged = await runStatus(["--home", dirs.flagged], childEnv(dirs.user), dirs.cwdA, platform);
    assert.equal(flagged.code, 0, flagged.stderr);
    assert.deepEqual(JSON.parse(flagged.stdout), { home: dirs.flagged });
    assert.equal(flagged.stderr, "");

    const fromEnv = await runStatus([], childEnv(dirs.user, { BAO_HOME: dirs.fromEnv }), dirs.cwdA, platform);
    assert.equal(fromEnv.code, 0, fromEnv.stderr);
    assert.deepEqual(JSON.parse(fromEnv.stdout), { home: dirs.fromEnv });
    assert.equal(fromEnv.stderr, "");

    const lines: string[] = [];
    const resolved = resolveHome({
      env: { BAO_HOME: dirs.fromEnv },
      platform,
      userHome: dirs.user,
      cwd: dirs.cwdA,
      warn: (line) => lines.push(line),
    });
    assert.equal(resolved, dirs.fromEnv);
    assert.deepEqual(lines, []);

    const called = await mcpCall(dirs.cwdA, ["--home", dirs.flagged], childEnv(dirs.user), "search_workflows", { query: "keep" }, platform);
    assert.deepEqual(called.payload.hits, []);
    assert.equal("libraries" in called.payload, false);
    assert.equal(called.stderr, "");
    assert.equal(existsSync(path.join(dirs.flagged, "workflows")), true);
    assert.equal(readFileSync(path.join(old, "workflows", "keep.json"), "utf8"), workflowJson("keep"));
  }
});

test("live verbs find the app the same way as bao open", async () => {
  const dirs = layout();
  const legacy = path.join(dirs.user, ".local", "share", "bao");
  mkdirSync(legacy, { recursive: true });
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url || "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ outcome: { kind: "ok" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  writeFileSync(path.join(legacy, "server.json"), `${JSON.stringify({ port })}\n`);
  try {
    const kept = await runCli(["live_snapshot"], childEnv(dirs.user), dirs.cwdA, "darwin");
    assert.equal(kept.code, 0, kept.stderr);
    assert.deepEqual(JSON.parse(kept.stdout), { outcome: { kind: "ok" } });
    assert.deepEqual(hits, ["/api/live"]);

    const flagged = await runCli(["live_snapshot", "--home", dirs.flagged], childEnv(dirs.user), dirs.cwdA, "darwin");
    assert.equal(flagged.code, 1);
    assert.match(flagged.stderr, /bao app is not running/);
    const fromEnv = await runCli(["live_snapshot"], childEnv(dirs.user, { BAO_HOME: dirs.fromEnv }), dirs.cwdA, "darwin");
    assert.equal(fromEnv.code, 1);
    assert.match(fromEnv.stderr, /bao app is not running/);
    assert.deepEqual(hits, ["/api/live"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test("bao open with an explicit home does not reach a server named by a legacy library", async () => {
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
    const opened = await runCli(["open", "bao://workflow/abc"], childEnv(dirs.user, { BAO_HOME: dirs.fromEnv, BAO_PORT: undefined }), dirs.cwdA, "darwin");
    assert.equal(opened.code, 1);
    assert.match(opened.stderr, /start Bao first/);
    assert.equal(hits.n, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test("status stays quiet when the resolved home is the only library", async () => {
  for (const platform of ["linux", "darwin"] as const) {
    const dirs = layout();
    const home = platformDefault(dirs.user, platform);
    mkdirSync(path.join(home, "workflows"), { recursive: true });
    writeFileSync(path.join(home, "workflows", "mine.json"), "{}\n");
    const quiet = await runStatus([], childEnv(dirs.user), dirs.cwdA, platform);
    assert.equal(quiet.stderr, "");
    assert.deepEqual(JSON.parse(quiet.stdout), { home });
  }
});

test("bao mcp passes --home through without putting the directory on the tool result", async () => {
  const dirs = layout();
  const called = await mcpCall(dirs.cwdA, ["--home", dirs.flagged], childEnv(dirs.user, { BAO_HOME: dirs.fromEnv }), "run_workflow", {});
  assert.equal("home" in called.payload, false);
  assert.equal(called.payload.outcome, "failed");
  assert.equal(existsSync(path.join(dirs.cwdA, ".bao-mcp")), false);
  assert.equal(existsSync(path.join(dirs.fromEnv, "workflows")), false);
  assert.equal(existsSync(path.join(dirs.flagged, "workflows")), true);

  for (const platform of ["linux", "darwin"] as const) {
    const homeDirs = layout();
    const expected = platformDefault(homeDirs.user, platform);
    const left = await mcpCall(homeDirs.cwdA, [], childEnv(homeDirs.user), "run_workflow", {}, platform);
    const right = await mcpCall(homeDirs.cwdB, [], childEnv(homeDirs.user), "run_workflow", {}, platform);
    assert.equal("home" in left.payload, false);
    assert.equal("home" in right.payload, false);
    assert.equal(existsSync(path.join(expected, "workflows")), true);
    assert.equal(existsSync(path.join(homeDirs.cwdA, ".bao-mcp")), false);
    assert.equal(existsSync(path.join(homeDirs.cwdB, ".bao-mcp")), false);
  }
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

test("mcp keeps a legacy workflow directory and does not create the new library", async () => {
  const dirs = layout();
  const legacy = path.join(dirs.cwdA, ".bao-mcp");
  const fresh = platformDefault(dirs.user, "darwin");
  mkdirSync(path.join(legacy, "workflows"), { recursive: true });
  writeFileSync(path.join(legacy, "workflows", "keep.json"), "{\"id\":\"keep\"}\n");
  const called = await mcpCall(dirs.cwdA, [], childEnv(dirs.user), "run_workflow", {}, "darwin");
  assert.equal("home" in called.payload, false);
  assert.equal(called.stderr.trim(), `bao: no workflows in ${fresh}; using ${legacy}`);
  assert.equal(readFileSync(path.join(legacy, "workflows", "keep.json"), "utf8"), "{\"id\":\"keep\"}\n");
  assert.equal(existsSync(fresh), false);
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

function runLiveHome(platform: "linux" | "darwin", env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const audit = path.join(process.cwd(), "desktop/dist/desktop/src/cdp-live/audit.js");
  const code = `process.stdout.write(require(${JSON.stringify(audit)}).liveSessionDir())`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgsFor(platform), "-e", code], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(stderr || `live home exited ${code}`));
      else resolve(stdout);
    });
  });
}

test("live audit uses one default home from different working directories", async () => {
  for (const platform of ["linux", "darwin"] as const) {
    const dirs = layout();
    const env = childEnv(dirs.user);
    const left = await runLiveHome(platform, env, dirs.cwdA);
    const right = await runLiveHome(platform, env, dirs.cwdB);
    const expected = path.join(platformDefault(dirs.user, platform), "live-session");
    assert.equal(left, expected);
    assert.equal(right, expected);
    assert.equal(left.startsWith(dirs.cwdA), false);
    assert.equal(right.startsWith(dirs.cwdB), false);
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
  const chosen = platformDefault(dirs.user, "linux");
  plantWorkflow(legacy, "keep");
  plantWorkflow(chosen, "fresh");
  const lines: string[] = [];
  const kinds: string[] = [];
  const options = {
    env: {},
    platform: "linux" as const,
    userHome: dirs.user,
    cwd: dirs.cwdA,
    warn: (line: string, kind: string) => { lines.push(line); kinds.push(kind); },
  };
  const home = resolveHome(options);
  resolveHome(options);
  assert.equal(home, chosen);
  assert.deepEqual(lines, [`bao: library data is at ${legacy}; using ${chosen}`]);
  assert.deepEqual(kinds, ["split"]);
  assert.equal(readFileSync(path.join(legacy, "workflows", "keep.json"), "utf8"), workflowJson("keep"));
  assert.equal(existsSync(path.join(chosen, "workflows", "keep.json")), false);
});

test("a legacy directory whose only entry is .DS_Store is empty", () => {
  const dirs = layout();
  const legacy = path.join(dirs.cwdA, ".bao-mcp");
  const chosen = platformDefault(dirs.user, "linux");
  mkdirSync(legacy);
  writeFileSync(path.join(legacy, ".DS_Store"), "junk");
  const lines: string[] = [];
  const home = resolveHome({
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
  assert.deepEqual(JSON.parse(status.stdout), {
    home: legacy,
    notices: [`bao: no workflows in ${fresh}; using ${legacy}`],
  });
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
    assert.equal(opened.stderr.includes(`using ${legacy}`), true);
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

test("the window names both libraries once, then records that it did", async () => {
  const dirs = layout();
  const legacy = path.join(dirs.user, ".local", "share", "bao");
  const fresh = path.join(dirs.user, "Library", "Application Support", "bao");
  plantWorkflow(legacy, "keep");
  plantWorkflow(fresh, "fresh");
  const previousHome = process.env.HOME;
  const previousBao = process.env.BAO_HOME;
  process.env.HOME = dirs.user;
  delete process.env.BAO_HOME;
  const notices: string[] = [];
  const home = resolveHome({ env: { HOME: dirs.user }, platform: "darwin", userHome: dirs.user, cwd: dirs.cwdA, warn: (line) => notices.push(line) });
  const split = `library data is at ${legacy}; using ${fresh}`;
  const splitsOn = async (): Promise<string[]> => {
    const app = await startApp({ home, port: 0, libraryNotices: notices });
    try {
      const state = await (await fetch(`http://127.0.0.1:${app.port}/api/state`)).json() as { librarySplits?: string[] };
      const again = await (await fetch(`http://127.0.0.1:${app.port}/api/state`)).json() as { librarySplits?: string[] };
      assert.deepEqual(again.librarySplits, state.librarySplits);
      return state.librarySplits || [];
    } finally {
      await app.close();
    }
  };
  try {
    assert.equal(home, fresh);
    assert.deepEqual(notices, [`bao: ${split}`]);
    assert.deepEqual(await splitsOn(), [split]);
    const record = JSON.parse(readFileSync(path.join(fresh, "shown-notices.json"), "utf8")) as { shown: Record<string, string> };
    assert.deepEqual(Object.keys(record.shown), [split]);
    assert.equal(Number.isNaN(Date.parse(record.shown[split] || "")), false);
    assert.deepEqual(await splitsOn(), []);
    assert.equal(existsSync(path.join(legacy, "shown-notices.json")), false);
  } finally {
    process.env.HOME = previousHome;
    if (previousBao === undefined) delete process.env.BAO_HOME;
    else process.env.BAO_HOME = previousBao;
  }
});

test("the window does not look past the home it was given", async () => {
  const dirs = layout();
  const legacy = path.join(dirs.user, ".local", "share", "bao");
  const home = path.join(dirs.root, "given");
  plantWorkflow(legacy, "keep");
  plantWorkflow(home, "mine");
  const previousHome = process.env.HOME;
  const previousBao = process.env.BAO_HOME;
  process.env.HOME = dirs.user;
  delete process.env.BAO_HOME;
  const app = await startApp({ home, port: 0 });
  try {
    const state = await (await fetch(`http://127.0.0.1:${app.port}/api/state`)).json() as { librarySplits?: string[]; workflows?: { id: string }[] };
    assert.deepEqual(state.librarySplits, []);
    assert.deepEqual(state.workflows?.map((item) => item.id), ["mine"]);
    assert.equal(existsSync(path.join(home, "shown-notices.json")), false);
  } finally {
    await app.close();
    process.env.HOME = previousHome;
    if (previousBao === undefined) delete process.env.BAO_HOME;
    else process.env.BAO_HOME = previousBao;
  }
});

test("--home= accepts a directory, rejects a missing value, and rejects a relative path", async () => {
  const dirs = layout();
  const env = childEnv(dirs.user);
  const equals = await runStatus(["--home=/x"], env, dirs.cwdA);
  assert.equal(equals.code, 0);
  assert.deepEqual(JSON.parse(equals.stdout), { home: "/x" });

  const relative = await runStatus(["--home", "rel-lib"], env, dirs.cwdA);
  assert.equal(relative.code, 1);
  assert.match(relative.stderr, /absolute/);
  assert.equal(existsSync(path.join(dirs.cwdA, "rel-lib")), false);

  const tilde = await runStatus(["--home=~/box"], env, dirs.cwdA);
  assert.equal(tilde.code, 0);
  assert.deepEqual(JSON.parse(tilde.stdout), { home: path.join(dirs.user, "box") });

  const fromEnv = await runStatus([], childEnv(dirs.user, { BAO_HOME: "rel-lib" }), dirs.cwdB);
  assert.equal(fromEnv.code, 1);
  assert.match(fromEnv.stderr, /BAO_HOME/);

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

test("an empty HOME is refused by the resolver", () => {
  assert.throws(
    () => resolveHome({ env: { HOME: "" }, platform: "darwin", cwd: "/tmp", warn: () => {} }),
    /absolute/,
  );
  assert.throws(
    () => resolveHome({ env: { HOME: "rel-lib" }, platform: "linux", cwd: "/tmp", warn: () => {} }),
    /absolute/,
  );
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

function runObserver(env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number; stderr: string }> {
  const child = spawn(process.execPath, ["--require", darwinPreload, observeHook], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, stderr }));
    child.stdin.end("{}\n");
  });
}

test("darwin status keeps a legacy library that has server.json and no workflows", async () => {
  const dirs = layout();
  const legacy = path.join(dirs.user, ".local", "share", "bao");
  const fresh = platformDefault(dirs.user, "darwin");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, "server.json"), "{\"port\":39999}\n");
  const status = await runStatus([], childEnv(dirs.user), dirs.cwdA, "darwin");
  assert.equal(status.code, 0, status.stderr);
  const body = JSON.parse(status.stdout) as { home: string; notices?: string[] };
  assert.equal(body.home, legacy);
  assert.deepEqual(body.notices, [`bao: no library data in ${fresh}; using ${legacy}`]);
  assert.equal(existsSync(fresh), false);
  assert.equal(readFileSync(path.join(legacy, "server.json"), "utf8"), "{\"port\":39999}\n");
});

test("darwin status keeps a legacy library that has runs and no workflows", async () => {
  const dirs = layout();
  const legacy = path.join(dirs.user, ".local", "share", "bao");
  const fresh = platformDefault(dirs.user, "darwin");
  mkdirSync(path.join(legacy, "runs"), { recursive: true });
  writeFileSync(path.join(legacy, "runs", "run-1.json"), "{}\n");
  const status = await runStatus([], childEnv(dirs.user), dirs.cwdA, "darwin");
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).home, legacy);
  assert.equal(existsSync(path.join(fresh, "runs")), false);
  assert.equal(readFileSync(path.join(legacy, "runs", "run-1.json"), "utf8"), "{}\n");
});

test("darwin bao open reads a legacy server.json and does not ask to start Bao", async () => {
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
    const opened = await runCli(["open", "bao://workflow/abc"], childEnv(dirs.user), dirs.cwdA, "darwin");
    assert.equal(opened.stderr.includes("start Bao first"), false, opened.stderr);
    assert.equal(opened.code, 0, opened.stderr);
    assert.equal(hits.n, 1);
    const status = await runStatus([], childEnv(dirs.user), dirs.cwdA, "darwin");
    assert.equal(JSON.parse(status.stdout).home, legacy);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test("import-login uses the port in the legacy server.json", async () => {
  const dirs = layout();
  const legacy = path.join(dirs.user, ".local", "share", "bao");
  mkdirSync(legacy, { recursive: true });
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url || "");
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  writeFileSync(path.join(legacy, "server.json"), `${JSON.stringify({ port })}\n`);
  try {
    const result = await runCli(
      ["import-login", "--from", "chrome", "--domain", "example.com"],
      childEnv(dirs.user),
      dirs.cwdA,
      "darwin",
    );
    assert.deepEqual(hits, ["/api/import-login"]);
    assert.equal(result.stderr.includes("4787"), false, result.stderr);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test("the observer hook writes into a legacy library that has only server.json", async () => {
  const dirs = layout();
  const legacy = path.join(dirs.user, ".local", "share", "bao");
  const fresh = path.join(dirs.user, "Library", "Application Support", "bao", "observer", "trail.jsonl");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(legacy, "server.json"), "{\"port\":39999}\n");
  const result = await runObserver(childEnv(dirs.user), dirs.cwdA);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(path.join(legacy, "observer", "trail.jsonl")), true);
  assert.equal(existsSync(fresh), false);
  assert.equal(readFileSync(path.join(legacy, "server.json"), "utf8"), "{\"port\":39999}\n");
});

test("an empty HOME is refused and does not create a library", async () => {
  const dirs = layout();
  const env = childEnv(dirs.user, { HOME: "" });
  const status = await runStatus([], env, dirs.cwdA, "darwin");
  assert.equal(status.code, 1);
  assert.match(status.stderr, /absolute/);
  assert.equal(status.stdout.includes("\"home\""), false);
  assert.equal(existsSync(path.join(dirs.cwdA, "Library")), false);
  assert.equal(existsSync(path.join(dirs.cwdA, ".local")), false);
  await assert.rejects(
    () => mcpCall(dirs.cwdA, [], env, "run_workflow", {}, "darwin"),
    /absolute/,
  );
  assert.equal(existsSync(path.join(dirs.cwdA, "Library")), false);
  assert.equal(existsSync(path.join(dirs.cwdA, ".local")), false);
  assert.equal(status.stdout.includes("/tmp/"), false);
});

test("a relative --home is refused and ~/ is one absolute library", async () => {
  const dirs = layout();
  const env = childEnv(dirs.user);
  const relative = await runStatus(["--home", "rel-lib"], env, dirs.cwdA);
  assert.equal(relative.code, 1);
  assert.match(relative.stderr, /absolute/);
  assert.equal(existsSync(path.join(dirs.cwdA, "rel-lib")), false);
  const other = await runStatus(["--home", "rel-lib"], env, dirs.cwdB);
  assert.equal(other.code, 1);
  assert.equal(existsSync(path.join(dirs.cwdB, "rel-lib")), false);
  const fromEnv = await runStatus([], childEnv(dirs.user, { BAO_HOME: "rel-lib" }), dirs.cwdB);
  assert.equal(fromEnv.code, 1);
  assert.match(fromEnv.stderr, /BAO_HOME/);
  await assert.rejects(
    () => mcpCall(dirs.cwdA, ["--home", "rel-lib"], env, "run_workflow", {}),
    /absolute/,
  );
  assert.equal(existsSync(path.join(dirs.cwdA, "rel-lib")), false);
  const left = await runStatus(["--home", "~/box"], env, dirs.cwdA);
  const right = await runStatus(["--home", "~/box"], env, dirs.cwdB);
  assert.equal(left.code, 0, left.stderr);
  assert.equal(right.code, 0, right.stderr);
  const box = path.join(dirs.user, "box");
  assert.deepEqual(JSON.parse(left.stdout), { home: box });
  assert.equal(left.stdout, right.stdout);
});

test("the window names the library directory it is using", async () => {
  const dirs = layout();
  const home = path.join(dirs.root, "library");
  plantWorkflow(home, "keep");
  const app = await startApp({ home, port: 0 });
  try {
    const state = await (await fetch(`http://127.0.0.1:${app.port}/api/state`)).json() as { home?: string; workflows?: { id: string }[] };
    assert.equal(state.home, home);
    assert.ok(state.workflows?.some((item) => item.id === "keep"));
    const js = await (await fetch(`http://127.0.0.1:${app.port}/app.js`)).text();
    assert.match(js, /library-home/);
  } finally {
    await app.close();
  }
});

function runScript(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

test("print-home reports one absolute library on stdout", async () => {
  const script = path.join(process.cwd(), "desktop/src/print-home.cjs");
  for (const platform of ["linux", "darwin"] as const) {
    const dirs = layout();
    const legacy = path.join(dirs.user, ".local", "share", "bao");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "server.json"), "{\"port\":39999}\n");
    const result = await runScript(["--require", platform === "darwin" ? darwinPreload : linuxPreload, script], childEnv(dirs.user), dirs.cwdA);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(result.stdout, `ok\n${legacy}\n`);
    assert.equal(path.isAbsolute(legacy), true);
    if (platform === "darwin") assert.equal(existsSync(platformDefault(dirs.user, "darwin")), false);
    assert.equal(existsSync(path.join(legacy, "shown-notices.json")), false);
    assert.equal(readFileSync(path.join(legacy, "server.json"), "utf8"), "{\"port\":39999}\n");
  }
  const dirs = layout();
  const empty = await runScript([script], childEnv(dirs.user, { HOME: "" }), dirs.cwdA);
  assert.equal(empty.code, 2);
  assert.match(empty.stdout, /^error\n/);
  assert.match(empty.stdout, /absolute/);
  assert.equal(empty.stdout.includes("/tmp/"), false);
  assert.equal(existsSync(path.join(dirs.cwdA, "Library")), false);
  assert.equal(existsSync(path.join(dirs.cwdA, ".local")), false);
});

test("print-home names a second library once per library", async () => {
  const script = path.join(process.cwd(), "desktop/src/print-home.cjs");
  const dirs = layout();
  const legacy = path.join(dirs.user, ".local", "share", "bao");
  const fresh = platformDefault(dirs.user, "darwin");
  plantWorkflow(fresh, "fresh");
  mkdirSync(path.join(legacy, "runs"), { recursive: true });
  writeFileSync(path.join(legacy, "runs", "run-1.json"), "{}\n");
  const split = `library data is at ${legacy}; using ${fresh}`;
  const launch = () => runScript(["--require", darwinPreload, script], childEnv(dirs.user), dirs.cwdA);

  const first = await launch();
  assert.equal(first.code, 0, first.stderr + first.stdout);
  assert.equal(first.stdout, `ok\n${fresh}\n${split}\n`);
  const record = JSON.parse(readFileSync(path.join(fresh, "shown-notices.json"), "utf8")) as { shown: Record<string, string> };
  assert.deepEqual(Object.keys(record.shown), [split]);

  const second = await launch();
  assert.equal(second.code, 0, second.stderr + second.stdout);
  assert.equal(second.stdout, `ok\n${fresh}\n`);
  assert.equal(existsSync(path.join(legacy, "shown-notices.json")), false);
  assert.equal(readFileSync(path.join(legacy, "runs", "run-1.json"), "utf8"), "{}\n");

  const other = path.join(dirs.cwdB, ".bao-mcp");
  plantWorkflow(other, "other");
  const third = await runScript(["--require", darwinPreload, script], childEnv(dirs.user), dirs.cwdB);
  assert.equal(third.code, 0, third.stderr + third.stdout);
  assert.equal(third.stdout, `ok\n${fresh}\nlibrary data is at ${other}; using ${fresh}\n`);
});
