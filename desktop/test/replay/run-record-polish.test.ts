import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentBrowserWorkflow } from "../../src/engines/agent-browser-workflow";
import { AGENT_IDLE_REASON } from "../../src/v1/stop-copy";
const ok = { stdout: "", stderr: "", exitCode: 0 };

test("a refused workflow save names the step that blocked it", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-polish-workflow-"));
  try {
    const blocked = new AgentBrowserWorkflow(root, "run-block", async () => { throw new Error("side panel"); });
    await blocked.record("click", ["@e56"], "command-4", async () => ok, () => false);
    assert.equal(blocked.finish(), "Not saved as a workflow: command-4 (click): its replay target could not be recorded.");

    const scrolled = new AgentBrowserWorkflow(root, "run-scroll", async () => { throw new Error("unused"); });
    await scrolled.record("scroll", ["down", "100"], "command-8", async () => ok, () => false);
    assert.equal(scrolled.finish(), "Not saved as a workflow: command-8 (scroll): it scrolled the page, which Bao cannot replay yet.");

    const closed = new AgentBrowserWorkflow(root, "run-closed", async () => { throw new Error("unused"); });
    closed.unavailable("the owner closed the window before the task finished");
    assert.equal(closed.finish(), "Not saved as a workflow: the owner closed the window before the task finished.");

    const inflight = new AgentBrowserWorkflow(root, "run-inflight", async () => { throw new Error("unused"); });
    await inflight.record("close", [], "command-6", async () => {
      inflight.unavailable("the owner closed the window before the task finished");
      return ok;
    }, () => false);
    assert.equal(inflight.finish(), "Not saved as a workflow: the owner closed the window before the task finished.");

    const failed = new AgentBrowserWorkflow(root, "run-failed", async () => { throw new Error("unused"); });
    assert.equal(failed.finish(true), "Not saved as a workflow: it contained no replayable actions.");
    const named = new AgentBrowserWorkflow(root, "run-named", async () => { throw new Error("unused"); });
    named.unavailable("the owner closed the window before the task finished");
    assert.equal(named.finish(true), "Not saved as a workflow: the owner closed the window before the task finished.");

    const idle = new AgentBrowserWorkflow(root, "run-idle", async () => { throw new Error("unused"); });
    idle.unavailable(AGENT_IDLE_REASON);
    assert.equal(idle.finish(), `Not saved as a workflow: ${AGENT_IDLE_REASON}`);
    const plain = new AgentBrowserWorkflow(root, "run-plain", async () => { throw new Error("unused"); });
    plain.unavailable("the task failed");
    assert.equal(plain.finish(), "Not saved as a workflow: the task failed.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
