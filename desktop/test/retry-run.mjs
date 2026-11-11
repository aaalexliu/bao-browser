import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const reporterPath = fileURLToPath(new URL("./failed-files-reporter.mjs", import.meta.url));

function takeFlag(args, name) {
  const values = [];
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === name) {
      values.push(args[++i]);
      continue;
    }
    if (arg.startsWith(`${name}=`)) {
      values.push(arg.slice(name.length + 1));
      continue;
    }
    rest.push(arg);
  }
  return { values, rest };
}

export function withFailureReporter(args, dest, reporter = reporterPath) {
  const reporters = takeFlag(args, "--test-reporter");
  const destinations = takeFlag(reporters.rest, "--test-reporter-destination");
  const named = reporters.values.length ? reporters.values : ["spec"];
  const sinks = destinations.values.slice();
  while (sinks.length < named.length) sinks.push("stdout");
  named.push(reporter);
  sinks.push(dest);
  const flags = [];
  for (let i = 0; i < named.length; i++) {
    flags.push(`--test-reporter=${named[i]}`, `--test-reporter-destination=${sinks[i]}`);
  }
  return [...destinations.rest, ...flags];
}

function sameFile(left, right) {
  const resolved = path.resolve(left);
  if (resolved === path.resolve(right)) return true;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

export function failedFilesFromLog(text, files) {
  const failed = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    for (const file of files) {
      if (failed.includes(file)) continue;
      const named = typeof event.file === "string" && sameFile(file, event.file);
      if (named || line.includes(file)) failed.push(file);
    }
  }
  return failed;
}

function spawnNode(execPath, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(execPath, args, { env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

export async function runWithFileRetry({ execPath, args, files, env }) {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-test-failed-"));
  const dest = path.join(dir, "failed.jsonl");
  writeFileSync(dest, "");
  const childEnv = { ...env, BAO_TEST_FAILED_FILES: dest };
  try {
    const first = await spawnNode(execPath, [...withFailureReporter(args, dest), ...files], childEnv);
    if (first.signal) return { code: 1, signal: first.signal, flaky: [], failed: [] };
    if (first.code === 0) return { code: 0, signal: null, flaky: [], failed: [] };
    const again = failedFilesFromLog(readFileSync(dest, "utf8"), files);
    if (again.length === 0) return { code: first.code, signal: null, flaky: [], failed: [] };
    const flaky = [];
    const failed = [];
    for (const file of again) {
      const retry = await spawnNode(execPath, [...args, file], env);
      if (retry.signal || retry.code !== 0) failed.push(file);
      else flaky.push(file);
    }
    for (const file of flaky) console.error(`flaky: ${file}`);
    for (const file of failed) console.error(`failed: ${file}`);
    return { code: failed.length ? 1 : 0, signal: null, flaky, failed };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
