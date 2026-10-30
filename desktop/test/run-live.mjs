import { execFileSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { compiledTestPlan, laneChildEnv, pinnedTestBrowser } from "../dist/desktop/test/runtime.js";

function isolationArg() {
  const help = execFileSync(process.execPath, ["--test", "--help"], { encoding: "utf8" });
  if (help.includes("--test-isolation=")) return "--test-isolation=process";
  return "--experimental-test-isolation=process";
}

const sourceDir = "desktop/test/live";
const distDir = "desktop/dist/desktop/test/live";
const plan = compiledTestPlan(sourceDir, distDir);
for (const stale of plan.stale) rmSync(path.join(distDir, stale), { force: true });
if (plan.missing.length) {
  console.error(`compiled live test missing: ${plan.missing.join(", ")}`);
  process.exit(1);
}

const named = process.argv.slice(2);
const unknown = named.filter((name) => !plan.run.includes(name));
if (unknown.length) {
  console.error(`no compiled live test named: ${unknown.join(", ")}`);
  process.exit(1);
}

const files = plan.run
  .filter((name) => named.length === 0 || named.includes(name))
  .map((name) => path.join(distDir, name));
const env = laneChildEnv("live", process.env, pinnedTestBrowser());
const child = spawn(process.execPath, ["--test", isolationArg(), ...files], {
  env,
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
