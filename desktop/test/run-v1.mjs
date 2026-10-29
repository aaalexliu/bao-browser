// Hermetic runner for npm run test:v1. The suite never sees a logged-in Cursor
// account or a vendor model key. A test opts in by setting the env in its own
// process, after this runner has cleared it.

import { execFileSync, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

function isolationArg() {
  const help = execFileSync(process.execPath, ["--test", "--help"], { encoding: "utf8" });
  if (help.includes("--test-isolation=")) return "--test-isolation=process";
  return "--experimental-test-isolation=process";
}

const live = process.argv[2] === "live";
const filters = live ? process.argv.slice(3) : [];
const dir = live ? "desktop/dist/desktop/test/live" : "desktop/dist/desktop/test/unit";
const files = readdirSync(dir)
  .filter((name) => name.endsWith(".test.js"))
  .filter((name) => filters.length === 0 || filters.some((part) => name.includes(part)))
  .sort()
  .map((name) => path.join(dir, name));
if (files.length === 0) {
  console.error(`no tests in ${dir}`);
  process.exit(1);
}

const env = { ...process.env, BAO_HEAL_CURSOR_ACCOUNT: "0" };
for (const key of [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "BAO_XAI_MODEL",
  "CURSOR_API_KEY",
  "BAO_HEAL_CURSOR",
  "BAO_HEAL_CURSOR_RESPONSE",
  "BAO_HEAL_FIXTURE",
  "BAO_CURSOR_AGENT",
]) {
  delete env[key];
}

const child = spawn(process.execPath, ["--test", isolationArg(), ...files], {
  env,
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
