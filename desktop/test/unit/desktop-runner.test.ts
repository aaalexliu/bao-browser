import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { laneChildEnv, playwrightVersionError, scaledMs, testTimeScale } from "../runtime";

const RUNNER_DEPS = ["retry-run.mjs", "failed-files-reporter.mjs", "time-scale.cjs"];

function copyRunner(root: string, name: string): string {
  const runner = path.join(root, "desktop/test", name);
  mkdirSync(path.dirname(runner), { recursive: true });
  copyFileSync(path.resolve("desktop/test", name), runner);
  if (name === "run-v1.mjs") {
    for (const dep of RUNNER_DEPS) copyFileSync(path.resolve("desktop/test", dep), path.join(root, "desktop/test", dep));
  }
  return runner;
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
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root };
  delete env.NODE_TEST_CONTEXT;
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
