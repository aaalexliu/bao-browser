import { createRequire } from "node:module";

const { scaledMs } = createRequire(import.meta.url)("./time-scale.cjs");

export const TEST_TIMEOUT_MS = 120_000;

export function testTimeoutMs(env = process.env) {
  return scaledMs(TEST_TIMEOUT_MS, env);
}

export function runnerTestArgs(env = process.env) {
  return [`--test-timeout=${testTimeoutMs(env)}`, "--test-force-exit"];
}
