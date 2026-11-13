import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { AgentBrowserRun } from "../../src/engines/agent-browser-record";
import { STEP_RECORD_SCHEMA, StepRecordStore, stepWhy } from "../../src/engines/step-record";
import { assertDevtoolsHar, describeMultipart, filePaths, type DevtoolsHarEntry } from "../../src/proxy/cdp-network";
import { TOOLS } from "../../src/mcp/server";
import { Library } from "../../src/v1/store";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=", "base64");

function entry(url: string, body?: string): DevtoolsHarEntry {
  return {
    startedDateTime: new Date(1).toISOString(),
    time: 3,
    request: {
      method: "GET", url, httpVersion: "HTTP/1.1", headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: -1,
    },
    response: {
      status: 200, statusText: "OK", httpVersion: "HTTP/1.1", headers: [], cookies: [],
      content: { size: body?.length ?? 0, mimeType: body ? "application/json" : "text/plain" },
      redirectURL: "", headersSize: -1, bodySize: body?.length ?? 0,
    },
    cache: {},
    timings: { blocked: -1, dns: -1, connect: -1, send: 0, wait: 1, receive: 2, ssl: -1 },
  };
}

test("why is a short optional string, and the tool accepts it", () => {
  assert.equal(stepWhy(undefined), undefined);
  assert.equal(stepWhy("  "), undefined);
  assert.equal(stepWhy(" open the October statement "), "open the October statement");
  assert.throws(() => stepWhy(1), /why must be a short string/);
  assert.throws(() => stepWhy("x".repeat(501)), /500/);
  const tool = TOOLS.find((item) => item.name === "agent_browser");
  assert.ok(tool);
  const schema = tool.inputSchema as { properties: { why: { type: string; maxLength: number } }; required: readonly string[] };
  assert.equal(schema.properties.why.type, "string");
  assert.equal(schema.properties.why.maxLength, 500);
  assert.equal(schema.required.includes("why"), false);
  assert.match(tool.description, /why=/);
});

test("a step record keeps unknown keys, stores a body once, and lists the run", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-step-record-"));
  const library = new Library(root);
  const run = new AgentBrowserRun(root);
  run.setWhy("open the October statement");
  const failed = run.begin("click", ["@e1"]);
  await run.complete(failed, [{ stdout: "", stderr: "timed out after 1000ms", exitCode: 1 }], root, async () => png);
  const waiting = run.begin("wait_for_owner", ["1000"]);
  await run.complete(waiting, [{ stdout: "", stderr: "", exitCode: 0 }], root, async () => png, undefined, false, { waitFor: "a sign-in page" });
  const closed = run.begin("snapshot", []);
  await run.complete(closed, [{ stdout: JSON.stringify({ instruction: "Bao's task tab was closed" }), stderr: "", exitCode: 0 }], root, async () => png);
  run.finish();

  const store = new StepRecordStore(root, run.id);
  const click = await store.readStep(failed.id);
  assert.equal(click?.schema, STEP_RECORD_SCHEMA);
  assert.equal(click?.why, "open the October statement");
  assert.equal(click?.status, "failed");
  assert.equal(click?.error, "timed out after 1000ms");
  assert.equal((click?.waits as { for: string }[])[0]?.for, "timeout");
  const wait = await store.readStep(waiting.id);
  assert.equal(wait?.why, "open the October statement");
  assert.equal((wait?.waits as { for: string; ms: number }[])[0]?.for, "a sign-in page");
  assert.equal(typeof (wait?.waits as { ms: number }[])[0]?.ms, "number");
  assert.ok(await store.readStep(closed.id), "a closed task tab still seals a step record");

  const file = path.join(root, "runs", run.id, "steps", `${failed.id}.json.gz`);
  const extra = JSON.parse(gunzipSync(await readFile(file)).toString("utf8")) as Record<string, unknown>;
  extra.page = { url: "http://127.0.0.1/kept" };
  await writeFile(file, gzipSync(Buffer.from(JSON.stringify(extra))));
  await store.writeStep({
    schema: STEP_RECORD_SCHEMA, id: failed.id, command: "click", args: ["@e1"], status: "failed",
    error: "timed out after 1000ms", startedAt: 1, endedAt: 2, waits: [{ for: "timeout", ms: 1 }], network: { entries: [] },
  });
  assert.deepEqual((await store.readStep(failed.id))?.page, { url: "http://127.0.0.1/kept" });

  const body = Buffer.from("{\"ok\":true}");
  const first = await store.putBody(body);
  const second = await store.putBody(body);
  assert.equal(first, second);
  assert.equal(first, createHash("sha256").update(body).digest("hex"));
  assert.equal((await readdir(path.join(root, "runs", run.id, "bodies"))).length, 1);

  const harEntry = entry("http://127.0.0.1/json", body.toString());
  harEntry._responseBody = first;
  await store.writeHar([harEntry]);
  const har = JSON.parse(await readFile(path.join(root, "runs", run.id, "run.har"), "utf8")) as { log: { entries: DevtoolsHarEntry[] } };
  assertDevtoolsHar(har);
  assert.equal(har.log.entries[0]?.response.content.text, body.toString());
  assert.equal(library.listRuns().some((item) => item.id === run.id), true);

  const upload = path.join(root, "statement.pdf");
  await writeFile(upload, Buffer.from("pdf-bytes"));
  const multipart = await describeMultipart(
    `--bound\r\nContent-Disposition: form-data; name="note"\r\n\r\nOctober\r\n--bound\r\nContent-Disposition: form-data; name="file"; filename="statement.pdf"\r\nContent-Type: application/pdf\r\n\r\npdf-bytes\r\n--bound--`,
    "multipart/form-data; boundary=bound",
    filePaths(["--headed", upload]),
  );
  assert.equal(multipart?.fileParts[0]?.path, upload);
  assert.equal(multipart?.fileParts[0]?.sha256, createHash("sha256").update("pdf-bytes").digest("hex"));
  assert.equal(multipart?.params.find((part) => part.name === "note")?.value, "October");
  const stepBytes = (await stat(file)).size;
  assert.ok(stepBytes > 0);
  console.log(JSON.stringify({ stepBytes, bodyBytes: body.length }));
});
