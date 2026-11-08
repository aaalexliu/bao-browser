import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { launchOwnedChrome } from "../../src/launch";
import { getRun } from "../../src/mcp/catalog";
import type { RecordedAgentBrowserCommand } from "../../src/engines/agent-browser-record";
import { Library, type StoredRun } from "../../src/v1/store";

const command: RecordedAgentBrowserCommand = {
  id: "command-1", label: 'click "@e7"', caption: { text: "Click Milk" }, status: "passed", startedAt: 1, endedAt: 2,
  target: { rect: { x: 10, y: 20, width: 30, height: 40 }, viewport: { width: 800, height: 600 } },
  native: { command: "click", args: ["@e7"], results: [{ stdout: "Clicked Milk\n", stderr: "native detail", exitCode: 0 }], isError: false, screenshots: [] },
};
const capture: StoredRun = {
  id: "run-capture", kind: "capture", workflowId: "agent-browser", status: "recording", at: 1, heals: [], steps: [command],
};

for (const [status, outcome] of [
  ["recording", "recording"], ["passed", "ok"], ["failed", "failed"],
  ["needs_human", "needs_human"], ["paused", "needs_human"],
] as const) {
  test(`get_run preserves ${status} capture outcome, target and native detail`, () => {
    const root = mkdtempSync(path.join(tmpdir(), "bao-capture-status-"));
    try {
      const library = new Library(root);
      library.saveRun({ ...capture, status });
      const result = getRun(library, capture.id);
      assert.equal(result.outcome, outcome);
      assert.equal(result.status, status);
      assert.equal(result.run_id, capture.id);
      assert.equal(result.link, `bao://receipt/${capture.id}`);
      assert.deepEqual(result.receipts, [{
        id: command.id, status: command.status, readBack: "", label: command.label, target: command.target, native: {
          ...command.native,
          results: [{ stdout: "Clicked Milk\n", stderr: "native detail", exitCode: 0, stdoutTruncated: false, stdoutLength: 13, stderrTruncated: false, stderrLength: 13 }],
        },
      }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("get_run preserves failed capture command errors and stop reason", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-capture-failed-"));
  try {
    const library = new Library(root);
    const failed = { ...command, status: "failed", reason: "Target moved", native: { ...command.native, isError: true, error: "Target moved", results: [{ stdout: "", stderr: "Target moved", exitCode: 1 }] } };
    library.saveRun({ ...capture, status: "failed", steps: [failed] });
    const result = getRun(library, capture.id);
    assert.equal(result.outcome, "failed");
    assert.equal(result.reason, "Target moved");
    assert.deepEqual(result.stops, [{ stepId: command.id, outcome: "failed", reason: "Target moved" }]);
    assert.deepEqual(result.receipts, [{ id: failed.id, status: failed.status, readBack: "", label: failed.label, target: failed.target, native: {
      ...failed.native,
      results: [{ stdout: "", stderr: "Target moved", exitCode: 1, stdoutTruncated: false, stdoutLength: 0, stderrTruncated: false, stderrLength: 12 }],
    } }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("get_run leaves saved-workflow receipts and links unchanged", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-replay-status-"));
  try {
    const library = new Library(root);
    library.saveRun({ ...capture, kind: "replay", workflowId: "groceries", status: "passed" });
    const result = getRun(library, capture.id);
    assert.equal(result.outcome, "ok");
    assert.equal(result.status, "passed");
    assert.equal(result.link, "bao://workflow/groceries");
    assert.deepEqual(result.receipts, [{ id: command.id, status: "passed", readBack: "" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const kind of ["capture", "replay"] as const) {
  for (const status of ["new-state", "", "toString"]) {
    for (const enveloped of [false, true]) {
      test(`get_run returns unknown for ${kind} status ${JSON.stringify(status)}, envelope=${enveloped}`, () => {
        const root = mkdtempSync(path.join(tmpdir(), "bao-capture-unknown-"));
        try {
          const library = new Library(root);
          library.saveRun({ ...capture, kind, status: enveloped ? "passed" : status,
            ...(enveloped ? { envelope: { status } } : {}),
            steps: [{ ...command, status: "failed", reason: "Target moved" }],
          });
          const result = getRun(library, capture.id);
          assert.equal(result.outcome, "unknown");
          assert.equal(result.status, status);
          assert.deepEqual(result.stops, [{ stepId: command.id, outcome: "unknown", reason: "Target moved" }]);
        } finally { rmSync(root, { recursive: true, force: true }); }
      });
    }
  }
}

test("get_run bounds every native output stream without changing stored evidence", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-capture-output-"));
  try {
    const library = new Library(root);
    const results = [
      { stdout: "a".repeat(1001), stderr: "b".repeat(2000), exitCode: 1 },
      { stdout: "c".repeat(1000), stderr: "", exitCode: 0 },
    ];
    const steps = [command, { ...command, id: "command-2", native: { ...command.native, results } }];
    library.saveRun({ ...capture, steps });
    const result = getRun(library, capture.id);
    assert.deepEqual(result.receipts[1], {
      id: "command-2", status: "passed", readBack: "", label: command.label, target: command.target,
      native: { ...command.native, results: [
        { stdout: "a".repeat(1000), stderr: "b".repeat(1000), exitCode: 1, stdoutTruncated: true, stdoutLength: 1001, stderrTruncated: true, stderrLength: 2000 },
        { stdout: "c".repeat(1000), stderr: "", exitCode: 0, stdoutTruncated: false, stdoutLength: 1000, stderrTruncated: false, stderrLength: 0 },
      ] },
    });
    assert.equal(result.nativeOutputNote, `For full native output, open bao://receipt/${capture.id}.`);
    assert.deepEqual(library.readRun(capture.id).steps, steps);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bao open receipt routes to the exact existing Runs receipt without a workflow", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-open-receipt-"));
  const home = path.join(root, "user");
  mkdirSync(home);
  const app = await startApp({ home: path.join(root, "library"), port: 0 });
  let browser: Awaited<ReturnType<typeof launchOwnedChrome>> | undefined;
  try {
    browser = await launchOwnedChrome({ userDataDir: path.join(root, "chrome"), headless: true });
    app.library.saveRun({ ...capture, status: "passed" });
    app.library.saveRun({ ...capture, id: "run-newer", status: "failed", at: 2 });
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1200, height: 800 });
    page.setDefaultTimeout(5000);
    await page.goto(`http://127.0.0.1:${app.port}`);
    const cli = path.resolve(__dirname, "../../src/app/cli.js");
    const opened = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "open", `bao://receipt/${capture.id}`, "--home", app.library.root], {
        env: { ...process.env, HOME: home, BAO_HOME: app.library.root, BAO_HEAL_CURSOR_ACCOUNT: "0" }, timeout: 10_000,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(opened.status, 0, opened.stderr + opened.stdout);
    assert.deepEqual(JSON.parse(opened.stdout), { ok: true, opened: { kind: "receipt", id: capture.id, link: `bao://receipt/${capture.id}`, request: 1 } });
    await page.waitForSelector(`.run-row[data-open-run="${capture.id}"][aria-current="true"]`);
    await page.waitForSelector("#run-receipt");
    const state = await (await fetch(`http://127.0.0.1:${app.port}/api/state`)).json() as { opened: { kind: string; id: string } };
    assert.equal(state.opened.kind, "receipt");
    assert.equal(state.opened.id, capture.id);
    assert.throws(() => app.library.read("agent-browser"));
    await page.locator('[data-place="workflows"]').click();
    await page.waitForSelector('[data-place="workflows"][aria-current="page"]');
    const reopened = await fetch(`http://127.0.0.1:${app.port}/api/open`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ link: `bao://receipt/${capture.id}` }),
    });
    assert.equal(reopened.status, 200);
    await page.waitForSelector(`.run-row[data-open-run="${capture.id}"][aria-current="true"]`);
    await page.waitForSelector("#run-receipt");
    const missing = await fetch(`http://127.0.0.1:${app.port}/api/open`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ link: "bao://receipt/absent" }),
    });
    assert.equal(missing.status, 404);
  } finally {
    await browser?.close();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
