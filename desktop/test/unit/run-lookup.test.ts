import { fixtureDoc, fixtureStep } from "../support/fixture-step";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { launchOwnedChrome } from "../../src/launch";
import { getRun, type WorkflowOutcome } from "../../src/mcp/catalog";
import { guideCrops } from "../../src/v1/guide";
import { blankPng } from "../../src/v1/redacted-png";
import { createRemoteAgent } from "../../src/v1/remote-agent";
import { saveRelay } from "../../src/v1/relay-link";
import type { WorkflowV2 } from "../../src/v1/schema";
import { shotFile } from "../../src/v1/shots";
import { Library, type StoredRun } from "../../src/v1/store";
import { MemoryJobStore } from "../../../web/src/lib/relay-job";
import { createRelay, listenRelay, MemoryDirectory } from "../../../web/src/lib/relay";

const cli = path.resolve(__dirname, "../../src/app/cli.js");
const outputs = [{ name: "result", type: "table" as const, columns: [{ name: "value", type: "text" as const }], rows: [{ value: "Imported cloud run" }] }];
const workflow: WorkflowV2 = fixtureDoc({
  schema: "bao.workflow/v4", version: 2, id: "cloud", name: "Cloud", startUrl: "https://example.test/", createdAt: 1, inputs: [],
  steps: [fixtureStep({ id: "note", index: 0, action: "note", label: "Read cloud", surface: "dom", timeoutMs: 0 })],
});
const stored: StoredRun = {
  schema: "bao.run/v4",
  id: "run-imported", kind: "capture", workflowId: "cloud", status: "passed", at: 1234,
  heals: [], steps: [{ id: "note", status: "passed" }], outputs, video: "run-imported.webm",
};
const report: WorkflowOutcome = {
  runId: stored.id, run_id: stored.id, workflowId: stored.workflowId, outcome: "ok", status: "completed",
  receipts: [{ id: "note", status: "passed", readBack: "Imported cloud run" }], stops: [], link: "bao://workflow/cloud", outputs,
};

function mcp(home: string, user: string, id: string): WorkflowOutcome {
  const call = spawnSync(process.execPath, [cli, "mcp", "--home", home], {
    env: { ...process.env, HOME: user, BAO_HOME: home, BAO_HEAL_CURSOR_ACCOUNT: "0" },
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_run", arguments: { run_id: id } } })}\n`,
    encoding: "utf8", timeout: 10_000,
  });
  assert.equal(call.status, 0, call.stderr);
  const reply = JSON.parse(call.stdout.trim()) as { result: { isError: boolean; content: { text: string }[] } };
  assert.equal(reply.result.isError, false, reply.result.content[0]?.text);
  return JSON.parse(reply.result.content[0]!.text) as WorkflowOutcome;
}

