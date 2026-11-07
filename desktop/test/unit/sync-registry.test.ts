import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { query } from "../../../web/src/lib/db";
import { getPng } from "../../../web/src/lib/blobstore";
import { redactedPng } from "../../../web/src/lib/png";
import { createShare, getShare, installShare, listRuns, previewPublication, pull, pushRun, pushVersion, recordReview } from "../../../web/src/lib/registry";

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
  steps: [{ id: "pass", index: 0, action: "type", label: "Enter password", surface: "dom", timeoutMs: 1000, sensitive: true, input: "password", value: "{{password}}" }],
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
  const shots = [{ stepId: "pass", png: png.toString("base64") }];
  const pushed = await pushVersion(owner, source.id, {
    baseVersion: 0, document: source, shots,
    heal: { workflowId: source.id, args: { password: credentials[0], email: "ada@fixture.test" }, screenshot: shots[0]!.png },
  });
  assert.equal(pushed.version, 1);
  const synced = await pull(owner, source.id);
  checkDocument(synced.document);
  assert.equal(synced.shots.length, 1);
  const heal = synced.heal as { args: { email: string; password: string }; screenshot: string };
  assert.equal(heal.args.email, "ada@fixture.test");
  assert.equal(heal.args.password.includes(credentials[0]!), false);
  assert.equal(heal.screenshot, shots[0]!.png);
  assert.deepEqual(await getPng(`shots/${source.id}/v1/pass.png`), png);

  const shared = await createShare(owner, source.id, "fork");
  const share = await getShare(shared.token);
  checkDocument(share.document);
  assert.deepEqual(share.questions, []);
  const installed = await installShare(reader, shared.token, { email: "grace@fixture.test", password: "other-password" });
  const copy = (await pull(reader, installed.id)).document;
  assert.equal(JSON.stringify(copy).includes("grace@fixture.test"), true);
  assert.equal(JSON.stringify(copy).includes("other-password"), false);

  const preview = await previewPublication(owner, source.id);
  checkDocument(preview.document);
  await assert.rejects(() => recordReview(owner, source.id, "wrong-hash", shots), /review that hash/);
  await recordReview(owner, source.id, preview.documentHash, shots, { email: "ada@fixture.test", password: credentials[0] });
  assert.equal((await previewPublication(owner, source.id)).reviewed, true);
  const reviews = await query<{ samples: unknown }>("SELECT samples FROM reviews WHERE workflow_id = $1", [source.id]);
  assert.equal(JSON.stringify(reviews[0]!.samples).includes("ada@fixture.test"), true);
  assert.equal(JSON.stringify(reviews[0]!.samples).includes(credentials[0]!), false);

  await pushRun(owner, source.id, { id: "owner-run", status: "passed", at: 1, steps: [{ id: "pass", status: "passed" }], shots });
  const runs = await listRuns(owner, source.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.shots.length, 1);
  assert.deepEqual(await getPng("runs/owner-run/pass.png"), png);
  assert.equal(source.inputs[2]!.default, credentials[0]);
  await assert.rejects(() => pull(reader, source.id), /not found/);
});
