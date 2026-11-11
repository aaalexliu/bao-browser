import { spawn } from "node:child_process";
import { runnerTestArgs } from "../desktop/test/runner-flags.mjs";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node scripts/run-node-test.mjs <file>...");
  process.exit(2);
}
const child = spawn(process.execPath, ["--test", ...runnerTestArgs(), ...files], { stdio: "inherit" });
child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
