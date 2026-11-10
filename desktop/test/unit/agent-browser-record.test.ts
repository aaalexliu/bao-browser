import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentBrowserRun, type RecordedAgentBrowserCommand } from "../../src/engines/agent-browser-record";
import { Library } from "../../src/v1/store";
import { runViewer, type RunSummary } from "../../src/app/views";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=", "base64");

test("recorder keeps exact native values and requested image bytes without workflow redaction", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-native-record-"));
  try {
    const library = new Library(root);
    const recorder = new AgentBrowserRun(root);
    const initial = library.listRuns()[0]!;
    assert.equal(initial.status, "recording");
    const args = ["#password", "ghp_synthetic_secret", "123-45-6789", "spaces\n'quotes'"];
    const pending = recorder.begin("fill", args);
    assert.equal((library.readRun(initial.id).steps as RecordedAgentBrowserCommand[])[0]!.status, "pending");
    const result = { stdout: "raw stdout\n\n", stderr: "raw stderr\n", exitCode: 1 };
    await recorder.complete(pending, [result], root, async () => png);
    await writeFile(path.join(root, "relative.png"), png);
    const screenshot = recorder.begin("screenshot", ["relative.png"]);
    await recorder.complete(screenshot, [{ stdout: "✓ Screenshot saved to relative.png\n", stderr: "", exitCode: 0 }], root, async () => png);
    const implicit = recorder.begin("screenshot", ["--json"]);
    await recorder.complete(implicit, [{ stdout: JSON.stringify({ data: { path: path.join(root, "relative.png") } }), stderr: "", exitCode: 0 }], root, async () => png);
    recorder.finish();
    const saved = library.readRun(initial.id);
    const steps = saved.steps as RecordedAgentBrowserCommand[];
    assert.equal(saved.status, "failed");
    assert.deepEqual(steps[0]!.native.args, args);
    assert.deepEqual(steps[0]!.native.results, [result]);
    assert.equal(steps[0]!.native.isError, true);
    for (const step of steps.slice(1)) {
      const artifact = step.native.screenshots[0]!;
      assert.deepEqual(await readFile(path.join(root, "shots", "runs", initial.id, artifact.file)), png);
    }
    assert.deepEqual(library.list().workflows, []);
    recorder.finish();
    assert.deepEqual(library.readRun(initial.id), saved, "finalization is idempotent");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const status of ["passed", "failed", "paused"] as const) test(`outcome-less ${status} runs accept exactly one task outcome`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-outcome-record-"));
  try {
    const library = new Library(root);
    const recorder = new AgentBrowserRun(root);
    const step = recorder.begin("snapshot", []);
    if (status !== "paused") await recorder.complete(step, [{ stdout: "native result", stderr: "", exitCode: status === "failed" ? 1 : 0 }], root, async () => png);
    recorder.finish();
    assert.equal(library.readRun(recorder.id).status, status);
    assert.equal(library.readRun(recorder.id).envelope, undefined);
    recorder.finish({ outcome: "failed", reason: "Checked task failed" });
    const saved = library.readRun(recorder.id);
    assert.equal(saved.status, "failed");
    assert.equal(saved.envelope?.reason, "Checked task failed");
    recorder.finish({ outcome: "passed", reason: "Later claim" });
    recorder.finish();
    assert.deepEqual(library.readRun(recorder.id), saved);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const waiting of [true, false]) test(`closed owner wait finalizes a ${waiting ? "needs-human" : "recording"} run`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-owner-record-"));
  try {
    const library = new Library(root);
    const recorder = new AgentBrowserRun(root);
    const id = library.listRuns()[0]!.id;
    if (waiting) recorder.ownerWaiting(true);
    assert.equal(library.readRun(id).status, waiting ? "needs_human" : "recording");
    recorder.finish(waiting ? undefined : "session_closed");
    const ended = library.readRun(id);
    assert.equal(ended.status, "failed");
    assert.equal(ended.envelope?.status, "failed");
    assert.equal(ended.envelope?.reason, "session_closed");
    assert.doesNotMatch(ended.envelope?.ask ?? "", /will continue here|is waiting/);
    recorder.finish();
    recorder.finish({ outcome: "passed", reason: "Later claim" });
    assert.deepEqual(library.readRun(id), ended);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a session that ends between owner waits marks only the last wait of that wait", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-wait-between-"));
  try {
    const library = new Library(root);
    const recorder = new AgentBrowserRun(root);
    const noPage = async () => { throw new Error("no page"); };
    const ready = recorder.begin("wait_for_owner", ["60000"]);
    recorder.ownerWaiting(true);
    await recorder.complete(ready, [{ stdout: JSON.stringify({ outcome: "ready" }), stderr: "", exitCode: 0 }], root, noPage, undefined, true);
    recorder.ownerWaiting(false);
    const wall = recorder.begin("snapshot", []);
    recorder.ownerWaiting(true);
    await recorder.complete(wall, [{ stdout: "", stderr: "", exitCode: 0 }], root, noPage);
    recorder.finish("session_closed");
    const kept = (library.readRun(recorder.id).steps as RecordedAgentBrowserCommand[]).find((step) => step.id === ready.id);
    assert.equal(kept?.status, "passed", "a wait that already finished stays passed");

    const between = new AgentBrowserRun(root);
    const first = between.begin("wait_for_owner", ["60000"]);
    between.ownerWaiting(true);
    await between.complete(first, [{ stdout: JSON.stringify({ outcome: "waiting" }), stderr: "", exitCode: 0 }], root, noPage, undefined, true);
    const last = between.begin("wait_for_owner", ["60000"]);
    await between.complete(last, [{ stdout: JSON.stringify({ outcome: "waiting" }), stderr: "", exitCode: 0 }], root, noPage, undefined, true);
    between.finish();
    const ended = library.readRun(between.id);
    const endedSteps = ended.steps as RecordedAgentBrowserCommand[];
    assert.equal(ended.envelope?.reason, "session_closed");
    assert.equal(endedSteps.find((step) => step.id === first.id)?.status, "passed");
    const cut = endedSteps.find((step) => step.id === last.id);
    assert.equal(cut?.status, "failed");
    assert.equal(cut?.reason, "The session ended before you finished.");

    const givenUp = new AgentBrowserRun(root);
    const waited = givenUp.begin("wait_for_owner", ["60000"]);
    givenUp.ownerWaiting(true);
    await givenUp.complete(waited, [{ stdout: JSON.stringify({ outcome: "waiting" }), stderr: "", exitCode: 0 }], root, noPage, undefined, true);
    givenUp.finish({ outcome: "failed", reason: "Gave up." });
    const closed = library.readRun(givenUp.id);
    const closedStep = (closed.steps as RecordedAgentBrowserCommand[]).find((step) => step.id === waited.id);
    assert.equal(closed.envelope?.reason, "session_closed");
    assert.equal(closedStep?.status, "failed");
    assert.equal(closedStep?.reason, "The session ended before you finished.");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failed atomic run replacement keeps the last readable partial run", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-run-atomic-"));
  try {
    const library = new Library(root);
    const recorder = new AgentBrowserRun(root);
    const saved = library.listRuns()[0]!;
    const warnings: string[] = [];
    t.mock.method(process.stderr, "write", (text: string) => { warnings.push(text); return true; });
    t.mock.method(fs, "renameSync", () => { throw new Error("replacement denied"); });
    const step = recorder.begin("snapshot", []);
    await recorder.complete(step, [{ stdout: "snapshot output\n", stderr: "", exitCode: 0 }], root, async () => { throw new Error("page unavailable"); });
    recorder.finish();
    assert.deepEqual(library.readRun(saved.id), saved);
    assert.deepEqual(await readdir(path.join(root, "runs")), [`${saved.id}.json`]);
    assert.ok(warnings.some((text) => text.includes("run write")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("agent-browser recording failure summary shows the command and error once without repair wording", () => {
  const run: RunSummary = {
    id: "run-startup", workflowId: "agent-browser", kind: "capture", pageEngine: "agent-browser", status: "failed",
    steps: [{ id: "command-1", label: 'open "Fixture"', status: "failed", reason: "Chrome <launch> failed" }],
  };
  const workflow = { name: "agent-browser", recordedOnly: true, steps: run.steps! };
  const html = runViewer(run, workflow);
  const summary = /<div class="why" id="why-stopped">(.*?)<\/div>/.exec(html)![1]!;
  assert.match(summary, /<p>Step 1 open &quot;Fixture&quot; failed: Chrome &lt;launch&gt; failed<\/p>/);
  assert.equal(summary.split("Chrome &lt;launch&gt; failed").length - 1, 1);
  assert.doesNotMatch(summary, /plain-failure|repair|Phase the step|heal/);
  assert.match(summary, /Open this step/);
  for (const legacy of [
    runViewer({ ...run, pageEngine: "old" }, workflow),
    runViewer(run, { ...workflow, recordedOnly: false }),
  ]) {
    assert.match(legacy, /id="plain-failure"/);
    assert.match(legacy, /Bao did not try a cheap repair/);
  }
});

test("recording-only run viewer uses saved steps and pictures without workflow-only actions", () => {
  const run: RunSummary = {
    id: "run-native", workflowId: "agent-browser", kind: "capture", status: "failed", heals: [],
    steps: [
      { id: "command-1", label: "click #missing", status: "failed", afterShot: "command-1-after.png" },
      { id: "command-2", label: "snapshot", status: "passed", afterShot: "command-2-after.png" },
    ],
  };
  const html = runViewer(run, { name: "agent-browser", recordedOnly: true, steps: run.steps! }, "command-2");
  assert.match(html, /command-2-after\.png/);
  assert.match(html, /snapshot/);
  assert.doesNotMatch(html, /id="rerun-run"|id="debug-step"|id="teach-fix"|Nothing after|No steps ran|model calls/);
});
