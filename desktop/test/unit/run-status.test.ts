import assert from "node:assert/strict";
import test from "node:test";
import { libraryTable, runKind, runsList, statusLabel, workflowDetail, type RunSummary } from "../../src/app/views";

function run(status: string): RunSummary {
  return { id: "run", workflowId: "wf", status };
}

test("the run viewer and the Runs list share one status word", () => {
  assert.equal(statusLabel(runKind(run("failed"))), "failed");
  assert.equal(statusLabel(runKind(run("timed-out"))), "stopped, timed out");
  assert.equal(statusLabel(runKind(run("timeout"))), "stopped, timed out");
  assert.equal(statusLabel(runKind(run("needs_human"))), "needs you");
  assert.equal(statusLabel(runKind(run("paused"))), "needs you");
  assert.equal(statusLabel(runKind(run("waiting-for-sign-in"))), "waiting for sign-in");
  assert.equal(statusLabel(runKind(run("needs_signin"))), "waiting for sign-in");
});

test("a sign-in wait reads Waiting for sign-in with the pause glyph in Needs you and in history", () => {
  const html = runsList([{ ...run("waiting-for-sign-in"), at: Date.now() }], []);
  const states = [...html.matchAll(/<span class="run-state ([^"]+)">([^<]+)<\/span>/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(states, [["paused", "Waiting for sign-in"], ["waiting-for-sign-in", "Waiting for sign-in"]]);
  const glyphs = [...html.matchAll(/<span class="run-glyph [^"]+" aria-hidden="true">(<svg.*?<\/svg>)<\/span>/g)].map((match) => match[1]);
  assert.equal(glyphs.length, 2);
  assert.equal(glyphs[1], glyphs[0]);
});

test("a workflow whose last run waits for sign-in says so with the pause glyph", () => {
  const waiting = { ...run("waiting-for-sign-in"), at: Date.now() };
  const doc = { id: "wf", name: "Account", steps: [] };
  for (const html of [libraryTable([{ ...doc, steps: 0 }], [waiting]), workflowDetail(doc, { runs: [waiting] })]) {
    assert.match(html, /class="(?:status|wf-run-status) waiting-for-sign-in"><svg[^>]*><circle[^>]*\/><path d="M5\.2 4v6M8\.8 4v6"/);
    assert.match(html, /<\/svg>Waiting for sign-in</);
  }
});
