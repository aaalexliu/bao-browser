import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runnerTestArgs } from "../../desktop/test/runner-flags.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const files = [
  "web/src/lib/relay.boundary.test.ts",
  "web/src/lib/relay-job.test.ts",
  "web/src/lib/catalog.test.ts",
];
const child = spawn(process.execPath, [
  "--experimental-transform-types",
  "--import", "./web/test/register.mjs",
  "--test",
  ...runnerTestArgs(),
  ...files,
], { cwd: root, stdio: "inherit" });
child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
