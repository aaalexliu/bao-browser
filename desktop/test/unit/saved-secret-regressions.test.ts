import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { scrubSaved, STRIPPED_SECRET } from "../../../shared/saved-secrets";
import { BrowserDriver } from "../../src/v1/browser-driver";
import { explain, interpret, type TrailEvent } from "../../src/v1/interpret";
import { replay, type Driver, type ReplayOptions } from "../../src/v1/replay";
import { validateWorkflow, type Identity, type WorkflowStep, type WorkflowV2 } from "../../src/v1/schema";
import { testChromium } from "../../src/test-browser";

const secret = "BaoSecretFixture9kQ7m";
const field: Identity = { surface: "dom", role: "textbox", id: "credential", nameAttr: "credential", path: [] };
const doc = (step: WorkflowStep): WorkflowV2 => ({
  schema: "bao.workflow/v2", version: 2, id: "secret-regression", name: "Secret regression", createdAt: 1,
  startUrl: "http://127.0.0.1/", inputs: [], steps: [step],
});

// Each entry reaches interpretation, ordinary-neighbor inference, and real browser replay.
const entries: { name: string; identity?: Partial<Identity>; event?: Partial<TrailEvent> }[] = [
  { name: "password role", identity: { role: "password" } },
  { name: "password input type", identity: { inputType: "password" } },
  { name: "password autocomplete", identity: { autocomplete: "current-password" } },
  { name: "one time code", identity: { autocomplete: "one-time-code" } },
  { name: "marked entry", event: { sensitive: true } },
  { name: "listed secret" },
  { name: "live field naming", event: { sensitive: true, source: { agent: "live-model", vendor: "bao", adapter: "cdp-live" } } },
];

