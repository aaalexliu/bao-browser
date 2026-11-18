import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { activePolling, createStatePoller } from "../../src/app/state-poll";

async function advance(t: TestContext, ms: number): Promise<void> {
  t.mock.timers.tick(ms);
  await setImmediate();
}

test("a failed guide returns to idle polling even if its last progress still says highlight", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = {
    replaying: true,
    guide: { workflowId: "wf", runId: "guide", status: "highlight" as const, actions: 0, index: 0, total: 1, stepId: "step", intent: "Type" },
  };
  let calls = 0;
  const poller = createStatePoller({
    poll: async () => { calls += 1; },
    active: () => activePolling(state),
    visible: () => true,
  });
  let failGuide: (error: Error) => void = () => {};
  const guide = poller.track(new Promise<void>((_resolve, reject) => { failGuide = reject; }));
  const failed = assert.rejects(guide, /page closed/);
  await setImmediate();
  assert.equal(calls, 1);
  await advance(t, 100);
  assert.equal(calls, 2);

  state.replaying = false;
  failGuide(new Error("page closed"));
  await failed;
  await setImmediate();
  assert.equal(calls, 3);
  assert.equal(state.guide.status, "highlight");
  for (let second = 0; second < 3; second++) {
    await advance(t, 999);
    assert.equal(calls, 3 + second);
    await advance(t, 1);
    assert.equal(calls, 4 + second);
  }
});