async function remoteGetRun(library: Library): Promise<void> {
  let connected!: () => void;
  let failed!: (error: Error) => void;
  const connection = new Promise<void>((resolve, reject) => { connected = resolve; failed = reject; });
  class Directory extends MemoryDirectory {
    override async relayFromToken(token: string) {
      const principal = await super.relayFromToken(token);
      connected();
      return principal;
    }
  }
  const directory = new Directory();
  directory.addDevice("mac", "owner");
  const issued = await directory.issueCode("owner", Date.now());
  const paired = await directory.claimCode(issued.code, "Mac", "mac");
  const agentToken = await directory.mintAgent("owner", "mac");
  assert.ok(agentToken);
  const relay = createRelay({ store: new MemoryJobStore(), directory, enabled: () => true });
  const server = await listenRelay(relay);
  saveRelay(library.root, { server: server.origin, token: paired.token, tokenId: paired.tokenId, deviceId: paired.deviceId });
  library.updateSettings({ remoteMcp: true });
  const agent = createRemoteAgent({ library, prompts: {}, stop() {}, clearStop() {} });
  const timeout = setTimeout(() => failed(new Error("remote agent did not connect")), 5000);
  agent.start();
  try {
    await connection;
    const response = await fetch(`${server.origin}/mcp`, {
      method: "POST", headers: { authorization: `Bearer ${agentToken.token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_run", arguments: { run_id: stored.id } } }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const reply = await response.json() as { result: { content: { text: string }[] } };
    const result = JSON.parse(reply.result.content[0]!.text) as { runId: string; status: string; outputs: unknown };
    assert.equal(result.runId, stored.id);
    assert.equal(result.status, "passed");
    assert.deepEqual(result.outputs, outputs);
  } finally {
    clearTimeout(timeout);
    await agent.stop();
    library.updateSettings({ remoteMcp: false });
    await server.close();
  }
}

test("runs/stored: every run lookup finds an imported run with a temp HOME", async (t) => {
      const location = "runs";
      const record = stored;
      const root = mkdtempSync(path.join(tmpdir(), "bao-run-lookup-"));
      const previous = { HOME: process.env.HOME, BAO_HOME: process.env.BAO_HOME };
      process.env.HOME = path.join(root, "user");
      mkdirSync(process.env.HOME);
      const library = new Library(path.join(root, "library"));
      mkdirSync(path.join(library.root, location), { recursive: true });
      writeFileSync(path.join(library.root, location, `${stored.id}.json`), JSON.stringify(record));
      library.save(workflow);
      const shotDir = path.join(library.root, "shots", "runs", stored.id);
      mkdirSync(shotDir, { recursive: true });
      const crop = blankPng(8, 8);
      writeFileSync(path.join(shotDir, shotFile("note", "after")), crop);
      mkdirSync(path.join(library.root, "videos"));
      const video = Buffer.from("isolated run video fixture");
      writeFileSync(path.join(library.root, "videos", stored.video!), video);
      const app = await startApp({ home: library.root, port: 0 });
      const base = `http://127.0.0.1:${app.port}`;
      const surfaces: Record<string, () => void | Promise<void>> = {
        "remote MCP get_run": () => remoteGetRun(library),
        "guide run picture lookup": () => assert.deepEqual(guideCrops(library.root, workflow).get("note"), crop),
        "CLI MCP get_run": () => {
          const result = mcp(library.root, process.env.HOME!, stored.id);
          assert.equal(result.runId, stored.id);
          assert.equal(result.outcome, "ok");
          assert.deepEqual(result.outputs, outputs);
        },
        "catalog getRun": () => {
          assert.equal(getRun(library, stored.id).runId, stored.id);
          assert.deepEqual(getRun(library, stored.id).outputs, outputs);
        },
        "Library.readRun": () => {
          const result = library.readRun(stored.id);
          assert.equal(result.id, stored.id);
          assert.equal(result.status, "passed");
          assert.ok(result.at > 0);
          assert.deepEqual(result.outputs, outputs);
        },
        "Library.listRuns": () => assert.deepEqual(library.listRuns().map((run) => run.id), [stored.id]),
        "Runs view and open by id": async () => {
          assert.ok(process.env.BAO_TEST_BROWSER, "run with the hermetic test lane to keep Chrome isolated");
          const browser = await launchOwnedChrome({ userDataDir: path.join(root, "chrome"), headless: true });
          try {
            const page = await browser.newPage();
            await page.goto(base);
            await page.click(`[data-open-run="${stored.id}"]`);
            await page.getByText("Detailed evidence", { exact: true }).click();
            await page.waitForSelector(`#run-viewer[data-run="${stored.id}"][data-status="passed"]`);
            assert.match(await page.locator("#run-host").innerText(), /Cloud/);
          } finally {
            await browser.close();
          }
        },
        "Runs view state": async () => {
          const response = await fetch(`${base}/api/state`);
          assert.equal(response.status, 200);
          const state = await response.json() as { runs: StoredRun[] };
          assert.deepEqual(state.runs.map((run) => run.id), [stored.id]);
        },
        "run detail API": async () => {
          const response = await fetch(`${base}/api/runs/${stored.id}`);
          assert.equal(response.status, 200);
          const result = await response.json() as StoredRun;
          assert.equal(result.id, stored.id);
          assert.equal(result.status, "passed");
          assert.deepEqual(result.outputs, outputs);
        },
        "CSV output API": async () => {
          const response = await fetch(`${base}/api/runs/${stored.id}/outputs.csv`);
          assert.equal(response.status, 200);
          assert.match(await response.text(), /Imported cloud run/);
        },
        "video API": async () => {
          const response = await fetch(`${base}/api/runs/${stored.id}/video`);
          assert.equal(response.status, 200);
          assert.deepEqual(Buffer.from(await response.arrayBuffer()), video);
        },
        "JSON output API": async () => {
          const response = await fetch(`${base}/api/runs/${stored.id}/outputs.json`);
          assert.equal(response.status, 200);
          assert.deepEqual(await response.json(), outputs);
        },
      };
      try {
        for (const [name, check] of Object.entries(surfaces)) await t.test(name, check);
        assert.equal(readFileSync(path.join(library.root, location, `${stored.id}.json`), "utf8"), JSON.stringify(record));
      } finally {
        await app.close();
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        rmSync(root, { recursive: true, force: true });
      }
});

test("paired records deduplicate history and preserve stored metadata and the full MCP report", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-run-pair-"));
  try {
    const library = new Library(root);
    library.saveRun(stored);
    mkdirSync(path.join(root, "reports"));
    const paused: WorkflowOutcome = {
      ...report, outcome: "needs_signin", status: "needs_signin", ask: "Sign in", step: "login",
      resume: "r_resume", resume_token: "r_resume", deadline: "No timeout",
    };
    writeFileSync(path.join(root, "reports", `${stored.id}.json`), JSON.stringify(paused));
    assert.deepEqual(library.listRuns(), [stored]);
    assert.deepEqual(getRun(library, stored.id), paused);
    const decision = { ts: 1, healId: "heal", decision: "keep" as const };
    library.appendDecision(stored.id, decision);
    assert.deepEqual(library.readRun(stored.id).decisions, [decision]);
    assert.equal(library.listRuns().length, 1);
    assert.deepEqual(getRun(library, stored.id), paused);
    rmSync(path.join(root, "runs", `${stored.id}.json`));
    assert.throws(() => library.readRun(stored.id), /run not found/);
    assert.deepEqual(library.listRuns(), []);
    assert.deepEqual(getRun(library, stored.id), paused);
    assert.equal(guideCrops(root, workflow).size, 0);
    assert.equal(readFileSync(path.join(root, "reports", `${stored.id}.json`), "utf8"), JSON.stringify(paused));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [status, outcome] of [
  ["passed", "ok"], ["ok", "ok"], ["completed", "ok"],
  ["needs-sign-in", "needs_signin"], ["needs_signin", "needs_signin"],
  ["needs_approval", "needs_approval"], ["needs_human", "needs_human"],
  ["paused", "needs_human"], ["running", "needs_human"], ["idle", "needs_human"],
  ["failed", "failed"], ["timed-out", "failed"], ["timeout", "failed"], ["stopped", "failed"],
] as const) {
  for (const withEnvelope of [false, true]) {
    test(`stored MCP status ${status}, envelope ${withEnvelope}`, () => {
      const root = mkdtempSync(path.join(tmpdir(), "bao-run-status-"));
      try {
        const library = new Library(root);
        const run: StoredRun = {
          ...stored, status, steps: [], failure: { reason: "Saved stop reason" },
          ...(withEnvelope ? { envelope: { status, reason: "Envelope reason", ask: "Act now", step: "human", deadline: null, resume_token: "r_saved" } } : {}),
        };
        library.saveRun(run);
        const before = readFileSync(path.join(root, "runs", `${stored.id}.json`), "utf8");
        const result = getRun(library, stored.id);
        assert.equal(result.outcome, outcome);
        assert.equal(result.status, status);
        assert.equal(result.reason, withEnvelope ? "Envelope reason" : "Saved stop reason");
        assert.equal(result.ask, withEnvelope ? "Act now" : outcome === "ok" ? undefined : "Saved stop reason");
        assert.equal(result.step, withEnvelope ? "human" : undefined);
        assert.equal(result.resume_token, withEnvelope ? "r_saved" : undefined);
        if (withEnvelope) assert.equal(result.deadline, null);
        assert.equal(readFileSync(path.join(root, "runs", `${stored.id}.json`), "utf8"), before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

for (const wall of ["bot_wall", "login_wall", "normal"]) {
  test(`stored MCP projects the final page classification: ${wall}`, () => {
    const root = mkdtempSync(path.join(tmpdir(), "bao-run-wall-"));
    try {
      const library = new Library(root);
      const pageClass = { class: wall, stepId: "read", reason: "Wall evidence", vendor: "site", evidence: [{ source: "dom", detail: "Blocked" }], line: "Blocked" };
      library.saveRun({ ...stored, pageClasses: [{ ...pageClass, class: "login_wall" }, pageClass] });
      assert.deepEqual(getRun(library, stored.id).pageClass, wall === "normal" ? undefined : pageClass);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("stored MCP defaults missing wall evidence to an empty array", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-run-wall-"));
  try {
    const library = new Library(root);
    for (const wall of ["bot_wall", "login_wall"]) {
      const pageClass = { class: wall, stepId: "read", reason: "Wall detected" };
      library.saveRun({ ...stored, pageClasses: [pageClass] });
      assert.deepEqual(getRun(library, stored.id).pageClass, { ...pageClass, vendor: undefined, line: undefined, evidence: [] });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stored-only MCP lookup keeps failure and human-step details", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-run-outcome-"));
  try {
    const library = new Library(root);
    library.saveRun({ ...stored, status: "failed", failure: { stepId: "read", reason: "Page changed" }, steps: [{ id: "read", status: "failed" }] });
    const failed = getRun(library, stored.id);
    assert.equal(failed.outcome, "failed");
    assert.equal(failed.reason, "Page changed");
    assert.deepEqual(failed.stops, [{ stepId: "read", outcome: "failed", reason: "Page changed" }]);
    assert.deepEqual(failed.receipts, [{ id: "read", status: "failed", readBack: "" }]);
    library.saveRun({ ...stored, status: "needs_human", envelope: { status: "needs_human", ask: "Check the page", resume_token: "r_check", step: "read" } });
    const paused = getRun(library, stored.id);
    assert.equal(paused.outcome, "needs_human");
    assert.equal(paused.ask, "Check the page");
    assert.equal(paused.resume_token, "r_check");
    library.saveRun({ ...stored, status: "needs_human", steps: [{ id: "read", status: "paused", reason: "Check the page" }] });
    const bare = getRun(library, stored.id);
    assert.equal(bare.status, "needs_human");
    assert.equal(bare.step, "read");
    assert.equal(bare.ask, "Check the page");
    assert.deepEqual(bare.stops, [{ stepId: "read", outcome: "needs_human", reason: "Check the page" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing runs, bad ids, and corrupt files do not become successful lookups", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-run-errors-"));
  const previousHome = process.env.HOME;
  process.env.HOME = path.join(root, "user");
  mkdirSync(process.env.HOME);
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    const library = new Library(root);
    assert.deepEqual(library.listRuns(), []);
    for (const read of [() => library.readRun("missing"), () => getRun(library, "missing")]) assert.throws(read, /run not found/);
    for (const id of ["../outside", "a/b", "a\\b", ""]) {
      assert.throws(() => library.readRun(id), /bad id/);
      assert.throws(() => getRun(library, id), /bad id/);
    }
    writeFileSync(path.join(root, "runs", "broken.json"), "{broken");
    assert.throws(() => library.readRun("broken"), SyntaxError);
    assert.throws(() => getRun(library, "broken"), SyntaxError);
    library.saveRun(stored);
    app = await startApp({ home: root, port: 0 });
    for (const location of ["runs", "reports"]) {
      mkdirSync(path.join(root, location), { recursive: true });
      for (const corrupt of ["{broken", "null", "{}", "[]"]) {
        writeFileSync(path.join(root, location, "broken.json"), corrupt);
        assert.deepEqual(library.listRuns(), [stored]);
        const response: Response = await fetch(`http://127.0.0.1:${app.port}/api/state`);
        assert.equal(response.status, 200);
        const state = await response.json() as { runs: StoredRun[] };
        assert.deepEqual(state.runs.map((run) => run.id), [stored.id]);
      }
    }
  } finally {
    await app?.close();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
