// Bao turns the daily Chrome's remote debugging on and off as a person would: a new tab on
// chrome://inspect/#remote-debugging, then BaoOSHelper presses the checkbox in that Chrome by pid.
// BaoOSHelper, Chrome, ps, and lsof are fakes here, so nothing touches the daily Chrome.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ACCESSIBILITY_MISSING,
  AUTOMATION_DENIED,
  AUTOMATION_PROMPT,
  CHROME_NOT_OPEN,
  SCREEN_LOCKED,
  chromePidsFromPs,
  checkboxKnown,
  explainRemoteDebuggingError,
  setRemoteDebugging,
  type RemoteDebuggingDeps,
} from "../../src/cdp-live/remote-debugging";
import type { AxHit } from "../../src/proxy/os-macos";

const DIR = "/Users/me/Library/Application Support/Google/Chrome";
const PORT_FILE = `${DIR}/DevToolsActivePort`;
const logDir = mkdtempSync(path.join(tmpdir(), "bao-remote-debugging-"));
after(() => rmSync(logDir, { recursive: true, force: true }));

test("the daily Chrome is the browser process on its user-data dir, not a renderer, a headless Chrome, or another profile dir", () => {
  const ps = [
    "  101 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "  102 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer",
    "  103 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --remote-debugging-pipe --user-data-dir=/tmp/puppeteer_dev_chrome_profile-x",
    "  104 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/test-profile --no-first-run",
    "  105 /Applications/Bao.app/Contents/Resources/Chromium.app/Contents/MacOS/Google Chrome for Testing --app=http://127.0.0.1:4787/",
    "",
  ].join("\n");
  assert.deepEqual(chromePidsFromPs(ps, DIR, DIR), [101]);
  assert.deepEqual(chromePidsFromPs(`  106 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${DIR} --profile-directory=Default`, DIR, DIR), [106]);
  assert.deepEqual(chromePidsFromPs(ps, "/tmp/test-profile", DIR), [104]);
});

/** A daily Chrome whose inspect page Bao can open, and whose checkbox BaoOSHelper can press. */
function fakeChrome(start: { on: boolean; inspectOpen: boolean }) {
  const state = { ...start, presses: 0, opened: 0, closed: 0, pids: [7], openError: "", reads: 0, missingReads: 0, boxMissing: false, portStuck: false, gate: { ok: true, permitted: true } as AxHit, asked: { ok: true, permitted: true } as AxHit, calls: [] as string[][] };
  const helper: RemoteDebuggingDeps["helper"] = {
    exec: async (args: string[]): Promise<AxHit> => {
      state.calls.push(args);
      if (args[0] === "ae-permission") return args.includes("--ask") ? state.asked : state.gate;
      if (args[0] === "ae-url") return { ok: true, url: state.inspectOpen ? "chrome://inspect/#remote-debugging" : "about:blank" };
      if (args[0] === "checkbox-read") return { ok: true, found: state.inspectOpen && !state.boxMissing && state.reads++ >= state.missingReads, value: state.on ? "1" : "0" };
      if (args[0] === "checkbox-set") {
        if (state.boxMissing) return { ok: true, found: false };
        state.presses += 1;
        state.on = args.includes("1");
        return { ok: true, found: true, value: state.on ? "1" : "0" };
      }
      return { ok: true };
    },
  };
  const deps: RemoteDebuggingDeps = {
    helper,
    portFile: PORT_FILE,
    axLog: path.join(logDir, "ax.jsonl"),
    openInspect: async (pid: number) => {
      assert.equal(pid, 7);
      if (state.openError) throw new Error(state.openError);
      state.opened += 1;
      state.inspectOpen = true;
    },
    closeOpenedTab: async (pid) => {
      assert.equal(pid, 7);
      state.closed += 1;
      state.inspectOpen = false;
    },
    findChrome: async (dir) => {
      assert.equal(dir, DIR);
      return state.pids;
    },
    readPort: async () => ({ port: 9222, browserPath: "/devtools/browser/x" }),
    listener: async (port) => (state.on && !state.portStuck && port === 9222 ? 7 : undefined),
    sleep: async () => undefined,
    timeoutMs: 1_000,
  };
  return { state, deps };
}

test("Bao opens the inspect page, presses the checkbox on, and waits for Chrome to listen", async () => {
  const { state, deps } = fakeChrome({ on: false, inspectOpen: false });
  assert.deepEqual(await setRemoteDebugging(true, deps), { pid: 7, pressed: true, opened: true, port: 9222, already: false });
  assert.deepEqual([state.opened, state.presses, state.closed], [1, 1, 1]);
});

test("a Chrome that already listens is left as it is", async () => {
  const { state, deps } = fakeChrome({ on: true, inspectOpen: false });
  assert.deepEqual(await setRemoteDebugging(true, deps), { pid: 7, pressed: false, opened: false, port: 9222, already: true });
  assert.deepEqual([state.opened, state.presses], [0, 0]);
});

test("off presses the checkbox on the open inspect page and waits for the port to close", async () => {
  const { state, deps } = fakeChrome({ on: true, inspectOpen: true });
  assert.deepEqual(await setRemoteDebugging(false, deps), { pid: 7, pressed: true, opened: false, port: null, already: false });
  assert.equal(state.on, false);
  assert.equal(state.opened, 0, "the inspect page was already open");
});

test("Bao refuses when the daily Chrome is not open, or when two browsers share its profile dir", async () => {
  const closed = fakeChrome({ on: false, inspectOpen: false });
  closed.state.pids = [];
  await assert.rejects(setRemoteDebugging(true, closed.deps), /Chrome is not open/);
  const two = fakeChrome({ on: false, inspectOpen: false });
  two.state.pids = [7, 8];
  await assert.rejects(setRemoteDebugging(true, two.deps), /more than one Chrome/);
  assert.equal(closed.state.presses + two.state.presses, 0);
});

