// Two PgJobStore objects, one PGlite directory. Moved from web/test/relay-pg.test.ts.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { query } from "./db";
import { PgDirectory } from "./relay";
import {
  argsForJob,
  asJobId,
  deviceScope,
  durableResult,
  jobPolicy,
  PgJobStore,
  type QueuedJob,
} from "./relay-job";

delete process.env.DATABASE_URL;
process.env.BAO_PG_DIR = mkdtempSync(path.join(tmpdir(), "bao-relay-pg-"));

test("a finish on the second store wakes a wait on the first", async () => {
  const first = new PgJobStore();
  const second = new PgJobStore();
  const scope = deviceScope("user-a", "dev-a");
  const id = asJobId("job-11111111-1111-4111-8111-111111111111");
  assert.ok(id);
  await first.insert(queued(id));
  const running = await first.claim(scope, id);
  assert.equal(running?.status, "running");
  assert.equal((await second.oldestRunning(scope))?.id, id);
  assert.equal(await second.claim(deviceScope("user-b", "dev-b"), id), null);

  const waiting = first.wait(id, 4_000);
  const wrote = await second.settle(scope, id, "ok", durableResult("ok", {
    title: "Books",
    screenshot: "iVBORw0KGgoAAA",
    resume: "resume-secret",
    resume_token: "tok",
  }));
  assert.equal(wrote.kind, "wrote");
  const woke = await waiting;
  assert.equal(woke?.status, "done");
  assert.equal(woke?.outcome, "ok");
  if (woke?.status === "done") {
    assert.equal(woke.result.title, "Books");
    assert.equal("screenshot" in woke.result, false);
    assert.equal("resume" in woke.result, false);
    assert.equal("resume_token" in woke.result, false);
  }

  const stranger = await second.settle(
    deviceScope("user-b", "dev-b"),
    id,
    "failed",
    durableResult("failed", { reason: "no" }),
  );
  assert.equal(stranger.kind, "missing");
  const lost = await first.settle(scope, id, "failed", durableResult("failed", { title: "other" }));
  assert.equal(lost.kind, "lost");
  if (lost.kind === "lost") {
    assert.equal(lost.job.outcome, "ok");
    assert.equal(lost.job.result.title, "Books");
  }
});

test("a foreign device claim does not consume the code", async () => {
  await query(`INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`, ["user-a", "a@bao.test", "A"]);
  await query(`INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`, ["user-b", "b@bao.test", "B"]);
  await query(
    `INSERT INTO devices (id, user_id, name, token_hash) VALUES ($1, $2, $3, $4)`,
    ["dev-a", "user-a", "Mac A", "hash-a"],
  );
  await query(
    `INSERT INTO devices (id, user_id, name, token_hash) VALUES ($1, $2, $3, $4)`,
    ["dev-b", "user-b", "Mac B", "hash-b"],
  );
  const directory = new PgDirectory();
  const issued = await directory.issueCode("user-a", Date.now());
  await assert.rejects(() => directory.claimCode(issued.code, "Mac", "  "), /device id/);
  await assert.rejects(() => directory.claimCode(issued.code, "Mac", "dev-b"), /device not found/);
  const pending = await query<{ used_at: Date | null }>(
    `SELECT used_at FROM relay_pair_codes WHERE code = $1`,
    [issued.code],
  );
  assert.equal(pending[0]?.used_at ?? null, null);
  const claimed = await directory.claimCode(issued.code, "Mac", "dev-a");
  assert.match(claimed.token, /^bao_rt_/);
  assert.equal(claimed.deviceId, "dev-a");
  assert.equal(await directory.revokeRelay(claimed.token), true);
  assert.equal(await directory.relayFromToken(claimed.token), null);
});

function queued(id: NonNullable<ReturnType<typeof asJobId>>): QueuedJob {
  const prepared = argsForJob({ id: "books" });
  if ("error" in prepared) throw new Error(prepared.error);
  return {
    id,
    scope: deviceScope("user-a", "dev-a"),
    tokenId: "atk-pg",
    tool: "search_workflows",
    workflowId: prepared.workflowId,
    policy: jobPolicy(),
    args: prepared.args,
    events: [],
    createdAt: new Date().toISOString(),
    status: "queued",
    outcome: null,
    result: null,
    claimedAt: null,
    finishedAt: null,
  };
}
