import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { playwrightVersionError } from "../runtime";

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
      mkdirSync(path.dirname(runner), { recursive: true });
      mkdirSync(path.dirname(runtime), { recursive: true });
      copyFileSync(path.resolve("desktop/test", name), runner);
      writeFileSync(runtime, `exports.playwrightVersionError = () => ${JSON.stringify(message)};
exports.compiledTestPlan = () => { throw new Error("must not plan tests"); };
exports.laneChildEnv = () => { throw new Error("must not prepare a browser"); };`);
      const result = spawnSync(process.execPath, [runner], { cwd: root, env: { ...process.env, HOME: root }, encoding: "utf8", timeout: 10_000 });
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, `${message}\n`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

async function until<T>(read: () => T | undefined, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
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
] as const) test(`desktop runner ${name}`, { timeout: 40_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-runner-"));
  const runner = path.join(root, "desktop/test/run-v1.mjs");
  const runtime = path.join(root, "desktop/dist/desktop/test/runtime.js");
  const dist = path.join(root, "desktop/dist/desktop/test/unit");
  const started = path.join(root, "started");
  const release = path.join(root, "release");
  mkdirSync(path.dirname(runner), { recursive: true });
  mkdirSync(dist, { recursive: true });
  copyFileSync(path.resolve("desktop/test/run-v1.mjs"), runner);
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