test("off when the port is already closed changes nothing", async () => {
  const { state, deps } = fakeChrome({ on: false, inspectOpen: false });
  assert.deepEqual(await setRemoteDebugging(false, deps), { pid: 7, pressed: false, opened: false, port: null, already: true });
  assert.equal(state.opened, 0);
  assert.equal(state.presses, 0);
});

test("a locked screen fails before any key or press", async () => {
  const { state, deps } = fakeChrome({ on: false, inspectOpen: false });
  deps.screenLocked = async () => true;
  await assert.rejects(setRemoteDebugging(true, deps), new RegExp(SCREEN_LOCKED.replace(/[.]/g, "\\.")));
  assert.equal(state.opened, 0);
  assert.equal(state.presses, 0);
});

test("errors name a locked screen, a missing grant, and Chrome not running", () => {
  assert.equal(explainRemoteDebuggingError(new Error("The screen is locked. Unlock it, then try again")).message, SCREEN_LOCKED);
  assert.equal(explainRemoteDebuggingError(new Error("BaoOSHelper accessibility is not granted")).message, ACCESSIBILITY_MISSING);
  assert.equal(explainRemoteDebuggingError(new Error(CHROME_NOT_OPEN)).message, CHROME_NOT_OPEN);
  assert.equal(explainRemoteDebuggingError(new Error("unknown command ae-open")).message, "BaoOSHelper is older than this Bao; rebuild it");
  assert.equal(explainRemoteDebuggingError(new Error("not allowed to control Google Chrome")).message, AUTOMATION_DENIED);
  assert.equal(checkboxKnown("1"), true);
  assert.equal(checkboxKnown("0"), false);
  assert.equal(checkboxKnown(""), null);
});

test("a checkbox that does not move times out instead of reporting on", async () => {
  const { deps } = fakeChrome({ on: false, inspectOpen: true });
  deps.helper = {
    exec: async (args: string[]) => {
      if (args[0] === "ae-permission") return { ok: true, permitted: true };
      if (args[0] === "ae-url") return { ok: true, url: "chrome://inspect/#remote-debugging" };
      if (args[0] === "checkbox-read") return { ok: true, found: true, value: "0" };
      return { ok: true, found: true, value: "0" };
    },
  };
  await assert.rejects(setRemoteDebugging(true, { ...deps, timeoutMs: 0 }), /timed out waiting for Chrome to listen on its DevTools port/);
});

for (const on of [true, false]) {
  test(`${on ? "on" : "off"} skips Automation when the port already matches`, async () => {
    const { state, deps } = fakeChrome({ on, inspectOpen: false });
    state.gate = { ok: true, wouldPrompt: true };
    assert.equal((await setRemoteDebugging(on, deps)).already, true);
    assert.deepEqual(state.calls, []);
  });

  for (const asked of [{ ok: true, denied: true }, { ok: true, wouldPrompt: true }]) {
    test(`${on ? "on" : "off"} stops at a refused or unanswered Automation prompt`, async () => {
      const { state, deps } = fakeChrome({ on: !on, inspectOpen: false });
      state.gate = { ok: true, wouldPrompt: true };
      state.asked = asked;
      const notices: string[] = [];
      deps.onNotice = (message) => notices.push(message);
      await assert.rejects(setRemoteDebugging(on, deps), asked.denied ? /System Settings > Privacy & Security > Automation/ : /still undetermined/);
      assert.deepEqual(state.calls, [
        ["ae-permission", "--pid", "7"],
        ["ae-permission", "--pid", "7", "--ask"],
      ]);
      assert.deepEqual(notices, [AUTOMATION_PROMPT, ""]);
      assert.deepEqual([state.opened, state.presses], [0, 0]);
    });
  }
}

test("a granted prompt resumes the toggle and clears the app notice", async () => {
  const { state, deps } = fakeChrome({ on: false, inspectOpen: false });
  state.gate = { ok: true, wouldPrompt: true };
  const notices: string[] = [];
  deps.onNotice = (message) => notices.push(message);
  assert.equal((await setRemoteDebugging(true, deps)).port, 9222);
  assert.deepEqual(notices, [AUTOMATION_PROMPT, ""]);
  assert.equal(state.closed, 1);
});

test("a new inspect tab waits for its AX checkbox instead of claiming a missing press succeeded", async () => {
  const { state, deps } = fakeChrome({ on: false, inspectOpen: false });
  state.missingReads = 2;
  assert.equal((await setRemoteDebugging(true, deps)).pressed, true);
  assert.equal(state.reads, 3);
  assert.equal(state.closed, 1);
});

test("a missing checkbox fails and closes only the tab Bao opened", async () => {
  const { state, deps } = fakeChrome({ on: false, inspectOpen: false });
  state.boxMissing = true;
  await assert.rejects(setRemoteDebugging(true, { ...deps, timeoutMs: 0 }), /timed out waiting for the remote-debugging checkbox/);
  assert.equal(state.presses, 0);
  assert.equal(state.closed, 1);
});

test("failure to listen closes the owned inspect tab without claiming success", async () => {
  const { state, deps } = fakeChrome({ on: false, inspectOpen: false });
  state.portStuck = true;
  await assert.rejects(setRemoteDebugging(true, { ...deps, timeoutMs: 0 }), /timed out waiting for Chrome to listen/);
  assert.equal(state.closed, 1);
});
