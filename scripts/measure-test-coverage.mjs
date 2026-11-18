import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { laneChildEnv } from "../desktop/dist/desktop/test/runtime.js";
import { runnerTestArgs } from "../desktop/test/runner-flags.mjs";

// Run only in the opt-in workflow. Each file owns its descendants' V8 data.
const dest = path.resolve(process.argv[2]);
mkdirSync(dest, { recursive: true });
// measure-test-coverage.mjs <dest> [lane] [shard]: the same file list run-v1.mjs gives that lane and shard.
const lane = process.argv[3] || "unit";
const [index, total] = (process.argv[4] || "1/1").split("/").map(Number);
const files = readdirSync(`desktop/test/${lane}`).filter((file) => file.endsWith(".test.ts")).sort().filter((_, at) => at % total === index - 1);
const results = [];
async function worker() {
  while (files.length) {
    const file = files.shift();
    const dir = path.join(dest, file);
    mkdirSync(dir, { recursive: true });
    const start = performance.now();
    const env = { ...laneChildEnv("hermetic", process.env), NODE_V8_COVERAGE: dir };
    const args = ["--test", "--test-concurrency=1", "--test-reporter=tap", ...runnerTestArgs(),
      path.join(`desktop/dist/desktop/test/${lane}`, file.replace(/\.ts$/, ".js"))];
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      let log = "";
      child.stdout.on("data", (data) => { log += data; });
      child.stderr.on("data", (data) => { log += data; });
      child.on("error", reject);
      child.on("exit", (status) => {
        writeFileSync(path.join(dir, "test.log"), log);
        resolve(status ?? 1);
      });
    });
    const result = { file, code, seconds: (performance.now() - start) / 1000 };
    results.push(result);
    console.log(JSON.stringify(result));
  }
}
await Promise.all([worker(), worker()]);
writeFileSync(path.join(dest, "results.json"), JSON.stringify(results, null, 2));
process.exit(results.some((result) => result.code !== 0) ? 1 : 0);
