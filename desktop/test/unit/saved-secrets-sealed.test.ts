import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareImport } from "../../../web/src/lib/import-sheet";
import { redactForRelease, releaseHash } from "../../../web/src/lib/publish";
import { stripUnsafe as webStrip, assertSyncSafe } from "../../../web/src/lib/guard";
import { stripUnsafe as desktopStrip } from "../../src/v1/sync-guard";
import { runWorkflow } from "../../src/mcp/catalog";
import { PageExecutor } from "../../src/proxy/executor";
import { AuditTrail } from "../../src/proxy/audit";
import { fileDigest } from "../../src/v1/files-dates";
import { ReceiptLog, verifyReceiptChain, type Receipt } from "../../src/v1/receipt";
import { canonical } from "../../src/v1/canonical";
import { scrubHome } from "../../src/v1/scrub-home";
import { scrubSaved, STRIPPED_SECRET } from "../../../shared/saved-secrets";
import { toJson, type WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { loadState, saveState, syncAll } from "../../src/v1/sync";
import { draftVersion } from "../../src/v1/versions";
import { pinTestBrowser } from "../../src/launch";

const SECRET = "sk-seededWholeToken";
const typed = { op: "type", sensitive: true, value: SECRET };
const document = (): WorkflowV2 => ({
  schema: "bao.workflow/v2", version: 2, id: "sealed", name: "Sealed", createdAt: 1,
  startUrl: "https://example.test/", inputs: [{ name: "entry", type: "text" }],
  steps: [{ id: "entry", index: 0, action: "type", label: "Fill", surface: "dom", timeoutMs: 0, input: "entry", value: "{{entry}}" }],
});

test("sealed artifact census preserves payload bytes and verifies every seal after later passes", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-sealed-census-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  const doc = document();
  library.save(doc);
  const logFile = path.join(home, "runs", "sealed.receipts.jsonl");
  const log = new ReceiptLog(logFile);
  const body = { kind: "read-back" as const, ts: 1, runId: "sealed", workflowId: doc.id, stepId: "entry", source: "value" as const,
    expected: SECRET, actual: SECRET, pass: true, screenshot: "opaque diagnostic", detail: typed };
  const receipt = log.append(body, { secrets: [SECRET] });
  assert.equal(receipt.expected, STRIPPED_SECRET);
  assert.equal(receipt.actual, STRIPPED_SECRET);
  const releaseSource = document();
  releaseSource.inputs[0]!.default = SECRET;
  const prepared = prepareImport(releaseSource).document;
  const preview = { document: prepared, documentHash: releaseHash(prepared) };
  assert.equal((prepared as WorkflowV2).inputs[0]!.default, STRIPPED_SECRET);
  assert.equal(releaseSource.inputs[0]!.default, SECRET);
  assert.equal(body.actual, SECRET);
  const download = path.join(home, "download.txt");
  writeFileSync(download, "public download\n");
  const output = fileDigest(download);
  const { testChromium } = await import("../../src/test-browser.js");
  const browser = await testChromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
  await page.goto("data:text/html,public");
  const trail = new AuditTrail();
  const observation = await new PageExecutor(page, trail).observe({ source: { agent: "fixture", vendor: "bao", adapter: "stdio" }, raw: {} });
  const snapshot = trail.events[0]!.after!;
  const imageFile = path.join(home, "screenshot.png");
  writeFileSync(imageFile, observation.png);
  const evalSnapshot = { snapshot: { sha256: fileDigest(imageFile).sha256, path: imageFile, w: 320, h: 240 } };
  const cropBytes = await page.screenshot({ clip: { x: 0, y: 0, width: 80, height: 80 } });
  const cropFile = path.join(home, "crop.png");
  writeFileSync(cropFile, cropBytes);
  const crop = { crop: `sha256:${fileDigest(cropFile).sha256}` };
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const census: { type: string; artifact: unknown; verify: (value: unknown) => void }[] = [
    { type: "read-back receipt", artifact: receipt, verify: (value) => assert.equal(verifyReceiptChain([value as Receipt]), true) },
    { type: "publication preview", artifact: preview, verify: (value) => { const saved = value as typeof preview; assert.equal(releaseHash(saved.document), saved.documentHash); } },
    { type: "download digest", artifact: output, verify: (value) => { const saved = value as typeof output; assert.equal(hash(readFileSync(saved.path)), saved.sha256); assert.equal(readFileSync(saved.path).length, saved.size); assert.equal(readFileSync(saved.path, "utf8"), "public download\n"); } },
    { type: "screenshot address", artifact: snapshot, verify: (value) => assert.equal((value as typeof snapshot).screenshot, `sha256:${hash(observation.png)}`) },
    { type: "eval screenshot digest", artifact: evalSnapshot, verify: (value) => { const saved = value as typeof evalSnapshot; assert.equal(saved.snapshot.sha256, hash(readFileSync(saved.snapshot.path))); assert.deepEqual(readFileSync(saved.snapshot.path), observation.png); } },
    { type: "crop address", artifact: crop, verify: (value) => { assert.equal((value as typeof crop).crop, `sha256:${hash(readFileSync(cropFile))}`); assert.deepEqual(readFileSync(cropFile), cropBytes); } },
  ];
  let revision = 0;
  let remote: WorkflowV2 & { artifact?: unknown } = doc;
  const receiver = new Library(path.join(home, "receiver"));
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const body = url.pathname === "/api/sync/snapshot" ? { heals: [{ id: `heal-${revision}`, workflowId: doc.id, heal: { artifact: remote.artifact } }] }
      : url.pathname === "/api/devices" ? { devices: [], categories: [] }
      : url.pathname === "/api/workflows" ? { workflows: [{ id: doc.id }] }
      : { document: remote, version: revision, shots: [] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  saveState(receiver.root, { server: `http://127.0.0.1:${(server.address() as { port: number }).port}`, deviceToken: "fixture", deviceId: "fixture", backedUp: true, workflows: {}, pushedRuns: [], remoteDevices: [], remoteCategories: [], conflicts: [] });
  const passes: [string, (value: unknown) => unknown | Promise<unknown>][] = [
    ["strip", (artifact) => scrubSaved({ artifact, evidence: typed }, { secrets: [STRIPPED_SECRET, "sha256"] }).artifact],
    ["library context", (artifact) => library.scrub({ artifact }, doc.id, undefined, [SECRET, STRIPPED_SECRET, "sha256"]).artifact],
    ["desktop outbound strip", (artifact) => desktopStrip(artifact, [SECRET, STRIPPED_SECRET, "sha256"])],
    ["web outbound strip", (artifact) => webStrip(artifact, [SECRET, STRIPPED_SECRET, "sha256"])],
    ["release strip", (artifact) => redactForRelease(artifact).document],
    ["workflow", (artifact) => { library.save({ ...doc, artifact } as WorkflowV2); return (library.read(doc.id) as WorkflowV2 & { artifact: unknown }).artifact; }],
    ["run", (artifact) => { library.saveRun({ id: "sealed", workflowId: doc.id, status: "passed", at: 1, steps: [], heals: [artifact] }); return library.readRun("sealed").heals[0]; }],
    ["trail", (artifact) => { library.saveTrail(doc.id, [artifact]); return (library.readTrail(doc.id) as unknown[])[0]; }],
    ["append trail", (artifact) => { library.saveTrail(doc.id, []); library.appendTrail(doc.id, artifact); return (library.readTrail(doc.id) as unknown[])[0]; }],
    ["kept heal", (artifact) => { library.noteHealPromotion(doc.id, { id: "heal", workflowId: doc.id, runId: "sealed", ts: 1, mode: "auto", failedStep: doc.steps[0], snapshot: {}, prompt: "", model: { provider: "fixture", name: "fixture", version: "1" }, kept: true, artifact }); return (library.readKeptHeal(doc.id) as { artifact: unknown }).artifact; }],
    ["version heal draft", (artifact) => (draftVersion(library, { ...doc, artifact } as WorkflowV2, "heal").document as WorkflowV2 & { artifact: unknown }).artifact],
    ["intent eval", (artifact) => { library.saveIntentEval(doc.id, { artifact }); return (library.readIntentEval(doc.id) as { artifact: unknown }).artifact; }],
    ["sync pull and heal catch-up", async (artifact) => {
      revision += 1;
      remote = { ...doc, artifact };
      await syncAll(receiver, "pull");
      const heal = JSON.parse(readFileSync(path.join(receiver.root, "heals", `heal-${revision}.json`), "utf8"));
      assert.equal(canonical(heal.heal.artifact), canonical(artifact));
      return (receiver.read(doc.id) as WorkflowV2 & { artifact: unknown }).artifact;
    }],
  ];
  for (const row of census) {
    const original = canonical(row.artifact);
    assert.equal(original.includes(SECRET), false, row.type);
    row.verify(row.artifact);
    for (const [name, pass] of passes) {
      const result = await pass(row.artifact);
      assert.equal(canonical(result), original, `${row.type} / ${name}`);
      row.verify(result);
      assert.equal(canonical(row.artifact), original, `${row.type} mutated / ${name}`);
    }
  }
  const chainBytes = readFileSync(logFile);
  const files = ["workflows/sealed.json", "runs/sealed.json", "trails/sealed.json", "promotions/sealed.heal.json", "versions/sealed.json", "evals/intent/sealed.json"];
  const before = files.map((file) => readFileSync(path.join(home, file)));
  assert.deepEqual(scrubHome(home).files, []);
  assert.deepEqual(scrubHome(home, true).files, []);
  files.forEach((file, index) => assert.deepEqual(readFileSync(path.join(home, file)), before[index], file));
  assert.deepEqual(readFileSync(logFile), chainBytes);
  assert.equal(verifyReceiptChain(log.entries), true);
  assert.throws(() => assertSyncSafe({ screenshot: snapshot.screenshot }), /screenshot/);
});

test("sealed lookalikes inside user data strip before outbound copies", () => {
  const raw = document();
  raw.inputs[0]!.default = SECRET;
  const lookalike = { document: raw, documentHash: releaseHash(raw) };
  assert.deepEqual(scrubSaved(lookalike, { secrets: [SECRET] }), lookalike);
  const data = { receipt: { kind: "read-back", hash: "signed", expected: SECRET, actual: SECRET }, preview: lookalike };
  const value = { op: "type", args: data, list: { rows: [{ cell: data }] }, workflow: { ...document(), inputs: [{ name: "payload", type: "text", default: data }] } };
  for (const strip of [(item: unknown) => scrubSaved(item), (item: unknown) => desktopStrip(item, []), (item: unknown) => webStrip(item, [])]) {
    const saved = JSON.stringify(strip(value));
    assert.equal(saved.includes(SECRET), false);
    assert.ok(saved.includes(STRIPPED_SECRET));
  }
  assert.equal(raw.inputs[0]!.default, SECRET);
});

test("outbound composition persists stable sync, share and sealed copies with real replay", { timeout: 120_000 }, (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-outbound-composition-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TMPDIR: home, BAO_COMPOSITION_HOME: home, BAO_TEST_BROWSER: pinTestBrowser(), BAO_HEAL_CURSOR_ACCOUNT: "0", NODE_PATH: path.join(process.cwd(), "web", "node_modules") };
  for (const key of ["DATABASE_URL", "BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY", "XAI_API_KEY", "CURSOR_API_KEY"]) delete env[key];
  const child = spawnSync(process.execPath, [path.resolve("desktop/dist/desktop/test/fixtures/outbound-composition.js")], { env, encoding: "utf8", timeout: 110_000, maxBuffer: 10 * 1024 * 1024 });
  assert.equal(child.status, 0, [child.stdout, child.stderr, child.error?.message].join("\n"));
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, "proof", "result.json"), "utf8")), { scenarios: 14, replayCopies: 56 });
});

test("MCP materialization hashes the stripped saved workflow", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-sealed-materialize-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const doc = document();
  doc.startUrl = "http://127.0.0.1/";
  doc.inputs = [{ name: "entry", type: "secret", required: true }];
  doc.steps[0]!.value = SECRET;
  const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ document: doc, version: 1, owned: true })); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  saveState(home, { server: `http://127.0.0.1:${(server.address() as { port: number }).port}`, deviceToken: "fixture", deviceId: "fixture", backedUp: true, workflows: {}, pushedRuns: [], remoteDevices: [], remoteCategories: [], conflicts: [] });
  const library = new Library(home);
  const outcome = await runWorkflow(library, { id: doc.id });
  assert.equal(outcome.outcome, "needs_human");
  assert.equal(outcome.reason, "Enter entry on this device");
  const saved = library.read(doc.id);
  assert.equal(saved.steps[0]!.value, STRIPPED_SECRET);
  assert.equal(loadState(home).workflows[doc.id]!.hash, createHash("sha256").update(toJson(saved)).digest("hex"));
  assert.equal(doc.steps[0]!.value, SECRET);
});
