import assert from "node:assert/strict";
import test from "node:test";
import { askAutomation, readAutomation } from "../../src/cdp-live/automation";
import { AUTOMATION_DENIED, AUTOMATION_PROMPT } from "../../src/cdp-live/remote-debugging";

const DIR = "/Users/me/Library/Application Support/Google/Chrome";

function fake(pids: number[], hit: { permitted?: boolean; denied?: boolean; wouldPrompt?: boolean }) {
  const calls: string[][] = [];
  let opened = 0;
  const state = { listenerPid: undefined as number | undefined, missingPort: false };
  const portReads: string[] = [];
  const ports: number[] = [];
  const deps = {
    portFile: `${DIR}/DevToolsActivePort`,
    findChrome: async () => pids,
    openChrome: async () => { opened += 1; pids.push(9); },
    sleep: async () => undefined,
    readPort: async (file: string) => {
      portReads.push(file);
      if (state.missingPort) throw new Error("port file is missing");
      return { port: 9222, browserPath: "/devtools/browser/test" };
    },
    listener: async (port: number) => {
      ports.push(port);
      return state.listenerPid;
    },
    helper: {
      exec: async (args: string[]) => {
        calls.push(args);
        return { ok: true, ...hit };
      },
    },
  };
  return { calls, deps, state, portReads, ports, opened: () => opened };
}

test("the Automation row reads the daily Chrome pid and does not ask", async () => {
  const granted = fake([7], { permitted: true });
  assert.deepEqual(await readAutomation(granted.deps), { state: "granted", message: "allowed", pid: 7, opened: false, remoteDebugging: false });
  assert.deepEqual(granted.calls, [["ae-permission", "--pid", "7"]]);
  const denied = fake([7], { denied: true });
  assert.equal((await readAutomation(denied.deps)).message, AUTOMATION_DENIED);
  const waiting = fake([7], { wouldPrompt: true });
  assert.equal((await readAutomation(waiting.deps)).message, "not yet asked");
  const closed = fake([], { permitted: true });
  assert.equal((await readAutomation(closed.deps)).message, "Chrome is not open. Allow opens Google Chrome, then asks.");
  assert.equal(closed.opened(), 0);
  assert.deepEqual(closed.calls, []);
  assert.deepEqual(closed.portReads, []);
});

test("the Automation report counts debugging only when the selected Chrome owns the listener", async () => {
  for (const hit of [{ permitted: true }, { denied: true }, { wouldPrompt: true }, {}]) {
    for (const listenerPid of [7, 99, undefined]) {
      const chrome = fake([7], hit);
      chrome.state.listenerPid = listenerPid;
      const report = await readAutomation(chrome.deps);
      assert.equal(report.remoteDebugging, listenerPid === 7);
      assert.deepEqual(chrome.portReads, [`${DIR}/DevToolsActivePort`]);
      assert.deepEqual(chrome.ports, [9222]);
      assert.deepEqual(chrome.calls, [["ae-permission", "--pid", "7"]]);
    }
  }
  const missing = fake([7], { denied: true });
  missing.state.missingPort = true;
  assert.equal((await readAutomation(missing.deps)).remoteDebugging, false);
  assert.deepEqual(missing.ports, []);
  const ambiguous = fake([7, 99], { permitted: true });
  assert.equal((await readAutomation(ambiguous.deps)).state, "unavailable");
  assert.deepEqual(ambiguous.calls, []);
  assert.deepEqual(ambiguous.portReads, []);
});

test("an unavailable helper preserves its error and the Chrome listener observation", async () => {
  for (const listenerPid of [7, undefined]) {
    const chrome = fake([7], {});
    chrome.state.listenerPid = listenerPid;
    chrome.deps.helper.exec = async () => { throw new Error("BaoOSHelper is older than this Bao; rebuild it"); };
    assert.deepEqual(await readAutomation(chrome.deps), {
      state: "unavailable",
      message: "BaoOSHelper is older than this Bao; rebuild it",
      pid: 7,
      remoteDebugging: listenerPid === 7,
    });
  }
});

test("Allow asks the running Chrome, and opens it with no flags only when it is closed", async () => {
  const running = fake([7], { permitted: true });
  const notices: string[] = [];
  assert.equal((await askAutomation({ ...running.deps, onNotice: (message) => notices.push(message) })).message, "allowed");
  assert.deepEqual(running.calls, [["ae-permission", "--pid", "7"], ["ae-permission", "--pid", "7", "--ask"]]);
  assert.deepEqual(notices, []);
  assert.equal(running.opened(), 0);

  const closed = fake([], { denied: true });
  const reply = await askAutomation(closed.deps);
  assert.equal(closed.opened(), 1);
  assert.equal(reply.pid, 9);
  assert.match(reply.message, /Bao opened it, then asked/);
  assert.match(reply.message, /System Settings > Privacy & Security > Automation/);
  assert.deepEqual(closed.calls, [["ae-permission", "--pid", "9"], ["ae-permission", "--pid", "9", "--ask"]]);
  const prompt = fake([4], { wouldPrompt: true });
  const shown: string[] = [];
  await askAutomation({ ...prompt.deps, onNotice: (message) => shown.push(message) });
  assert.deepEqual(shown, [AUTOMATION_PROMPT]);
});