test("secret slots keep only field structure and replay beside an unchanged ordinary field", { timeout: 60_000 }, async (t) => {
  const server = createServer((_req, res) => res.end(`<!doctype html><html><body>
    <label>Credential <input id="credential" name="credential" type="password" autocomplete="current-password"></label>
    <label>Display name <input id="display" name="display" oninput="document.querySelector('output').textContent='Saved display name'"></label>
    <output></output></body></html>`));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/`;
  const browser = await testChromium.launch({ headless: true });
  try {
    for (const entry of entries) {
      const events: TrailEvent[] = [{
        id: "entry", ts: 1, kind: "act", op: "type", value: secret,
        identity: { ...field, ...entry.identity, text: secret, value: secret, name: "Credential", label: "Credential", placeholder: "Credential", title: "Credential", description: "Private entry", cssPath: "#credential", xpath: '//*[@id="credential"]', path: [{ role: "form", name: "Credential form" }] },
        locators: [{ kind: "text", value: secret }, { kind: "role", role: "textbox", name: secret }, { kind: "role", role: "textbox", name: "Credential" }, { kind: "css", value: "#credential" }],
        afterText: `welcome ${secret}`, subtreeBefore: "", subtreeAfter: secret, valueAfter: secret,
        skipWhen: secret,
        ...entry.event,
      }, {
        id: "display", ts: 2, kind: "act", op: "type", value: "Ada",
        identity: { surface: "dom", role: "textbox", id: "display", nameAttr: "display", name: "Display name", text: "Display name", path: [] },
        afterText: "Saved display name",
      }];
      const original = structuredClone(events);
      const meta = { id: "slots", startUrl: url, secrets: entry.name === "listed secret" ? [secret] : undefined };
      const workflow = interpret(events, meta);
      assert.equal(JSON.stringify(workflow).includes(secret), false, entry.name);
      assert.deepEqual(events, original, entry.name);
      assert.deepEqual(validateWorkflow(workflow), [], entry.name);
      const slot = workflow.steps[0]!;
      assert.equal(workflow.inputs.find((input) => input.name === slot.input)?.type, "secret", entry.name);
      assert.equal(slot.value, `{{${slot.input}}}`);
      assert.equal(slot.identity?.id, "credential");
      assert.equal(slot.identity?.nameAttr, "credential");
      const { text, value, ...structure } = events[0]!.identity!;
      assert.deepEqual(slot.identity, structure);
      assert.deepEqual(slot.locators, [{ kind: "role", role: "textbox", name: "Credential" }, { kind: "css", value: "#credential" }]);
      assert.equal(slot.expect, undefined);
      assert.equal(slot.postcondition, undefined);
      assert.equal(slot.when, undefined);
      const ordinary = interpret([events[1]!], { id: "ordinary", startUrl: url }).steps[0]!;
      assert.deepEqual(workflow.steps[1], { ...ordinary, id: "slots-1", index: 1 }, entry.name);
      assert.ok(ordinary.locators?.some((locator) => locator.name === "Display name"));
      assert.equal(ordinary.expect?.match, "Saved display name");

      const page = await browser.newPage();
      try {
        await page.goto(url);
        const args = Object.fromEntries(workflow.inputs.map((input) => [input.name, input.default ?? ""]));
        args[slot.input!] = secret;
        const result = await replay(workflow, args, new BrowserDriver(page));
        assert.equal(result.status, "passed", `${entry.name}: ${result.failure?.phase}: ${result.failure?.reason}`);
        assert.equal(result.modelCalls, 0);
        assert.deepEqual(result.heals, []);
        assert.equal(await page.locator("#credential").inputValue(), secret);
        assert.equal(await page.locator("#display").inputValue(), "Ada");
      } finally { await page.close(); }
    }
  } finally {
    await browser.close();
  }
});

test("secret-entry locator echoes use the typed value without changing structural neighbors", () => {
  const identity: Identity = { ...field, name: "Credential" };
  const safe = [
    { kind: "text" as const, value: "Credential" },
    { kind: "role" as const, role: "textbox", name: "Credential" },
    { kind: "css" as const, value: "#credential" },
    { kind: "xpath" as const, value: '//*[@id="credential"]' },
  ];
  const echoes = [
    { kind: "text" as const, value: secret },
    { kind: "role" as const, role: "textbox", name: secret },
  ];
  for (const preserveActions of [false, true]) {
    for (const echo of echoes) {
      for (const neighbors of [safe, []]) {
        const event: TrailEvent = {
          id: "entry", ts: 1, kind: "act", op: "type", sensitive: true,
          value: secret, identity, locators: [echo, ...neighbors],
        };
        const original = structuredClone(event);
        const meta = { id: "locator-echo", startUrl: "http://127.0.0.1/", preserveActions };
        const fallback = interpret([{ ...event, locators: undefined }], meta).steps[0]!.locators;
        for (const workflow of [interpret([event], meta), explain([event], meta).workflow]) {
          assert.equal(JSON.stringify(workflow).includes(secret), false);
          assert.deepEqual(workflow.steps[0]!.identity, identity);
          assert.deepEqual(workflow.steps[0]!.locators, neighbors.length ? safe : fallback);
          assert.deepEqual(validateWorkflow(workflow), []);
        }
        const ordinary = interpret([{ ...event, sensitive: false }], meta);
        assert.deepEqual(ordinary.steps[0]!.locators, event.locators);
        assert.deepEqual(event, original);
      }
    }
  }
});

test("every replay exit waits for capture before copying and strips only owned whole values", async () => {
  const base: WorkflowStep = { id: "entry", index: 0, action: "click", label: secret, surface: "dom", timeoutMs: 0, identity: { ...field, role: "button", id: "missing" } };
  const cases: { name: string; step?: Partial<WorkflowStep>; opts?: ReplayOptions; expected: string; triage?: string }[] = [
    { name: "never", step: { heal: "never" }, expected: "failed", triage: "never" },
    { name: "blocker", step: { waitFor: { kind: "text", match: "Ready", timeoutMs: 0 } }, expected: "failed", triage: "blocker" },
    { name: "circuit", opts: { circuitOpen: true }, expected: "failed", triage: "circuit" },
    { name: "unresolved", step: { unresolved: { reason: "recorded miss" } }, expected: "failed" },
    { name: "stripped", step: { action: "type", value: STRIPPED_SECRET }, expected: "failed" },
    { name: "trust pause", opts: { siteTrust: "ask" }, expected: "paused" },
    { name: "passed", step: { action: "note" }, expected: "passed" },
    { name: "skipped", step: { when: { input: "branch", value: "other" } }, expected: "failed" },
    { name: "capture failure", step: { action: "note" }, expected: "passed" },
  ];
  for (const row of cases) {
    let release!: () => void;
    let captured!: () => void;
    const captureStarted = new Promise<void>((resolve) => { captured = resolve; });
    const captureReady = new Promise<void>((resolve) => { release = resolve; });
    const snapshot = { dom: [{ role: "button", name: secret, text: `welcome ${secret}`, testId: "continue" }], ax: '- button "Continue"' };
    const trail = [{ kind: "click" as const, stepId: "entry", op: "type", value: secret, label: secret }];
    const driver: Driver = {
      tree: async () => ({ nodes: [], texts: [], values: [] }),
      snapshot: async () => ({ dom: { op: "type", value: secret, label: secret }, ax: snapshot.ax }),
      click: async () => {}, fill: async () => {}, key: async () => {}, upload: async () => {}, drop: async () => {}, digits: async () => {}, check: async () => {}, notify: async () => {}, sleep: async () => {},
      captureStep: async () => { captured(); await captureReady; if (row.name === "capture failure") throw new Error("capture unavailable"); return snapshot; },
      trace: () => ({ console: [{ text: secret }], network: [{ url: `https://example.test/${secret}` }] }),
    };
    let settled = false;
    const resultPromise = replay(doc({ ...base, ...row.step }), {}, driver, {
      ...row.opts, secrets: [secret], trail,
      heal: { available: () => true, propose: async () => { throw new Error("model called"); } },
    }).then((result) => { settled = true; return result; });
    await captureStarted;
    assert.equal(settled, false, row.name);
    release();
    const result = await resultPromise;
    assert.equal(result.status, row.expected, row.name);
    assert.equal(result.steps[0]?.triage, row.triage, row.name);
    assert.deepEqual(result.steps[0]?.snapshot, row.name === "capture failure" ? undefined : snapshot, row.name);
    assert.equal(result.modelCalls, 0, row.name);
    assert.deepEqual(result.trail, [{ ...trail[0], value: STRIPPED_SECRET }], row.name);
    assert.equal(trail[0]!.value, secret, row.name);
    assert.equal(result.console?.[0]?.text, secret, row.name);
    assert.equal(result.network?.[0]?.url, `https://example.test/${secret}`, row.name);
    assert.deepEqual(scrubSaved(result, { secrets: [secret] }), result, row.name);
    if (result.failure) assert.deepEqual(result.failure.snapshot, { dom: { op: "type", value: STRIPPED_SECRET, label: secret }, ax: snapshot.ax }, row.name);
  }
});
