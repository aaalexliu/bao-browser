import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { videoBar, type RunSummary } from "../../src/app/views";
import type { StepView } from "../../src/app/view-types";
import { openOsReplayVideo, openReplayVideo, shouldRecordOwnedWindow } from "../../src/v1/replay-video";

test("native window recording requires an explicit opt-in even for headed Mac replays", () => {
  assert.equal(shouldRecordOwnedWindow("darwin", true), false);
  assert.equal(shouldRecordOwnedWindow("darwin", true, true), true);
  assert.equal(shouldRecordOwnedWindow("darwin", false, true), false);
  assert.equal(shouldRecordOwnedWindow("linux", true, true), false);
});

test("default replay video paths never launch a Screen Recording probe", async (t) => {
  const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("must not launch window recorder"); });
  const previous = process.env.BAO_REPLAY_VIDEO;
  const headed = process.env.BAO_HEADED;
  const previousApp = process.env.BAO_WINDOW_VIDEO;
  const app = await mkdtemp(path.join(tmpdir(), "bao-optional-video-"));
  await mkdir(path.join(app, "Contents", "MacOS"), { recursive: true });
  await writeFile(path.join(app, "Contents", "MacOS", "bao-window-video"), "unused test recorder");
  process.env.BAO_WINDOW_VIDEO = app;
  try {
    delete process.env.BAO_REPLAY_VIDEO;
    process.env.BAO_HEADED = "1";
    for (const video of [await openReplayVideo([42], "/unused.webm"), await openOsReplayVideo(42, "/unused.webm")]) {
      assert.deepEqual(await video.stop(), { wrote: false, frames: 0 });
    }
    assert.equal(spawn.mock.callCount(), 0);
  } finally {
    if (previous === undefined) delete process.env.BAO_REPLAY_VIDEO;
    else process.env.BAO_REPLAY_VIDEO = previous;
    if (headed === undefined) delete process.env.BAO_HEADED;
    else process.env.BAO_HEADED = headed;
    if (previousApp === undefined) delete process.env.BAO_WINDOW_VIDEO;
    else process.env.BAO_WINDOW_VIDEO = previousApp;
    await rm(app, { recursive: true, force: true });
  }
});

test("the run page links the replay webm", () => {
  const step: StepView = { id: "s", status: "passed", startedAt: 10, endedAt: 20, label: "Drop file" };
  const run: RunSummary = { id: "run-1", workflowId: "wf", status: "passed", video: "run-1.webm", videoStartedAt: 10 };
  const html = videoBar(run, [step]);
  assert.match(html, /src="\/api\/runs\/run-1\/video"/);
  const hidden = videoBar({ ...run, video: undefined }, [step]);
  assert.match(hidden, /hidden/);
});
