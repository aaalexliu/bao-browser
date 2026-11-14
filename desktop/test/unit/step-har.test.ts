import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assignEntries, mergeHar, parseHar, readStepRecord, runHarPath, stepWait, stepWhy, writeRunHar, writeStepRecord, type HarEntry, type HarLog, type StepNetworkRecord } from "../../src/engines/step-har";

test("why keeps one sentence and drops a blank", () => {
  assert.equal(stepWhy("  Open the statement.  "), "Open the statement.");
  assert.equal(stepWhy("a  b\nc"), "a b c");
  assert.equal(stepWhy("x".repeat(600))?.length, 500);
  assert.equal(stepWhy("   "), undefined);
  assert.equal(stepWhy(12), undefined);
  assert.equal(stepWhy(undefined), undefined);
});

test("wait names the command or the owner", () => {
  assert.deepEqual(stepWait("click", 1000, 1250), { for: "click", ms: 250 });
  assert.deepEqual(stepWait("wait_for_owner", 0, 40), { for: "owner", ms: 40 });
  assert.deepEqual(stepWait("open", 5, 1), { for: "open", ms: 0 });
});

test("entries follow the step that had already started", () => {
  const steps = [
    { id: "command-1", startedAt: Date.parse("2026-11-14T00:00:00.000Z") },
    { id: "command-2", startedAt: Date.parse("2026-11-14T00:00:02.000Z") },
  ];
  const entries = [
    { startedDateTime: "2026-11-14T00:00:00.100Z", url: "during-1" },
    { startedDateTime: "2026-11-13T23:59:59.000Z", url: "before" },
    { startedDateTime: "2026-11-14T00:00:03.000Z", url: "during-2" },
    { startedDateTime: "not-a-time", url: "undated" },
  ];
  const assigned = assignEntries(entries, steps);
  assert.deepEqual(assigned.get("command-1")?.map((entry) => entry.url), ["during-1", "before"]);
  assert.deepEqual(assigned.get("command-2")?.map((entry) => entry.url), ["during-2"]);
  assert.equal([...assigned.values()].some((group) => group.some((entry) => entry.url === "undated")), false);
});

test("one HAR is copied as bytes and a second is concatenated", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-step-har-"));
  try {
    const first = Buffer.from(JSON.stringify({ log: { version: "1.2", creator: { name: "agent-browser", version: "0.41.0" }, entries: [{ startedDateTime: "2026-11-14T00:00:00.000Z", url: "a" }] } }));
    await writeRunHar(home, "run-1", [{ raw: first, har: parseHar(first) }]);
    assert.deepEqual(await readFile(runHarPath(home, "run-1")), first);
    const second = parseHar(Buffer.from(JSON.stringify({ log: { version: "1.2", creator: { name: "agent-browser", version: "0.41.0" }, entries: [{ url: "b" }] } })));
    await writeRunHar(home, "run-1", [{ raw: first, har: parseHar(first) }, { raw: Buffer.from("{}"), har: second }]);
    const merged = JSON.parse((await readFile(runHarPath(home, "run-1"))).toString("utf8")) as HarLog;
    assert.equal(merged.log.creator.name, "agent-browser");
    assert.deepEqual(merged.log.entries.map((entry) => entry.url), ["a", "b"]);
    assert.deepEqual(mergeHar([parseHar(first), second]).log.entries.map((entry) => entry.url), ["a", "b"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a failed step keeps its error, why, and wait", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-step-record-"));
  const record: StepNetworkRecord = {
    schema: "bao.step-record/v1",
    id: "command-2",
    command: "click",
    args: ["@e1"],
    why: "Save the form.",
    status: "failed",
    error: "native error",
    startedAt: "2026-11-14T00:00:00.000Z",
    endedAt: "2026-11-14T00:00:01.250Z",
    waits: [{ for: "click", ms: 1250 }],
    network: { entries: [{ request: { method: "POST", url: "http://127.0.0.1/upload" } }] },
  };
  try {
    await writeStepRecord(home, "run-1", record);
    assert.deepEqual(await readStepRecord(home, "run-1", "command-2"), record);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("fifty step records and one HAR stay small", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-step-size-"));
  const body = JSON.stringify({ statement: "x".repeat(800) });
  const entries: HarEntry[] = Array.from({ length: 50 }, (_, index) => ({
    startedDateTime: new Date(Date.parse("2026-11-14T00:00:00.000Z") + index * 1000).toISOString(),
    request: { method: "GET", url: `http://127.0.0.1/api/${index}` },
    response: { status: 200, content: { mimeType: "application/json", text: body } },
  }));
  const raw = Buffer.from(JSON.stringify({ log: { version: "1.2", creator: { name: "agent-browser", version: "0.41.0" }, entries } }));
  const started = performance.now();
  try {
    await writeRunHar(home, "run-50", [{ raw, har: parseHar(raw) }]);
    for (let index = 0; index < 50; index++) {
      await writeStepRecord(home, "run-50", {
        schema: "bao.step-record/v1",
        id: `command-${index + 1}`,
        command: "click",
        args: [`@e${index}`],
        status: "passed",
        startedAt: entries[index]!.startedDateTime!,
        endedAt: entries[index]!.startedDateTime!,
        waits: [{ for: "click", ms: 12 }],
        network: { entries: [entries[index]!] },
      });
    }
    const elapsed = performance.now() - started;
    const harBytes = (await readFile(runHarPath(home, "run-50"))).length;
    const stepBytes = (await readFile(path.join(home, "runs", "run-50", "steps", "command-1.json.gz"))).length;
    console.log(JSON.stringify({ steps: 50, writeMs: Math.round(elapsed), perStepMs: Math.round(elapsed / 50), harBytes, oneStepGzipBytes: stepBytes }));
    assert.equal(harBytes, raw.length);
    assert.ok(stepBytes < raw.length);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
