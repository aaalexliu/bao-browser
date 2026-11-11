"use strict";

function testTimeScale(env = process.env) {
  const raw = env.BAO_TEST_TIME_SCALE;
  if (raw == null || String(raw).trim() === "") return 1;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`BAO_TEST_TIME_SCALE must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function scaledMs(ms, env = process.env) {
  const scale = testTimeScale(env);
  if (scale === 1) return ms;
  return Math.ceil(ms * scale);
}

exports.testTimeScale = testTimeScale;
exports.scaledMs = scaledMs;
