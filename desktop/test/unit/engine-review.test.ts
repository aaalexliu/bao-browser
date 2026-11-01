import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runKind, runsList, runViewer, videoBar } from "../../src/app/views";
import { Library } from "../../src/v1/store";
import { saveState, syncAll, syncStatus } from "../../src/v1/sync";
import { circuitOpen, consecutiveHeals } from "../../src/v1/triage";

const recording = { id: "recording", kind: "capture" as const, workflowId: "wf", status: "passed", at: 100, heals: [], steps: [] };

test("capture records stay local while replays upload", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-recording-sync-"));
  const library = new Library(home);
  const posts: unknown[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url?.endsWith("/runs")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      posts.push(JSON.parse(body));
    }
    if (req.url === "/api/sync/snapshot") res.end(JSON.stringify({ counts: {}, runs: [], heals: [] }));
    else if (req.url === "/api/workflows") res.end(JSON.stringify({ workflows: [] }));
    else res.end(JSON.stringify({ ok: true, devices: [], categories: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    saveState(home, { server: `http://127.0.0.1:${address.port}`, deviceToken: "fixture", deviceId: "fixture", backedUp: true,
      workflows: {}, pushedRuns: [], remoteDevices: [], remoteCategories: [], conflicts: [], categoryEnabled: { settings: false } });
    library.saveRun(recording);
    await syncAll(library);
    assert.deepEqual(posts, []);
    assert.equal(syncStatus(library).buckets.find((bucket) => bucket.category === "run history")?.local, 0);
    library.saveRun({ ...recording, id: "replay", kind: "replay" });
    await syncAll(library);
    assert.deepEqual(posts.map((body) => (body as { id: string }).id), ["replay"]);
    assert.equal(library.readRun("recording").kind, "capture");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});

test("recordings do not trip replay circuits or clear heal streaks", () => {
  assert.equal(circuitOpen([{ ...recording, status: "failed" }], 100, { limit: 1 }), false);
  assert.equal(consecutiveHeals([
    recording,
    { workflowId: "wf", at: 50, heals: [{ failedStep: { id: "s0" } }] },
  ], "s0"), 1);
});

test("Library labels captures as recordings and keeps untimed truncated video visible", () => {
  assert.equal(runKind(recording), "recording");
  assert.match(runsList([recording], []), />recording<\/span>/);
  assert.match(runViewer(recording, { name: "Recorded task", steps: [] }), /Recorded task recorded/);
  const html = videoBar({ ...recording, video: "recording.webm", videoStartedAt: 100, videoTruncated: true }, []);
  assert.match(html, /<video id="run-video"/);
  assert.match(html, /Video truncated at the capture limit/);
});
