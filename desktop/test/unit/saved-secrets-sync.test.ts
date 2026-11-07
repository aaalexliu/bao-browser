import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { toJson, type WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { loadState, resolveConflict, saveState, syncAll } from "../../src/v1/sync";
import { clearConflict, draftVersion, listVersions, noteConflict, promoteVersion, restoreVersion } from "../../src/v1/versions";
import { NEEDS_SECRET_VALUE, scrubSaved, STRIPPED_SECRET } from "../../../shared/saved-secrets";
import type { HealRecord } from "../../src/v1/heal";
import { replay, type Driver } from "../../src/v1/replay";

function document(id = "saved"): WorkflowV2 {
  return {
    schema: "bao.workflow/v2", version: 2, id, name: "Saved", createdAt: 1,
    startUrl: "https://example.test/", inputs: [],
    steps: [{ id: "entry", index: 0, action: "type", label: "Fill", surface: "dom", timeoutMs: 0, value: "private-entry", identity: { surface: "dom", role: "password", path: [] } }],
  };
}

test("every version-book write strips document copies and conflict history", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-secret-versions-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  const doc = document();
  writeFileSync(path.join(home, "workflows", "saved.json"), toJson(doc));
  const check = () => {
    const saved = JSON.parse(readFileSync(path.join(home, "versions", "saved.json"), "utf8"));
    assert.equal(JSON.stringify(saved).includes("private-entry"), false);
    assert.ok(JSON.stringify(saved).includes(STRIPPED_SECRET));
    assert.deepEqual(scrubSaved(saved), saved);
  };
  listVersions(library, doc.id);
  check();
  for (const source of ["edit", "heal", "restore"] as const) {
    const draft = draftVersion(library, doc, source);
    check();
    promoteVersion(library, doc.id, draft.n);
    check();
  }
  restoreVersion(library, doc.id, 1);
  check();
  noteConflict(library, {
    mine: doc, theirs: doc, mineDevice: "Here", theirsDevice: "There", remoteVersion: 10,
    history: [{ version: 10, document: doc }],
  });
  check();
  clearConflict(library, doc.id);
  check();
  const brace = document();
  brace.steps[0] = { ...brace.steps[0]!, sensitive: true, value: "secret{{1}}" };
  const drafted = draftVersion(library, brace, "edit");
  assert.equal(drafted.document.steps[0]!.value, STRIPPED_SECRET);
  noteConflict(library, { mine: library.read(doc.id), theirs: brace, mineDevice: "Here", theirsDevice: "There", remoteVersion: 99, history: [{ version: 99, document: brace }] });
  assert.equal(listVersions(library, doc.id).some((row) => row.n === 99 && row.role === "past"), true);
  const book = readFileSync(path.join(home, "versions", "saved.json"), "utf8");
  assert.equal(book.includes("secret{{1}}"), false);
  assert.equal(brace.steps[0]!.value, "secret{{1}}");
  assert.equal(doc.steps[0]!.value, "private-entry");
});

test("nested sensitive bindings strip defaults and mark their actual steps", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-secret-nested-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  for (const sensitive of [true, false]) {
    for (const explicit of [true, false]) {
      const doc = document();
      doc.inputs = [{ name: "entry", type: "text", default: "private-entry" }, { name: "rows", type: "table" }];
      doc.steps[0] = {
        ...doc.steps[0]!, value: "{{entry}}", input: explicit ? "entry" : undefined, sensitive,
        identity: sensitive ? undefined : { surface: "dom", role: "password", path: [] },
      };
      for (let depth = 0; depth < 2; depth += 1) {
        doc.version = depth ? 3 : 2;
        library.save(doc);
        const saved = library.read(doc.id);
        assert.equal(saved.inputs[0]!.default, STRIPPED_SECRET);
        let step = saved.steps[0]!;
        while (step.forEach) step = step.forEach.steps[0]!;
        assert.equal(step.unresolved?.reason, NEEDS_SECRET_VALUE);
        assert.deepEqual(scrubSaved(saved), saved);
        doc.steps = [{ id: `loop-${depth}`, index: 0, action: "for_each", label: "Rows", surface: "dom", timeoutMs: 0, forEach: { over: { kind: "input", name: "rows" }, steps: doc.steps } }];
      }
    }
  }
});

