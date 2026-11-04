import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { query } from "../../../web/src/lib/db";
import { createShare, getShare, installShare, previewPublication, pull, pushVersion } from "../../../web/src/lib/registry";
import { buildPushBody as webBody, stripUnsafe as webStrip, assertSyncSafe } from "../../../web/src/lib/guard";
import { prepareImport } from "../../../web/src/lib/import-sheet";
import { releaseHash } from "../../../web/src/lib/publish";
import { buildPushBody as desktopBody, stripUnsafe as desktopStrip } from "../../src/v1/sync-guard";
import { BrowserDriver } from "../../src/v1/browser-driver";
import { liveReplayArgs } from "../../src/cdp-live/live-replay";
import { canonical } from "../../src/v1/canonical";
import { replay } from "../../src/v1/replay";
import { scrubHome } from "../../src/v1/scrub-home";
import { NEEDS_SECRET_VALUE, scrubSaved, STRIPPED_SECRET } from "../../src/v1/saved-secrets";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { saveState, syncAll } from "../../src/v1/sync";
import { testChromium } from "../../src/test-browser.js";

async function main(): Promise<void> {
  const home = process.env.BAO_COMPOSITION_HOME!;
  assert.ok(home);
  delete process.env.DATABASE_URL;
  process.env.BAO_PG_DIR = path.join(home, "database");
  process.env.BAO_BLOB_DIR = path.join(home, "blobs");
  await query("INSERT INTO users (id, email, name, verified) VALUES ('author', 'author@fixture.test', 'Author', true), ('reader', 'reader@fixture.test', 'Reader', true)");
  const author = { userId: "author" };
  const reader = { userId: "reader" };
  let currentId = "";
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname === "/form") {
        res.setHeader("content-type", "text/html");
        res.end('<!doctype html><label for="password">Value</label><input id="password"><script>window.typed=[];document.querySelector("input").addEventListener("input", e=>window.typed.push(e.target.value))</script>');
        return;
      }
      let result: unknown;
      if (url.pathname === "/api/sync/snapshot") result = {};
      else if (url.pathname === "/api/devices") result = { devices: [], categories: [] };
      else if (url.pathname === "/api/workflows") result = { workflows: [{ id: currentId }] };
      else if (req.method === "POST" && url.pathname === `/api/workflows/${currentId}/versions`) {
        let bytes = "";
        for await (const chunk of req) bytes += chunk;
        result = await pushVersion(author, currentId, JSON.parse(bytes));
      } else if (url.pathname === `/api/workflows/${currentId}`) result = await pull(author, currentId);
      else { res.statusCode = 404; res.end("not found"); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await testChromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    let count = 0;
    for (const secret of [STRIPPED_SECRET, "secret", "strip", "stripped", "pass", "4111111111111111", "sk-seededWholeToken"]) {
      for (const mode of ["raw", "saved"]) {
        const id = `composition-${count++}-${mode}`;
        const metadata = `Keep ${secret} Ada Lovelace ada@example.test`;
        const source: WorkflowV2 = {
          schema: "bao.workflow/v2", version: 2, id, name: metadata, createdAt: 1,
          startUrl: `${origin}/form?token=keep-secret`,
          inputs: [{ name: "evidence", type: "secret", default: secret, required: false }, { name: "password", type: "text", default: secret, required: false }],
          steps: [{ id: "entry", index: 0, action: "type", surface: "dom", label: metadata, timeoutMs: 1000, input: "password", value: "{{password}}",
            identity: { surface: "dom", role: "textbox", id: "password", name: "Value", cssPath: "#password", path: [] } }],
        };
        const original = canonical(source);
        const library = new Library(path.join(home, id));
        library.save(source);
        const input = mode === "saved" ? library.read(id) : source;
        const privateValue = input.inputs[0]!.default as string;
        const copies = [webStrip(input, [privateValue]), desktopStrip(input, [privateValue])].map((value) => value as WorkflowV2);
        assert.equal(canonical(copies[0]), canonical(copies[1]));
        const check = (doc: WorkflowV2) => {
          assert.equal(doc.name.includes(metadata), true);
          assert.equal(doc.startUrl, source.startUrl);
          assert.equal(doc.steps[0]!.label, metadata);
          assert.deepEqual(doc.steps[0]!.identity, source.steps[0]!.identity);
          assert.equal(doc.steps[0]!.value, "{{password}}");
          assert.equal(doc.inputs.find((item) => item.name === "password")!.default, STRIPPED_SECRET);
          assert.equal(doc.inputs.find((item) => item.name === "evidence")!.default, undefined);
        };
        copies.forEach(check);
        assert.throws(() => assertSyncSafe({ document: library.read(id) }), /secret/);
        for (const body of [webBody, desktopBody]) assert.throws(() => body(input, { baseVersion: 0 }), /secret/);
        const sender = new Library(path.join(home, id, "sender"));
        const receiver = new Library(path.join(home, id, "receiver"));
        sender.save(copies[0]!);
        currentId = id;
        for (const target of [sender, receiver]) saveState(target.root, { server: origin, deviceToken: "fixture", deviceId: "fixture", backedUp: true, workflows: {}, pushedRuns: [], remoteDevices: [], remoteCategories: [], conflicts: [] });
        await syncAll(sender, "push");
        const remote = await pull(author, id);
        check(remote.document as WorkflowV2);
        await syncAll(receiver, "pull");
        check(receiver.read(id));
        const shared = await createShare(author, id, "fork");
        const share = await getShare(shared.token);
        check(share.document as WorkflowV2);
        const installed = await installShare(reader, shared.token, {});
        const imported = (await pull(reader, installed.id)).document as WorkflowV2;
        check(imported);
        const preview = await previewPublication(author, id);
        assert.equal(preview.documentHash, releaseHash(preview.document));
        check(preview.document as WorkflowV2);
        check(prepareImport(input).document as WorkflowV2);
        library.saveIntentEval(id, preview);
        const sealedBytes = canonical(preview);
        assert.equal(canonical(scrubSaved(preview, { secrets: [secret, STRIPPED_SECRET] })), sealedBytes);
        scrubHome(library.root, true);
        const savedPreview = library.readIntentEval(id) as typeof preview;
        assert.equal(canonical(savedPreview), sealedBytes);
        assert.equal(releaseHash(savedPreview.document), savedPreview.documentHash);
        for (const [kind, doc] of [["sync", receiver.read(id)], ["share", share.document], ["install", imported], ["release", preview.document]] as [string, WorkflowV2][]) {
          const file = path.join(library.root, `${kind}.json`);
          writeFileSync(file, JSON.stringify(doc));
          const stored = JSON.parse(readFileSync(file, "utf8")) as WorkflowV2;
          check(stored);
          await page.goto(stored.startUrl);
          let healing = 0;
          const heal = { available: () => true, propose: async () => { healing += 1; throw new Error("unexpected healing"); } };
          const missing = await replay(stored, liveReplayArgs(stored, {}), new BrowserDriver(page), { heal });
          assert.equal(missing.status, "failed");
          assert.equal(missing.steps[0]!.reason, NEEDS_SECRET_VALUE);
          assert.equal(await page.locator("#password").inputValue(), "");
          assert.deepEqual(await page.evaluate(() => (window as unknown as { typed: string[] }).typed), []);
          assert.equal(healing, 0);
          const fresh = `fresh-runtime-${count}-${kind}`;
          const run = await replay(stored, liveReplayArgs(stored, { password: fresh }), new BrowserDriver(page), { heal });
          assert.equal(run.status, "passed", JSON.stringify(run));
          assert.equal(await page.locator("#password").inputValue(), fresh);
          assert.equal(healing, 0);
          assert.equal(canonical(stored), canonical(doc));
        }
        assert.equal(canonical(source), original);
      }
    }
    mkdirSync(path.join(home, "proof"), { recursive: true });
    writeFileSync(path.join(home, "proof", "result.json"), JSON.stringify({ scenarios: count, replayCopies: count * 4 }));
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
