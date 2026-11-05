import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { laneChildEnv } from "../desktop/dist/desktop/test/runtime.js";

const manifest = JSON.parse(readFileSync(new URL("../test/essential.json", import.meta.url), "utf8"));
const group = manifest[process.argv[2]];
if (!group) throw new Error(`Unknown essential group: ${process.argv[2]}`);
for (const file of group.tests) {
  if (!existsSync(file)) throw new Error(`Essential test missing: ${file}`);
}
const env = laneChildEnv("hermetic", process.env);
async function run(args) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
  if (code !== 0) process.exit(code);
}
const files = group.tests.map((file) => file.replace(/^desktop\/test\//, "desktop/dist/desktop/test/").replace(/\.ts$/, ".js"));
if (group.kind === "desktop") {
  const filter = group.names ? ["--test-name-pattern=" + group.names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$").join("|")] : [];
  await run(["--test", "--test-concurrency=2", "--test-reporter=tap", "--test-force-exit", ...filter, ...files]);
} else if (group.kind === "web") {
  await run(["--experimental-transform-types", "--import", "./web/test/register.mjs", "--test", ...group.tests]);
} else {
  throw new Error(`Unknown essential kind: ${group.kind}`);
}
