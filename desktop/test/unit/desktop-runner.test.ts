import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import test from "node:test";
import { pidsForDataDir } from "../../src/launch";
import { laneChildEnv, playwrightVersionError, scaledMs, testTimeScale } from "../runtime";

const RUNNER_DEPS = ["retry-run.mjs", "failed-files-reporter.mjs", "time-scale.cjs", "runner-flags.mjs"];

function copyRunner(root: string, name: string): string {
  const runner = path.join(root, "desktop/test", name);
  mkdirSync(path.dirname(runner), { recursive: true });
  copyFileSync(path.resolve("desktop/test", name), runner);
  const deps = name === "run-v1.mjs" ? RUNNER_DEPS : ["time-scale.cjs", "runner-flags.mjs"];
  for (const dep of deps) copyFileSync(path.resolve("desktop/test", dep), path.join(root, "desktop/test", dep));
  return runner;
}

function runnerEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH
      || path.join(userInfo().homedir, "Library", "Caches", "ms-playwright"),
    NODE_PATH: path.resolve("node_modules"),
    ...extra,
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  delete env.BAO_TEST_FAILED_FILES;
  delete env.BAO_TEST_TIME_SCALE;
  delete env.BAO_HEADED;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

test("the Playwright version comparison accepts the lock and reports either direction of drift", () => {
  assert.equal(playwrightVersionError("1.61.1", "1.61.1"), undefined);
  for (const installed of ["1.60.0", "1.65.0"]) {
    assert.equal(playwrightVersionError(installed, "1.61.1"),
      `Playwright version mismatch: installed ${installed}, package-lock.json 1.61.1. Run: npm ci`);
  }
});

