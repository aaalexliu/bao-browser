import { fixtureDoc, fixtureStep, fixtureInput, withStep, writeStep } from "../support/fixture-step";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { oneTimeCodeInput, reusableInputs, STRIPPED_SECRET } from "../../../shared/saved-secrets";
import { secretArg } from "../../src/v1/auth";
import { runField } from "../../src/app/views";
import { startApp } from "../../src/app/server";
import { editInput } from "../../src/v1/input-token";
import { BrowserDriver } from "../../src/v1/browser-driver";
import { explain, interpret, type TrailEvent } from "../../src/v1/interpret";
import { replay, withInputDefaults, type Driver, type ReplayOptions } from "../../src/v1/replay";
import { checkMatch, stepQuery, stepLocators, stepInputName, stepValueTemplate, stepCheck, validateWorkflow, type Identity, type WorkflowStep, type WorkflowV2 } from "../../src/v1/schema";
import { testChromium } from "../../src/test-browser";
import { applyHermeticApp } from "../runtime";

const secret = "BaoSecretFixture9kQ7m";
const field: Identity = { surface: "dom", role: "textbox", id: "credential", nameAttr: "credential", path: [] };
const doc = (step: object): WorkflowV2 => (fixtureDoc({
  schema: "bao.workflow/v4", version: 2, id: "secret-regression", name: "Secret regression", createdAt: 1,
  startUrl: "http://127.0.0.1/", inputs: [], steps: [fixtureStep(step)],
}));

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

