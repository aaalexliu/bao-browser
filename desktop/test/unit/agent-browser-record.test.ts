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
    assert.deepEqual(library.list(), []);
    recorder.finish();
    assert.deepEqual(library.readRun(initial.id), saved, "finalization is idempotent");
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
