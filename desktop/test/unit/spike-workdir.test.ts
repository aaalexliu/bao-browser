import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("an unset spike throws before it creates a temp work directory", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "bao-spike-order-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: scratch };
    delete env.BAO_SPIKE_ARTIFACTS;
    delete env.BAO_AGENT_STORE_DIR;
    const ran = spawnSync(process.execPath, ["desktop/dist/desktop/src/proxy/spike-macos.js"], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(ran.status, 1, ran.stderr);
    assert.match(ran.stderr, /Set BAO_SPIKE_ARTIFACTS or BAO_AGENT_STORE_DIR/);
    assert.deepEqual(readdirSync(scratch), []);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("an unset live spike throws before it creates a temp work directory", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "bao-spike-live-"));
  const trail = path.join(scratch, "trail.json");
  writeFileSync(trail, "{\"events\":[]}\n");
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: scratch };
    delete env.BAO_SPIKE_ARTIFACTS;
    delete env.BAO_AGENT_STORE_DIR;
    const ran = spawnSync(process.execPath, [
      "desktop/dist/desktop/src/proxy/spike-macos-live.js",
      "calc",
      trail,
      "pin",
    ], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(ran.status, 1, ran.stderr);
    assert.match(ran.stderr, /Set BAO_SPIKE_ARTIFACTS or BAO_AGENT_STORE_DIR/);
    assert.deepEqual(readdirSync(scratch), ["trail.json"]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
