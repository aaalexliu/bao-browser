import assert from "node:assert/strict";
import test from "node:test";
import { videoBar, type RunSummary } from "../../src/app/views";
import type { StepView } from "../../src/app/view-types";
import { shouldRecordOwnedWindow } from "../../src/v1/replay-video";

test("a headed mac replay records the window, and a headless run does not", () => {
  assert.equal(shouldRecordOwnedWindow("darwin", true), true);
  assert.equal(shouldRecordOwnedWindow("darwin", false), false);
  assert.equal(shouldRecordOwnedWindow("linux", true), false);
});

test("the run page links the replay webm", () => {
  const step: StepView = { id: "s", status: "passed", startedAt: 10, endedAt: 20, label: "Drop file" };
  const run: RunSummary = { id: "run-1", workflowId: "wf", status: "passed", video: "run-1.webm", videoStartedAt: 10 };
  const html = videoBar(run, [step]);
  assert.match(html, /src="\/api\/runs\/run-1\/video"/);
  const hidden = videoBar({ ...run, video: undefined }, [step]);
  assert.match(hidden, /hidden/);
});
