import { existsSync, readFileSync } from "node:fs";
import { laneChildEnv } from "../desktop/dist/desktop/test/runtime.js";
import { runWithFileRetry } from "../desktop/test/retry-run.mjs";

const manifest = JSON.parse(readFileSync(new URL("../test/essential.json", import.meta.url), "utf8"));
const group = manifest[process.argv[2]];
if (!group) throw new Error(`Unknown essential group: ${process.argv[2]}`);
for (const file of group.tests) {
  if (!existsSync(file)) throw new Error(`Essential test missing: ${file}`);
}
const env = laneChildEnv("hermetic", process.env);
const files = group.tests.map((file) => file.replace(/^desktop\/test\//, "desktop/dist/desktop/test/").replace(/\.ts$/, ".js"));
const filter = group.names ? ["--test-name-pattern=" + group.names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$").join("|")] : [];
const args = group.kind === "desktop"
  ? ["--test", "--test-concurrency=2", "--test-reporter=tap", "--test-force-exit", ...filter]
  : group.kind === "web"
    ? ["--experimental-transform-types", "--import", "./web/test/register.mjs", "--test"]
    : null;
if (!args) throw new Error(`Unknown essential kind: ${group.kind}`);
const result = await runWithFileRetry({
  execPath: process.execPath,
  args,
  files: group.kind === "web" ? group.tests : files,
  env,
});
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.code);
