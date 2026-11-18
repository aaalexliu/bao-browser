import assert from "node:assert/strict";
import test from "node:test";
import { healDetail, healInbox, healWorkflowName, identityTable, imageRef, libraryTable, passGrid, plainFailure, promotionLine, runViewer, stopHeadline, workflowDetail } from "../../src/app/views";
import { lookup } from "../../src/v1/identity";
import { viewFromLookup } from "../../src/v1/run-trace";
import type { Identity } from "../../src/v1/schema";

function id(partial: Partial<Identity>): Identity {
  return { surface: "dom", role: "button", path: [], ...partial };
}

test("a tie names both scores and the attribute that changed", () => {
  const query = id({ name: "Upload", id: "file-submit" });
  const nodes = [
    id({ text: "Upload file", id: "file-submit" }),
    id({ text: "Upload", id: "other-upload" }),
  ];
  const hit = lookup(query, nodes);
  assert.equal(hit.ok, false);
  assert.equal(hit.reason, "tie");
  assert.equal(hit.ranked[0]?.score, 80);
  assert.equal(hit.ranked[1]?.score, 70);
  assert.equal(hit.margin, 10);
  const view = viewFromLookup(query, nodes);
  const line = stopHeadline({ stepNumber: 1, label: "click Upload", identity: view, reason: hit.reason, brokenAttr: hit.brokenAttr });
  assert.match(line, /Step 1, click Upload: two candidates scored 80 and 70 \(lead 10 < 25\)/);
  assert.match(line, /What changed since recording: name "Upload" → "Upload file"/);
  const table = identityTable(view);
  assert.match(table, />80</);
  assert.match(table, />70</);
  assert.match(table, /Upload file/);
  assert.match(table, /✓/);
  assert.match(table, /≠/);
});

test("heal review shows both targets and retains the collapsed prompt text", () => {
  const html = healDetail({
    id: "run-9",
    workflowId: "wf",
    status: "passed",
    decisions: [],
    heals: [],
  }, {
    id: "heal-1",
    mode: "auto",
    intent: "click Upload",
    prompt: "the password is SuperSecretPassword! please",
    rawResponse: "{\"identity\":true} SuperSecretPassword!",
    model: { name: "bao-heal-fixture", version: "1" },
    failedStep: { id: "c", caption: { text: "click Upload" }, action: "click", target: { locators: [{ kind: "role", role: "button", name: "Upload" }], hint: { id: "file-submit" } } },
    proposedPatch: { identity: { role: "button", name: "Upload file", id: "file-submit" } },
    postconditionPassed: true,
    identity: viewFromLookup(id({ name: "Upload", id: "file-submit" }), [
      id({ text: "Upload file", id: "file-submit" }),
      id({ text: "Upload", id: "other-upload" }),
    ]),
  });
  assert.match(html, /Recorded/);
  assert.match(html, /Proposed/);
  assert.match(html, /Upload file/);
  assert.match(html, /id=file-submit/);
  assert.match(html, /<details id="heal-prompt">/);
  assert.equal(html.includes("heal-prompt\" open"), false);
  assert.equal(html.includes("SuperSecretPassword!"), true);
  assert.doesNotMatch(html, /\[secret\]/);
  assert.match(html, /data-keep="heal-1"/);
  assert.match(html, /data-revert="heal-1"/);
  assert.match(html, /Candidates/);
  assert.match(html, /The heal record is not edited/);
});

