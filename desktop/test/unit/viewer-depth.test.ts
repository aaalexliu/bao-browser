import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv from "ajv/dist/2020";
import { chromium } from "playwright";
import { BrowserDriver } from "../../src/v1/browser-driver";
import { consolePane, identityTable, networkPane, runViewer, snapshotPane, workflowDetail } from "../../src/app/views";
import { filmstripSpans, idleSkippedMs } from "../../src/v1/filmstrip";
import { stepPolicy } from "../../src/v1/heal";
import { actWaitMs, DEFAULT_ACT_TIMEOUT_MS } from "../../src/v1/human-ask";
import { replay, type Driver, type LiveTree } from "../../src/v1/replay";
import { validateWorkflow, type Identity, type WorkflowStep, type WorkflowV2 } from "../../src/v1/schema";
import { circuitOpen, classifyFailure } from "../../src/v1/triage";

const schema = JSON.parse(readFileSync(path.join(process.cwd(), "schema/workflow-v2.schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

function ident(partial: Partial<Identity>): Identity {
  return { surface: "dom", role: "button", path: [], ...partial };
}

function step(partial: Partial<WorkflowStep> & Pick<WorkflowStep, "id" | "action">): WorkflowStep {
  return { index: 0, label: partial.label || partial.action, surface: "dom", timeoutMs: 0, ...partial };
}

function doc(steps: WorkflowStep[]): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id: "wf",
    name: "Freeze",
    startUrl: "http://127.0.0.1/freeze",
    createdAt: 1,
    inputs: [],
    steps: steps.map((item, index) => ({ ...item, index })),
  };
}

function tree(nodes: Identity[], extra: Partial<LiveTree> = {}): LiveTree {
  return { nodes, texts: [], values: [], ...extra };
}

function fake(pages: LiveTree[]): Driver {
  let n = 0;
  const current = () => pages[Math.min(n, pages.length - 1)]!;
  return {
    tree: async () => current(),
    snapshot: async () => ({ dom: "Status: none" }),
    click: async () => { n += 1; },
    fill: async () => {},
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    sleep: async () => {},
    markStep: () => {},
    captureStep: async () => ({ dom: [{ role: "button", name: "Continue", testId: "apply" }], ax: "- button \"Continue\"" }),
    trace: () => ({
      console: [{ stepId: "apply", type: "info", text: "bao fixture ready" }],
      network: [{ stepId: "apply", method: "GET", url: "http://127.0.0.1/freeze", status: 200 }],
    }),
  };
}

const healer = {
  available: () => true,
  propose: async () => {
    throw new Error("a model was called");
  },
};

test("a miss is a change, a blocker, or an outage before any model call", () => {
  assert.equal(classifyFailure({ phase: "find", reason: "tie" }), "change");
  assert.equal(classifyFailure({ phase: "wait_for", reason: "Ready" }), "blocker");
  assert.equal(classifyFailure({ phase: "expect", reason: "waiting for you to log in" }), "blocker");
  assert.equal(classifyFailure({ phase: "expect", reason: "gone: Loading" }), "blocker");
  assert.equal(classifyFailure({ phase: "find", reason: "net::ERR_CONNECTION_REFUSED" }), "outage");
  assert.equal(classifyFailure({ phase: "find", reason: "status 503" }), "outage");
});

test("auto-heal opens a circuit after three failures in the window", () => {
  const now = 1_000_000;
  const recent = [0, 1, 2].map((i) => ({ status: "failed", at: now - i * 1000 }));
  assert.equal(circuitOpen(recent, now), true);
  assert.equal(circuitOpen(recent.slice(0, 2), now), false);
  assert.equal(circuitOpen(recent.map((run) => ({ ...run, at: now - 11 * 60 * 1000 })), now), false);
  assert.equal(circuitOpen(recent, now, { limit: 0 }), false);
});

test("the filmstrip drops idle gaps and sizes frames by the step", () => {
  const spans = filmstripSpans([
    { id: "a", startedAt: 0, endedAt: 400 },
    { id: "b", startedAt: 900, endedAt: 1100 },
    { id: "c", startedAt: 8000, endedAt: 8600 },
  ]);
  assert.deepEqual(spans.map((span) => span.flex), [400, 200, 600]);
  assert.deepEqual(spans.map((span) => span.skippedMs), [0, 0, 6900]);
  assert.equal(idleSkippedMs([
    { id: "a", startedAt: 0, endedAt: 100 },
    { id: "b", startedAt: 5000, endedAt: 5100 },
  ]), 4900);
});

test("a step policy of never or ask wins over the workflow", () => {
  const workflow = doc([step({ id: "c", action: "confirm" })]);
  workflow.heal = "auto";
  assert.equal(stepPolicy({ heal: "never" }, workflow, {}), "never");
  assert.equal(stepPolicy({ heal: "ask" }, workflow, {}), "approve");
  assert.equal(stepPolicy({ heal: "auto" }, workflow, { heal: "approve" }), "auto");
  assert.equal(stepPolicy({}, workflow, { heal: "approve" }), "auto");
});

test("an explicit step timeout of zero does not become the two-hour default", () => {
  assert.equal(actWaitMs(0), 0);
  assert.equal(actWaitMs(40), 40);
  assert.equal(actWaitMs(undefined), DEFAULT_ACT_TIMEOUT_MS);
  assert.equal(actWaitMs(0, 120 * 60 * 1000), 120 * 60 * 1000);
});

test("never, a blocker, and an open circuit do not call a model", async () => {
  const missing = tree([ident({ role: "button", testId: "apply", text: "Continue" })]);
  const click = step({
    id: "apply",
    action: "click",
    label: 'Click "Submit freeze"',
    intent: "Submit freeze",
    identity: ident({ testId: "missing-apply", text: "Submit freeze" }),
  });
  const refused = await replay(doc([{ ...click, heal: "never" }]), {}, fake([missing]), { heal: healer });
  assert.equal(refused.status, "failed");
  assert.equal(refused.steps[0]?.triage, "never");
  assert.equal(refused.modelCalls, 0);
  assert.equal(refused.steps[0]?.snapshot?.ax, "- button \"Continue\"");
  assert.equal(refused.console?.[0]?.text, "bao fixture ready");

  const waiting = doc([step({
    id: "w",
    action: "click",
    identity: ident({ testId: "go", text: "Go" }),
    waitFor: { kind: "text", match: "Ready", timeoutMs: 0 },
  })]);
  const blocked = await replay(waiting, {}, fake([tree([ident({ testId: "go", text: "Go" })], { texts: [] })]), { heal: healer });
  assert.equal(blocked.steps[0]?.triage, "blocker");
  assert.match(blocked.steps[0]?.reason || "", /^wait_for:/);

  const burst = await replay(doc([click]), {}, fake([missing]), { heal: healer, circuitOpen: true });
  assert.equal(burst.steps[0]?.triage, "circuit");
  assert.equal(burst.heals.length, 0);
});

test("ask pauses on a real change and a step heal value validates", async () => {
  const missing = tree([ident({ role: "button", testId: "apply", text: "Continue" })]);
  const click = step({
    id: "apply",
    action: "click",
    label: 'Click "Submit freeze"',
    intent: "Submit freeze",
    identity: ident({ testId: "missing-apply", text: "Submit freeze" }),
    heal: "ask",
  });
  const paused = await replay(doc([click]), {}, fake([missing]), {
    heal: {
      available: () => true,
      propose: async () => ({
        patch: { identity: ident({ testId: "apply", text: "Continue" }) },
        model: { provider: "cursor", name: "cursor", version: "live" },
        prompt: "live",
        rawResponse: "{}",
      }),
    },
  });
  assert.equal(paused.status, "paused");
  assert.equal(paused.steps[0]?.reason, "approve");
  const workflow = doc([click]);
  assert.deepEqual(validateWorkflow(workflow), []);
  assert.equal(validate(workflow), true);
});

test("an accessibility snapshot drops a password line and keeps the other controls", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html><body>
      <label>Password <input id="password" name="password" type="password" value="SuperSecretPassword!"></label>
      <button id="file-submit" type="button">Upload file</button>
    </body>`);
    const driver = new BrowserDriver(page);
    await driver.tree();
    const shot = await driver.captureStep();
    assert.match(shot.ax || "", /Upload file/);
    assert.equal((shot.ax || "").includes("SuperSecretPassword!"), false);
    assert.equal((shot.ax || "").toLowerCase().includes("password"), false);
    assert.equal((shot.dom || []).some((node) => node.id === "password"), false);
  } finally {
    await browser.close();
  }
});

test("the run viewer links a failure to its step and shows the snapshot", () => {
  const html = runViewer({
    id: "run-14",
    workflowId: "wf",
    status: "failed",
    modelCalls: 0,
    steps: [
      { id: "a", status: "passed", startedAt: 0, endedAt: 200 },
      {
        id: "c",
        status: "failed",
        phase: "find",
        reason: "tie",
        startedAt: 5000,
        endedAt: 5400,
        triage: "blocker",
        snapshot: { dom: [{ role: "button", name: "Upload file", testId: "file-submit" }], ax: "- button \"Upload file\"" },
      },
    ],
    console: [{ stepId: "c", type: "info", text: "bao fixture ready" }],
    network: [{ stepId: "c", method: "GET", url: "http://127.0.0.1/fixture", status: 200 }],
    failure: { stepId: "c", index: 1, phase: "find", reason: "tie" },
  }, { name: "upload note", steps: [{ id: "c", label: "click Upload" }] }, "c");
  assert.match(html, /id="open-failed-step"[^>]*data-select-step="c"/);
  assert.match(html, /id="idle-note"/);
  assert.match(html, /data-skipped="4800"/);
  assert.match(html, /id="triage"/);
  assert.match(html, /temporary blocker/);
  assert.match(html, /testId=file-submit/);
  assert.match(html, /Upload file/);
  assert.match(consolePane([{ stepId: "c", type: "info", text: "bao fixture ready" }], "c"), /bao fixture ready/);
  assert.match(networkPane([{ stepId: "open", method: "GET", url: "http://127.0.0.1/fixture", status: 200 }], "c"), /page load/);
  assert.match(snapshotPane(undefined, undefined), /No DOM snapshot/);
  const scores = identityTable({
    accepted: false,
    lead: 10,
    candidates: [{ label: "Upload file", score: 80, attrs: [{ attr: "name", recorded: "Upload", live: "Upload file", matched: false, points: 12 }] }],
  });
  assert.match(scores, />80</);
  assert.match(scores, /12/);
  const cards = workflowDetail({
    id: "wf",
    name: "upload note",
    steps: [{ id: "apply", action: "confirm", label: "Apply", heal: "never" }],
  });
  assert.match(cards, /data-step-heal="apply"/);
  assert.match(cards, /value="never" selected/);
});