test("sync hashes match saved documents after pull and every conflict choice", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-secret-sync-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const remoteDocument = (id = "saved") => {
    const doc = document(id);
    doc.steps[0] = { ...doc.steps[0]!, sensitive: true, value: "secret{{1}}" };
    return doc;
  };
  let docs = [remoteDocument()];
  let revision = 2;
  let pushes = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    let body: unknown;
    if (url.pathname === "/api/sync/snapshot") body = { heals: [{ id: "heal", workflowId: "saved", heal: remoteDocument() }] };
    else if (url.pathname === "/api/devices") body = { devices: [], categories: [] };
    else if (url.pathname === "/api/workflows") body = { workflows: docs.map(({ id }) => ({ id })) };
    else if (url.pathname.endsWith("/conflict")) body = { version: revision, document: remoteDocument(), copyId: "copy", copyVersion: revision, copy: remoteDocument("copy") };
    else if (req.method === "GET" && url.pathname.startsWith("/api/workflows/")) body = { version: revision, document: docs.find((doc) => url.pathname.endsWith(`/${doc.id}`)), shots: [] };
    else if (url.pathname.endsWith("/versions")) { pushes += 1; body = { version: 3 }; }
    else body = { ok: true };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const library = new Library(home);
  saveState(home, {
    server: `http://127.0.0.1:${address.port}`, deviceToken: "fixture", deviceId: "fixture", deviceName: "Here",
    backedUp: true, workflows: {}, pushedRuns: [], remoteDevices: [], remoteCategories: [], conflicts: [],
  });
  const check = async () => {
    const state = loadState(home);
    for (const doc of library.list().workflows) {
      const expected = createHash("sha256").update(toJson(doc)).digest("hex");
      assert.equal(state.workflows[doc.id]?.hash, expected);
    }
    await syncAll(library);
    assert.equal(pushes, 0);
    assert.deepEqual(loadState(home).conflicts, []);
  };
  await syncAll(library, "pull");
  await check();
  const heal = readFileSync(path.join(home, "heals", "heal.json"), "utf8");
  assert.equal(heal.includes("private-entry"), false);
  assert.deepEqual(JSON.parse(heal).heal, remoteDocument());
  for (const action of ["keep-mine", "keep-theirs", "keep-both"] as const) {
    const file = path.join(home, "conflicts", "saved.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, toJson(remoteDocument()));
    const state = loadState(home);
    state.conflicts = [{ id: "saved", remoteVersion: 2, at: 1, file }];
    saveState(home, state);
    await resolveConflict(library, "saved", action);
    if (action === "keep-both") docs = [remoteDocument(), remoteDocument("copy")];
    await check();
  }
  library.save({ ...library.read("saved"), name: "Local edit" });
  revision += 1;
  await syncAll(library, "pull");
  assert.equal(loadState(home).conflicts.some((row) => row.id === "saved"), true);
  assert.equal(readFileSync(path.join(home, "versions", "saved.json"), "utf8").includes("secret{{1}}"), false);
  await resolveConflict(library, "saved", "keep-theirs");
  await check();
  assert.equal(docs[0]!.steps[0]!.value, "secret{{1}}");
});

test("two homes sync a kept HealRecord without stripping its owned binding", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-kept-heal-sync-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sender = new Library(path.join(home, "sender"));
  const receiver = new Library(path.join(home, "receiver"));
  const doc = document("login");
  doc.inputs = [{ name: "password", type: "text" }];
  doc.steps[0] = { ...doc.steps[0]!, sensitive: true, input: "password", value: "{{password}}", identity: { surface: "dom", role: "textbox", id: "entry", path: [] } };
  const kept: HealRecord = {
    id: "kept", ts: 1, workflowId: doc.id, runId: "run", mode: "auto", failedStep: { ...doc.steps[0]! },
    intent: "Fill", snapshot: {}, prompt: "", model: { provider: "openai", name: "gpt-4o", version: "test" }, kept: true,
  };
  const original = structuredClone(kept);
  sender.save(doc);
  sender.noteHealPromotion(doc.id, kept);
  assert.deepEqual(sender.readKeptHeal(doc.id), kept);
  sender.noteHealPromotion("unowned", { ...kept, failedStep: { ...kept.failedStep, id: "unknown" } });
  assert.equal((sender.readKeptHeal("unowned") as HealRecord).failedStep.value, STRIPPED_SECRET);
  let uploaded: { document: WorkflowV2; heal: HealRecord } | undefined;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    let body: unknown = { ok: true };
    if (req.method === "POST" && url.pathname.endsWith("/versions")) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      uploaded = JSON.parse(Buffer.concat(chunks).toString());
      body = { version: 1 };
    } else if (url.pathname === "/api/workflows") body = { workflows: uploaded ? [{ id: doc.id }] : [] };
    else if (url.pathname === `/api/workflows/${doc.id}`) body = { version: 1, document: uploaded?.document, shots: [] };
    else if (url.pathname === "/api/sync/snapshot") body = { heals: uploaded ? [
      { id: "kept", workflowId: doc.id, heal: uploaded.heal },
      { id: "bare", workflowId: doc.id, heal: { ...uploaded.heal, failedStep: { ...uploaded.heal.failedStep, id: "unknown" } } },
    ] : [] };
    else if (url.pathname === "/api/devices") body = { devices: [], categories: [] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  for (const library of [sender, receiver]) saveState(library.root, {
    server: `http://127.0.0.1:${address.port}`, deviceToken: "fixture", deviceId: path.basename(library.root), deviceName: "Fixture",
    backedUp: true, workflows: {}, pushedRuns: [], remoteDevices: [], remoteCategories: [], conflicts: [],
  });
  await syncAll(sender, "push");
  assert.deepEqual(uploaded?.heal, kept);
  await syncAll(receiver, "pull");
  const stored = JSON.parse(readFileSync(path.join(receiver.root, "heals/kept.json"), "utf8"));
  assert.deepEqual(stored.heal, kept);
  const bare = JSON.parse(readFileSync(path.join(receiver.root, "heals/bare.json"), "utf8"));
  assert.deepEqual(bare.heal, { ...kept, failedStep: { ...kept.failedStep, id: "unknown" } });
  const saved = receiver.read(doc.id);
  assert.equal(saved.steps[0]!.value, "{{password}}");
  const fills: string[] = [];
  const driver = {
    tree: async () => ({ nodes: [saved.steps[0]!.identity], texts: [], url: saved.startUrl }), snapshot: async () => ({}),
    fill: async (_node: unknown, value: string) => { fills.push(value); }, sleep: async () => {},
  } as unknown as Driver;
  const proof = { ...saved, steps: [stored.heal.failedStep] };
  const result = await replay(proof, { password: "fresh-runtime-value" }, driver, {
    heal: { available: () => false, propose: async () => { throw new Error("unexpected heal"); } },
  });
  assert.equal(result.status, "passed");
  assert.deepEqual(fills, ["fresh-runtime-value"]);
  assert.deepEqual(kept, original);
});
