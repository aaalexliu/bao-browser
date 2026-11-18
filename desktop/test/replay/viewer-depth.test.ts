import { testWorkflow } from "../support/workflow";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv from "ajv/dist/2020";
import { runViewer, type RunSummary } from "../../src/app/views";
import { stepPolicy } from "../../src/v1/heal";
import { actWaitMs, DEFAULT_ACT_TIMEOUT_MS } from "../../src/v1/human-ask";
import { replay, type Driver, type LiveTree } from "../../src/v1/replay";
import { validateWorkflow, type Identity, type WorkflowStep, type WorkflowV2 } from "../../src/v1/schema";
import { circuitOpen, classifyFailure } from "../../src/v1/triage";

const schema = JSON.parse(readFileSync(path.join(process.cwd(), "schema/workflow.schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

function ident(partial: Partial<Identity>): Identity {
  return { surface: "dom", role: "button", path: [], ...partial };
}

function doc(steps: WorkflowStep[]): WorkflowV2 {
  return testWorkflow({
    schema: "bao.workflow/v4",
    id: "wf",
    name: "Freeze",
    startUrl: "http://127.0.0.1/freeze",
    createdAt: 1,
    inputs: [],
    steps: steps.map((item, index) => ({ ...item, index })),
  });
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

test("a step policy of never or ask wins over the workflow", () => {
  const workflow = doc([{
    id: "c",
    index: 0,
    timeoutMs: 0,
    caption: { text: "You press the button" },
    action: "handoff",
    reason: "owner-press",
  }]);
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
  const click: WorkflowStep = {
    id: "apply",
    index: 0,
    timeoutMs: 0,
    caption: { text: "Click \"Submit freeze\"", citation: { text: "Submit freeze", source: "text" } },
    action: "click",
    target: {
      locators: [
        { kind: "role", role: "button", name: "Submit freeze" },
        { kind: "text", value: "Submit freeze" },
        { kind: "testid", value: "missing-apply" },
        { kind: "css", value: "[data-testid=\"missing-apply\"]" },
      ],
      hint: { role: "button", surface: "dom" },
    },
  };
  const refused = await replay(doc([{ ...click, heal: "never" }]), {}, fake([missing]), { heal: healer });
  assert.equal(refused.status, "failed");
  assert.equal(refused.steps[0]?.triage, "never");
  assert.equal(refused.modelCalls, 0);
  assert.equal(refused.steps[0]?.snapshot?.ax, "- button \"Continue\"");
  assert.equal(refused.console?.[0]?.text, "bao fixture ready");

  const waiting = doc([{
    id: "w",
    index: 0,
    timeoutMs: 0,
    caption: { text: "Click Go", citation: { text: "Go", source: "text" } },
    action: "click",
    target: {
      locators: [
        { kind: "role", role: "button", name: "Go" },
        { kind: "text", value: "Go" },
        { kind: "testid", value: "go" },
        { kind: "css", value: "[data-testid=\"go\"]" },
      ],
      hint: { role: "button", surface: "dom" },
    },
    check: { kind: "text", match: "waiting", timeoutMs: 0 },
  }]);
  const blocked = await replay(waiting, {}, fake([tree([ident({ testId: "go", text: "Go" })], { texts: [] })]), { heal: healer });
  assert.equal(blocked.steps[0]?.triage, "blocker");
  assert.match(blocked.steps[0]?.reason || "", /waiting/);

  const burst = await replay(doc([click]), {}, fake([missing]), { heal: healer, circuitOpen: true });
  assert.equal(burst.steps[0]?.triage, "circuit");
  assert.equal(burst.heals.length, 0);
});

test("ask pauses on a real change and a step heal value validates", async () => {
  const missing = tree([ident({ role: "button", testId: "apply", text: "Continue" })]);
  const click: WorkflowStep = {
    id: "apply",
    index: 0,
    timeoutMs: 0,
    caption: { text: "Click \"Submit freeze\"", citation: { text: "Submit freeze", source: "text" } },
    heal: "ask",
    action: "click",
    target: {
      locators: [
        { kind: "role", role: "button", name: "Submit freeze" },
        { kind: "text", value: "Submit freeze" },
        { kind: "testid", value: "missing-apply" },
        { kind: "css", value: "[data-testid=\"missing-apply\"]" },
      ],
      hint: { role: "button", surface: "dom" },
    },
  };
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

test("a live agent-browser replay keeps identity scores and DOM and accessibility diagnostics", () => {
  const diagnostics = {
    identity: {
      accepted: false, lead: 10,
      candidates: [{ label: "Upload file", score: 80, attrs: [{ attr: "name", recorded: "Upload", live: "Upload file", matched: false, points: 12 }] }],
    },
    snapshot: { dom: [{ role: "button", name: "Upload file", testId: "file-submit" }], ax: '- button "Upload file"' },
  };
  for (const source of ["step", "failure"] as const) {
    const steps: NonNullable<RunSummary["steps"]> = [
      { id: "open", status: "passed" },
      { id: "upload", status: "failed", phase: "find", reason: "tie", ...(source === "step" ? diagnostics : {}) },
    ];
    const run: RunSummary = {
      id: "live", workflowId: "upload", pageEngine: "agent-browser", status: "failed", steps,
      failure: { stepId: "upload", index: 1, phase: "find", reason: "tie", ...(source === "failure" ? diagnostics : {}) },
    };
    for (const selectedId of [undefined, "upload"]) {
      const html = runViewer(run, { name: "Upload", recordedOnly: false, steps }, selectedId);
      assert.match(html, /<h3 class="section">Identity<\/h3>/);
      assert.match(html, /id="identity-table"/);
      assert.match(html, />80</);
      assert.match(html, /<th>name<\/th><td>Upload file 12 ≠<\/td>/);
      assert.match(html, /id="snapshot-inspector"/);
      assert.match(html, /id="dom-snapshot"[^]*testId=file-submit/);
      assert.match(html, /id="ax-snapshot"[^]*Upload file/);
    }
  }
});
