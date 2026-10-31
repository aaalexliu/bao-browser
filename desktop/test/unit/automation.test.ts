import assert from "node:assert/strict";
import test from "node:test";
import { askAutomation, readAutomation } from "../../src/cdp-live/automation";
import { AUTOMATION_DENIED, AUTOMATION_PROMPT } from "../../src/cdp-live/remote-debugging";

const DIR = "/Users/me/Library/Application Support/Google/Chrome";

function fake(pids: number[], hit: { permitted?: boolean; denied?: boolean; wouldPrompt?: boolean }) {
  const calls: string[][] = [];
  let opened = 0;
  const deps = {
    portFile: `${DIR}/DevToolsActivePort`,
    findChrome: async () => pids,
    openChrome: async () => { opened += 1; pids.push(9); },
    sleep: async () => undefined,
    helper: {
      exec: async (args: string[]) => {
        calls.push(args);
        return { ok: true, ...hit };
      },
    },
  };
  return { calls, deps, opened: () => opened };
}

test("the Automation row reads the daily Chrome pid and does not ask", async () => {
  const granted = fake([7], { permitted: true });
  assert.deepEqual(await readAutomation(granted.deps), { state: "granted", message: "allowed", pid: 7, opened: false });
  assert.deepEqual(granted.calls, [["ae-permission", "--pid", "7"]]);
  const denied = fake([7], { denied: true });
  assert.equal((await readAutomation(denied.deps)).message, AUTOMATION_DENIED);
  const waiting = fake([7], { wouldPrompt: true });
  assert.equal((await readAutomation(waiting.deps)).message, "not yet asked");
  const closed = fake([], { permitted: true });
  assert.equal((await readAutomation(closed.deps)).message, "Chrome is not open. Allow opens Google Chrome, then asks.");
  assert.equal(closed.opened(), 0);
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