test("secret slots keep typed values and replay beside an unchanged ordinary field", { timeout: 60_000 }, async (t) => {
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
      assert.equal(workflow.inputs[0]!.default, entry.name === "one time code" ? undefined : secret, entry.name);
      assert.deepEqual(events, original, entry.name);
      assert.deepEqual(validateWorkflow(workflow), [], entry.name);
      const slot = workflow.steps[0]!;
      assert.equal(workflow.inputs.find((input) => input.name === stepInputName(slot))?.type, "secret", entry.name);
      assert.equal(stepValueTemplate(slot), `{{${stepInputName(slot)}}}`);
      assert.equal(stepQuery(slot)?.id, "credential");
      assert.equal(stepQuery(slot)?.nameAttr, "credential");
      const query = stepQuery(slot);
      assert.equal(query?.id, "credential");
      assert.equal(query?.nameAttr, "credential");
      assert.equal(query?.label, "Credential");
      assert.equal(JSON.stringify(query).includes(secret), false);
      assert.deepEqual(stepLocators(slot), [{ kind: "role", role: "textbox", name: "Credential" }, { kind: "css", value: "#credential" }]);
      assert.equal(stepCheck(slot), undefined);
      assert.equal(stepCheck(slot), undefined);
      assert.equal(slot.when, undefined);
      const ordinary = interpret([events[1]!], { id: "ordinary", startUrl: url }).steps[0]!;
      assert.deepEqual(workflow.steps[1], { ...ordinary, id: "slots-1", index: 1 }, entry.name);
      assert.ok(stepLocators(ordinary)?.some((locator) => locator.kind === "role" && locator.name === "Display name"));
      assert.equal(checkMatch(stepCheck(ordinary)), "Saved display name");

      const page = await browser.newPage();
      try {
        await page.goto(url);
        const args = Object.fromEntries(workflow.inputs.map((input) => [input.name, input.default ?? ""]));
        args[stepInputName(slot)!] = secret;
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

test("OTP history never supplies defaults or past-run inputs, while fresh input replays", async () => {
  for (const autocomplete of ["one-time-code", "section-login ONE-TIME-CODE"]) {
    const event: TrailEvent = {
      id: "otp", ts: 1, kind: "act", op: "type", value: "123456",
      identity: { ...field, autocomplete },
    };
    const workflow = interpret([event], { id: "otp-history", startUrl: "http://127.0.0.1/" });
    const input = workflow.inputs[0]!;
    assert.equal(event.value, "123456");
    assert.equal(input.default, undefined);
    input.default = "123456";
    assert.deepEqual(withInputDefaults(workflow, {}), {});
    assert.equal(secretArg(workflow, {}, input.name), "");
    assert.equal(secretArg(workflow, { [input.name]: "654321" }, input.name), "654321");
    assert.deepEqual(reusableInputs(workflow, { [input.name]: "123456", ordinary: "Ada" }), { ordinary: "Ada" });
    assert.match(runField({ ...input, fresh: oneTimeCodeInput(workflow, input.name) }, "234567"), /value=""/);
    const edited = editInput(workflow, { name: input.name, default: "345678" });
    assert.ok(edited.doc);
    assert.equal(edited.doc.inputs[0]!.default, undefined);
    const fills: string[] = [];
    const driver: Driver = {
      tree: async () => ({ nodes: [stepQuery(workflow.steps[0]!)!], texts: [], values: [] }),
      snapshot: async () => ({}),
      click: async () => {}, fill: async (_node, value) => { fills.push(value); }, key: async () => {},
      upload: async () => {}, drop: async () => {}, digits: async () => {}, check: async () => {},
      notify: async () => {}, sleep: async () => {},
    };
    await replay(workflow, {}, driver);
    assert.equal(fills.includes("123456"), false);
    fills.length = 0;
    const fresh = await replay(workflow, { [input.name]: "654321" }, driver);
    assert.equal(fresh.status, "passed", fresh.failure?.reason);
    assert.deepEqual(fills, ["654321"]);
    assert.equal(input.default, "123456");
    const bound = { ...workflow, steps: [withStep(workflow.steps[0]!, { input: undefined })] };
    assert.deepEqual(withInputDefaults(bound, {}), {});
  }
});

test("past-input route filters current OTP fields without changing saved history or explicit run-link values", { timeout: 30_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-otp-inputs-"));
  const app = await startApp({ home, port: 0 });
  try {
    const workflow = doc(fixtureStep({
      id: "otp", index: 0, action: "type", label: "Code", surface: "dom", timeoutMs: 1000,
      input: "code", value: "{{code}}", identity: { ...field },
    }));
    workflow.inputs = [
      fixtureInput({ name: "code", type: "text", label: "Code", default: "123456" }),
      fixtureInput({ name: "ordinary", type: "text", label: "Display name" }),
      fixtureInput({ name: "password", type: "secret", label: "Password" }),
      fixtureInput({ name: "count", type: "number", label: "Count" }),
    ];
    app.library.save(workflow);
    const history = { code: "123456", ordinary: "Ada", password: secret, count: 2 };
    app.library.savePublicInputs(workflow.id, history);
    const historyPath = path.join(app.library.root, "inputs", `${workflow.id}.json`);
    const historyBytes = readFileSync(historyPath, "utf8");
    const base = `http://127.0.0.1:${app.port}`;
    const endpoint = `${base}/api/workflows/${workflow.id}/inputs`;
    const ordinary = await fetch(endpoint);
    assert.equal(ordinary.status, 200);
    assert.deepEqual(await ordinary.json(), history);

    for (const type of ["text", "secret"] as const) {
      for (const binding of ["input", "value"] as const) {
        workflow.inputs[0]!.type = type;
        const otp = workflow.steps[0]!;
        if ((otp.action === "type" || otp.action === "digits") && otp.target) otp.target = { ...otp.target, hint: { ...otp.target.hint, autocomplete: "section-login ONE-TIME-CODE" } };
        writeStep(workflow.steps[0]!, { input: binding === "input" ? "code" : undefined });
        app.library.save(workflow);
        const saved = app.library.read(workflow.id);
        const past = await fetch(endpoint);
        assert.equal(past.status, 200);
        assert.deepEqual(await past.json(), { ordinary: "Ada", password: secret, count: 2 }, `${type} ${binding}`);
        assert.deepEqual(await (await fetch(`${base}/api/workflows/${workflow.id}`)).json(), saved);
        assert.equal(readFileSync(historyPath, "utf8"), historyBytes);
        assert.deepEqual(app.library.readPublicInputs(workflow.id), history);
        assert.equal(saved.inputs[0]!.default, "123456");

        const link = `bao://run/${workflow.id}?inputs=${encodeURIComponent(JSON.stringify({ code: "654321", ordinary: "Grace" }))}`;
        const opened = await fetch(`${base}/api/open`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ link }),
        });
        assert.equal(opened.status, 200);
        const body = await opened.json() as { opened: { inputs: Record<string, string> } };
        assert.deepEqual(body.opened.inputs, { code: "654321", ordinary: "Grace" });
      }
    }
    assert.equal(readFileSync(historyPath, "utf8"), historyBytes);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("plain Replay uses the current saved secret while pinned and run-link inputs stay explicit", { timeout: 90_000 }, async () => {
  const envKeys = ["BAO_HOME", "BAO_CHROME_USER_DATA", "BAO_HEADED", "BAO_HEAL_CURSOR_ACCOUNT", "BAO_OS_HELPER", "BAO_EXTENSION_HOST", "BAO_CURSOR_AGENT", "BAO_BROWSER"];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const dirs = applyHermeticApp("replay-secret-default");
  const submissions: Record<string, string>[] = [];
  const fixture = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    res.setHeader("content-type", "text/html");
    if (url.pathname === "/submit") {
      submissions.push(Object.fromEntries(url.searchParams));
      res.end("<!doctype html><p>Submitted</p>");
      return;
    }
    res.end(`<!doctype html><form action="/submit">
      <label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label>
      <label>Display name <input id="display" name="display"></label>
      <label>Code <input id="code" name="code" autocomplete="one-time-code"></label>
      <button type="submit">Submit</button></form>`);
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const app = await startApp({ home: dirs.home, port: 0, extensionHost: false, chromeProfilesRoot: dirs.chromeUserData });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const page = await browser.newPage();
  try {
    const address = fixture.address();
    assert.ok(address && typeof address !== "string");
    const workflow: WorkflowV2 = fixtureDoc({
      schema: "bao.workflow/v4", version: 2, id: "replay-secret-default", name: "Replay secret default", createdAt: 1,
      startUrl: `http://127.0.0.1:${address.port}/`,
      inputs: [
        fixtureInput({ name: "password", type: "secret", label: "Password", default: "old-password" }),
        fixtureInput({ name: "display", type: "text", label: "Display name", default: "Saved display" }),
        fixtureInput({ name: "code", type: "text", label: "Code", default: "111111" }),
      ],
      steps: [
        ...["password", "display", "code"].map((name, index): WorkflowStep => (fixtureStep({
          id: name, index, action: "type", label: name, surface: "dom", timeoutMs: 5000, heal: "never",
          input: name, value: `{{${name}}}`,
          identity: { surface: "dom", role: "textbox", id: name, path: [], ...(name === "code" ? { autocomplete: "one-time-code" } : {}) },
        }))),
        fixtureStep({
          id: "submit", index: 3, action: "click", label: "Submit", surface: "dom", timeoutMs: 5000, heal: "never",
          identity: { surface: "dom", role: "button", name: "Submit", path: [] },
          postcondition: { kind: "text", match: "Submitted", timeoutMs: 5000 },
        }),
      ],
    });
    app.library.save(workflow);
    const base = `http://127.0.0.1:${app.port}`;
    const password = page.locator('#args [name="password"]');
    const display = page.locator('#args [name="display"]');
    const code = page.locator('#args [name="code"]');
    async function openPlain(): Promise<void> {
      await page.goto(base);
      await page.click('#rail [data-place="workflows"]');
      await page.click(`[data-open-workflow="${workflow.id}"]`);
      await page.click(`[data-screen="replay"][data-workflow="${workflow.id}"]`);
      await password.waitFor();
    }
    async function submit(): Promise<void> {
      const [response] = await Promise.all([
        page.waitForResponse((item) => item.url() === `${base}/api/replay` && item.request().method() === "POST"),
        page.click("#run"),
      ]);
      const run = await response.json() as { id?: string; runId?: string; status: string; modelCalls: number; failure?: unknown };
      assert.equal(response.ok(), true, JSON.stringify(run));
      assert.equal(run.status, "passed", JSON.stringify(run.failure));
      assert.equal(run.modelCalls, 0);
      const runId = run.id || run.runId;
      assert.ok(runId);
      await page.click('#rail [data-place="runs"]');
      await page.locator(`[data-open-run="${runId}"]`).first().click();
      const evidence = page.locator("#run-evidence");
      await evidence.waitFor();
      if (await evidence.getAttribute("open") === null) await evidence.locator(":scope > summary").click();
      await page.locator("#rerun-run").waitFor();
    }
    await openPlain();
    assert.equal(await password.inputValue(), "old-password");
    assert.equal(await code.inputValue(), "");
    await display.fill("Previous display");
    await code.fill("123456");
    await submit();
    assert.deepEqual(submissions, [{ password: "old-password", display: "Previous display", code: "123456" }]);

    const edited = await fetch(`${base}/api/workflows/${workflow.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputEdit: { name: "password", default: "new-password" } }),
    });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json() as WorkflowV2).inputs.find((input) => input.name === "password")?.default, "new-password");
    await page.click("#rerun-run");
    await password.waitFor();
    assert.equal(await password.inputValue(), "old-password");
    assert.equal(await display.inputValue(), "Previous display");
    assert.equal(await code.inputValue(), "");

    await openPlain();
    assert.equal(await password.inputValue(), "new-password");
    assert.equal(await display.inputValue(), "Previous display");
    assert.equal(await code.inputValue(), "");
    await code.fill("234567");
    await submit();
    assert.deepEqual(submissions[1], { password: "new-password", display: "Previous display", code: "234567" });

    const explicit = { password: "link-password", display: "Link display", code: "345678" };
    const opened = await fetch(`${base}/api/open`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ link: `bao://run/${workflow.id}?inputs=${encodeURIComponent(JSON.stringify(explicit))}` }),
    });
    assert.equal(opened.status, 200);
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('#args [name="password"]')?.value === "link-password");
    assert.equal(await display.inputValue(), "Link display");
    assert.equal(await code.inputValue(), "345678");
    await submit();
    assert.deepEqual(submissions[2], explicit);
    assert.equal(submissions.length, 3);
    assert.equal(app.library.read(workflow.id).inputs.find((input) => input.name === "password")?.default, "new-password");
  } finally {
    await browser.close();
    await app.close();
    await new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()));
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    rmSync(path.dirname(dirs.home), { recursive: true, force: true });
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
        const fallback = stepLocators(interpret([{ ...event, locators: undefined }], meta).steps[0]!);
        for (const workflow of [interpret([event], meta), explain([event], meta).workflow]) {
          assert.equal(workflow.inputs[0]!.default, secret);
          const query = stepQuery(workflow.steps[0]!);
          assert.equal(query?.id, identity.id);
          assert.equal(query?.name, identity.name);
          assert.equal(JSON.stringify(query).includes(secret), false);
          assert.deepEqual(stepLocators(workflow.steps[0]!), neighbors.length ? safe : fallback);
          assert.deepEqual(validateWorkflow(workflow), []);
        }
        const ordinary = interpret([{ ...event, sensitive: false }], meta);
        assert.deepEqual(stepLocators(ordinary.steps[0]!), event.locators);
        assert.deepEqual(event, original);
      }
    }
  }
});

