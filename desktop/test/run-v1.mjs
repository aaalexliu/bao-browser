import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { compiledTestPlan, laneChildEnv, playwrightVersionError } from "../dist/desktop/test/runtime.js";
import { runnerTestArgs } from "./runner-flags.mjs";
import { runWithFileRetry } from "./retry-run.mjs";

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

// --lane=unit (the default) runs desktop/test/unit. --lane=replay runs desktop/test/replay: saved-workflow replay and what hangs on it.
const LANES = ["unit", "replay"];
const laneFlag = process.argv.slice(2).find((arg) => arg.startsWith("--lane="));
const lane = laneFlag ? laneFlag.slice("--lane=".length) : "unit";
if (!LANES.includes(lane)) {
  console.error(`unknown lane: ${lane}. Use --lane=unit or --lane=replay.`);
  process.exit(1);
}
// --shard=2/3 runs every third file of the lane, starting at the second. CI runs the unit lane's shards side by side.
const shardFlag = process.argv.slice(2).find((arg) => arg.startsWith("--shard="));
const shard = /^--shard=([1-9]\d*)\/([1-9]\d*)$/.exec(shardFlag ?? "--shard=1/1");
if (!shard || Number(shard[1]) > Number(shard[2])) {
  console.error(`bad shard: ${shardFlag}. Use --shard=<index>/<total>, such as --shard=2/3.`);
  process.exit(1);
}
const sourceDir = `desktop/test/${lane}`;
const distDir = `desktop/dist/desktop/test/${lane}`;
const plan = compiledTestPlan(sourceDir, distDir);
for (const stale of plan.stale) rmSync(path.join(distDir, stale), { force: true });
if (plan.missing.length) {
  console.error(`compiled ${lane} test missing: ${plan.missing.join(", ")}`);
  process.exit(1);
}

const files = plan.run.filter((_, index) => index % Number(shard[2]) === Number(shard[1]) - 1).map((name) => path.join(distDir, name));
const env = laneChildEnv("hermetic", process.env);
const result = await runWithFileRetry({
  execPath: process.execPath,
  args: ["--test", isolationArg(), "--test-concurrency=2", ...runnerTestArgs(), ...process.argv.slice(2).filter((arg) => arg !== laneFlag && arg !== shardFlag)],
  files,
  env,
});
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.code);
