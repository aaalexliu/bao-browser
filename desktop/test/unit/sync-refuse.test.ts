import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { workflowShotName } from "../../src/v1/shots";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { loadState, syncAll } from "../../src/v1/sync";

const planted = "SuperSecretValue99";

for (const refused of [false, true]) test(`other sync categories continue when a workflow push ${refused ? "is refused" : "strips credentials"}`, async () => {
  const seen: string[] = [];
  let rejectWorkflow = refused;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push(`${req.method} ${req.url} ${Buffer.concat(chunks).toString("utf8")}`);
      if (req.url === "/api/devices") {
        res.end(JSON.stringify({ devices: [], categories: [] }));
        return;
      }
      if (rejectWorkflow && req.url === "/api/workflows/secret-push/versions") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid workflow" }));
        return;
      }
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: 1 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const home = mkdtempSync(path.join(tmpdir(), "bao-secret-push-"));
  const library = new Library(home);
  library.save(secretWorkflow());
  library.save({ ...secretWorkflow(), id: "other-workflow" });
  library.saveRun({ id: "other-run", workflowId: "other-workflow", status: "passed", at: 2, steps: [], heals: [] });
  library.noteHealPromotion("secret-push", { args: { password: planted, email: "ada@fixture.test", file: "/Users/ada/note.txt" } });
  library.saveRun({ id: "owner-run", workflowId: "secret-push", status: "passed", at: 1, steps: [], heals: [] });
  writeFileSync(path.join(home, "sync.json"), JSON.stringify({
    server: `http://127.0.0.1:${port}`,
    deviceToken: "device-token",
    backedUp: true,
    workflows: {},
    pushedRuns: [],
    remoteDevices: [],
    remoteCategories: [],
    conflicts: [],
  }));
  try {
    const view = await syncAll(library, "push");
    assert.match(view.lastResult || "", refused ? /Push refused: invalid workflow/ : /pushed 2/);
    assert.equal(seen.some((line) => line.includes(planted)), false);
    const pushed = seen.find((line) => line.startsWith("POST /api/workflows/secret-push/versions"));
    assert.ok(pushed);
    assert.equal(pushed.includes("ada@fixture.test"), true);
    assert.equal(pushed.includes("/Users/ada/note.txt"), true);
    assert.equal(seen.some((line) => line.startsWith("POST /api/workflows/secret-push/runs")), !refused);
    assert.equal(loadState(home).pushedRuns.includes("owner-run"), !refused);
    assert.equal(loadState(home).pushedRuns.includes("other-run"), true);
    if (refused) {
      rejectWorkflow = false;
      await syncAll(library, "push");
      assert.equal(seen.filter((line) => line.startsWith("POST /api/workflows/secret-push/runs")).length, 1);
      assert.equal(loadState(home).pushedRuns.includes("owner-run"), true);
    }
    assert.equal(seen.some((line) => line.startsWith("POST /api/sync/settings")), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const status of [403, 404, 413]) test(`run HTTP ${status} remains retryable`, async () => {
  let runStatus = status;
  let attempts = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url?.endsWith("/runs")) {
        attempts++;
        res.writeHead(runStatus);
        res.end(JSON.stringify({ error: "not accepted" }));
      } else res.end(JSON.stringify({ version: 1, devices: [], categories: [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const home = mkdtempSync(path.join(tmpdir(), "bao-run-retry-"));
  const library = new Library(home);
  library.save(secretWorkflow());
  library.saveRun({ id: "retry-run", workflowId: "secret-push", status: "passed", at: 1, steps: [], heals: [] });
  writeFileSync(path.join(home, "sync.json"), JSON.stringify({ server: `http://127.0.0.1:${address.port}`, deviceToken: "fixture", backedUp: true }));
  try {
    await syncAll(library, "push");
    assert.equal(loadState(home).pushedRuns.includes("retry-run"), false);
    runStatus = 201;
    await syncAll(library, "push");
    assert.equal(attempts, 2);
    assert.equal(loadState(home).pushedRuns.includes("retry-run"), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a long workflow sync bounds picture bodies and reports omitted pictures", async () => {
  const bodies: { bytes: number; shots: { png: string }[] }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url?.endsWith("/versions") || req.url?.endsWith("/runs")) {
        const bytes = Buffer.concat(chunks);
        bodies.push({ bytes: bytes.length, shots: (JSON.parse(bytes.toString()) as { shots: { png: string }[] }).shots });
      }
      res.end(JSON.stringify({ version: 1, devices: [], categories: [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const home = mkdtempSync(path.join(tmpdir(), "bao-many-picture-sync-"));
  const library = new Library(home);
  const doc = secretWorkflow();
  doc.steps = Array.from({ length: 40 }, (_, i) => ({ ...doc.steps[0]!, id: `step-${i}`, index: i }));
  library.save(doc);
  const picture = await sharp(randomBytes(720 * 480 * 3), { raw: { width: 720, height: 480, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
  const dir = path.join(home, "shots", "workflows", doc.id);
  mkdirSync(dir, { recursive: true });
  for (const step of doc.steps) writeFileSync(path.join(dir, workflowShotName(step.id)), picture);
  writeFileSync(path.join(home, "sync.json"), JSON.stringify({ server: `http://127.0.0.1:${address.port}`, deviceToken: "fixture", backedUp: true }));
  try {
    const result = await syncAll(library, "push");
    assert.equal(bodies.length, 1);
    assert.ok(bodies[0]!.bytes < 4_000_000);
    assert.ok(bodies[0]!.shots.length > 0 && bodies[0]!.shots.length < 40);
    assert.match(result.lastResult || "", /\d+ pictures omitted for transport limits/);
    for (const shot of bodies[0]!.shots) {
      const meta = await sharp(Buffer.from(shot.png, "base64")).metadata();
      assert.equal(meta.format, "jpeg");
      assert.ok(meta.width! <= 720 && meta.height! <= 480);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function secretWorkflow(): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id: "secret-push",
    name: "Secret push",
    startUrl: "http://127.0.0.1/fixture.html",
    inputs: [{ name: "password", type: "secret", label: "Password", required: true }],
    createdAt: 1,
    steps: [{
      id: "pass",
      index: 0,
      action: "type",
      label: "Type the password",
      surface: "dom",
      timeoutMs: 4000,
      input: "password",
      value: "{{password}}",
      sensitive: true,
      identity: { surface: "dom", role: "password", path: [] },
    }],
  };
}