test("every replay exit waits for capture before copying without stripping values", async () => {
  const base: WorkflowStep = fixtureStep({ id: "entry", index: 0, action: "click", label: secret, surface: "dom", timeoutMs: 0, identity: { ...field, role: "button", id: "missing" } });
  const cases: { name: string; step?: object; opts?: ReplayOptions; expected: string; triage?: string }[] = [
    { name: "never", step: { heal: "never" }, expected: "failed", triage: "never" },
    { name: "blocker", step: { heal: "never", waitFor: { kind: "text", match: "Ready", timeoutMs: 0 } }, expected: "failed", triage: "never" },
    { name: "circuit", opts: { circuitOpen: true }, expected: "failed", triage: "circuit" },
    { name: "unresolved", step: { unresolved: { reason: "recorded miss" } }, expected: "failed", triage: "never" },
    { name: "stripped", step: { action: "type", value: STRIPPED_SECRET }, expected: "failed" },
    { name: "human pause", step: { action: "confirm", human: true }, opts: { yieldHuman: true }, expected: "paused" },
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
    const handoff = result.trail?.[1];
    if (row.name === "human pause") {
      assert.ok(handoff?.kind === "handoff");
      assert.ok(Number.isFinite(handoff.ts));
      assert.match(handoff.text || "", /^Handoff started /);
    }
    assert.deepEqual(result.trail, [
      trail[0],
      ...(row.name === "human pause" ? [{ kind: "handoff", stepId: "entry", phase: "start", ts: handoff?.ts, text: handoff?.text }] : []),
    ], row.name);
    assert.equal(trail[0]!.value, secret, row.name);
    assert.equal(result.console?.[0]?.text, secret, row.name);
    assert.equal(result.network?.[0]?.url, `https://example.test/${secret}`, row.name);
    if (result.failure) assert.deepEqual(result.failure.snapshot, { dom: { op: "type", value: secret, label: secret }, ax: snapshot.ax }, row.name);
  }
});
