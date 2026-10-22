// Pair, push, and pull against a local `vercel dev` (no deploy, no linked project).
// Not part of test:v1. Run: node --test desktop/test/live/vercel-dev-sync.test.ts

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { pairDevice, syncAll } from "../../src/v1/sync";

test("pair, push, and pull against local vercel dev", { timeout: 600_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-vercel-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BAO_PG_DIR: path.join(root, "pglite"),
    BAO_BLOB_DIR: path.join(root, "blobs"),
    BAO_AUTH_STUB: "1",
  };
  delete env.DATABASE_URL;
  delete env.POSTGRES_URL;
  delete env.BLOB_READ_WRITE_TOKEN;
  delete env.BLOB_STORE_ID;
  delete env.VERCEL_OIDC_TOKEN;

  const web = spawn(
    "npx",
    ["--yes", "vercel@65.0.0", "dev", "--local", "--yes", "--non-interactive", "--listen", `127.0.0.1:${port}`],
    {
      cwd: path.join(process.cwd(), "web"),
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  web.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  web.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));

  try {
    const health = await waitHealth(origin, logs);
    assert.equal(health.ok, true);
    assert.equal(health.driver, "pglite");

    const cookie = await signIn(origin, "owner@bao.local");
    const homeA = path.join(root, "mac-a");
    const homeB = path.join(root, "mac-b");
    const libA = new Library(homeA);
    const libB = new Library(homeB);
    const doc = workflow("vercel-roundtrip", "From the first Mac");
    libA.save(doc);

    await pairDevice(libA, { code: await pairCode(origin, cookie), server: origin, name: "Mac A" });
    const pushed = await syncAll(libA, "push");
    assert.equal(pushed.lastResult, "pushed 1, pulled 0, conflicts 0");

    await pairDevice(libB, { code: await pairCode(origin, cookie), server: origin, name: "Mac B" });
    const pulled = await syncAll(libB, "pull");
    assert.equal(pulled.lastResult, "pushed 0, pulled 1, conflicts 0");
    const pulledDoc = libB.read("vercel-roundtrip");
    assert.equal(pulledDoc.name, "From the first Mac");
    const step = pulledDoc.steps[0];
    assert.ok(step?.identity);
    assert.equal(step.identity.testId, "go");
  } finally {
    await stop(web);
  }
});

function workflow(id: string, name: string): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id,
    name,
    startUrl: "https://example.com/fixture",
    createdAt: 1,
    inputs: [],
    steps: [{
      id: "s0",
      index: 0,
      action: "click",
      label: "Open",
      surface: "dom",
      identity: { surface: "dom", role: "button", path: [], testId: "go" },
      timeoutMs: 1000,
    }],
  };
}

async function signIn(origin: string, email: string): Promise<string> {
  const sent = await fetch(`${origin}/api/auth/magic`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const body = await sent.json() as { verifyUrl?: string; error?: string };
  if (!body.verifyUrl) throw new Error(body.error || "no verify link");
  const verified = await fetch(`${origin}${body.verifyUrl}`, { redirect: "manual" });
  const match = verified.headers.get("set-cookie")?.match(/bao_session=([^;]+)/);
  if (!match) throw new Error("no session cookie");
  return `bao_session=${match[1]}`;
}

async function pairCode(origin: string, cookie: string): Promise<string> {
  const res = await fetch(`${origin}/api/pair`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
  });
  const body = await res.json() as { code?: string; error?: string };
  if (!body.code) throw new Error(body.error || `no pair code (${res.status})`);
  return body.code;
}

async function waitHealth(origin: string, logs: string[]): Promise<{ ok?: boolean; driver?: string }> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < 300_000) {
    try {
      const res = await fetch(`${origin}/api/health`);
      last = await res.text();
      if (res.ok) return JSON.parse(last) as { ok?: boolean; driver?: string };
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`vercel dev did not start: ${last}\n${logs.join("").slice(-8000)}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 800));
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}
