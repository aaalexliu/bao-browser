import assert from "node:assert/strict";
import test from "node:test";
import { actBar, commandItems, healDetail, healInbox, healWorkflowName, identityTable, imageRef, importErrorCard, libraryTable, onboarding, passGrid, plainFailure, promotionLine, rail, recordBar, runViewer, stopHeadline, workflowDetail } from "../../src/app/views";
import { importErrorView } from "../../src/app/import-error";
import { attentionCount, formatWait, makeAsk } from "../../src/v1/human-ask";
import { lookup } from "../../src/v1/identity";
import { viewFromLookup } from "../../src/v1/run-trace";
import { paddedClip } from "../../src/v1/shots";
import { ensureTrailTimes } from "../../src/v1/trail-time";
import type { Identity } from "../../src/v1/schema";

function id(partial: Partial<Identity>): Identity {
  return { surface: "dom", role: "button", path: [], ...partial };
}

test("confirm act bar names the button and has no approve control", () => {
  const ask = makeAsk({
    kind: "confirm",
    workflowId: "wf",
    workflowName: "experian: unfreeze",
    stepId: "apply",
    stepIndex: 5,
    stepCount: 6,
    label: 'you press "Apply"',
    button: "Apply",
    timeoutMs: 125000,
    now: 1_000,
  });
  const html = actBar({ activeAsk: ask }, 1_000);
  assert.match(html, /You need to act · experian: unfreeze · step 5 of 6/);
  assert.match(html, /Press Apply in the Bao Chrome window\. bao will not press it\./);
  assert.match(html, /Waiting 2:05 · times out /);
  assert.match(html, /run stops, nothing applied/);
  assert.equal(html.includes("act-continue"), false);
  assert.equal(html.includes(">Approve<"), false);
  assert.equal(html.includes("Keep"), false);
  assert.match(formatWait(1_000, ask.deadline, "run stops, nothing applied"), /nothing applied/);
});

test("login act bar offers continue and does not press the site button", () => {
  const ask = makeAsk({
    kind: "login",
    workflowId: "wf",
    workflowName: "experian: unfreeze",
    stepId: "login",
    stepIndex: 2,
    stepCount: 6,
    label: "sign in",
    timeoutMs: 90000,
    now: 0,
  });
  const html = actBar({ activeAsk: ask }, 0);
  assert.match(html, /Sign in in the Bao Chrome window/);
  assert.match(html, /not recording keystrokes in password fields/);
  assert.match(html, /I'm signed in, continue/);
  assert.equal(html.includes(">Approve<"), false);
  assert.equal(html.includes("Press Apply"), false);
  assert.match(html, /still signed out/);
});

test("attention count covers the ask, the import, and undecided heals", () => {
  const html = rail({
    recording: true,
    helper: { label: "helper off" },
    model: { label: "no model" },
    activeAsk: makeAsk({
      kind: "confirm", workflowId: "w", workflowName: "w", stepId: "s", stepIndex: 1, stepCount: 1, label: "Apply", button: "Apply", timeoutMs: 1000, now: 0,
    }),
    pendingImport: { phase: "confirm", domain: "example.com" },
    runs: [{ id: "r", workflowId: "w", status: "passed", heals: [{ id: "h1" }], decisions: [] }],
  });
  assert.match(html, /data-screen="library"/);
  assert.match(html, /data-screen="capture"/);
  assert.match(html, /data-screen="runs"/);
  assert.match(html, /data-screen="heals"/);
  assert.match(html, /data-screen="settings"/);
  assert.equal(html.includes("data-screen=\"trail\""), false);
  assert.match(html, /id="attention" data-count="3"/);
  assert.match(html, /id="heal-count">1/);
  assert.match(html, /recording/);
  assert.match(html, /helper off/);
  assert.match(html, /no model/);
  assert.equal(attentionCount({ ask: { kind: "confirm" }, importPhase: "confirm", pendingHeals: 1 }), 3);
});

test("import errors render code, cause, and hint from the structured fields", () => {
  const view = importErrorView({
    code: "keychain_denied",
    cause: "You clicked Deny on the Keychain prompt.",
    hint: "Try again and click Allow.",
  });
  const html = importErrorCard(view);
  assert.match(html, /data-error-code="keychain_denied"/);
  assert.match(html, /You clicked Deny on the Keychain prompt/);
  assert.match(html, /Try again and click Allow/);
  assert.equal(html.includes("could not import"), false);
  const mapped = importErrorView("keychain prompt was not approved");
  assert.equal(mapped.code, "keychain_denied");
  assert.match(mapped.cause, /Deny/);
  assert.match(mapped.hint, /Allow/);
  const fallback = importErrorView("import failed");
  assert.equal(fallback.code, "import_failed");
  assert.equal(fallback.cause.includes("could not import"), false);
});

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
  assert.match(line, /Step 1 "click Upload": two candidates scored 80 and 70 \(lead 10 < 25\)/);
  assert.match(line, /What changed since recording: name "Upload" → "Upload file"/);
  const table = identityTable(view);
  assert.match(table, />80</);
  assert.match(table, />70</);
  assert.match(table, /Upload file/);
  assert.match(table, /✓/);
  assert.match(table, /≠/);
});

