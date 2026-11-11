import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skill = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(skill, "../../..");
const evidence = mkdtempSync(path.join(tmpdir(), "bao-close-proof-"));
console.log(`Evidence: ${evidence}`);
const jar = process.env.TLA2TOOLS;
assert.ok(jar, "Set TLA2TOOLS to the TLC 1.7.4 jar. See SKILL.md.");
assert.equal(
  createHash("sha256").update(readFileSync(jar)).digest("hex"),
  "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
  "TLA2TOOLS must be the pinned TLC 1.7.4 jar",
);

const env = {
  ...process.env,
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH
    ?? path.join(homedir(), "Library/Caches/ms-playwright"),
  HOME: mkdtempSync(path.join(evidence, "home-")),
  BAO_HEAL_CURSOR_ACCOUNT: "0",
};
for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY", "XAI_API_KEY", "CURSOR_API_KEY"]) {
  delete env[key];
}

function run(name, executable, args, childEnv = env) {
  const result = spawnSync(executable, args, {
    cwd: root,
    env: childEnv,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeFileSync(path.join(evidence, `${name}.log`), output);
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `${name} stopped by ${result.signal}`);
  return { status: result.status, output };
}

for (const [config, expected] of [["PlaywrightClose", 0], ["Broken", 12]]) {
  const result = run(config, process.env.JAVA || "java", [
    "-XX:+UseParallelGC", "-Xmx512m", "-cp", jar, "tlc2.TLC",
    "-workers", "1", "-fp", "0",
    "-metadir", path.join(evidence, config),
    "-config", path.join(skill, `${config}.cfg`), path.join(skill, "PlaywrightClose.tla"),
  ]);
  assert.equal(result.status, expected, `${config}:\n${result.output}`);
  if (expected === 0) {
    assert.match(result.output, /Model checking completed\. No error has been found\./);
  } else {
    assert.match(result.output, /Invariant OneShutdownCompletion is violated/);
  }
  console.log(`${config}: expected exit ${expected}`);
}

const build = run("build", process.execPath, [
  path.join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.desktop.json",
]);
assert.equal(build.status, 0, build.output);
const require = createRequire(import.meta.url);
const { laneChildEnv, playwrightVersionError } = require(path.join(root, "desktop/dist/desktop/test/runtime.js"));
assert.equal(playwrightVersionError(), undefined);
const result = run("playwright-close", process.execPath, [
  "--test", "--test-isolation=process", "--test-reporter=tap",
  "--test-name-pattern=^a disconnect followed by context\\.close runs one shutdown$",
  path.join(root, "desktop/dist/desktop/test/unit/playwright-close.test.js"),
], laneChildEnv("hermetic", env));
assert.equal(result.status, 0, result.output);
assert.match(result.output, /# pass 1\b/, "The focused real-browser test must run, not skip.");
console.log("PASS: bounded model, expected counterexample, and one headless Chromium shutdown test.");