for (const name of ["run-v1.mjs", "run-live.mjs"]) {
  test(`${name} stops on Playwright drift before planning tests or preparing a browser`, () => {
    const root = mkdtempSync(path.join(tmpdir(), "bao-runner-version-"));
    const runner = path.join(root, "desktop/test", name);
    const runtime = path.join(root, "desktop/dist/desktop/test/runtime.js");
    const message = "Playwright version mismatch: installed 1.65.0, package-lock.json 1.61.1. Run: npm ci";
    try {
      mkdirSync(path.dirname(runtime), { recursive: true });
      copyRunner(root, name);
      writeFileSync(runtime, `exports.playwrightVersionError = () => ${JSON.stringify(message)};
exports.compiledTestPlan = () => { throw new Error("must not plan tests"); };
exports.laneChildEnv = () => { throw new Error("must not prepare a browser"); };`);
      const result = spawnSync(process.execPath, [runner], { cwd: root, env: { ...process.env, HOME: root }, encoding: "utf8", timeout: scaledMs(10_000) });
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, `${message}\n`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

async function until<T>(read: () => T | undefined, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + scaledMs(timeoutMs);
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

for (const [name, args, workers] of [
  ["defaults to two workers", [], 2],
  ["honors an explicit concurrency override", ["--test-concurrency=1"], 1],
] as const) test(`desktop runner ${name}`, { timeout: scaledMs(40_000) }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-runner-"));
  const runner = path.join(root, "desktop/test/run-v1.mjs");
  const runtime = path.join(root, "desktop/dist/desktop/test/runtime.js");
  const dist = path.join(root, "desktop/dist/desktop/test/unit");
  const started = path.join(root, "started");
  const release = path.join(root, "release");
  mkdirSync(dist, { recursive: true });
  copyRunner(root, "run-v1.mjs");
  const files = ["one.test.js", "two.test.js", "three.test.js"];
  writeFileSync(runtime, `exports.compiledTestPlan = () => ({ run: ${JSON.stringify(files)}, stale: [], missing: [] });
exports.laneChildEnv = (_lane, env) => env;
exports.playwrightVersionError = () => undefined;`);
  for (const file of files) writeFileSync(path.join(dist, file), `
const { appendFileSync, existsSync } = require("node:fs");
require("node:test")("probe", async () => {
  appendFileSync(${JSON.stringify(started)}, process.pid + "\\n");
  while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 20));
});`);
  const env = runnerEnv(root);
  const child = spawn(process.execPath, [runner, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  try {
    const running = () => existsSync(started) ? readFileSync(started, "utf8").trim().split("\n").length : 0;
    await until(() => {
      assert.equal(child.exitCode, null, output);
      return running() >= workers ? true : undefined;
    }, `${workers} runner workers`);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(running(), workers, "extra files wait for a worker slot");
    writeFileSync(release, "");
    assert.equal(await exited, 0, output);
    assert.equal(running(), files.length, "every planned file runs");
  } finally {
    writeFileSync(release, "");
    child.kill("SIGTERM");
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
});

test("BAO_TEST_TIME_SCALE defaults to 1 and the lane keeps only that inherited BAO name", () => {
  assert.equal(testTimeScale({}), 1);
  assert.equal(testTimeScale({ BAO_TEST_TIME_SCALE: "  " }), 1);
  assert.equal(scaledMs(2_000, {}), 2_000);
  assert.equal(scaledMs(2_000, { BAO_TEST_TIME_SCALE: "2" }), 4_000);
  assert.equal(scaledMs(2_000, { BAO_TEST_TIME_SCALE: "1.5" }), 3_000);
  assert.throws(() => testTimeScale({ BAO_TEST_TIME_SCALE: "0" }), /positive number/);
  assert.throws(() => testTimeScale({ BAO_TEST_TIME_SCALE: "nope" }), /positive number/);
  const kept = laneChildEnv("hermetic", { BAO_TEST_TIME_SCALE: "2.5", BAO_HOME: "/tmp/real-home" }, () => process.execPath);
  assert.equal(kept.BAO_TEST_TIME_SCALE, "2.5");
  assert.equal(kept.BAO_HOME, undefined);
  assert.equal(laneChildEnv("hermetic", { BAO_HOME: "/tmp/real-home" }, () => process.execPath).BAO_TEST_TIME_SCALE, undefined);
});

function forcedOnce(marker: string): string {
  return `
const { existsSync, writeFileSync } = require("node:fs");
require("node:test")("forced once", () => {
  if (!existsSync(${JSON.stringify(marker)})) {
    writeFileSync(${JSON.stringify(marker)}, "1");
    throw new Error("forced once");
  }
});
`;
}

function runPlanned(files: Record<string, string>): { status: number | null; output: string } {
  const root = mkdtempSync(path.join(tmpdir(), "bao-runner-flaky-"));
  const runtime = path.join(root, "desktop/dist/desktop/test/runtime.js");
  const dist = path.join(root, "desktop/dist/desktop/test/unit");
  const names = Object.keys(files);
  mkdirSync(path.dirname(runtime), { recursive: true });
  mkdirSync(dist, { recursive: true });
  const runner = copyRunner(root, "run-v1.mjs");
  writeFileSync(runtime, `exports.compiledTestPlan = () => ({ run: ${JSON.stringify(names)}, stale: [], missing: [] });
exports.laneChildEnv = (_lane, env) => env;
exports.playwrightVersionError = () => undefined;`);
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dist, name), body);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  delete env.BAO_TEST_FAILED_FILES;
  try {
    const result = spawnSync(process.execPath, [runner], { cwd: root, env, encoding: "utf8", timeout: scaledMs(20_000) });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a file that fails once is flaky and a file that fails twice fails the run", { timeout: scaledMs(40_000) }, () => {
  const marker = path.join(tmpdir(), `bao-once-${Date.now()}`);
  try {
    const both = runPlanned({
      "once.test.js": forcedOnce(marker),
      "twice.test.js": "require('node:test')('forced twice', () => { throw new Error('forced twice'); });\n",
    });
    assert.notEqual(both.status, 0, both.output);
    assert.match(both.output, /flaky: .*once\.test\.js/);
    assert.match(both.output, /failed: .*twice\.test\.js/);
    assert.equal(/flaky: .*twice\.test\.js/.test(both.output), false);
    rmSync(marker, { force: true });
    const once = runPlanned({ "once.test.js": forcedOnce(marker) });
    assert.equal(once.status, 0, once.output);
    assert.match(once.output, /flaky: .*once\.test\.js/);
    assert.equal(once.output.includes("failed:"), false);
  } finally {
    rmSync(marker, { force: true });
  }
});

function stubRuntime(root: string, files: string[], lane: "unit" | "live" = "unit"): string {
  const runnerName = lane === "live" ? "run-live.mjs" : "run-v1.mjs";
  const dist = path.join(root, "desktop/dist/desktop/test", lane);
  const runtime = path.join(root, "desktop/dist/desktop/test/runtime.js");
  mkdirSync(dist, { recursive: true });
  mkdirSync(path.dirname(runtime), { recursive: true });
  writeFileSync(runtime, `exports.compiledTestPlan = () => ({ run: ${JSON.stringify(files)}, stale: [], missing: [] });
exports.laneChildEnv = (_lane, env) => env;
exports.playwrightVersionError = () => undefined;`);
  return copyRunner(root, runnerName);
}

function runStub(root: string, runner: string, args: string[], env: NodeJS.ProcessEnv, deadlineMs: number): Promise<{ status: number | null; output: string; elapsed: number; killed: boolean }> {
  const child = spawn(process.execPath, [runner, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const started = Date.now();
  let killed = false;
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const timer = setTimeout(() => { killed = true; child.kill("SIGTERM"); }, deadlineMs);
  return exited.then((status) => {
    clearTimeout(timer);
    return { status, output, elapsed: Date.now() - started, killed };
  }, (error) => {
    clearTimeout(timer);
    child.kill("SIGTERM");
    throw error;
  });
}

test("runners pass a scaled timeout and force the process to exit", { timeout: scaledMs(20_000) }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-runner-flags-"));
  const flagFile = path.join(root, "flags.txt");
  try {
    const unit = stubRuntime(root, ["flags.test.js"]);
    writeFileSync(path.join(root, "desktop/dist/desktop/test/unit/flags.test.js"), `
require("node:test")("flags", () => {
  require("node:fs").writeFileSync(${JSON.stringify(flagFile)}, process.execArgv.join(${JSON.stringify("\n")}));
});`);
    const overridden = await runStub(root, unit, ["--test-timeout=5000"], runnerEnv(root), 10_000);
    assert.equal(overridden.killed, false, overridden.output);
    assert.equal(overridden.status, 0, overridden.output);
    const flags = readFileSync(flagFile, "utf8").split("\n");
    assert.equal(flags.filter((flag) => flag.startsWith("--test-timeout=")).at(-1), "--test-timeout=5000");
    assert.equal(flags.includes("--test-force-exit"), true);

    const liveRoot = mkdtempSync(path.join(tmpdir(), "bao-runner-live-flags-"));
    try {
      const live = stubRuntime(liveRoot, ["flags.test.js"], "live");
      const liveFlags = path.join(liveRoot, "flags.txt");
      writeFileSync(path.join(liveRoot, "desktop/dist/desktop/test/live/flags.test.js"), `
require("node:test")("flags", () => {
  require("node:fs").writeFileSync(${JSON.stringify(liveFlags)}, process.execArgv.join(${JSON.stringify("\n")}));
});`);
      const scaled = await runStub(liveRoot, live, [], runnerEnv(liveRoot, { BAO_TEST_TIME_SCALE: "2" }), 10_000);
      assert.equal(scaled.status, 0, scaled.output);
      assert.equal(readFileSync(liveFlags, "utf8").includes("--test-timeout=240000"), true, scaled.output);
      assert.equal(readFileSync(liveFlags, "utf8").includes("--test-force-exit"), true);
    } finally { rmSync(liveRoot, { recursive: true, force: true }); }

    const bad = spawnSync(process.execPath, [unit], { cwd: root, env: runnerEnv(root, { BAO_TEST_TIME_SCALE: "0" }), encoding: "utf8", timeout: 10_000 });
    assert.notEqual(bad.status, 0);
    assert.match(`${bad.stdout}${bad.stderr}`, /BAO_TEST_TIME_SCALE must be a positive number/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed fixture with an open server still exits", { timeout: scaledMs(15_000) }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-runner-open-server-"));
  try {
    const runner = stubRuntime(root, ["open-server.test.js"]);
    writeFileSync(path.join(root, "desktop/dist/desktop/test/unit/open-server.test.js"), `
const http = require("node:http");
require("node:test")("open server", async () => {
  const server = http.createServer((_req, res) => res.end("open"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  throw new Error("fixture failed");
});`);
    const result = await runStub(root, runner, [], runnerEnv(root), 5_000);
    assert.equal(result.killed, false, result.output);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /fixture failed/);
    assert.equal(result.elapsed < 5_000, true, `hung for ${result.elapsed}ms`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed fixture exits within the timeout and leaves no Chrome", { timeout: scaledMs(40_000) }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-runner-chrome-"));
  const profile = path.join(root, "chrome-profile");
  const cleaned = path.join(root, "cleaned");
  const commandFile = path.join(root, "chrome-command.txt");
  mkdirSync(profile);
  const killLeftovers = () => {
    for (const pid of pidsForDataDir(profile)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  };
  try {
    const runner = stubRuntime(root, ["failed-fixture.test.js"]);
    writeFileSync(path.join(root, "desktop/dist/desktop/test/unit/failed-fixture.test.js"), `
const http = require("node:http");
const fs = require("node:fs");
const test = require("node:test");
const { chromium } = require("playwright");
test("fixture fails while server and chrome are open", async (t) => {
  const server = http.createServer((_req, res) => res.end("fixture"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally {
      await new Promise((resolve) => server.close(() => resolve()));
      fs.writeFileSync(${JSON.stringify(cleaned)}, "1");
    }
  });
  browser = await chromium.launchPersistentContext(${JSON.stringify(profile)}, {
    headless: true,
    timeout: 15_000,
    args: ["--use-mock-keychain", "--password-store=basic"],
  });
  const listed = require("node:child_process").spawnSync("ps", ["-axww", "-o", "command="], { encoding: "utf8" });
  const chrome = String(listed.stdout || "").split(${JSON.stringify("\n")}).filter((line) => line.includes("--user-data-dir=" + ${JSON.stringify(profile)}));
  if (!chrome.length) throw new Error("headless Chrome did not start");
  fs.writeFileSync(${JSON.stringify(commandFile)}, chrome.join(${JSON.stringify("\n")}));
  throw new Error("fixture failed");
});`);
    const result = await runStub(root, runner, ["--test-timeout=20000"], runnerEnv(root), 30_000);
    assert.equal(result.killed, false, result.output);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /fixture failed/);
    assert.equal(result.elapsed < 20_000, true, `exited after ${result.elapsed}ms`);
    assert.equal(existsSync(cleaned), true, result.output);
    const command = readFileSync(commandFile, "utf8");
    assert.equal(command.includes(profile), true, command);
    assert.match(command, /headless/);
    assert.equal(command.includes("/Applications/Google Chrome.app"), false, command);
    assert.deepEqual(pidsForDataDir(profile), [], "headless Chrome still owns the fixture profile");
  } finally {
    killLeftovers();
    rmSync(root, { recursive: true, force: true });
  }
});
