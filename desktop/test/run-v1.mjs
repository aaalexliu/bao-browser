import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { compiledTestPlan, laneChildEnv, playwrightVersionError } from "../dist/desktop/test/runtime.js";
import { runWithFileRetry } from "./retry-run.mjs";

const { scaledMs } = createRequire(import.meta.url)("./time-scale.cjs");

const versionError = playwrightVersionError();
if (versionError) {
  console.error(versionError);
  process.exit(1);
}

function isolationArg() {
  const help = execFileSync(process.execPath, ["--test", "--help"], { encoding: "utf8" });
  if (help.includes("--test-isolation=")) return "--test-isolation=process";
  return "--experimental-test-isolation=process";
}

const sourceDir = "desktop/test/unit";
const distDir = "desktop/dist/desktop/test/unit";
const plan = compiledTestPlan(sourceDir, distDir);
for (const stale of plan.stale) rmSync(path.join(distDir, stale), { force: true });
if (plan.missing.length) {
  console.error(`compiled unit test missing: ${plan.missing.join(", ")}`);
  process.exit(1);
}

const files = plan.run.map((name) => path.join(distDir, name));
const env = laneChildEnv("hermetic", process.env);
const result = await runWithFileRetry({
  execPath: process.execPath,
  args: ["--test", isolationArg(), "--test-concurrency=2", `--test-timeout=${scaledMs(120_000)}`, ...process.argv.slice(2)],
  files,
  env,
});
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.code);
