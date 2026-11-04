import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { laneChildEnv } from "../desktop/dist/desktop/test/runtime.js";

// Run only in the opt-in workflow. Each file owns its descendants' V8 data.
const dest = path.resolve(process.argv[2]);
mkdirSync(dest, { recursive: true });
const files = readdirSync("desktop/test/unit").filter((file) => file.endsWith(".test.ts")).sort();
const results = [];
async function worker() {
  while (files.length) {
    const file = files.shift();
    const dir = path.join(dest, file);
    mkdirSync(dir, { recursive: true });
    const start = performance.now();
    const env = { ...laneChildEnv("hermetic", process.env), NODE_V8_COVERAGE: dir };
    const args = ["--test", "--test-concurrency=1", "--test-reporter=tap", "--test-force-exit",
      "--test-skip-pattern=^teach the fixture, correct three cards, replay twice, and splice a fix$",
      path.join("desktop/dist/desktop/test/unit", file.replace(/\.ts$/, ".js"))];
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
if (results.some((result) => result.code !== 0)) process.exitCode = 1;
