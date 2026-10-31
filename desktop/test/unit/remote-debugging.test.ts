// Bao turns the daily Chrome's remote debugging on and off as a person would: a new tab on
// chrome://inspect/#remote-debugging, then BaoOSHelper presses the checkbox in that Chrome by pid.
// BaoOSHelper, Chrome, ps, and lsof are fakes here, so nothing touches the daily Chrome.

import assert from "node:assert/strict";
import test from "node:test";
import type { ChromeAx } from "../../src/cdp-live/ax";
import { REMOTE_CHECKBOX } from "../../src/cdp-live/consent";
import {
  ACCESSIBILITY_MISSING,
  CHROME_NOT_OPEN,
  SCREEN_LOCKED,
  chromePidsFromPs,
  checkboxKnown,
  explainRemoteDebuggingError,
  setRemoteDebugging,
  shouldRestoreRemoteDebugging,
  type RemoteDebuggingDeps,
} from "../../src/cdp-live/remote-debugging";
import type { AxHit, AxNode } from "../../src/proxy/os-macos";

const DIR = "/Users/me/Library/Application Support/Google/Chrome";
const PORT_FILE = `${DIR}/DevToolsActivePort`;

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
  const state = { ...start, presses: 0, opened: 0, pids: [7], openError: "" };
  const node = (role: string, name: string, value = ""): AxNode => ({
    role, subrole: "", title: "", description: "", identifier: "", name, value, actions: [], frame: null,
    path: [{ role: "AXWindow", name: "Inspect with Chrome Developer Tools" }], pid: 7, app: "com.google.Chrome", useful: true,
  });
  const helper = {
    nodes: async (_bundle: string, pid?: number): Promise<AxHit> => {
      assert.equal(pid, 7, "the helper reads the daily Chrome by pid");
      const nodes = [node("AXWindow", "New Tab")];
      if (state.inspectOpen) nodes.push(node("AXCheckBox", REMOTE_CHECKBOX, state.on ? "1" : "0"));
      return { ok: true, nodes };
    },
    press: async (target: { role: string; name: string }, pid?: number): Promise<AxHit> => {
      assert.deepEqual([target.role, target.name, pid], ["AXCheckBox", REMOTE_CHECKBOX, 7]);
      state.presses += 1;
      state.on = !state.on;
      return { ok: true };
    },
  } as unknown as Pick<ChromeAx, "nodes" | "press">;
  const deps: RemoteDebuggingDeps = {
    helper,
    portFile: PORT_FILE,
    axLog: "/dev/null",
    openInspect: async (pid: number) => {
      assert.equal(pid, 7);
      if (state.openError) throw new Error(state.openError);
      state.opened += 1;
      state.inspectOpen = true;
    },
    findChrome: async (dir) => {
      assert.equal(dir, DIR);
      return state.pids;
    },
    readPort: async () => ({ port: 9222, browserPath: "/devtools/browser/x" }),
    listener: async (port) => (state.on && port === 9222 ? 7 : undefined),
    sleep: async () => undefined,
    timeoutMs: 1_000,
  };
  return { state, deps };
}

test("Bao opens the inspect page, presses the checkbox on, and waits for Chrome to listen", async () => {
  const { state, deps } = fakeChrome({ on: false, inspectOpen: false });
  assert.deepEqual(await setRemoteDebugging(true, deps), { pid: 7, pressed: true, opened: true, port: 9222, already: false });
  assert.deepEqual([state.opened, state.presses], [1, 1]);
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

test("a second Chrome process from the same app gets a plain error, and nothing is pressed", async () => {
  const { state, deps } = fakeChrome({ on: false, inspectOpen: false });
  state.openError = "expected one process for com.google.Chrome, found 2 ([74892, 7])";
  await assert.rejects(setRemoteDebugging(true, deps), /cannot type into Chrome while another Chrome process runs from the same app.*Quit that Chrome/);
  assert.equal(state.presses, 0);
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
  assert.equal(shouldRestoreRemoteDebugging(true), false);
  assert.equal(shouldRestoreRemoteDebugging(false), true);
  assert.equal(checkboxKnown("1"), true);
  assert.equal(checkboxKnown("0"), false);
  assert.equal(checkboxKnown(""), null);
});

test("a checkbox that is not pressable yet is retried", async () => {
  const { state, deps } = fakeChrome({ on: false, inspectOpen: true });
  let tries = 0;
  deps.helper = {
    ...deps.helper,
    press: async () => {
      tries += 1;
      if (tries === 1) throw new Error('control "Allow remote debugging for this browser instance" has no AXPress action; refusing coordinate fallback');
      state.on = true;
      state.presses += 1;
      return { ok: true };
    },
  } as typeof deps.helper;
  const result = await setRemoteDebugging(true, deps);
  assert.equal(tries, 2);
  assert.equal(result.pressed, true);
  assert.equal(result.port, 9222);
});

test("a checkbox that does not move times out instead of reporting on", async () => {
  const { deps } = fakeChrome({ on: false, inspectOpen: true });
  const stuck = { ...deps, helper: { ...deps.helper, press: async (): Promise<AxHit> => ({ ok: true }) } as Pick<ChromeAx, "nodes" | "press"> };
  await assert.rejects(setRemoteDebugging(true, { ...stuck, timeoutMs: 0 }), /timed out waiting for Chrome to listen on its DevTools port/);
});
