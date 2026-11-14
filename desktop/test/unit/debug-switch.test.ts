// The hold owns the debugging switch. A missing listener is not a claim. A dead Chrome does not clear one.
// Off uses the pid-scoped checkbox, never an Apple Event. A test process throws before any platform return.

import assert from "node:assert/strict";
import { lstatSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { holdDir, settleDebugSwitch } from "../../src/cdp-live/chrome-hold";
import { connectOwnedChrome } from "../../src/cdp-live/current-chrome";
import {
  claimForEnable,
  claimOwned,
  clearClaim,
  finishOwnedSwitch,
  readClaim,
  setSwitchByAx,
  turnSwitchOff,
  writeClaim,
} from "../../src/cdp-live/debug-switch";
import { REMOTE_CHECKBOX } from "../../src/cdp-live/consent";

async function scratchDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(tmpdir(), prefix)));
}

test("a claim records exactly whether Bao turned the switch on", async () => {
  const dir = await scratchDir("bao-switch-claim-");
  try {
    writeClaim(dir, false);
    assert.equal(readClaim(dir)?.owned, false);
    assert.equal(claimOwned(dir), false);
    assert.equal(lstatSync(path.join(dir, "switch.json")).mode & 0o777, 0o600);
    writeClaim(dir, true);
    assert.equal(claimOwned(dir), true);
    writeClaim(dir, false);
    assert.equal(claimOwned(dir), false);
    clearClaim(dir);
    assert.equal(readClaim(dir), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing listener is not a claim, and a checkbox that is already on is not Bao's", () => {
  assert.equal(claimForEnable(false, undefined, false), undefined);
  assert.equal(claimForEnable(false, true, false), false);
  assert.equal(claimForEnable(false, false, false), true);
  assert.equal(claimForEnable(true, true, false), true);
  assert.equal(claimForEnable(true, undefined, true), true);
  assert.equal(claimForEnable(false, undefined, true), false);
});

test("off clears the claim only when the checkbox change finished", async () => {
  const dir = await scratchDir("bao-switch-off-");
  try {
    writeClaim(dir, true);
    await finishOwnedSwitch(dir, async () => "unavailable");
    assert.equal(claimOwned(dir), true);
    await finishOwnedSwitch(dir, async () => { throw new Error("helper failed"); });
    assert.equal(claimOwned(dir), true);
    await finishOwnedSwitch(dir, async () => "failed");
    assert.equal(claimOwned(dir), true);
    await finishOwnedSwitch(dir, async () => "done");
    assert.equal(claimOwned(dir), false);
    writeClaim(dir, false);
    let called = false;
    await finishOwnedSwitch(dir, async () => { called = true; return "done"; });
    assert.equal(called, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the switch moves by pid through the checkbox, and a dead pid is not a success", async () => {
  const dir = await scratchDir("bao-switch-ax-");
  const axLog = path.join(dir, "ax.jsonl");
  const calls: string[][] = [];
  let on = true;
  const helper = {
    async exec(args: string[]) {
      calls.push(args);
      assert.equal(args.includes("ae-open"), false);
      assert.equal(args[args.indexOf("--pid") + 1], "7");
      if (args[0] === "checkbox-read") return { ok: true, found: true, value: on ? "1" : "0" };
      if (args[0] === "checkbox-set") {
        assert.equal(args[args.indexOf("--value") + 1], "0");
        assert.equal(args[args.indexOf("--name") + 1], REMOTE_CHECKBOX);
        on = false;
        return { ok: true, found: true, pressed: true };
      }
      return { ok: true, found: false, nodes: [] };
    },
  };
  try {
    assert.equal(await setSwitchByAx(helper, 7, false, axLog, () => false), "unavailable");
    assert.equal(calls.length, 0);
    const done = await setSwitchByAx(helper, 7, false, axLog, () => true);
    assert.equal(done, "done");
    assert.equal(on, false);
    assert.ok(calls.some((call) => call[0] === "inspect-open-ax"));
    assert.ok(calls.some((call) => call[0] === "checkbox-set"));
    assert.equal(calls.some((call) => call[0] === "ae-open" || call[0] === "ae-close"), false);
    calls.length = 0;
    assert.equal(await setSwitchByAx(helper, 7, false, axLog, () => true), "done");
    assert.equal(calls.some((call) => call[0] === "checkbox-set"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a test process refuses to change the switch before any platform return", async () => {
  await assert.rejects(turnSwitchOff(1, "/tmp/ax.jsonl"), /tests never change/);
  await settleDebugSwitch();
});

test("the hold claims a confirmed-off switch before the press, and does not claim one that is already on", async () => {
  const root = await scratchDir("bao-switch-enable-");
  const dir = holdDir(root);
  const axLog = path.join(root, "ax.jsonl");
  try {
    let portReady = false;
    let claimedBeforePress = false;
    const calls: string[] = [];
    const helper = {
      async permissions() { return { ok: true, accessibility: true }; },
      async screenLocked() { return false; },
      async exec(args: string[]) {
        calls.push(args[0] ?? "");
        if (args[0] === "checkbox-read") {
          assert.notEqual(readClaim(dir)?.owned, true);
          return { ok: true, found: true, value: "0" };
        }
        if (args[0] === "checkbox-set") {
          claimedBeforePress = readClaim(dir)?.owned === true;
          portReady = true;
          return { ok: true, found: true, pressed: true };
        }
        return { ok: true, found: false };
      },
    };
    await assert.rejects(connectOwnedChrome({ root, axLog, recordClaim: true }, {
      helper,
      findChrome: async () => [7],
      startChrome: async () => false,
      executable: () => "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      readPort: async () => {
        if (!portReady) throw new Error("missing");
        return { port: 9, browserPath: "/devtools/browser/fixture" };
      },
      listener: async () => portReady ? 7 : undefined,
      listenPorts: async () => [],
      probeVersion: async () => undefined,
      connect: async () => { throw new Error("stop after the press"); },
    }), /stop after the press/);
    assert.equal(claimedBeforePress, true);
    assert.equal(claimOwned(dir), true);
    assert.ok(calls.includes("checkbox-set"));
    assert.equal(calls.includes("ae-open"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("a checkbox that already reads on is not pressed and is not claimed", async () => {
  const root = await scratchDir("bao-switch-already-");
  const dir = holdDir(root);
  const axLog = path.join(root, "ax.jsonl");
  try {
    let portReady = false;
    const calls: string[] = [];
    const helper = {
      async permissions() { return { ok: true, accessibility: true }; },
      async screenLocked() { return false; },
      async exec(args: string[]) {
        calls.push(args[0] ?? "");
        if (args[0] === "checkbox-read") {
          portReady = true;
          return { ok: true, found: true, value: "1" };
        }
        return { ok: true, found: false };
      },
    };
    await assert.rejects(connectOwnedChrome({ root, axLog, recordClaim: true }, {
      helper,
      findChrome: async () => [7],
      startChrome: async () => false,
      executable: () => "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      readPort: async () => {
        if (!portReady) throw new Error("missing");
        return { port: 9, browserPath: "/devtools/browser/fixture" };
      },
      listener: async () => portReady ? 7 : undefined,
      listenPorts: async () => [],
      probeVersion: async () => undefined,
      connect: async () => { throw new Error("stop after the read"); },
    }), /stop after the read/);
    assert.equal(calls.includes("checkbox-set"), false);
    assert.equal(claimOwned(dir), false);
    assert.equal(readClaim(dir)?.owned, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("a listener that is already up is not claimed when Bao has no prior claim", async () => {
  const root = await scratchDir("bao-switch-listening-");
  const dir = holdDir(root);
  const axLog = path.join(root, "ax.jsonl");
  try {
    const calls: string[] = [];
    const helper = {
      async permissions() { return { ok: true, accessibility: true }; },
      async screenLocked() { return false; },
      async exec(args: string[]) {
        calls.push(args[0] ?? "");
        return { ok: true, found: false };
      },
    };
    await assert.rejects(connectOwnedChrome({ root, axLog, recordClaim: true }, {
      helper,
      findChrome: async () => [7],
      startChrome: async () => false,
      executable: () => "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      readPort: async () => { throw new Error("missing"); },
      listener: async () => 7,
      listenPorts: async () => [9],
      probeVersion: async () => ({ status: 200, body: JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:9/devtools/browser/fixture" }) }),
      connect: async () => { throw new Error("stop before press"); },
    }), /stop before press/);
    assert.equal(calls.includes("checkbox-set"), false);
    assert.equal(calls.includes("inspect-open-ax"), false);
    assert.equal(claimOwned(dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
