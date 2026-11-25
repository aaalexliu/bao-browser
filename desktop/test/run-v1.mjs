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
const argv = process.argv.slice(2);
const laneFlag = argv.find((arg) => arg.startsWith("--lane="));
const lane = laneFlag ? laneFlag.slice("--lane=".length) : "unit";
if (!LANES.includes(lane)) {
  console.error(`unknown lane: ${lane}. Use --lane=unit or --lane=replay.`);
  process.exit(1);
}
// --shard=2/3 runs every third file of the lane, starting at the second. CI runs the unit lane's shards side by side.
const shardFlag = argv.find((arg) => arg.startsWith("--shard="));
const shard = /^--shard=([1-9]\d*)\/([1-9]\d*)$/.exec(shardFlag ?? "--shard=1/1");
if (!shard || Number(shard[1]) > Number(shard[2])) {
  console.error(`bad shard: ${shardFlag}. Use --shard=<index>/<total>, such as --shard=2/3.`);
  process.exit(1);
}
// Named test files (auth-login.test.js, auth-login.test.ts, replay/mcp.test.js or desktop/test/replay/mcp.test.ts) run alone.
// A bare name is looked up in both lanes unless --lane= names one. --focused, which npm run test:focused passes, refuses to run without a name.
const names = argv.filter((arg) => !arg.startsWith("-"));
if (argv.includes("--focused") && names.length === 0) {
  console.error("name the test files to run, such as: npm run test:focused -- auth-login.test.js live-view.test.js");
  process.exit(1);
}

const searched = names.length && !laneFlag ? LANES : [lane];
const planned = [];
for (const each of searched) {
  const distDir = `desktop/dist/desktop/test/${each}`;
  const plan = compiledTestPlan(`desktop/test/${each}`, distDir);
  for (const stale of plan.stale) rmSync(path.join(distDir, stale), { force: true });
  if (plan.missing.length) {
    console.error(`compiled ${each} test missing: ${plan.missing.join(", ")}`);
    process.exit(1);
  }
  for (const name of plan.run) planned.push({ key: `${each}/${name}`, name, file: path.join(distDir, name) });
}

function namedFile(asked) {
  const name = asked.replace(/\.ts$/, ".js");
  const found = planned.filter((test) => name === test.name || name === test.key || name.endsWith(`/${test.key}`));
  if (found.length === 1) return found[0].file;
  const where = found.length ? `is in more than one lane; name one of ${found.map((test) => test.key).join(", ")}` : `is not a test in ${searched.map((each) => `desktop/test/${each}`).join(" or ")}`;
  console.error(`${asked} ${where}`);
  process.exit(1);
}

const chosen = names.length ? [...new Set(names.map(namedFile))] : planned.map((test) => test.file);
const files = chosen.filter((_, index) => index % Number(shard[2]) === Number(shard[1]) - 1);
const env = laneChildEnv("hermetic", process.env);
const result = await runWithFileRetry({
  execPath: process.execPath,
  args: ["--test", isolationArg(), "--test-concurrency=2", ...runnerTestArgs(), ...argv.filter((arg) => arg.startsWith("-") && arg !== laneFlag && arg !== shardFlag && arg !== "--focused")],
  files,
  env,
});
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.code);
