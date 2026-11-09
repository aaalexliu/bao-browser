import assert from "node:assert/strict";
import test from "node:test";
import { cursorSessionHeal, type StepFailure } from "../../src/v1/heal";
import type { WorkflowStep } from "../../src/v1/schema";

const step: WorkflowStep = {
  id: "s1",
  index: 0,
  timeoutMs: 8000,
  caption: { text: "Log in" },
  action: "click",
  target: {
    locators: [{ kind: "testid", value: "missing" }, { kind: "css", value: "[data-testid=\"missing\"]" }],
    hint: { role: "button", surface: "dom" },
  },
};

const failure = {
  stepId: "s1",
  index: 0,
  intent: "Log in",
  reason: "below-threshold",
  brokenAttr: "testId",
  snapshot: { dom: { role: "button", testId: "login" } },
} as StepFailure;

test("a cursor session proposal is the heal output when no vendor key is used", async () => {
  const heal = cursorSessionHeal(() => "{\"identity\":{\"surface\":\"dom\",\"role\":\"button\",\"testId\":\"login\",\"path\":[]}}");
  assert.equal(heal.available(), true);
  const proposal = await heal.propose(failure, step);
  assert.ok(proposal);
  assert.equal(proposal.model.provider, "cursor");
  assert.equal(proposal.model.name, "cursor-session");
  assert.equal(proposal.patch?.identity?.testId, "login");
  assert.match(proposal.prompt, /testId/);
  assert.match(proposal.rawResponse, /"login"/);
});

test("a missing cursor session response does not invent a patch", async () => {
  const heal = cursorSessionHeal(() => {
    throw new Error("missing");
  });
  assert.equal(await heal.propose(failure, step), null);
});
