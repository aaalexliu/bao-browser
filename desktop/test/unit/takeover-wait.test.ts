import assert from "node:assert/strict";
import test from "node:test";
import { controlState, doneAsk, handedBack, HANDED_BACK, holdCommand, staleHold, stepControl } from "../../../shared/takeover-overlay";

test("an acting command while the owner holds the tab waits and does not run", async () => {
  let ran = false;
  const gate = await holdCommand(true, "click", async () => {
    ran = true;
    return "clicked";
  }, async () => "done");
  assert.equal(ran, false);
  assert.equal(gate.held, true);
  if (gate.held) assert.equal(gate.outcome, "done");
  assert.equal(HANDED_BACK, "The owner took control of this tab and handed it back. Take a fresh snapshot before acting.");
});

test("an open or a tab close while the owner holds the tab waits, and a session close does not", async () => {
  const waited = async (command: string, args: string[] = []) => {
    let ran = false;
    const gate = await holdCommand(true, command, async () => { ran = true; return "ran"; }, async () => "done", args);
    return { ran, held: gate.held };
  };
  assert.deepEqual(await waited("open", ["https://shop.example"]), { ran: false, held: true });
  assert.deepEqual(await waited("tab", ["close"]), { ran: false, held: true });
  assert.deepEqual(await waited("tab", ["--json", "close", "t2"]), { ran: false, held: true });
  assert.deepEqual(await waited("close"), { ran: true, held: false });
  assert.deepEqual(await waited("tab", ["t2"]), { ran: true, held: false });
});

test("done keeps the ask and names Done", () => {
  assert.equal(doneAsk("Sign in in the Bao window, then press Continue."), "Sign in in the Bao window, then click Done.");
  assert.equal(doneAsk("Finish the check on the page."), "Finish the check on the page, then click Done");
  assert.equal(doneAsk("Sign in, then click Done"), "Sign in, then click Done");
});

test("a snapshot while the owner holds the tab is not an acting command", async () => {
  let ran = false;
  const gate = await holdCommand(true, "snapshot", async () => {
    ran = true;
    return "tree";
  }, async () => "done");
  assert.equal(ran, true);
  assert.equal(gate.held, false);
  if (!gate.held) assert.equal(gate.value, "tree");
});

test("control moves agent, taking, owner, releasing, and back", () => {
  const taken = stepControl(controlState(), { type: "take", at: 10 });
  assert.equal(taken.phase, "taking");
  const owned = stepControl(taken, { type: "own" });
  assert.equal(owned.phase, "owner");
  assert.equal(owned.reason, "takeover");
  const releasing = stepControl(owned, { type: "done", at: 20 });
  assert.equal(releasing.phase, "releasing");
  assert.equal(releasing.startedAt, 10);
  assert.equal(releasing.endedAt, 20);
  assert.equal(stepControl(releasing, { type: "resume" }).phase, "agent");
  assert.equal(stepControl(controlState(), { type: "done", at: 1 }).phase, "agent");
});

test("a take during prep skips the command after Done, and a tab that is still held waits", () => {
  assert.equal(staleHold(true, false, "click"), "handback");
  assert.equal(staleHold(true, false, "open", ["https://shop.example"]), "handback");
  assert.equal(staleHold(true, false, "tab", ["close"]), "handback");
  assert.equal(staleHold(true, true, "click"), "wait");
  assert.equal(staleHold(false, true, "press", ["Enter"]), "wait");
  assert.equal(staleHold(false, false, "click"), "run");
  assert.equal(staleHold(true, false, "snapshot"), "run");
  assert.equal(staleHold(true, false, "close"), "run");
  assert.equal(handedBack({ stdout: `${HANDED_BACK}\n`, exitCode: 0 }), true);
  assert.equal(handedBack({ stdout: "\u2713 Done\n", exitCode: 0 }), false);
  assert.equal(handedBack({ stdout: `${HANDED_BACK}\n`, exitCode: 1 }), false);
});

test("an ask goes straight to the in-control pill", () => {
  const asked = stepControl(controlState(), { type: "ask", ask: "Sign in, then click Done", at: 5 });
  assert.equal(asked.phase, "owner");
  assert.equal(asked.reason, "ask");
  assert.equal(asked.ask, "Sign in, then click Done");
});
