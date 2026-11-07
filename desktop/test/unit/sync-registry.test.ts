import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { query } from "../../../web/src/lib/db";
import { getPng } from "../../../web/src/lib/blobstore";
import { redactedPng } from "../../../web/src/lib/png";
import { buildPushBody } from "../../../web/src/lib/guard";
import sharp from "sharp";
import { createRelay, MemoryDirectory } from "../../../web/src/lib/relay";
import { MemoryJobStore } from "../../../web/src/lib/relay-job";
import { createShare, getShare, installShare, listLibrary, listRuns, previewPublication, pull, pushRun, pushVersion, recordReview } from "../../../web/src/lib/registry";

test("audit pages newest 50 rows without losing timestamp precision or owner scope", async () => {
  for (let i = 0; i < 55; i++) {
    await query(`INSERT INTO agent_jobs (id, token_id, user_id, device_id, tool, status, policy, args, created_at)
      VALUES ($1, 'token', 'audit-owner', 'device', 'run_workflow', 'queued', '{}', '{}', '2026-01-01'::timestamptz + $2 * interval '1 microsecond')`, [`audit-${String(i).padStart(2, "0")}`, i]);
  }
  await query(`INSERT INTO agent_jobs (id, token_id, user_id, device_id, tool, status, policy, args)
    VALUES ('other-owner-job', 'token', 'someone-else', 'device', 'run_workflow', 'queued', '{}', '{}')`);
  const relay = createRelay({ store: new MemoryJobStore(), directory: new MemoryDirectory(), enabled: () => true });
  try {
    const principal = { userId: "audit-owner" };
    const first = await relay.handle(new Request("http://localhost/api/agent/audit"), principal);
    assert.equal(first.status, 200);
    const page = await first.json() as { jobs: { id: string }[]; nextCursor: string };
    assert.equal(page.jobs.length, 50);
    assert.equal(page.jobs[0]!.id, "audit-54");
    assert.equal(page.jobs[49]!.id, "audit-05");
    assert.ok(page.nextCursor);
    const second = await relay.handle(new Request(`http://localhost/api/agent/audit?cursor=${page.nextCursor}`), principal);
    const tail = await second.json() as { jobs: { id: string }[]; nextCursor: string | null };
    assert.deepEqual(tail.jobs.map((job) => job.id), ["audit-04", "audit-03", "audit-02", "audit-01", "audit-00"]);
    assert.equal(tail.nextCursor, null);
  } finally {
    relay.close();
  }
});

const home = mkdtempSync(path.join(tmpdir(), "bao-owner-sync-"));
delete process.env.DATABASE_URL;
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.BLOB_STORE_ID;
process.env.BAO_PG_DIR = path.join(home, "pg");
process.env.BAO_BLOB_DIR = path.join(home, "blobs");

const owner = { userId: "owner" };
const reader = { userId: "reader" };
const credentials = ["fixture-password-99", "sk-fixtureApiToken", "4111111111111111"];
const source = {
  schema: "bao.workflow/v2", version: 2, id: "owner-sync", name: "Owner sync", createdAt: 1,
  startUrl: "https://example.test/",
  inputs: [
    { name: "email", type: "text", default: "ada@fixture.test" },
    { name: "file", type: "file", default: "/Users/ada/note.txt" },
    { name: "password", type: "secret", default: credentials[0] },
    { name: "token", type: "text", default: credentials[1] },
    { name: "card", type: "text", default: credentials[2] },
  ],
  steps: [
    { id: "pass", index: 0, action: "type", label: "Enter password", surface: "dom", timeoutMs: 1000, sensitive: true, input: "password", value: "{{password}}" },
    { id: "go", index: 1, action: "key", key: "Enter", label: "Continue", surface: "dom", timeoutMs: 1000 },
  ],
};

function checkDocument(document: unknown): void {
  const text = JSON.stringify(document);
  assert.equal(text.includes("ada@fixture.test"), true);
  assert.equal(text.includes("/Users/ada/note.txt"), true);
  for (const credential of credentials) assert.equal(text.includes(credential!), false);
}

test("registry sync, share, release, and run pictures retain owner data without redaction markers", async () => {
  await query("INSERT INTO users (id, email, name) VALUES ('owner', 'owner@fixture.test', 'Owner'), ('reader', 'reader@fixture.test', 'Reader')");
  const png = redactedPng(1);
  const shots = [{ stepId: "go", png: png.toString("base64") }];
  const direct = { ...source, id: "direct-push" };
  await pushVersion(owner, direct.id, { baseVersion: 0, document: direct, shots: [{ stepId: "pass", png: png.toString("base64") }, ...shots] });
  assert.deepEqual((await pull(owner, direct.id)).document, direct);
  const directCard = (await listLibrary(owner.userId, "")).find((card) => card.id === direct.id);
  assert.equal(directCard?.thumbnail, `/api/blobs/shots/${direct.id}/v1/go.jpg`);
  checkDocument((await previewPublication(owner, direct.id)).document);
  const pushed = await pushVersion(owner, source.id, buildPushBody(source, {
    baseVersion: 0, crops: [{ stepId: "pass", png }, { stepId: "go", png }],
    heal: { workflowId: source.id, args: { password: credentials[0], email: "ada@fixture.test" }, screenshot: shots[0]!.png },
  }));
  assert.equal(pushed.version, 1);
  const synced = await pull(owner, source.id);
  checkDocument(synced.document);
  assert.equal(synced.shots.length, 1);
  assert.deepEqual(synced.shots.map((shot) => shot.stepId), ["go"]);
  const heal = synced.heal as { args?: unknown; screenshot: string };
  assert.equal(heal.args, undefined);
  assert.equal(heal.screenshot, shots[0]!.png);
  assert.equal((await sharp((await getPng(`shots/${source.id}/v1/go.jpg`))!).metadata()).format, "jpeg");

  const shared = await createShare(owner, source.id, "fork");
  const share = await getShare(shared.token);
  checkDocument(share.document);
  assert.deepEqual(share.questions, []);
  const installed = await installShare(reader, shared.token, { email: "grace@fixture.test", password: "other-password", file: "/Users/grace/import.txt" });
  const copy = (await pull(reader, installed.id)).document;
  assert.equal(JSON.stringify(copy).includes("grace@fixture.test"), true);
  assert.equal(JSON.stringify(copy).includes("other-password"), false);
  assert.equal(JSON.stringify(copy).includes("/Users/grace/import.txt"), true);

  const preview = await previewPublication(owner, source.id);
  checkDocument(preview.document);
  await assert.rejects(() => recordReview(owner, source.id, "wrong-hash", shots), /review that hash/);
  await recordReview(owner, source.id, preview.documentHash, shots, { email: "ada@fixture.test", password: credentials[0] });
  assert.equal((await previewPublication(owner, source.id)).reviewed, true);
  const reviews = await query<{ samples: unknown }>("SELECT samples FROM reviews WHERE workflow_id = $1", [source.id]);
  assert.equal(JSON.stringify(reviews[0]!.samples).includes("ada@fixture.test"), true);
  assert.equal(JSON.stringify(reviews[0]!.samples).includes(credentials[0]!), false);

  await pushRun(owner, source.id, { id: "owner-run", status: "passed", at: 1, steps: [{ id: "go", status: "passed" }], shots });
  const runs = await listRuns(owner, source.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.shots.length, 1);
  assert.equal((await sharp((await getPng("runs/owner-run/go.jpg"))!).metadata()).format, "jpeg");
  assert.equal(source.inputs[2]!.default, credentials[0]);
  await assert.rejects(() => pull(reader, source.id), /not found/);
});
