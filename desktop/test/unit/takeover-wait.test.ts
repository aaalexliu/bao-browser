import assert from "node:assert/strict";
import test from "node:test";
import { controlState, HANDED_BACK, holdCommand, stepControl } from "../../../shared/takeover-overlay";

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

test("an ask goes straight to the in-control pill", () => {
  const asked = stepControl(controlState(), { type: "ask", ask: "Sign in, then click Done", at: 5 });
  assert.equal(asked.phase, "owner");
  assert.equal(asked.reason, "ask");
  assert.equal(asked.ask, "Sign in, then click Done");
});
