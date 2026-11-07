import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { workflowShotName } from "../../src/v1/shots";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkflowV2 } from "../../src/v1/schema";
import type { WorkflowVersion } from "../../src/v1/versions";
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
      if (rejectWorkflow && req.url === "/api/workflows/secret-push/runs") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
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
    assert.equal(pushed.includes("ada@fixture.test"), false);
    assert.equal(pushed.includes("/Users/ada/note.txt"), false);
    assert.equal(seen.some((line) => line.startsWith("POST /api/workflows/secret-push/runs")), true);
    assert.equal(loadState(home).pushedRuns.includes("owner-run"), !refused);
    assert.equal(loadState(home).pushedRuns.includes("other-run"), true);
    if (refused) {
      rejectWorkflow = false;
      await syncAll(library, "push");
      assert.equal(seen.filter((line) => line.startsWith("POST /api/workflows/secret-push/runs")).length, 2);
      assert.equal(loadState(home).pushedRuns.includes("owner-run"), true);
    }
    assert.equal(seen.some((line) => line.startsWith("POST /api/sync/settings")), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const status of [403, 404, 413]) test(`untracked run HTTP ${status} remains retryable with workflow sync off`, async () => {
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
  writeFileSync(path.join(home, "sync.json"), JSON.stringify({ server: `http://127.0.0.1:${address.port}`, deviceToken: "fixture", backedUp: true, categoryEnabled: { workflows: false } }));
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
  const bodies: { bytes: number; shots: { stepId: string; png: string }[] }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url?.endsWith("/versions") || req.url?.endsWith("/runs")) {
        const bytes = Buffer.concat(chunks);
        bodies.push({ bytes: bytes.length, shots: (JSON.parse(bytes.toString()) as { shots: { stepId: string; png: string }[] }).shots });
      }
      res.end(JSON.stringify({ version: 1, devices: [], categories: [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const home = mkdtempSync(path.join(tmpdir(), "bao-many-picture-sync-"));
  const library = new Library(home);
  const doc = secretWorkflow();
  doc.inputs = [{ name: "credential", type: "secret", label: "Credential", required: true }];
  doc.steps = Array.from({ length: 40 }, (_, i) => ({ id: `step-${i}`, index: i, action: "key", key: "Enter", label: "Continue", surface: "dom", timeoutMs: 1000 }));
  doc.steps.push(
    { id: "private-sensitive", index: 40, action: "type", value: "{{credential}}", sensitive: true, label: "Private", surface: "dom", timeoutMs: 1000 },
    { id: "private-input", index: 41, action: "type", input: "credential", value: "{{credential}}", label: "Credential", surface: "dom", timeoutMs: 1000 },
  );
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
    assert.equal(bodies[0]!.shots.some((shot) => shot.stepId.startsWith("private-")), false);
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

for (const mode of ["pull", "push"] as const) test(`${mode} keeps a dirty local edit when a direct push adds a secret default`, async () => {
  let version = 0;
  let document = secretWorkflow();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const current = { version, document, shots: [], deviceName: "Remote Mac" };
      if (req.url === "/api/workflows/secret-push/versions" && req.method === "POST") {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { baseVersion: number; document: WorkflowV2 };
        if (body.baseVersion !== version) {
          res.writeHead(409);
          res.end(JSON.stringify({ error: "conflict", current, draft: { version: version + 1 } }));
          return;
        }
        document = body.document;
        version++;
        res.writeHead(201);
        res.end(JSON.stringify({ version }));
      } else if (req.url === "/api/workflows/secret-push/versions") {
        res.end(JSON.stringify({ versions: [{ version, document, device_name: "Remote Mac", created_at: "2026-01-01T00:00:00Z" }] }));
      } else if (req.url === "/api/workflows/secret-push") res.end(JSON.stringify(current));
      else if (req.url === "/api/workflows") res.end(JSON.stringify({ workflows: [{ id: "secret-push" }] }));
      else if (req.url === "/api/sync/snapshot") {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "not found" }));
      } else res.end(JSON.stringify({ devices: [], categories: [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const home = mkdtempSync(path.join(tmpdir(), "bao-secret-conflict-"));
  const library = new Library(home);
  const origin = `http://127.0.0.1:${address.port}`;
  library.save(secretWorkflow());
  writeFileSync(path.join(home, "sync.json"), JSON.stringify({ server: origin, deviceToken: "fixture", backedUp: true }));
  try {
    await syncAll(library, "push");
    const local = library.read("secret-push");
    local.name = "Unsynced local edit";
    library.save(local);
    const remote = secretWorkflow();
    remote.name = "Direct remote edit";
    remote.inputs[0]!.default = "direct-remote-password";
    const pushed = await fetch(`${origin}/api/workflows/secret-push/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseVersion: version, document: remote }),
    });
    assert.equal(pushed.status, 201);
    const view = await syncAll(library, mode);
    assert.equal(view.conflicts.length, 1);
    assert.equal(view.conflicts[0]!.remoteVersion, 2);
    assert.equal(library.read("secret-push").name, "Unsynced local edit");
    const book = JSON.parse(readFileSync(path.join(home, "versions", "secret-push.json"), "utf8")) as WorkflowVersion[];
    const conflict = book.find((row) => row.source === "conflict")?.conflict;
    assert.equal(conflict?.theirs.name, "Direct remote edit");
    assert.equal(conflict?.theirs.inputs[0]!.default, "[secret stripped]");
    assert.equal(document.inputs[0]!.default, "direct-remote-password");
    await syncAll(library, mode);
    assert.equal(library.read("secret-push").name, "Unsynced local edit");
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