test("run viewer shows the stop, one segment per step, and zero model calls", () => {
  const query = id({ name: "Upload", id: "file-submit" });
  const nodes = [
    id({ text: "Upload file", id: "file-submit" }),
    id({ text: "Upload", id: "other-upload" }),
  ];
  const view = viewFromLookup(query, nodes);
  const refused = runViewer({
    id: "run-14",
    workflowId: "wf",
    status: "failed",
    modelCalls: 0,
    steps: [
      { id: "a", status: "passed", startedAt: 1000, endedAt: 1400 },
      { id: "b", status: "passed", startedAt: 1400, endedAt: 2500 },
      { id: "c", status: "failed", startedAt: 2500, endedAt: 3000, identity: view, reason: "tie" },
      { id: "d", status: "pending" },
    ],
    failure: { stepId: "c", index: 2, intent: "click Upload", reason: "tie", brokenAttr: "roleName", identity: view },
  }, {
    name: "upload note",
    steps: [
      { id: "a", label: "open" },
      { id: "b", label: "upload" },
      { id: "c", label: "click Upload" },
      { id: "d", label: "check" },
    ],
  });
  assert.match(refused, /id="why-stopped"/);
  assert.match(refused, /Step 3 (&quot;|")click Upload(&quot;|")/);
  assert.match(refused, /name (&quot;|")Upload(&quot;|") → (&quot;|")Upload file(&quot;|")/);
  assert.equal((refused.match(/class="seg /g) || []).length, 4);
  assert.match(refused, /data-steps="4"/);
  assert.match(refused, /id="model-calls">0 model calls/);
  assert.match(refused, /id="video-bar"/);
  assert.match(refused, /data-marker="c"/);
  const passed = runViewer({
    id: "run-2",
    workflowId: "wf",
    status: "passed",
    modelCalls: 0,
    steps: [{ id: "a", status: "passed", startedAt: 1, endedAt: 2 }],
  }, { name: "calculator add", steps: [{ id: "a", label: "equals" }] });
  assert.match(passed, /0 model calls/);
  assert.match(passed, /passed/);
});

test("heal review shows both targets, hides the prompt, and masks a secret", () => {
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
    failedStep: { id: "c", label: "click Upload", identity: { role: "button", name: "Upload", id: "file-submit" } },
    proposedPatch: { identity: { role: "button", name: "Upload file", id: "file-submit" } },
    postconditionPassed: true,
    identity: viewFromLookup(id({ name: "Upload", id: "file-submit" }), [
      id({ text: "Upload file", id: "file-submit" }),
      id({ text: "Upload", id: "other-upload" }),
    ]),
  }, ["SuperSecretPassword!"]);
  assert.match(html, /Recorded/);
  assert.match(html, /Proposed/);
  assert.match(html, /Upload file/);
  assert.match(html, /id=file-submit/);
  assert.match(html, /<details id="heal-prompt">/);
  assert.equal(html.includes("heal-prompt\" open"), false);
  assert.equal(html.includes("SuperSecretPassword!"), false);
  assert.match(html, /\[secret\]/);
  assert.match(html, /data-keep="heal-1"/);
  assert.match(html, /data-revert="heal-1"/);
  assert.match(html, /Candidates/);
  assert.match(html, /The heal record is not edited/);
});

test("a heal shows its own workflow, never a sibling name", () => {
  const html = healInbox([
    {
      id: "run-login",
      workflowId: "wf-text",
      status: "passed",
      decisions: [],
      heals: [{ id: "h1", workflowId: "wf-login", failedStep: { id: "login", label: "Click login" } }],
    },
  ], [
    { id: "wf-login", name: "fixture login", steps: 1 },
    { id: "wf-text", name: "textedit write", steps: 2 },
  ]);
  assert.match(html, /fixture login/);
  assert.equal(html.includes("textedit write"), false);
  assert.equal(healWorkflowName(
    { workflowId: "missing", failedStep: { label: "Click login" } },
    { workflowId: "wf-text" },
    new Map([["wf-text", "textedit write"]]),
  ), "Click login");
});

test("library cards show a sparkline, inputs, and search", () => {
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
  assert.match(html, /data-screen="replay"/);
  assert.match(html, /class="spark"/);
  assert.equal((html.match(/class="swatch /g) || []).length, 7);
  assert.match(html, /class="legend"/);
  assert.equal(html.includes("<img"), false);
  assert.equal(imageRef("run-1", "not-a-png"), "");
  assert.equal(imageRef("run-1", "AAAASECRETBYTES"), "");
  assert.match(imageRef("run-1", "step-after.png"), /\/api\/runs\/run-1\/shots\/step-after\.png/);
  assert.match(html, /\{\{note\}\}/);
  assert.match(html, /secret/);
  assert.match(html, />file</);
  assert.match(html, /id="library-search"/);
  assert.match(html, /⌘K/);
  assert.match(html, /class="status failed"/);
  assert.match(html, /class="wf-title"/);
  assert.match(html, /class="wf-foot"/);
  const titleAt = html.indexOf("wf-title");
  const footAt = html.indexOf("wf-foot");
  assert.ok(titleAt > 0 && titleAt < footAt);
  assert.match(libraryTable([], []), /No workflows yet/);
});

test("workflow steps are cards with identity, inputs, expect, and human styling", () => {
  const html = workflowDetail({
    id: "wf",
    name: "fixture apply",
    steps: [
      { id: "a", action: "login", label: "Sign in", human: true, intent: "sign in first", sensitive: true },
      { id: "b", action: "type", label: "Type {{note}}", value: "{{note}}", input: "note", identity: { role: "textbox", name: "Note" }, expect: { kind: "text" } },
      { id: "c", action: "verify", label: "re-read the status" },
      { id: "d", action: "upload", label: "Upload file" },
      { id: "e", action: "confirm", label: "confirm before applying", human: true, intent: "you press Apply" },
    ],
  });
  assert.match(html, /class="step-card human"/);
  assert.match(html, /textbox · Note/);
  assert.match(html, /\{\{note\}\}/);
  assert.match(html, /secret/);
  assert.match(html, />file</);
  assert.match(html, /badge expect">expect/);
  assert.match(html, /badge expect">verify/);
  assert.match(html, /data-screen="replay"/);
  assert.match(html, /you press Apply/);
  assert.match(html, /id="workflow-steps"/);
  const steps = html.slice(html.indexOf("workflow-steps"));
  assert.ok(steps.indexOf("Type {{note}}") < steps.indexOf("re-read the status"));
  assert.ok(steps.indexOf("re-read the status") < steps.indexOf("confirm before applying"));
  assert.match(html, /class="crumb"/);
  assert.match(html, /data-screen="library"/);
  assert.equal(html.includes("id=\"library\""), false);
  assert.equal(html.includes("<img"), false);
  assert.match(html, /class="ph"/);
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
  assert.match(html, /id="identity-table"/);
  assert.match(html, /id="snapshot-inspector"/);
  assert.match(html, /data-run-tab="console"/);
  assert.match(html, /data-run-tab="network"/);
  assert.match(plainFailure({ phase: "auth" }), /did not heal the redirect/);
  assert.equal(passGrid([], []).includes("pass-grid"), false);
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
    failedStep: { label: "Click login" },
    proposedPatch: { identity: { testId: "login" } },
  }, [], {
    workflowName: "fixture login",
    promotion: { status: "provisional", drift: "passed", replays: 1, healId: "heal-1" },
  });
  assert.match(detail, /id="heal-workflow">fixture login/);
  assert.match(detail, /data-status="provisional"/);
  assert.match(detail, /data-keep="heal-1"/);
  assert.equal(detail.includes("textedit write"), false);
});

test("the record bar and the permission card follow live state", () => {
  const bar = recordBar({ recording: true, capturePaused: true, recordingSince: 10 });
  assert.match(bar, /id="rec-timer"/);
  assert.match(bar, /id="rec-stop"/);
  assert.match(bar, /Mark step/);
  assert.match(bar, />Resume</);
  const off = onboarding({ label: "helper off", accessibility: false, screenCapture: false });
  assert.match(off, /data-perm="accessibility" data-ok="false"/);
  assert.match(off, /data-perm="screen" data-ok="false"/);
  assert.match(off, /not granted yet/);
  assert.equal(off.includes("data-ok=\"true\""), false);
  const on = onboarding({ label: "helper ok", accessibility: true, screenCapture: true });
  assert.match(on, /data-ok="true"/);
  assert.match(on, /allowed/);
  assert.ok(commandItems([{ id: "wf", name: "fixture apply" }]).some((item) => item.label === "Run fixture apply" && item.screen === "replay"));
});

test("a target clip stays inside the viewport and is larger than the control", () => {
  const clip = paddedClip({ x: 400, y: 300, width: 80, height: 28 }, { width: 1280, height: 800 });
  assert.ok(clip.width >= 240);
  assert.ok(clip.height >= 140);
  assert.ok(clip.x >= 0 && clip.y >= 0);
  assert.ok(clip.x + clip.width <= 1280);
  assert.ok(clip.y + clip.height <= 800);
  assert.ok(clip.x < 440 && clip.x + clip.width > 440);
  const bar = paddedClip({ x: 0, y: 40, width: 1280, height: 36 }, { width: 1280, height: 800 });
  assert.ok(bar.width <= 560);
  assert.equal(bar.x, 0);
});

test("a trail with a missing timestamp gets one", () => {
  const timed = ensureTrailTimes([{ id: "a", ts: 10 }, { id: "b" }, { id: "c", ts: 0 }]);
  assert.equal(timed.filled, 2);
  assert.equal(timed.events[0]?.ts, 10);
  assert.equal(timed.events[1]?.ts, 11);
  assert.equal(timed.events[2]?.ts, 12);
  const same = ensureTrailTimes([{ id: "a", ts: 4 }]);
  assert.equal(same.filled, 0);
  assert.equal(same.events[0]?.ts, 4);
});
