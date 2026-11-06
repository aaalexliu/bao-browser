import assert from "node:assert/strict";
import test from "node:test";
import { runViewer, type RunSummary } from "../../src/app/views";

function ownerRun(args: string[]): RunSummary {
  return {
    id: "run-owner-wait",
    kind: "capture",
    pageEngine: "agent-browser",
    workflowId: "agent-browser",
    status: "needs_human",
    steps: [{
      id: "command-1", status: "pending", label: ["wait_for_owner", ...args.map((arg) => JSON.stringify(arg))].join(" "),
      native: { command: "wait_for_owner", args },
    }],
    envelope: { status: "needs_human", reason: "owner_signin", ask: "Sign in or clear the check in the Bao window." },
  };
}

function render(run: RunSummary): string {
  return runViewer(run, { name: "agent-browser", recordedOnly: true, steps: run.steps || [] });
}

for (const [args, limit] of [
  [["60000"], "1 min"],
  [[], "1 min"],
  [["120000"], "2 min"],
  [["1500"], "1.5 s"],
  [["1"], "0.001 s"],
] as const) {
  test(`owner wait ${JSON.stringify(args)} names the check limit, not a session deadline`, () => {
    const run = ownerRun([...args]);
    const stored = JSON.stringify(run);
    const html = render(run);
    const label = `Wait for you to sign in or clear a check (up to ${limit} per check)`;
    assert.ok(html.includes(`<strong>${label}</strong>`));
    assert.ok(html.includes(`aria-label="${label}" title="${label}"`));
    assert.ok(html.includes(`waiting · up to ${limit} per check; no overall timeout`));
    assert.equal(html.includes("wait_for_owner"), false, "all visible labels, including Recent runs, use plain words");
    assert.equal(html.includes("60000"), false);
    assert.equal(JSON.stringify(run), stored, "display leaves the native record unchanged");
    assert.equal(html.includes('id="rerun-run"'), false);
  });
}

test("a completed waiting check keeps its limit while the session stays open", () => {
  const run = ownerRun(["60000"]);
  run.steps![0]!.status = "passed";
  run.steps![0]!.startedAt = 1;
  run.steps![0]!.endedAt = 60_001;
  assert.match(render(run), /waiting · up to 1 min per check; no overall timeout/);
});

for (const previous of [
  { id: "click", status: "failed", label: "Click Sign in", native: { command: "click", args: ["@e1"] } },
  { id: "earlier-check", status: "failed", native: { command: "wait_for_owner", args: ["30000"] } },
  { id: "earlier-check", status: "paused", native: { command: "wait_for_owner", args: ["30000"] } },
] as const) {
  for (const status of ["pending", "passed", "failed"] as const) {
    test(`envelope names the current ${status} check after ${previous.id} ${previous.status}`, () => {
      const run = ownerRun(["60000"]);
      run.steps![0]!.status = status;
      run.steps!.unshift({ ...previous, native: { ...previous.native, args: [...previous.native.args] } });
      const stored = JSON.stringify(run);
      const html = render(run);
      const wait = html.match(/<p id="envelope-wait">([^<]*)<\/p>/)?.[1];
      assert.equal(wait, "waiting on step 2, Wait for you to sign in or clear a check (up to 1 min per check) · no overall timeout");
      assert.match(html, /id="run-status"><strong>needs you<\/strong> at step 1/);
      assert.equal(JSON.stringify(run), stored);
      run.envelope!.deadline = "10:30 PM";
      assert.equal(render(run).match(/<p id="envelope-wait">([^<]*)<\/p>/)?.[1],
        "waiting on step 2, Wait for you to sign in or clear a check (up to 1 min per check) · 10:30 PM");
    });
  }
}

test("an invalid current check does not borrow an earlier check's limit", () => {
  const run = ownerRun(["bad"]);
  run.steps!.unshift({ id: "earlier-check", status: "failed", native: { command: "wait_for_owner", args: ["30000"] } });
  assert.equal(render(run).match(/<p id="envelope-wait">([^<]*)<\/p>/)?.[1],
    "waiting on step 2, Wait for you to sign in or clear a check · no timeout");
});

test("an invalid recorded timeout never invents a check limit", () => {
  for (const args of [["bad"], ["0"], ["120001"]]) {
    const html = render(ownerRun(args));
    assert.match(html, /<strong>Wait for you to sign in or clear a check<\/strong>/);
    assert.equal(html.includes("up to"), false);
  }
});

test("an explicit envelope deadline still wins over a check limit", () => {
  const run = ownerRun(["60000"]);
  run.envelope!.deadline = "10:30 PM";
  assert.match(render(run), /waiting · 10:30 PM/);
  assert.equal(render(run).includes("no overall timeout"), false);
});

test("ordinary workflow waits and unrelated native commands keep their labels", () => {
  const run = ownerRun(["60000"]);
  run.steps![0]!.native = { command: "wait", args: ["60000"] };
  run.steps![0]!.label = "Wait for the report";
  assert.match(render(run), /<strong>Wait for the report<\/strong>/);
  assert.match(render(run), /waiting · no timeout/);
  run.pageEngine = "old";
  run.steps![0]!.native = { command: "wait_for_owner", args: ["60000"] };
  assert.match(render(run), /<strong>Wait for the report<\/strong>/);
});

test("every filmstrip frame exposes its full escaped label, even with a screenshot", () => {
  const run = ownerRun([]);
  run.steps![0] = { id: "click", status: "passed", label: 'Click "Save" <then continue>', afterShot: "click-after.png" };
  const html = render(run);
  assert.match(html, /class="frame has-shot[^>]+aria-label="Click &quot;Save&quot; &lt;then continue&gt;" title="Click &quot;Save&quot; &lt;then continue&gt;"/);
});
