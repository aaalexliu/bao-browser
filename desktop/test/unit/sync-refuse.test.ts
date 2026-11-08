import { fixtureInput, fixtureStep, fixtureDoc, withStep, writeStep } from "../support/fixture-step";
import { stepValueTemplate, stepKey, stepForEach } from "../../src/v1/schema";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { workflowShotName } from "../../src/v1/shots";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { STRIPPED_SECRET } from "../../../shared/saved-secrets";
import { parseTable, tableToCsv } from "../../../shared/table";
import type { SyncPush } from "../../../web/src/lib/guard";
import type { WorkflowStep, WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { loadState, resolveConflict, syncAll } from "../../src/v1/sync";
import type { WorkflowVersion } from "../../src/v1/versions";

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
  doc.inputs = [];
  doc.steps = Array.from({ length: 40 }, (_, i) => fixtureStep({ id: `step-${i}`, index: i, action: "key", key: "Enter", label: "Continue", timeoutMs: 1000 }));
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
    assert.equal(conflict?.theirs.inputs[0]!.default, "direct-remote-password");
    assert.equal(document.inputs[0]!.default, "direct-remote-password");
    await syncAll(library, mode);
    assert.equal(library.read("secret-push").name, "Unsynced local edit");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("password defaults sync without leaving or disappearing from this device", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-password-sync-"));
  const library = new Library(home);
  const local = secretWorkflow();
  local.inputs[0]!.default = planted;
  local.inputs.push(fixtureInput({ name: "deleted", type: "secret", label: "Deleted", default: "old-password" }));
  library.save(local);
  let remote: unknown;
  let version = 1;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/sync/snapshot") {
        res.writeHead(404).end("{}");
      } else if (req.url === "/api/devices") {
        res.end(JSON.stringify({ devices: [], categories: [] }));
      } else if (req.method === "POST") {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as SyncPush;
        assert.equal(JSON.stringify(body).includes(planted), false);
        remote = body.document;
        res.end(JSON.stringify({ version }));
      } else if (req.url === "/api/workflows") {
        res.end(JSON.stringify({ workflows: [{ id: local.id }] }));
      } else {
        res.end(JSON.stringify({ version, document: remote }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  writeFileSync(path.join(home, "sync.json"), JSON.stringify({
    server: `http://127.0.0.1:${address.port}`, deviceToken: "device-token", backedUp: true,
    workflows: {}, pushedRuns: [], remoteDevices: [], remoteCategories: [], conflicts: [],
  }));
  try {
    const pushed = await syncAll(library, "push");
    assert.match(pushed.lastResult || "", /pushed 1/);
    const updated = remote as WorkflowV2;
    assert.equal(updated.inputs[0]!.default, undefined);
    updated.name = "Changed on another device";
    updated.inputs = updated.inputs.filter((input) => input.name !== "deleted");
    version = 2;
    await syncAll(library, "pull");
    const saved = library.read(local.id);
    assert.equal(saved.name, updated.name);
    assert.equal(saved.inputs[0]!.default, planted);
    assert.equal(saved.inputs.some((input) => input.name === "deleted"), false);
    const again = await syncAll(library, "push");
    assert.match(again.lastResult || "", /pushed 0/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const mode of ["pull", "keep-theirs", "keep-both"] as const) {
  test(`${mode} restores stripped local values without undoing remote edits or removals`, async () => {
    const token = "sk-localSavedToken123456789";
    const card = "4111111111111111";
    const home = mkdtempSync(path.join(tmpdir(), `bao-defaults-${mode}-`));
    const library = new Library(home);
    const local = secretWorkflow();
    undefined;
    const originalTable = `Display Name,Token\r\nAda,${token}\r\nGrace,${card}\r\n`;
    const tableNames = ["unchangedRows", "renamedRows", "deletedRows", "reorderedRows"];
    local.inputs = [
      fixtureInput({ name: "password", type: "secret", default: planted }),
      fixtureInput({ name: "token", type: "text", default: token }),
      fixtureInput({ name: "card", type: "text", default: card }),
      fixtureInput({ name: "changed", type: "text", default: token }),
      fixtureInput({ name: "changedSecret", type: "secret", default: planted }),
      fixtureInput({ name: "cleared", type: "text", default: token }),
      fixtureInput({ name: "removed", type: "text", default: token }),
      fixtureInput({ name: "file", type: "file", default: token }),
      fixtureInput({ name: "otp", type: "text", default: "123456" }),
      fixtureInput({ name: "rows", type: "table", default: `name,token\nAda,${token}\nGrace,${card}\nReplaced row,${token}\nRemoved row,${card}` }),
      fixtureInput({ name: "unstripped", type: "text", default: "local text" }),
      fixtureInput({ name: "mixedRows", type: "table", default: "name,token\r\nAda,[secret stripped]\r\nGrace,sk-GraceFixture222\r\n" }),
      ...tableNames.map((name) => fixtureInput({ name, type: "table", default: originalTable })),
    ];
    const literal = (id: string, value: string): WorkflowStep => (fixtureStep({
      id, index: 0, action: "type", label: id, surface: "dom", timeoutMs: 1000,
      identity: { surface: "dom", role: "textbox", path: [] }, value,
    }));
    local.steps.push(
      withStep(literal("token-input", "{{token}}"), { input: "token" }),
      literal("literal", token),
      fixtureStep(withStep(literal("key", ""), { action: "key", key: token, value: undefined })),
      literal("remote-value", token),
      fixtureStep(withStep(literal("remote-key", ""), { action: "key", key: token, value: undefined })),
      literal("removed-step", token),
      withStep(literal("unrelated", token), { unresolved: { reason: "no identity" } }),
      literal("unavailable", STRIPPED_SECRET),
      literal("unstripped", "local literal"),
      withStep(literal("sensitive", "private literal"), { sensitive: true }),
      withStep(literal("otp-step", "{{otp}}"), { input: "otp", identity: { surface: "dom", role: "textbox", path: [], autocomplete: "one-time-code" } }),
      fixtureStep({ ...literal("loop", ""), action: "for_each", value: undefined,
        forEach: { over: { kind: "input", name: "rows" }, steps: [
          literal("nested", card),
          literal("nested-removed", token),
          literal("nested-remote", token),
          fixtureStep(withStep(literal("nested-key", ""), { action: "key", key: token, value: undefined })),
          withStep(literal("nested-unrelated", token), { unresolved: { reason: "no identity" } }),
        ] } }),
    );
    local.steps.forEach((step, index) => {
      step.index = index;
      stepForEach(step)?.steps.forEach((child, childIndex) => { child.index = childIndex; });
    });
    library.save(local);
    let remote: WorkflowV2;
    let version = 1;
    let pushes = 0;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/api/sync/snapshot") {
          res.writeHead(404).end("{}");
        } else if (req.url === "/api/devices") {
          res.end(JSON.stringify({ devices: [], categories: [] }));
        } else if (req.url?.endsWith("/conflict")) {
          res.end(JSON.stringify({ version, document: remote, copyId: "remote-copy", copyVersion: 1, copy: { ...remote, id: "remote-copy" } }));
        } else if (req.method === "POST") {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as SyncPush;
          remote = body.document as WorkflowV2;
          pushes += 1;
          res.end(JSON.stringify({ version }));
        } else if (req.url === "/api/workflows") {
          res.end(JSON.stringify({ workflows: [{ id: local.id }] }));
        } else {
          res.end(JSON.stringify({ version, document: remote }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    writeFileSync(path.join(home, "sync.json"), JSON.stringify({
      server: `http://127.0.0.1:${address.port}`, deviceToken: "device-token", backedUp: true,
      workflows: {}, pushedRuns: [], remoteDevices: [], remoteCategories: [], conflicts: [],
    }));
    try {
      await syncAll(library, "push");
      assert.equal(pushes, 1);
      const updated = remote!;
      assert.equal(updated.inputs.find((input) => input.name === "token")?.default, STRIPPED_SECRET);
      assert.equal(updated.inputs.find((input) => input.name === "card")?.default, STRIPPED_SECRET);
      assert.equal((() => { const _step = updated.steps.find((step) => step.id === "literal"); return _step == null ? undefined : stepValueTemplate(_step); })(), STRIPPED_SECRET);
      assert.equal((() => { const _step = updated.steps.find((step) => step.id === "key"); return _step == null ? undefined : stepKey(_step); })(), STRIPPED_SECRET);
      assert.equal((() => { const _step = updated.steps.find((step) => step.id === "sensitive"); return _step == null ? undefined : stepValueTemplate(_step); })(), undefined);
      assert.deepEqual(parseTable(updated.inputs.find((input) => input.name === "rows")?.default), [
        { name: "Ada", token: STRIPPED_SECRET },
        { name: "Grace", token: STRIPPED_SECRET },
        { name: "Replaced row", token: STRIPPED_SECRET },
        { name: "Removed row", token: STRIPPED_SECRET },
      ]);
      assert.equal(updated.inputs.find((input) => input.name === "mixedRows")?.default,
        "name,token\nAda,[secret stripped]\nGrace,[secret stripped]\n");
      const pushedTable = updated.inputs.find((input) => input.name === "unchangedRows")!.default!;
      assert.equal(pushedTable, `Display Name,Token\nAda,${STRIPPED_SECRET}\nGrace,${STRIPPED_SECRET}\n`);
      const remoteTables = {
        renamedRows: `Display Name,Token\nRemote Ada,${STRIPPED_SECRET}\nGrace,${STRIPPED_SECRET}\n`,
        deletedRows: `Display Name,Token\nGrace,${STRIPPED_SECRET}\n`,
        reorderedRows: `Display Name,Token\nGrace,${STRIPPED_SECRET}\nAda,${STRIPPED_SECRET}\n`,
      };
      for (const [name, value] of Object.entries(remoteTables)) updated.inputs.find((input) => input.name === name)!.default = value;
      updated.name = "Remote edit";
      updated.inputs = updated.inputs.filter((input) => input.name !== "removed");
      updated.inputs.find((input) => input.name === "changed")!.default = "remote text";
      updated.inputs.find((input) => input.name === "changedSecret")!.default = "remote password";
      delete updated.inputs.find((input) => input.name === "cleared")!.default;
      updated.inputs.find((input) => input.name === "otp")!.default = STRIPPED_SECRET;
      updated.inputs.find((input) => input.name === "unstripped")!.default = STRIPPED_SECRET;
      updated.inputs.find((input) => input.name === "rows")!.default = tableToCsv(["name", "token"], [
        { name: "Remote Ada", token: STRIPPED_SECRET },
        { name: "Remote Grace", token: "remote table value" },
        { name: "New remote row", token: "new remote value" },
      ]);
      updated.steps = updated.steps.filter((step) => step.id !== "removed-step");
      writeStep(updated.steps.find((step) => step.id === "remote-value")!, { value: "remote literal" });
      const remoteKey = updated.steps.find((step) => step.id === "remote-key")!;
      remoteKey.action = "key";
      writeStep(remoteKey, { value: undefined });
      writeStep(remoteKey, { key: "Enter" });
      writeStep(updated.steps.find((step) => step.id === "unstripped")!, { value: STRIPPED_SECRET });
      const nested = stepForEach(updated.steps.find((step) => step.id === "loop")!)!;
      nested.steps = nested.steps.filter((step) => step.id !== "nested-removed");
      const remoteNested = nested.steps.find((step) => step.id === "nested-remote");
      if (remoteNested) writeStep(remoteNested, { value: "remote nested value" });
      nested.steps.forEach((step, index) => { step.index = index; });
      updated.steps.forEach((step, index) => { step.index = index; });
      version = 2;
      if (mode !== "pull") library.save({ ...library.read(local.id), name: "Local edit" });
      await syncAll(library, "pull");
      if (mode !== "pull") {
        assert.equal(loadState(home).conflicts.length, 1);
        assert.equal(library.read(local.id).name, "Local edit");
        await resolveConflict(library, local.id, mode);
      }
      for (const id of mode === "keep-both" ? [local.id, "remote-copy"] : [local.id]) {
        const saved = library.read(id);
        const defaults = Object.fromEntries(saved.inputs.map((input) => [input.name, input.default]));
        assert.equal(saved.name, "Remote edit");
        assert.equal(defaults.password, planted);
        assert.equal(defaults.token, token);
        assert.equal(defaults.card, card);
        assert.equal(defaults.changed, "remote text");
        assert.equal(defaults.changedSecret, "remote password");
        assert.equal(defaults.cleared, undefined);
        assert.equal("removed" in defaults, false);
        assert.equal(defaults.file, STRIPPED_SECRET);
        assert.equal(defaults.otp, STRIPPED_SECRET);
        assert.equal(defaults.unstripped, STRIPPED_SECRET);
        assert.deepEqual(parseTable(defaults.rows), [
          { name: "Remote Ada", token: STRIPPED_SECRET },
          { name: "Remote Grace", token: "remote table value" },
          { name: "New remote row", token: "new remote value" },
        ]);
        assert.equal(defaults.unchangedRows, originalTable);
        assert.equal(defaults.mixedRows, "name,token\r\nAda,[secret stripped]\r\nGrace,sk-GraceFixture222\r\n");
        for (const [name, value] of Object.entries(remoteTables)) {
          assert.equal(defaults[name], value);
          assert.ok(defaults[name]!.includes(STRIPPED_SECRET));
          assert.equal(defaults[name]!.includes(token), false);
          assert.equal(defaults[name]!.includes(card), false);
        }
        const steps = new Map(saved.steps.map((step) => [step.id, step]));
        assert.equal((() => { const _step = steps.get("literal"); return _step == null ? undefined : stepValueTemplate(_step); })(), token);
        assert.equal((() => { const _step = steps.get("key"); return _step == null ? undefined : stepKey(_step); })(), token);
        assert.equal((() => { const _step = steps.get("remote-value"); return _step == null ? undefined : stepValueTemplate(_step); })(), "remote literal");
        assert.equal((() => { const _step = steps.get("remote-key"); return _step == null ? undefined : stepKey(_step); })(), "Enter");
        assert.equal(steps.has("removed-step"), false);
        assert.equal((() => { const _step = steps.get("unstripped"); return _step == null ? undefined : stepValueTemplate(_step); })(), STRIPPED_SECRET);
        assert.equal((() => { const _step = steps.get("sensitive"); return _step == null ? undefined : stepValueTemplate(_step); })(), "private literal");
        const loop = steps.get("loop");
        const children = new Map((loop ? stepForEach(loop)?.steps ?? [] : []).map((step) => [step.id, step]));
        assert.equal(children.size, 4);
        assert.equal(children.has("nested-removed"), false);
        assert.equal(stepValueTemplate(children.get("nested")!), card);
        assert.equal(undefined, undefined);
        assert.equal(stepValueTemplate(children.get("nested-remote")!), "remote nested value");
        assert.equal(stepKey(children.get("nested-key")!), token);
        assert.equal(undefined, undefined);
        assert.equal(stepValueTemplate(children.get("nested-unrelated")!), token);
        assert.equal(loadState(home).workflows[id]!.version, id === local.id ? 2 : 1);
      }
      assert.equal(loadState(home).conflicts.length, 0);
      await syncAll(library, "push");
      assert.equal(pushes, 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

function secretWorkflow(): WorkflowV2 {
  return fixtureDoc({
    schema: "bao.workflow/v4",
    version: 2,
    id: "secret-push",
    name: "Secret push",
    startUrl: "http://127.0.0.1/fixture.html",
    inputs: [fixtureInput({ name: "password", type: "secret", label: "Password", required: true })],
    createdAt: 1,
    steps: [fixtureStep({
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
    })],
  });
}