test("target review uses the recorded step index, honest evidence and promotion progress", () => {
  const run = { id: "review-run", workflowId: "statements", status: "failed" };
  const heal = {
    id: "review-target", ts: 1, failedStep: { index: 2, identity: { role: "link", name: "Statements", path: [{ role: "navigation", name: "Main menu" }] } },
    proposedPatch: { identity: { role: "menuitem", name: "Statements", path: [{ role: "menu", name: "Accounts" }] } },
  };
  const html = healDetail(run, heal, { promotion: { status: "provisional", replays: 1, need: 3 } });
  assert.match(html, /<h2>Step 3 moved<\/h2>/);
  assert.match(html, /Old target<\/dt><dd>“Statements” link in “Main menu” navigation/);
  assert.match(html, /New target<\/dt><dd>“Statements” menuitem in “Accounts” menu/);
  assert.match(html, /heal-count">1 of 3/);
  assert.equal((html.match(/<i class="passed">/g) || []).length, 1);
  assert.equal((html.match(/<i><\/i>/g) || []).length, 2);
  assert.match(html, /Review the new target before keeping it/);
  assert.doesNotMatch(html, /finished|January|recorded Oct|shot-slider/);
  const unknown = healDetail(run, { id: "missing" });
  assert.match(unknown, /Target not recorded/);
  assert.match(unknown, /Not recorded/);
  assert.equal((unknown.match(/No picture stored/g) || []).length, 2);
  assert.doesNotMatch(unknown, /0 of 3|datetime=/);
  const kept = healDetail({ ...run, decisions: [{ ts: 1, healId: heal.id, decision: "keep" }] }, heal);
  assert.match(kept, /Target kept/);
  assert.match(kept, /Saved this target as a draft/);
  for (const status of ["provisional", "promoted", "reverted"]) {
    for (const decision of ["keep", "revert"] as const) {
      const decided = healDetail({ ...run, decisions: [{ ts: 1, healId: heal.id, decision }] }, heal, { promotion: { status, replays: 1, need: 3 } });
      assert.match(decided, decision === "keep" ? /Target kept/ : /Target reverted/);
      assert.match(decided, decision === "keep" ? /Saved this target as a draft/ : /Saved the recorded target as a draft/);
      assert.doesNotMatch(decided, /Keep it now/);
    }
  }
  const reverted = healDetail(run, heal, { promotion: { status: "reverted", replays: 1, need: 3 } });
  assert.match(reverted, /Target reverted/);
  assert.match(reverted, /Bao reverted this target/);
});

test("a heal shows its own workflow, never a sibling name", () => {
  const html = healInbox([
    {
      id: "run-login",
      workflowId: "wf-text",
      status: "passed",
      decisions: [],
      heals: [{ id: "h1", workflowId: "wf-login", failedStep: { id: "login", caption: { text: "Click login" } } }],
    },
  ], [
    { id: "wf-login", name: "fixture login", steps: 1 },
    { id: "wf-text", name: "textedit write", steps: 2 },
  ]);
  assert.match(html, /fixture login/);
  assert.equal(html.includes("textedit write"), false);
  assert.equal(healWorkflowName(
    { workflowId: "missing", failedStep: { caption: { text: "Click login" } } },
    { workflowId: "wf-text" },
    new Map([["wf-text", "textedit write"]]),
  ), "Click login");
});

test("Workflows list shows the latest run without input chips or placeholder pictures", () => {
  const html = libraryTable([
    {
      id: "wf",
      name: "fixture apply",
      steps: 2,
      waits: 1,
      expects: 1,
      firstStep: { label: "Sign in" },
      inputs: [{ name: "note", type: "text" }, { name: "password", type: "secret" }, { name: "upload", type: "file" }],
    },
  ], [
    { id: "r1", workflowId: "wf", status: "passed", at: 1 },
    { id: "r2", workflowId: "wf", status: "failed", at: 2 },
  ]);
  assert.doesNotMatch(html, /data-screen="replay"/);
  assert.match(html, /<table id="workflow-list"/);
  assert.match(html, /Workflows, newest run first/);
  assert.doesNotMatch(html, /class="spark"|class="legend"|class="chip|data-shot/);
  assert.equal(html.includes("<img"), false);
  assert.equal(imageRef("run-1", "not-a-png"), "");
  assert.equal(imageRef("run-1", "AAAASECRETBYTES"), "");
  assert.match(imageRef("run-1", "step-after.png"), /\/api\/runs\/run-1\/shots\/step-after\.png/);
  assert.doesNotMatch(html, /\{\{note\}\}|>secret<|>file</);
  assert.match(html, /id="library-search"/);
  assert.match(html, /⌘K/);
  assert.match(html, /class="status failed"/);
  assert.match(html, /data-open-workflow="wf">fixture apply<\/button>/);
  assert.match(html, /aria-label="Search workflows"/);
  assert.match(html, /class="library-record" data-screen="capture"/);
  assert.match(html, /<time datetime="1970-01-01T00:00:00.002Z">/);
  const sorted = libraryTable([
    { id: "none", name: "Not run", steps: 0 },
    { id: "older", name: "Older run", steps: 0 },
    { id: "newer", name: "Newer run", steps: 0 },
  ], [
    { id: "latest", workflowId: "newer", status: "failed", at: 20 },
    { id: "old", workflowId: "newer", status: "passed", at: 1 },
    { id: "other", workflowId: "older", status: "passed", at: 10 },
  ]);
  assert.ok(sorted.indexOf('data-open-workflow="newer"') < sorted.indexOf('data-open-workflow="older"'));
  assert.ok(sorted.indexOf('data-open-workflow="older"') < sorted.indexOf('data-open-workflow="none"'));
  assert.match(sorted, /Not run yet/);
  for (const at of [undefined, Number.MAX_VALUE]) {
    assert.match(libraryTable([{ id: "unknown", name: "Unknown time", steps: 0 }], [{ id: "r", workflowId: "unknown", status: "passed", at }]), /Time not saved/);
  }
  assert.match(libraryTable([], []), /No workflows yet/);
  const split = libraryTable([], [], [], ["library data is at /legacy; using /fresh"]);
  assert.match(split, /id="library-split"/);
  assert.match(split, /library data is at \/legacy; using \/fresh/);
});

test("workflow detail has compact ordered steps, one inspector, and no placeholder pictures", () => {
  const html = workflowDetail({
    id: "wf",
    name: "fixture apply",
    steps: [
      { id: "a", action: "handoff", reason: "sign-in", caption: { text: "Sign in" } },
      { id: "b", action: "type", caption: { text: "Type {{note}}" }, text: { input: "note" }, target: { locators: [{ kind: "role", role: "textbox", name: "Note" }] }, check: { kind: "text" } },
      { id: "c", action: "verify", caption: { text: "re-read the status" } },
      { id: "d", action: "upload", caption: { text: "Upload file" } },
      { id: "e", action: "handoff", reason: "owner-press", caption: { text: "you press Apply" } },
    ],
  });
  assert.match(html, /data-step-row="a" class="selected"/);
  assert.match(html, /Waits for you/);
  assert.match(html, /The “Note” box/);
  assert.match(html, /\{\{note\}\}/);
  assert.match(html, /Upload file/);
  assert.match(html, /Then checks the page/);
  assert.equal((html.match(/id="workflow-step-help"/g) || []).length, 1);
  assert.match(html, /data-screen="replay"/);
  assert.match(html, /you press Apply/);
  assert.match(html, /id="workflow-steps"/);
  const steps = html.slice(html.indexOf("workflow-steps"));
  assert.ok(steps.indexOf("Type {{note}}") < steps.indexOf("re-read the status"));
  assert.ok(steps.indexOf("re-read the status") < steps.indexOf("you press Apply"));
  assert.match(html, /aria-label="Back to all workflows"/);
  assert.match(html, /data-screen="library"/);
  assert.equal(html.includes("id=\"library\""), false);
  assert.equal(html.includes("<img"), false);
  assert.doesNotMatch(html, /class="ph"/);
  assert.match(html, /data-testid="share-menu"/);
  assert.match(html, /data-testid="share-copy" data-copy="bao:\/\/workflow\/wf"/);
  assert.match(html, /data-testid="share-publish" disabled/);
  assert.match(html, /Pair this Mac before listing/);
  assert.match(html, /data-testid="share-export"/);
  assert.equal(html.includes('data-testid="share-export" disabled'), false);
  assert.match(html, /data-testid="share-guide"/);
  assert.equal(html.includes('data-testid="share-guide" disabled'), false);
  assert.equal(html.includes('data-testid="deeplink"'), false);
  assert.equal(html.includes('data-testid="import-link"'), false);
  const routed = workflowDetail({
    id: "wf",
    name: "Note either way",
    inputs: [
      { name: "username", type: "text" },
      { name: "route", type: "choice", label: "Which way", choices: ["Log in first", "Already signed in"] },
    ],
    steps: [{ id: "u", action: "type", caption: { text: "Type {{username}}" }, text: { input: "username" }, when: { input: "route", value: "Log in first" } }],
  });
  assert.match(routed, /id="route-branch"[^>]*>Paths: Log in first \/ Already signed in</);
  assert.match(routed, /\{\{username\}\}/);
  assert.equal(routed.includes(">{{route}}<"), false);
  assert.equal(routed.includes('data-testid="deeplink"'), false);
  const empty = workflowDetail({ id: "empty", name: "Empty", steps: [] });
  assert.match(empty, /data-testid="share-export" disabled/);
  assert.match(empty, /data-testid="share-guide" disabled/);
  assert.match(empty, /This workflow has no steps to export/);
  const cropped = workflowDetail({
    id: "wf",
    name: "fixture apply",
    steps: [{ id: "signed-in", action: "click", caption: { text: "Click signed in" } }],
  }, { shots: { "signed-in": "/api/runs/run-1/shots/signed-in-after.png" } });
  assert.match(cropped, /data-shot="\/api\/runs\/run-1\/shots\/signed-in-after\.png"/);
  assert.match(cropped, /class="wf-picture"/);
});

test("a failed run says the phase, the change, what bao tried, and shows the grid", () => {
  const html = runViewer({
    id: "run-14",
    workflowId: "wf",
    status: "failed",
    modelCalls: 0,
    repairs: [{ stepId: "c", repair: "label", detail: "visible label" }],
    receipts: [{ stepId: "c", source: "dom", expected: "Applied", actual: "Waiting", pass: false }],
    trajectory: [{ stepId: "c", action: "click", target: "button#file-submit", postcondition: "text Applied", timing: "lt1s" }],
    steps: [{ id: "c", status: "failed", phase: "find", reason: "tie", startedAt: 1, endedAt: 2 }],
    failure: { stepId: "c", index: 0, phase: "find", reason: "tie", identity: { accepted: false, changed: 'name "Upload" → "Upload file"', candidates: [] } },
  }, {
    name: "upload note",
    steps: [{ id: "c", label: "click Upload" }],
  }, "c", {
    recent: [
      { id: "run-14", workflowId: "wf", status: "failed", steps: [{ id: "c", status: "failed" }] },
      { id: "run-2", workflowId: "wf", status: "passed", steps: [{ id: "c", status: "passed" }], heals: [{ id: "h", failedStep: { id: "c" } }] },
    ],
    recorded: [{ stepId: "c", action: "click", target: "button[testid=missing]", postcondition: "text Applied", timing: "lt1s" }],
  });
  assert.match(html, /id="plain-failure"/);
  assert.match(html, /Phase find/);
  assert.match(html, /What changed: name/);
  assert.match(html, /Bao tried label/);
  assert.match(html, /id="scrubber"/);
  assert.equal((html.match(/class="frame /g) || []).length, 1);
  assert.equal(html.includes("<img"), false);
  assert.match(html, /class="legend"/);
  assert.match(html, /id="pass-grid"/);
  assert.match(html, /class="cell failed"/);
  assert.match(html, /class="cell healed"/);
  assert.match(html, /id="repairs"/);
  assert.match(html, /does not match/);
  assert.match(html, /id="trajectory"/);
  assert.match(html, /aimed at/);
  assert.match(html, /id="open-failed-step"/);
  assert.match(html, /No steps ran/);
  assert.equal(html.includes("Nothing after step 0"), false);
  assert.match(html, /id="identity-table"/);
  assert.match(html, /id="snapshot-inspector"/);
  assert.match(html, /data-run-tab="console"/);
  assert.match(html, /data-run-tab="network"/);
  assert.match(plainFailure({ phase: "auth" }), /did not heal the redirect/);
  assert.equal(passGrid([], []).includes("pass-grid"), false);
  const grid = passGrid([
    { id: "run-new", workflowId: "wf", status: "failed", at: Date.UTC(2026, 9, 22, 16, 2), steps: [{ id: "c", status: "failed" }] },
    { id: "run-old", workflowId: "wf", status: "passed", at: Date.UTC(2026, 9, 22, 15, 0), steps: [{ id: "c", status: "passed" }] },
  ], [{ id: "c", label: "click Upload" }]);
  assert.ok(grid.indexOf("run-old") < grid.indexOf("run-new"));
  assert.match(grid, /title="run-old · /);
  assert.match(grid, /title="run-new · /);
  assert.equal(grid.includes(">Step<"), false);
  assert.equal(/<thead[\s\S]*class="swatch/.test(grid), false);
  assert.match(grid, /scope="row">click Upload/);
});

test("a provisional heal can be shown as promoted without editing the record", () => {
  const open = promotionLine({ status: "provisional", drift: "pending", replays: 1 });
  assert.match(open, /data-status="provisional"/);
  assert.match(open, /1 of 3/);
  assert.match(open, /later real runs/);
  const kept = promotionLine({ status: "promoted", replays: 2 });
  assert.match(kept, /data-status="promoted"/);
  const detail = healDetail({
    id: "run-9", workflowId: "wf-login", status: "passed", decisions: [], heals: [],
  }, {
    id: "heal-1",
    workflowId: "wf-login",
    failedStep: { caption: { text: "Click login" } },
    proposedPatch: { identity: { testId: "login" } },
  }, {
    workflowName: "fixture login",
    promotion: { status: "provisional", drift: "passed", replays: 1, healId: "heal-1" },
  });
  assert.match(detail, /id="heal-workflow">fixture login/);
  assert.match(detail, /data-status="provisional"/);
  assert.match(detail, /data-keep="heal-1"/);
  assert.equal(detail.includes("textedit write"), false);
});
