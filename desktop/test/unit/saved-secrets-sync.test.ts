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
import { NEEDS_SECRET_VALUE, scrubSaved, STRIPPED_SECRET } from "../../src/v1/saved-secrets";

function document(id = "saved"): WorkflowV2 {
  return {
    schema: "bao.workflow/v2", version: 2, id, name: "Saved", createdAt: 1,
    startUrl: "https://example.test/", inputs: [],
    steps: [{ id: "entry", index: 0, action: "type", label: "Fill", surface: "dom", value: "private-entry", sensitive: true }],
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
  assert.equal(doc.steps[0]!.value, "private-entry");
});

test("nested sensitive bindings strip defaults and mark their actual steps", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-secret-nested-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  for (const sensitive of [true, false]) {
    for (const explicit of [true, false]) {
      const doc = document();
      doc.version = 3;
      doc.inputs = [{ name: "entry", type: "text", default: "private-entry" }, { name: "rows", type: "table" }];
      doc.steps[0] = {
        ...doc.steps[0]!, value: "{{entry}}", input: explicit ? "entry" : undefined, sensitive,
        identity: sensitive ? undefined : { surface: "dom", role: "password", path: [] },
      };
      for (let depth = 0; depth < 3; depth += 1) {
        library.save(doc);
        const saved = library.read(doc.id);
        assert.equal(saved.inputs[0]!.default, STRIPPED_SECRET);
        let step = saved.steps[0]!;
        while (step.forEach) step = step.forEach.steps[0]!;
        assert.equal(step.unresolved?.reason, NEEDS_SECRET_VALUE);
        assert.deepEqual(scrubSaved(saved), saved);
        doc.steps = [{ id: `loop-${depth}`, index: 0, action: "for_each", label: "Rows", surface: "dom", forEach: { over: { kind: "input", name: "rows" }, steps: doc.steps } }];
      }
    }
  }
});

test("sync hashes match saved documents after pull and every conflict choice", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-secret-sync-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let docs = [document()];
  let pushes = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    let body: unknown;
    if (url.pathname === "/api/sync/snapshot") body = { heals: [{ id: "heal", workflowId: "saved", heal: document() }] };
    else if (url.pathname === "/api/devices") body = { devices: [], categories: [] };
    else if (url.pathname === "/api/workflows") body = { workflows: docs.map(({ id }) => ({ id })) };
    else if (url.pathname.endsWith("/conflict")) body = { version: 2, document: document(), copyId: "copy", copyVersion: 2, copy: document("copy") };
    else if (req.method === "GET" && url.pathname.startsWith("/api/workflows/")) body = { version: 2, document: docs.find((doc) => url.pathname.endsWith(`/${doc.id}`)), shots: [] };
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
    for (const doc of library.list()) {
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
  assert.ok(heal.includes(STRIPPED_SECRET));
  for (const action of ["keep-mine", "keep-theirs", "keep-both"] as const) {
    const file = path.join(home, "conflicts", "saved.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, toJson(document()));
    const state = loadState(home);
    state.conflicts = [{ id: "saved", remoteVersion: 2, at: 1, file }];
    saveState(home, state);
    await resolveConflict(library, "saved", action);
    if (action === "keep-both") docs = [document(), document("copy")];
    await check();
  }
});
