import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { syncPanel } from "../../src/app/logins-view";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { loadState, saveState, syncAll, syncStatus } from "../../src/v1/sync";

const AT = "2026-10-22T04:50:16.442Z";

function workflow(id: string, name: string): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id,
    name,
    startUrl: "https://example.com/fixture",
    createdAt: 1,
    inputs: [],
    steps: [{
      id: "s0",
      index: 0,
      action: "click",
      label: "Open",
      surface: "dom",
      identity: { surface: "dom", role: "button", path: [], testId: "go" },
      timeoutMs: 1000,
    }],
  };
}

function listen(handler: (req: { method?: string; url?: string }, res: { writeHead: (code: number, headers: Record<string, string>) => void; end: (body?: string) => void }) => void): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => handler(req, res));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("port");
      resolve({ server, port: address.port });
    });
  });
}

test("the sync panel shows a toggle and the catch-up count for each category", () => {
  const html = zoned(
    require.resolve("../../src/app/logins-view"),
    `syncPanel({paired:true,catchingUp:true,backupSchedule:"weekly",lastBackupAt:${JSON.stringify(AT)},scheduledBackupPath:"/tmp/bao/backups/scheduled-1",buckets:[{category:"workflows",enabled:true,local:1,cloud:4},{category:"run history",enabled:true,local:0,cloud:3},{category:"heal records",enabled:false,local:0,cloud:2},{category:"settings",enabled:true,local:0,cloud:1}]})`,
    "America/New_York",
  );
  assert.match(html, /data-testid="sync-categories"/);
  assert.match(html, /data-sync-category="workflows" checked/);
  assert.match(html, /data-sync-category="run history" checked/);
  assert.match(html, /data-sync-category="heal records"/);
  assert.equal(html.includes('data-sync-category="heal records" checked'), false);
  assert.match(html, /data-sync-category="settings" checked/);
  assert.match(html, /1 on this device of 4 in the cloud/);
  assert.match(html, /0 on this device of 3 in the cloud/);
  assert.match(html, /0 on this device of 2 in the cloud/);
  assert.match(html, /0 on this device of 1 in the cloud/);
  assert.match(html, /Back up weekly/);
  assert.match(html, /Backup from Oct 22, 12:50 AM EDT/);
  assert.match(html, /Reveal in Finder/);
  assert.match(html, /data-testid="reveal-backup"/);
  assert.match(html, /title="\/tmp\/bao\/backups\/scheduled-1"/);
  assert.equal(html.includes("Restore from"), false);
  assert.equal(html.includes(">Backup:"), false);
  assert.match(syncPanel({ paired: true, catchingUp: false }), /data-testid="sync-categories"/);
  assert.equal(syncPanel({ paired: true, catchingUp: false }).includes("in the cloud"), false);
});

test("an offline home catches up on reconnect, and a disabled category stays put", async () => {
  const docs = [workflow("one", "One"), workflow("two", "Two")];
  let failPulls = 1;
  const { server, port } = await listen((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && url.pathname === "/api/sync/snapshot") {
      send(200, {
        counts: { workflows: 2, "run history": 1, "heal records": 1, settings: 1 },
        runs: [{ id: "run-1", workflowId: "one", status: "passed", at: AT, steps: [{ id: "s0", status: "passed" }] }],
        heals: [{ id: "heal-one-v1", workflowId: "one", heal: { id: "h1", note: "kept" } }],
        settings: { heal: "approve" },
        settingsUpdatedAt: AT,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/workflows") {
      if (failPulls > 0) {
        failPulls -= 1;
        send(503, { error: "offline" });
        return;
      }
      send(200, { workflows: docs.map((doc) => ({ id: doc.id })) });
      return;
    }
    const workflowId = decodeURIComponent(url.pathname.split("/")[3] || "");
    if (req.method === "GET" && url.pathname.startsWith("/api/workflows/")) {
      const doc = docs.find((item) => item.id === workflowId);
      send(doc ? 200 : 404, doc ? { version: 1, document: doc, shots: [] } : { error: "missing" });
      return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/versions")) {
      send(201, { version: 1 });
      return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/runs")) {
      send(201, { id: "run-1" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/sync/settings") {
      send(200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/devices") {
      send(200, { devices: [{ id: "dev", name: "Offline Mac", created_at: AT, last_seen_at: AT }], categories: [] });
      return;
    }
    send(404, { error: "not found" });
  });
  try {
    const home = mkdtempSync(path.join(tmpdir(), "bao-catchup-"));
    const library = new Library(home);
    saveState(home, {
      server: `http://127.0.0.1:${port}`,
      deviceToken: "device-token",
      deviceId: "dev",
      deviceName: "Offline Mac",
      backedUp: false,
      workflows: {},
      pushedRuns: [],
      remoteDevices: [],
      remoteCategories: [],
      conflicts: [],
    });
    await assert.rejects(() => syncAll(library), /offline/);
    const offline = syncStatus(library);
    assert.equal(offline.catchingUp, true);
    assert.match(offline.lastResult || "", /reconnect/);
    assert.equal(offline.buckets.find((bucket) => bucket.category === "workflows")?.local, 0);
    assert.equal(offline.buckets.find((bucket) => bucket.category === "workflows")?.cloud, 2);
    assert.equal(library.list().length, 0);

    await syncAll(library);
    const caught = syncStatus(library);
    assert.equal(caught.catchingUp, false);
    assert.equal(library.list().length, 2);
    assert.equal(library.listRuns().length, 1);
    assert.equal(existsSync(path.join(home, "heals", "heal-one-v1.json")), true);
    assert.equal(library.settings().heal, "approve");
    for (const bucket of caught.buckets) assert.equal(bucket.local, bucket.cloud, bucket.category);

    const skipped = mkdtempSync(path.join(tmpdir(), "bao-catchup-skip-"));
    const other = new Library(skipped);
    saveState(skipped, {
      ...loadState(home),
      server: `http://127.0.0.1:${port}`,
      backedUp: false,
      workflows: {},
      pushedRuns: [],
      categoryEnabled: { "run history": false },
      cloudCounts: {},
      catchingUp: false,
      settingsCloudAt: undefined,
    });
    await syncAll(other);
    assert.equal(other.list().length, 2);
    assert.equal(other.listRuns().length, 0);
    assert.equal(syncStatus(other).buckets.find((bucket) => bucket.category === "run history")?.enabled, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

function zoned(compiled: string, call: string, tz: string): string {
  const result = spawnSync(process.execPath, ["-e", `process.stdout.write(String(require(${JSON.stringify(compiled)}).${call}))`], {
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
