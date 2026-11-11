import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
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
exports.laneChildEnv = (_lane, env) => env;`);
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
