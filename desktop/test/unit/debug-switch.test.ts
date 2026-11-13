// Bao turns Chrome's debugging switch off only when Bao turned it on and the last session is gone.
// finish_task, close, MCP disconnect, idle end, and a handled stop all release the session lease.
// A quit, a crash, or chrome-hold outliving the session leaves a dead pid, which the hold reaps.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { holdDir, serveHold, settleDebugSwitch } from "../../src/cdp-live/chrome-hold";
import { liveLeaseCount, productionTurnOff, readClaim, rememberSwitch, takeLease, turnOffIfIdle } from "../../src/cdp-live/debug-switch";
import type { CurrentChrome } from "../../src/cdp-live/current-chrome";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function scratchDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

function heldChrome(root: string): CurrentChrome & { close(): void } {
  let closed = false;
  let resolveClosed: () => void = () => undefined;
  const done = new Promise<void>((resolve) => { resolveClosed = resolve; });
  return {
    pid: process.pid,
    executable: "/bin/test-chrome",
    root,
    endpoint: { port: 9, browserPath: "/devtools/browser/switch" },
    cdp: {} as CurrentChrome["cdp"],
    closed: done,
    isClosed: () => closed,
    detach() { closed = true; resolveClosed(); },
    close() { closed = true; resolveClosed(); },
  };
}

test("Bao owns the switch only when it had to turn it on", async () => {
  const dir = await scratchDir("bao-switch-own-");
  try {
    rememberSwitch(dir, false);
    assert.deepEqual(readClaim(dir), { owned: false });
    assert.equal(lstatSync(path.join(dir, "switch.json")).mode & 0o777, 0o600);
    rememberSwitch(dir, true);
    assert.deepEqual(readClaim(dir), { owned: true });
    rememberSwitch(dir, false);
    assert.deepEqual(readClaim(dir), { owned: true }, "a later connect must not clear a claim Bao still owns");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the last released lease turns the switch off, and a second lease keeps it on", async () => {
  const dir = await scratchDir("bao-switch-leases-");
  try {
    rememberSwitch(dir, true);
    const first = takeLease(dir);
    const second = takeLease(dir);
    let offs = 0;
    assert.equal(await turnOffIfIdle(dir, async () => { offs += 1; }), false);
    assert.equal(offs, 0);
    first.release();
    assert.equal(await turnOffIfIdle(dir, async () => { offs += 1; }), false);
    assert.equal(offs, 0);
    assert.equal(liveLeaseCount(dir), 1);
    second.release();
    assert.equal(await turnOffIfIdle(dir, async () => { offs += 1; }), true);
    assert.equal(offs, 1);
    assert.equal(readClaim(dir), undefined);
    assert.equal(existsSync(path.join(dir, "switch.json")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a quit, a crash, or a hold that outlives the session reaps the dead lease and turns the switch off", async () => {
  const dir = await scratchDir("bao-switch-dead-");
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  if (!child.pid) throw new Error("no child pid");
  try {
    rememberSwitch(dir, true);
    takeLease(dir, child.pid);
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
    let offs = 0;
    assert.equal(await turnOffIfIdle(dir, async () => { offs += 1; }), true);
    assert.equal(offs, 1);
    assert.equal(readClaim(dir), undefined);
  } finally {
    if (pidAlive(child.pid)) child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed off keeps the claim, and a live holder is left to turn it off", async () => {
  const dir = await scratchDir("bao-switch-keep-");
  try {
    rememberSwitch(dir, true);
    assert.equal(await turnOffIfIdle(dir, async () => { throw new Error("helper failed"); }), false);
    assert.deepEqual(readClaim(dir), { owned: true });
    let offs = 0;
    assert.equal(await turnOffIfIdle(dir, async () => { offs += 1; }, { holderAlive: true }), false);
    assert.equal(offs, 0);
    assert.deepEqual(readClaim(dir), { owned: true });
    await rm(path.join(dir, "switch.json"), { force: true });
    rememberSwitch(dir, false);
    assert.equal(await turnOffIfIdle(dir, async () => { offs += 1; }), false);
    assert.equal(offs, 0, "a switch Bao did not turn on is left alone");
    assert.deepEqual(readClaim(dir), { owned: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the hold turns the switch off only after the last session releases its lease", async () => {
  const scratch = await scratchDir("bao-switch-hold-");
  const root = scratch;
  const chrome = heldChrome(root);
  const dir = holdDir(root);
  let offs = 0;
  const serving = serveHold(chrome, undefined, async () => { offs += 1; });
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(path.join(dir, "hold.json"))) {
      if (Date.now() >= deadline) throw new Error("the hold did not publish");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const first = takeLease(dir);
    const second = takeLease(dir);
    rememberSwitch(dir, true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(offs, 0, "two sessions still using the switch");
    first.release();
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(offs, 0, "one session still using the switch");
    second.release();
    const offBy = Date.now() + 5_000;
    while (offs === 0) {
      if (Date.now() >= offBy) throw new Error("the hold did not turn the switch off");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(offs, 1);
    assert.equal(readClaim(dir), undefined);
  } finally {
    chrome.close();
    await serving;
    await rm(dir, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a test process never changes Chrome's debugging switch", async () => {
  const previous = process.env.BAO_LANE;
  process.env.BAO_LANE = "hermetic";
  try {
    await assert.rejects(productionTurnOff("/tmp/DevToolsActivePort", "/tmp/ax.jsonl"), /tests never change/);
    await settleDebugSwitch();
  } finally {
    if (previous === undefined) delete process.env.BAO_LANE;
    else process.env.BAO_LANE = previous;
  }
});
