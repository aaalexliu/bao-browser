import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runViewer } from "../../src/app/views";
import { uncapturablePage } from "../../src/engines/agent-browser-proxy";
import { AgentBrowserRun, type RecordedAgentBrowserCommand } from "../../src/engines/agent-browser-record";
import { AgentBrowserWorkflow } from "../../src/engines/agent-browser-workflow";
import { getRun } from "../../src/mcp/catalog";
import { browserToolResult, pageShotLine } from "../../src/mcp/tool-card";
import { Library, type StoredRun } from "../../src/v1/store";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6S8AAAAASUVORK5CYII=", "base64");
const ok = { stdout: "", stderr: "", exitCode: 0 };

function command(id: string, status: "passed" | "failed", extra: Partial<RecordedAgentBrowserCommand> = {}): RecordedAgentBrowserCommand {
  return {
    id, label: id, caption: { text: id }, status, startedAt: 1, endedAt: 2,
    native: { command: "click", args: ["@e1"], results: [{ stdout: "", stderr: "", exitCode: status === "failed" ? 1 : 0 }], isError: status === "failed", screenshots: [] },
    ...extra,
  };
}

function capture(id: string, status: StoredRun["status"], steps: RecordedAgentBrowserCommand[], extra: Partial<StoredRun> = {}): StoredRun {
  return { schema: "bao.run/v4", id, kind: "capture", workflowId: "agent-browser", status, at: 1, heals: [], steps, ...extra };
}

test("get_run on a passed capture points at the last step, not an earlier failure", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-polish-run-"));
  try {
    const library = new Library(root);
    const steps = [command("command-4", "failed", { reason: "Saved click missed" }), command("command-7", "passed")];
    library.saveRun(capture("run-passed", "passed", steps));
    const passed = getRun(library, "run-passed");
    assert.equal(passed.outcome, "ok");
    assert.equal(passed.step, "command-7");
    assert.equal(passed.stops.length, 0);

    library.saveRun(capture("run-envelope", "passed", steps, { envelope: { status: "passed", step: "human", reason: "Envelope reason" } }));
    assert.equal(getRun(library, "run-envelope").step, "human");

    library.saveRun(capture("run-pointed", "passed", steps, { failure: { stepId: "human", index: 0, phase: "action", reason: "Saved stop reason" } }));
    assert.equal(getRun(library, "run-pointed").step, "human");

    library.saveRun(capture("run-failed", "failed", steps));
    assert.equal(getRun(library, "run-failed").step, "command-4");

    library.saveRun(capture("run-open", "recording", steps));
    assert.equal(getRun(library, "run-open").step, undefined);

    library.saveRun(capture("run-empty", "passed", []));
    assert.equal(getRun(library, "run-empty").step, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("get_run receipts show a kept page picture, a fallback note, and a missing picture", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-polish-receipt-"));
  try {
    const library = new Library(root);
    library.saveRun(capture("run-shots", "passed", [
      command("command-1", "passed", { afterShot: "command-1-after.jpg" }),
      command("command-2", "passed", { afterShot: "command-2-after.jpg", shotNote: "The active tab could not be pictured, so Bao kept a picture of its task tab." }),
      command("command-3", "passed", { afterShotError: "Page screenshot unavailable: cdp timeout Page.captureScreenshot." }),
    ]));
    const receipts = getRun(library, "run-shots").receipts;
    assert.equal(receipts[0]?.afterShot, "command-1-after.jpg");
    assert.equal(receipts[0]?.afterShotError, undefined);
    assert.equal(receipts[0]?.shotNote, undefined);
    assert.equal(receipts[1]?.shotNote, "The active tab could not be pictured, so Bao kept a picture of its task tab.");
    assert.equal(receipts[2]?.afterShotError, "Page screenshot unavailable: cdp timeout Page.captureScreenshot.");
    assert.equal(receipts[2]?.afterShot, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a passed capture viewer points at the last step and does not headline an earlier failure", () => {
  const steps = [
    { id: "command-4", label: "click", caption: { text: "click" }, status: "failed" as const, reason: "Native command failed." },
    { id: "command-7", label: "snapshot", caption: { text: "snapshot" }, status: "passed" as const },
  ];
  const workflow = { name: "Pizza", recordedOnly: true, steps };
  const passed = runViewer({
    id: "run-passed", workflowId: "agent-browser", pageEngine: "agent-browser", kind: "capture", status: "passed", steps,
  }, workflow);
  assert.match(passed, /class="step passed on" data-select-step="command-7"/);
  assert.match(passed, /id="why-stopped"><p>Pizza recorded<\/p>/);
  assert.doesNotMatch(passed, /id="open-failed-step"|Step 1 click failed/);

  const recording = runViewer({
    id: "run-open", workflowId: "agent-browser", pageEngine: "agent-browser", kind: "capture", status: "recording", steps,
  }, workflow);
  assert.match(recording, /class="step failed on" data-select-step="command-4"/);
  assert.match(recording, /Step 1 click failed: Native command failed\./);
});

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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing page picture names the cause in the tool result", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-polish-shot-"));
  try {
    const recording = new AgentBrowserRun(home);
    const missed = recording.begin("click", ["@e56"]);
    await recording.complete(missed, [{ stdout: "Clicked\n", stderr: "", exitCode: 0 }], home, async () => {
      throw new Error("cdp timeout Page.captureScreenshot");
    });
    const missedReply = browserToolResult("click", missed.native.results, { runId: recording.id, step: missed });
    assert.equal(pageShotLine(missed), "Page screenshot unavailable: cdp timeout Page.captureScreenshot.");
    assert.ok(missedReply.content.some((item) => item.text === pageShotLine(missed)));

    const kept = recording.begin("snapshot", []);
    await recording.complete(kept, [{ stdout: "Read\n", stderr: "", exitCode: 0 }], home, async () => ({
      bytes: png, note: "The active tab could not be pictured, so Bao kept a picture of its task tab.",
    }));
    assert.equal(kept.afterShotError, undefined);
    assert.ok(kept.afterShot);
    assert.equal(pageShotLine(kept), kept.shotNote);
    const keptReply = browserToolResult("snapshot", kept.native.results, { runId: recording.id, step: kept });
    assert.ok(keptReply.content.some((item) => item.text === kept.shotNote));

    assert.equal(pageShotLine({ ...missed, native: { ...missed.native, command: "close" } }), undefined);
    assert.equal(pageShotLine({ ...missed, native: { ...missed.native, command: "wait_for_owner" } }), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a side panel or non-page target is not a capturable page", () => {
  assert.equal(uncapturablePage("https://gemini.google.com/glic?hl=en-US", "page"), true);
  assert.equal(uncapturablePage("https://gemini.google.com/glic/panel", "page"), true);
  assert.equal(uncapturablePage("https://www.google.com/maps/search/pizza", "page"), false);
  assert.equal(uncapturablePage("chrome://newtab/", "page"), true);
  assert.equal(uncapturablePage("about:blank", undefined), true);
  assert.equal(uncapturablePage("https://fixture.invalid/", "webview"), true);
  assert.equal(uncapturablePage(undefined, undefined), false);
});
