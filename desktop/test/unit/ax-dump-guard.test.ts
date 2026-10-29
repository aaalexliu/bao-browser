import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("a failed ax dump leaves fixtures/ax/macos-26/files.json untouched", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "bao-ax-dump-"));
  try {
    const fixtures = path.join(scratch, "fixtures", "ax", "macos-26");
    mkdirSync(fixtures, { recursive: true });
    const original = "{\n  \"kept\": true\n}\n";
    const fixture = path.join(fixtures, "files.json");
    writeFileSync(fixture, original);
    const home = path.join(scratch, "home");
    const temp = path.join(scratch, "tmp");
    const store = path.join(scratch, "store");
    mkdirSync(home);
    mkdirSync(temp);
    mkdirSync(store);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      TMPDIR: temp,
      BAO_AGENT_STORE_DIR: store,
      BAO_MAC_SPIKE_ROOT: scratch,
    };
    delete env.BAO_SPIKE_ARTIFACTS;
    const ran = spawnSync(process.execPath, ["desktop/src/proxy/spike-macos-ax.mjs"], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
    });
    assert.equal(ran.status, 1, ran.stderr);
    assert.equal(readFileSync(fixture, "utf8"), original);
    const report = path.join(store, "bao-mac-spike", "ax-macos-26-report.json");
    assert.equal(existsSync(report), true);
    const body = JSON.parse(readFileSync(report, "utf8")) as { permissions: null; apps: Record<string, unknown> };
    assert.equal(body.permissions, null);
    assert.deepEqual(body.apps, {});
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
