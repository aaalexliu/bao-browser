import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { createLiveHost } from "../../src/cdp-live/live-host";
import { launchOwnedChrome } from "../../src/launch";
import { applyHermeticApp } from "../runtime";
import { LiveTrail } from "../../src/cdp-live/live-trail";
import { SessionLog, publicLiveSession, readLiveSession, type LiveSessionRecord } from "../../src/cdp-live/audit";
import { logAx } from "../../src/cdp-live/ax";
import { interpret, type TrailEvent } from "../../src/v1/interpret";
import { replay, type Driver } from "../../src/v1/replay";
import { toPuppeteerReplay } from "../../src/v1/export-replay";
import { Library } from "../../src/v1/store";
import { NEEDS_SECRET_VALUE, scrubSaved, STRIPPED_SECRET } from "../../../shared/saved-secrets";
import { scrubHome } from "../../src/v1/scrub-home";
import { draftVersion, versionDocument } from "../../src/v1/versions";
import { ReceiptLog, verifyReceiptChain } from "../../src/v1/receipt";
import { writeFindDebug } from "../../src/v1/find-debug";
import { writePendingPrompt, readPendingPrompt } from "../../src/v1/pending-prompt";
import { makeAsk } from "../../src/v1/human-ask";
import { cursorHeal } from "../../src/v1/heal";
import { validateWorkflow, WORKFLOW_SCHEMA_ID, type Identity, type WorkflowStep, type WorkflowV2 } from "../../src/v1/schema";

function workflow(step: Partial<WorkflowStep> = {}): WorkflowV2 {
  return {
    schema: WORKFLOW_SCHEMA_ID, version: 2, id: "saved", name: "Saved form", createdAt: 1,
    startUrl: "https://example.test/", inputs: [],
    steps: [{ id: "entry", index: 0, action: "type", label: "Fill form", surface: "dom", timeoutMs: 50, ...step }],
  };
}

const cases: { name: string; value: string; field?: Partial<Identity>; sensitive?: boolean; secret: boolean }[] = [
  { name: "sensitive flag", value: "private-entry", sensitive: true, secret: true },
  { name: "password type", value: "private-entry", field: { inputType: "password" }, secret: true },
  { name: "password role", value: "private-entry", field: { role: "password" }, secret: true },
  ...["secret{{1}}", "prefix{{entry}}suffix", "{{private}}", "prefix {{private}} suffix", "left {private} right"].flatMap((value) => [
    { name: `sensitive brace literal ${value}`, value, sensitive: true, secret: true },
    { name: `password brace literal ${value}`, value, field: { inputType: "password" }, secret: true },
  ]),
  ...["current-password", "new-password", "one-time-code", "cc-name", "cc-given-name", "cc-additional-name", "cc-family-name", "cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-type", "cc-future-token", "section-pay shipping cc-given-name"].map((autocomplete) => ({ name: autocomplete, value: "private-entry", field: { autocomplete }, secret: true })),
  ...["4111111111111111", "4111 1111 1111 1111", "4111-1111-1111-1111", "123-45-6789", "123 45 6789", "123456789", " 123456789 ", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.c2lnbmF0dXJl", "sk-fixture123", "ghp_fixture123", "gho_fixture123", "github_pat_fixture123", "xoxb-fixture123", "xoxp-fixture123", "xoxa-fixture123", "AKIAFIXTURE123456789", "GOCSPX-fixture123"].map((value) => ({ name: value, value, secret: true })),
  ...["ordinary text", "ordinary{{1}}", "Password", "4111111111111112", "2026-11-03", "742", "hello@example.com", "reference 123456789 next", "1234567890", "4111111111111111 12/26", "token sk-fixture123 here", "card 4111 1111 1111 1111", "SSN 123-45-6789", "JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.c2lnbmF0dXJl"].map((value) => ({ name: value, value, secret: false })),
  { name: "Password button", value: "ordinary text", field: { role: "button", tag: "button", name: "Password" }, secret: false },
];

test("whole-value rules and metadata stability cross every saved surface", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-secret-table-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  for (const sample of cases) {
    for (const op of ["type", "key"] as const) {
      const value = (sample.field || sample.sensitive) && sample.secret && op === "key" ? "Shift+q" : sample.value;
      const identity: Identity = { surface: "dom", role: "textbox", tag: "input", path: [], ...sample.field };
      const event: TrailEvent = { id: "entry", ts: 1, kind: "act", op, identity, sensitive: sample.sensitive, ...(op === "key" ? { key: value } : { value }), note: `Copied: ${value}` };
      const contextDoc = workflow({ identity, sensitive: sample.sensitive, input: "entry", value: "{{entry}}" });
      contextDoc.inputs = [{ name: "entry", type: "text" }];
      const literal = workflow({ action: op, identity, sensitive: sample.sensitive, ...(op === "key" ? { key: value } : { value }) });
      if (sample.sensitive && !sample.value.includes("{")) {
        literal.steps[0] = { ...literal.steps[0]!, sensitive: true, input: "entry", value: "{{entry}}" };
        literal.inputs = [{ name: "entry", type: "text", default: value }];
      }
      const surfaces: [string, () => Promise<string> | string][] = [
        ["live trail", async () => { const trail = await LiveTrail.open(home); await trail.add(event); return readFileSync(trail.file, "utf8"); }],
        ["library trail", () => { library.saveTrail("saved", [event]); return JSON.stringify(library.readTrail("saved")); }],
        ["appended trail", () => { library.saveTrail("saved", []); library.appendTrail("saved", event); return JSON.stringify(library.readTrail("saved")); }],
        ["run", () => { library.saveRun({ id: "saved", workflowId: "saved", at: 1, status: "passed", heals: [], steps: [event], trail: [event], failure: { message: `Copied: ${value}` } }); return JSON.stringify(library.readRun("saved")); }],
        ["workflow literal", () => { library.save(literal); return JSON.stringify(library.read("saved")); }],
        ["workflow import", () => JSON.stringify(library.importJson(JSON.stringify(literal)))],
        ["remembered inputs", () => { library.save(contextDoc); library.savePublicInputs("saved", { entry: value }); return JSON.stringify(library.readPublicInputs("saved")); }],
        ["runtime run", () => { library.save(contextDoc); library.saveRun({ id: "saved", workflowId: "saved", at: 1, status: "passed", heals: [], steps: [{ id: "entry" }], inputs: { entry: value } }); return JSON.stringify(library.readRun("saved")); }],
        ["promotion", () => { const row = { workflowId: "saved", event }; library.savePromotion(row); return readFileSync(path.join(home, "promotions", "saved.json"), "utf8"); }],
        ["kept heal", () => { library.noteHealPromotion("saved", event); return JSON.stringify(library.readKeptHeal("saved")); }],
        ["intent eval", () => { library.saveIntentEval("saved", event); return JSON.stringify(library.readIntentEval("saved")); }],
        ["teach case", () => { library.saveTeachIntentCase("saved", event); return readFileSync(path.join(home, "evals", "intent", "cases", "saved.json"), "utf8"); }],
        ["version", () => { library.save(contextDoc); const row = draftVersion(library, literal, "edit"); return JSON.stringify(versionDocument(library, "saved", row.n)); }],
        ["find debug", () => { writeFindDebug(path.join(home, "debug"), "saved", event); return readFileSync(path.join(home, "debug", "saved.json"), "utf8"); }],
        ["receipt", () => { const log = new ReceiptLog(path.join(home, "trails", "matrix.receipts.jsonl")); log.append({ kind: "read-back", ts: 1, runId: "saved", workflowId: "saved", stepId: "entry", source: "text", expected: value, actual: value, pass: true }, { workflow: contextDoc, args: { entry: value } }); const bytes = readFileSync(path.join(home, "trails", "matrix.receipts.jsonl"), "utf8"); assert.equal(verifyReceiptChain(bytes.trim().split("\n").map((line) => JSON.parse(line))), true); return JSON.stringify(log.entries[0]); }],
        ["heal handoff", async () => { const step = workflow({ identity, sensitive: sample.sensitive, value }).steps[0]!; await cursorHeal(path.join(home, "handoff"), { BAO_HEAL_WAIT_MS: "0" }).propose({ stepId: step.id, index: 0, intent: "Fill", phase: "action", reason: value, snapshot: { dom: [] } }, step); return readFileSync(path.join(home, "handoff", "heal-request.json"), "utf8"); }],
        ["observer", () => { const child = spawnSync(process.execPath, [path.resolve("desktop/mcp/claude/hooks/observe.mjs")], { input: JSON.stringify({ tool_name: "computer", tool_input: event }), encoding: "utf8", env: { ...process.env, BAO_HOME: home, HOME: home, BAO_HEAL_CURSOR_ACCOUNT: "0" } }); assert.equal(child.status, 0, child.stderr); const lines = readFileSync(path.join(home, "observer", "trail.jsonl"), "utf8").trim().split("\n"); return lines.at(-1)!; }],
        ...(!sample.field && !sample.sensitive && op === "type" ? [
          ["AX audit", async () => { const file = path.join(home, "ax.jsonl"); await logAx(file, { at: "now", what: value, via: "BaoOSHelper" }); return readFileSync(file, "utf8").trim().split("\n").at(-1)!; }],
          ["AX proxy trail", () => { const file = path.join(home, "proxy.json"); const child = spawnSync(process.execPath, [path.resolve(__dirname, "../../src/proxy/mcp-bao.js")], { input: JSON.stringify({ id: 1, method: "tools/call", params: { name: "unknown", arguments: {} } }) + "\n", encoding: "utf8", env: { ...process.env, HOME: home, BAO_HOME: home, BAO_HEAL_CURSOR_ACCOUNT: "0", BAO_WORK: path.join(home, "proxy-work"), BAO_TRAIL: file, BAO_VENDOR: value } }); assert.equal(child.status, 0, child.stderr); return readFileSync(file, "utf8"); }],
          ["session summary", async () => { const log = new SessionLog(path.join(home, "summary"), value); await log.flush("passed"); return readFileSync(path.join(home, "summary", "session.json"), "utf8"); }],
          ["pending prompt", () => { writePendingPrompt(home, { runId: "saved", ask: makeAsk({ kind: "login", workflowId: "saved", workflowName: "Saved", stepId: "entry", stepIndex: 1, stepCount: 1, label: value, site: "example.test", timeoutMs: 50 }) }); return JSON.stringify(readPendingPrompt(home)); }],
        ] as [string, () => Promise<string> | string][] : []),
        ...[0, 1].flatMap((depth) => [true, false].map((explicit) => [
          `workflow default depth ${depth} / explicit ${explicit}`,
          () => {
            const doc = workflow({ identity, sensitive: sample.sensitive, ...(explicit ? { input: "entry" } : {}), value: "{{entry}}" });
            doc.inputs = [{ name: "entry", type: "text", default: value }];
            for (let level = 0; level < depth; level += 1) {
              doc.steps = workflow({ action: "for_each", forEach: { over: { kind: "input", name: "rows" }, steps: doc.steps } }).steps;
            }
            if (depth) { doc.version = 3; doc.inputs.push({ name: "rows", type: "table" }); }
            library.save(doc);
            return JSON.stringify(library.read("saved"));
          },
        ] as [string, () => string])),

      ];
      for (const [surface, save] of surfaces) {
        const before = JSON.stringify(event);
        const saved = await save();
        assert.equal(JSON.stringify(event), before, "save mutated the live action");
        const context = `${sample.name} / ${op} / ${surface}`;
        const parsed = JSON.parse(saved);
        const field = op === "key" ? "key" : "value";
        let actual: unknown;
        if (surface.startsWith("workflow default") || ["workflow literal", "workflow import", "version"].includes(surface)) actual = parsed.inputs.find((input: { name: string }) => input.name === "entry")?.default ?? parsed.steps[0][field];
        else if (surface === "library trail" || surface === "appended trail") actual = parsed[0][field];
        else if (surface === "run") actual = parsed.steps[0][field];
        else if (surface === "remembered inputs") actual = parsed.entry;
        else if (surface === "runtime run") actual = parsed.inputs.entry;
        else if (surface === "promotion") actual = parsed.event[field];
        else if (surface === "receipt") actual = parsed.actual;
        else if (surface === "heal handoff") actual = parsed.step.value;
        else if (surface === "observer") actual = parsed.args[field];
        else if (surface === "AX audit") actual = parsed.what;
        else if (surface === "AX proxy trail") actual = parsed.source.vendor;
        else if (surface === "session summary") actual = parsed.intent;
        else if (surface === "pending prompt") actual = parsed.ask.label;
        else actual = parsed[field];
        const metadata = surface === "session summary" || surface === "pending prompt" || surface === "AX proxy trail" || surface === "AX audit";
        const expected = surface === "session summary" ? publicLiveSession({ status: "passed", intent: value })!.intent : sample.secret && !metadata ? STRIPPED_SECRET : value;
        assert.equal(actual, expected, context);
        assert.deepEqual(scrubSaved(parsed), parsed, `${context} must be idempotent`);
      }
    }
  }
});

test("cursor heal handoffs retain whole-value evidence without rewriting free text", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-whole-heal-request-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const secrets = ["hunter2", "secret", "strip", "stripped"];
  const step = workflow({ value: "hunter2", label: "Type hunter2" }).steps[0]!;
  const failure = { stepId: step.id, index: 0, intent: "Fill", phase: "action" as const, reason: "hunter2", snapshot: { dom: { values: [...secrets, STRIPPED_SECRET, "see hunter2", `see ${STRIPPED_SECRET}`] } } };
  const original = structuredClone({ step, failure, secrets });
  await cursorHeal(dir, { BAO_HEAL_WAIT_MS: "0" }, secrets).propose(failure, step);
  const saved = JSON.parse(readFileSync(path.join(dir, "heal-request.json"), "utf8"));
  assert.equal(saved.step.value, STRIPPED_SECRET);
  assert.equal(saved.step.label, "Type hunter2");
  assert.equal(saved.reason, "hunter2");
  assert.deepEqual(saved.dom.values, [...secrets, STRIPPED_SECRET, "see hunter2", `see ${STRIPPED_SECRET}`]);
  assert.deepEqual(scrubSaved(saved, { secrets }), saved);
  assert.deepEqual({ step, failure, secrets }, original);
});

test("structural redaction keeps schema words and input bindings intact", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-secret-bindings-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  for (const value of ["type", "password", "entry", "{{private}}", "{{entry}}", `new secret ${STRIPPED_SECRET}`]) {
    const identity: Identity = { surface: "dom", role: "textbox", inputType: "password", path: [] };
    const event = scrubSaved({ op: "type", value, identity });
    assert.equal(event.op, "type");
    assert.equal(event.identity.inputType, "password");
    assert.equal(event.value, STRIPPED_SECRET);
    const doc = workflow({ input: "entry", value: "{{entry}}", identity });
    doc.inputs = [{ name: "entry", type: "text", default: value }];
    library.save(doc);
    const saved = library.read(doc.id);
    assert.equal(saved.steps[0]!.input, "entry");
    assert.equal(saved.steps[0]!.value, "{{entry}}");
    assert.equal(saved.inputs[0]!.name, "entry");
    assert.equal(saved.inputs[0]!.default, STRIPPED_SECRET);
  }
});

test("declared workflow bindings stay metadata while literal secret values strip", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-secret-braces-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  const identity: Identity = { surface: "dom", role: "textbox", inputType: "password", path: [] };
  const raw: TrailEvent = { id: "raw", ts: 1, kind: "act", op: "type", identity, value: "{{private}}", note: "Copied {{private}}" };
  const before = structuredClone(raw);
  library.saveTrail("raw", [raw, { action: "type", sensitive: true, value: "{{private}}", label: "{{private}}" }]);
  assert.deepEqual(library.readTrail("raw"), [
    { ...raw, value: STRIPPED_SECRET },
    { action: "type", sensitive: true, value: STRIPPED_SECRET, label: "{{private}}", unresolved: { reason: NEEDS_SECRET_VALUE } },
  ]);
  assert.deepEqual(raw, before);

  for (const value of ["secret{{1}}", "prefix{{entry}}suffix", "{{private}}", "{{entry}}"] as const) {
    const candidate = workflow({ identity, sensitive: true, value, ...(value === "{{entry}}" ? { input: "entry" } : {}) });
    candidate.inputs = [{ name: "entry", type: "text" }];
    assert.deepEqual(validateWorkflow(candidate), value === "{{entry}}" || value === "prefix{{entry}}suffix" ? [] : ["secret literal entry"]);
    library.save(candidate);
    const expected = value === "{{entry}}" || value === "prefix{{entry}}suffix" ? value : STRIPPED_SECRET;
    assert.equal(library.read(candidate.id).steps[0]!.value, expected);
  }
  const doc = workflow({ identity, value: "{{private}}", label: "Copied {{private}}" });
  doc.inputs = [{ name: "entry", type: "text", default: "{{private}}" }];
  doc.steps.push({ ...doc.steps[0]!, id: "bound", index: 1, input: "entry", value: "{{entry}}", label: "Fill form" });
  doc.steps.push({
    id: "loop", index: 2, action: "for_each", surface: "dom", label: "Rows", timeoutMs: 50,
    forEach: { over: { kind: "input", name: "rows" }, steps: [{ ...doc.steps[0]!, id: "cell", value: "{{row.code}}", label: "Fill cell" }] },
  });
  doc.version = 3;
  doc.inputs.push({ name: "rows", type: "table", default: "code,note\n{{private}},public\n" });
  const active = structuredClone(doc);
  library.save(doc);
  const saved = library.read(doc.id);
  assert.deepEqual(validateWorkflow(saved), []);
  assert.equal(saved.steps[0]!.value, STRIPPED_SECRET);
  assert.equal(saved.steps[0]!.label, "Copied {{private}}");
  assert.equal(saved.steps[1]!.value, "{{entry}}");
  assert.equal(saved.steps[1]!.input, "entry");
  assert.equal(saved.steps[2]!.forEach!.steps[0]!.value, "{{row.code}}");
  assert.equal(saved.inputs[0]!.default, STRIPPED_SECRET);
  assert.equal(saved.inputs[1]!.default, `code,note\n${STRIPPED_SECRET},public\n`);
  assert.deepEqual(doc, active);
});

const metadataCollision = {
  status: "failed", outcome: "needs_human", phase: "action", driver: "cdp-live", heal: "auto", class: "login_wall",
  mode: "auto", decision: "keep", repair: "wait", timing: "lt1s", by: "value", relation: "below",
  state: "checked", gate: "login", confidence: "low", optional: "dismiss", target: "url", space: "viewport",
  read: "text", pausedKind: "signin", pageEngine: "old", drift: "pending", dialogType: "prompt",
  dialogDecision: "accept", valueMode: "full", via: "cdp", tag: "input", subrole: "text",
  cleared: "email", changed: ["text", "label"],
};
const collisionSecrets = [
  "failed", "pass", "passed", "action", "cdp-live", "auto", "login", "keep", "wait", "value", "needs_human", "lt1s", "signin", "pending",
  "below", "checked", "low", "dismiss", "url", "viewport", "text", "old", "prompt", "accept",
  "full", "cdp", "input", "email", "label",
];

test("known secret collisions preserve metadata across public saved writers", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-secret-enums-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  for (const value of collisionSecrets) {
    const identity: Identity = { surface: "dom", role: "textbox", inputType: "password", tag: "input", path: [] };
    const event: TrailEvent = {
      id: "entry", ts: 1, kind: "act", op: "type", identity, value,
      outcome: `Copied ${value}`, gate: "login", dialogType: "prompt", dialogDecision: "accept", valueMode: "full",
      note: value, detail: `Copied ${value}`,
    };
    const before = structuredClone(event);
    const copied = `Copied ${value}`;
    const expectedEvent = { ...event, value: STRIPPED_SECRET, outcome: copied, note: value, detail: copied };
    const session: LiveSessionRecord = {
      id: "session", intent: "Fill form", status: "failed", host: "example.test", updatedAt: 1,
      steps: [{ name: "Fill form", status: "passed", ms: 1 }],
      audit: [{ action: "type", label: value, path: "/", isTrusted: true, ms: 1, at: 1, shot: "", via: "cdp" }],
      note: `Copied ${value}`,
    };
    const artifact = [event, session, { ...metadataCollision, reason: value, label: `Copied ${value}`, detail: value }];
    const expected = [expectedEvent, {
      ...session, note: copied,
    }, { ...metadataCollision, reason: value, label: copied, detail: value }];
    const activeArtifact = structuredClone(artifact);
    library.saveTrail("collision", artifact);
    const savedArtifact = library.readTrail("collision");
    assert.deepEqual(savedArtifact, expected, value);
    assert.ok(Array.isArray(savedArtifact));
    const savedSession = publicLiveSession(savedArtifact[1]);
    assert.equal(savedSession?.status, "failed", value);
    assert.equal(savedSession?.steps[0]!.status, "passed", value);
    assert.equal(savedSession?.audit[0]!.via, "cdp", value);
    assert.equal(savedSession?.note, copied, value);
    assert.deepEqual(artifact, activeArtifact);

    const trail = await LiveTrail.open(home);
    await trail.add(event);
    const savedEvent = JSON.parse(readFileSync(trail.file, "utf8"));
    assert.deepEqual(savedEvent, { ...expectedEvent, source: { agent: "live-model", vendor: "bao", adapter: "cdp-live" } }, value);
    assert.deepEqual(event, before);

    const doc = workflow({ identity, input: "entry", value: "{{entry}}", heal: "auto", gate: "login" });
    doc.heal = "auto";
    doc.driver = "cdp-live";
    doc.inputs = [{ name: "entry", type: "text", default: value },
      ...Object.keys(metadataCollision).map((name) => ({ name, type: "secret" as const }))];
    const activeDoc = structuredClone(doc);
    library.save(doc);
    const savedDoc = library.read(doc.id);
    assert.deepEqual(validateWorkflow(savedDoc), [], value);
    assert.equal(savedDoc.heal, "auto", value);
    assert.equal(savedDoc.driver, "cdp-live", value);
    assert.equal(savedDoc.steps[0]!.gate, "login", value);
    assert.equal(savedDoc.steps[0]!.value, "{{entry}}", value);
    assert.equal(savedDoc.inputs[0]!.default, STRIPPED_SECRET, value);
    const version = draftVersion(library, doc, "edit");
    assert.deepEqual(versionDocument(library, doc.id, version.n), savedDoc, value);
    assert.deepEqual(doc, activeDoc);

    const args = Object.fromEntries(["entry", ...Object.keys(metadataCollision)].map((key) => [key, value]));
    const redactedArgs = Object.fromEntries(Object.keys(args).map((key) => [key, STRIPPED_SECRET]));
    library.savePublicInputs(doc.id, args);
    assert.deepEqual(library.readPublicInputs(doc.id), redactedArgs, value);
    const run = { id: "collision", workflowId: doc.id, at: 1, status: "failed", heals: [], inputs: args, steps: [event], failure: { reason: value } };
    const activeRun = structuredClone(run);
    library.saveRun(run);
    assert.deepEqual(library.readRun(run.id), { ...run, inputs: redactedArgs, steps: [expectedEvent] }, value);
    assert.deepEqual(run, activeRun);
    assert.deepEqual(scrubSaved(args, { workflow: doc, args }), redactedArgs, value);
    assert.deepEqual(args, Object.fromEntries(Object.keys(args).map((key) => [key, value])));

    const receiptFile = path.join(home, "trails", `${value}.receipts.jsonl`);
    const receipts = new ReceiptLog(receiptFile);
    const body = { kind: "read-back" as const, ts: 1, runId: "collision", workflowId: doc.id, stepId: "entry", source: "text" as const, expected: value, actual: `Copied ${value}`, pass: true };
    receipts.append(body, { workflow: doc, args });
    const receipt = receipts.entries[0]!;
    assert.equal(receipt.source, "text", value);
    assert.equal(receipt.expected, STRIPPED_SECRET, value);
    assert.equal(receipt.actual, copied, value);
    assert.equal(receipt.pass, true, value);
    assert.equal(body.expected, value);
    assert.equal(verifyReceiptChain(readFileSync(receiptFile, "utf8").trim().split("\n").map((line) => JSON.parse(line))), true, value);

    writeFileSync(path.join(home, "trails", "legacy.json"), JSON.stringify(artifact));
    scrubHome(home, true);
    assert.deepEqual(library.readTrail("legacy"), expected, value);
    assert.deepEqual(scrubHome(home, false).files, [], value);
  }
});

test("marked select fields strip whole selected values and defaults but unmarked options stay stable", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-secret-marked-choice-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  for (const [autocomplete, value] of [["cc-exp", "03/28"], ["cc-number", "4111111111111111"], ["one-time-code", "483921"]]) {
    for (const marked of [true, false]) {
      const identity: Identity = { surface: "dom", role: "combobox", tag: "select", name: "Choice", path: [], ...(marked ? { autocomplete } : {}) };
      const event: TrailEvent = { id: "select", ts: 1, kind: "act", op: "select", identity, value, valueBefore: value, valueAfter: value };
      const expected = marked ? STRIPPED_SECRET : value;
      const original = structuredClone(event);
      library.saveTrail("choice", [event]);
      const live = await LiveTrail.open(home);
      await live.add(event);
      for (const saved of [(library.readTrail("choice") as TrailEvent[])[0]!, JSON.parse(readFileSync(live.file, "utf8").trim().split("\n").at(-1)!)]) {
        assert.deepEqual([saved.value, saved.valueBefore, saved.valueAfter], [expected, expected, expected]);
      }
      for (const choice of [false, true]) {
        const doc = interpret([event], { id: "choice", startUrl: "https://example.test/" });
        if (choice) doc.inputs[0] = { ...doc.inputs[0]!, type: "choice", choices: [value!, "other"] };
        const input = doc.inputs[0]!.name;
        library.save(doc);
        const saved = library.read(doc.id);
        assert.equal(saved.inputs[0]!.default, expected);
        assert.equal(saved.steps[0]!.value, `{{${input}}}`);
        assert.deepEqual(validateWorkflow(saved), []);
        if (choice) assert.deepEqual(saved.inputs[0]!.choices, [value, "other"]);
        library.savePublicInputs(doc.id, { [input]: value });
        assert.deepEqual(library.readPublicInputs(doc.id), { [input]: expected });
      }
      assert.deepEqual(event, original);
    }
  }
  for (const role of ["radio", "checkbox"]) {
    const event: TrailEvent = { id: role, ts: 1, kind: "act", op: "check", checked: true, value: "483921", identity: { surface: "dom", role, inputType: role, autocomplete: "one-time-code", value: "483921", path: [] } };
    library.saveTrail("toggles", [event]);
    const saved = (library.readTrail("toggles") as TrailEvent[])[0]!;
    assert.equal(saved.value, STRIPPED_SECRET);
    assert.equal(saved.identity!.value, STRIPPED_SECRET);
    assert.equal(saved.checked, true);
    assert.equal(event.value, "483921");
  }
});

test("option tokens survive password collisions while whole copied data values strip", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-secret-options-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  for (const value of [...collisionSecrets, "sk-choice-token"]) {
    const selectIdentity: Identity = { surface: "dom", role: "combobox", tag: "select", name: "Route", path: [] };
    const select: TrailEvent = { id: "select", ts: 1, kind: "act", op: "select", identity: selectIdentity, value, note: `Copied ${value}` };
    const password: TrailEvent = {
      id: "password", ts: 2, kind: "act", op: "type", value,
      identity: { surface: "dom", role: "textbox", tag: "input", inputType: "password", path: [] },
    };
    const radio: TrailEvent = {
      id: "radio", ts: 3, kind: "act", op: "click",
      identity: { surface: "dom", role: "radio", tag: "input", inputType: "radio", value, path: [] },
    };
    const checkbox: TrailEvent = {
      id: "checkbox", ts: 4, kind: "act", op: "check", checked: true,
      identity: { surface: "dom", role: "checkbox", tag: "input", inputType: "checkbox", value, path: [] },
    };
    const options = [{ label: value, value, selected: true, disabled: false }, { label: "Other route", value: "other-route", selected: false, disabled: false }];
    const controls = [
      { ref: "native", kind: "select", label: "Route", value, options },
      { ref: "toggle", kind: "field", label: "Toggle", value, field: { type: "checkbox", name: "toggle", autocomplete: "off" } },
      { ref: "radio", kind: "radio", label: "Radio", value },
    ];
    const view = { options, controls, label: value, reason: `Copied ${value}`, detail: value };
    const artifact = [select, radio, checkbox, password, view];
    const active = structuredClone(artifact);
    library.saveTrail("options", artifact);
    const copied = `Copied ${value}`;
    const expected = [
      { ...select, note: copied }, radio, checkbox,
      { ...password, value: STRIPPED_SECRET },
      { options, controls, label: value, reason: copied, detail: value },
    ];
    assert.deepEqual(library.readTrail("options"), expected, value);
    assert.deepEqual(artifact, active);

    const doc = interpret([select], { id: "options", startUrl: "https://example.test/" });
    assert.equal(doc.inputs[0]!.type, "text", "recorded selects use text inputs");
    assert.equal(doc.inputs[0]!.default, value);
    const selectedInput = doc.inputs[0]!.name;
    doc.inputs.push({ name: "route", type: "choice", choices: [value, "other-route"], default: value }, { name: "credential", type: "text" });
    doc.steps.push(
      { id: "literal", index: 1, action: "select", sensitive: true, surface: "dom", identity: selectIdentity, value, label: "Choose route", timeoutMs: 50 },
      { id: "conditional", index: 2, action: "click", surface: "dom", identity: radio.identity, when: { input: "route", value }, label: "Choose branch", timeoutMs: 50 },
      { id: "check", index: 3, action: "check", surface: "dom", identity: checkbox.identity, checked: true, label: "Check branch", timeoutMs: 50 },
      { id: "password", index: 4, action: "type", input: "credential", surface: "dom", identity: password.identity, value, label: `Copied ${value}`, timeoutMs: 50 },
    );
    const activeDoc = structuredClone(doc);
    library.save(doc);
    const saved = library.read(doc.id);
    assert.deepEqual(validateWorkflow(saved), [], value);
    assert.equal(saved.inputs.find((input) => input.name === selectedInput)!.default, value);
    assert.deepEqual(saved.inputs.find((input) => input.name === "route"), { name: "route", type: "choice", choices: [value, "other-route"], default: value });
    assert.equal(saved.steps[0]!.value, `{{${selectedInput}}}`);
    assert.equal(saved.steps[1]!.value, STRIPPED_SECRET);
    assert.deepEqual(saved.steps[2]!.when, { input: "route", value });
    assert.equal(saved.steps[2]!.identity!.value, value);
    assert.equal(saved.steps[3]!.identity!.value, value);
    assert.equal(saved.steps[4]!.value, STRIPPED_SECRET);
    assert.equal(saved.steps[4]!.label, copied);
    assert.deepEqual(doc, activeDoc);
    const version = draftVersion(library, doc, "edit");
    const versioned = versionDocument(library, doc.id, version.n);
    assert.deepEqual(validateWorkflow(versioned), [], value);
    assert.deepEqual(versioned, saved, value);
    const args = { [selectedInput]: value, route: value, credential: value, copied: value };
    library.savePublicInputs(doc.id, args);
    assert.deepEqual(library.readPublicInputs(doc.id), { [selectedInput]: value, route: value, credential: STRIPPED_SECRET, copied: STRIPPED_SECRET });
    assert.deepEqual(args, { [selectedInput]: value, route: value, credential: value, copied: value });

    writeFileSync(path.join(home, "trails", "legacy-options.json"), JSON.stringify(artifact));
    scrubHome(home, true);
    assert.deepEqual(library.readTrail("legacy-options"), expected, value);
  }
});

test("SessionLog keeps metadata and embedded free text stable through its public API", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-secret-session-metadata-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const log = new SessionLog(home, "Use ghp_fixture123");
  log.setSteps([{ name: "Fill form", status: "passed", ms: 1 }]);
  await log.add({ action: "type", label: "ghp_fixture123", path: "/", isTrusted: true, ms: 1, via: "cdp" });
  await log.flush("failed", "Copied ghp_fixture123", "example.test");
  const saved = await readLiveSession(home);
  assert.equal(saved?.status, "failed");
  assert.equal(saved?.steps[0]!.status, "passed");
  assert.equal(saved?.audit[0]!.via, "cdp");
  assert.equal(saved?.audit[0]!.label, "ghp_fixture123");
  assert.equal(saved?.intent, "Use ghp_fixture123");
  assert.equal(saved?.note, "Copied ghp_fixture123");
});

test("session summaries use the value nets without treating a Password label as a secret", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-secret-session-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const log = new SessionLog(home, "Use ghp_fixture123");
  await log.flush("passed");
  assert.equal(JSON.parse(readFileSync(path.join(home, "session.json"), "utf8")).intent, "Use ghp_fixture123");
  assert.deepEqual(scrubSaved({ action: "click", label: "Password" }), { action: "click", label: "Password" });
  const media = { screenshot: "ghp_fixture123", png: "ghp_fixture123", base64: "ghp_fixture123", video: "ghp_fixture123" };
  assert.deepEqual(scrubSaved(media), media);
});


test("stripped literals, defaults, keys and nested actions stop before dispatch or healing", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-secret-replay-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  const calls: string[] = [];
  const driver = {
    tree: async () => ({ nodes: [], texts: [], url: "https://example.test/" }), snapshot: async () => ({}),
    fill: async () => { calls.push("fill"); }, key: async (key: string) => { calls.push(`key:${key}`); },
    digits: async () => { calls.push("digits"); }, goto: async () => { calls.push("goto"); },
  } as unknown as Driver;
  const docs = [
    workflow({ value: STRIPPED_SECRET }),
    workflow({ action: "key", key: STRIPPED_SECRET }),
    workflow({ action: "digits", value: STRIPPED_SECRET }),
    workflow({ input: "entry", value: "{{entry}}" }),
    workflow({ value: "{{entry}}" }),
    workflow({ action: "for_each", forEach: { over: { kind: "input", name: "rows" }, steps: workflow({ value: STRIPPED_SECRET }).steps } }),
    interpret([{ id: "private", kind: "act", ts: 1, op: "type", value: STRIPPED_SECRET, sensitive: true }], { id: "from-trail", startUrl: "https://example.test/" }),
  ];
  docs[0]!.steps = [
    { ...docs[0]!.steps[0]!, action: "key", key: "Enter", value: undefined, id: "before" },
    { ...docs[0]!.steps[0]!, index: 1 },
    { ...docs[0]!.steps[0]!, action: "key", key: "Tab", value: undefined, id: "after", index: 2 },
  ];
  docs[3]!.inputs = [{ name: "entry", type: "text", default: STRIPPED_SECRET }];
  docs[5]!.version = 3;
  docs[5]!.inputs = [{ name: "rows", type: "table" }];
  docs.push({
    ...docs[5]!,
    steps: [{ ...docs[5]!.steps[0]!, forEach: { over: { kind: "input", name: "rows" }, steps: workflow({ value: "{{row.code}}" }).steps } }],
  });
  for (const doc of docs) {
    library.save(doc);
    const saved = library.read(doc.id);
    assert.deepEqual(validateWorkflow(saved), []);
    const run = await replay(saved, { entry: STRIPPED_SECRET, rows: `code\n${STRIPPED_SECRET}\n` }, driver, {
      heal: { available: () => true, propose: async () => { calls.push("heal"); throw new Error("must not heal a missing value"); } },
    });
    assert.equal(run.status, "failed");
    assert.equal(run.failure?.reason, NEEDS_SECRET_VALUE);
    assert.throws(() => toPuppeteerReplay(saved, { entry: STRIPPED_SECRET, rows: `code\n${STRIPPED_SECRET}\n` }), /This step needs a value/);
  }
  assert.deepEqual(calls, ["key:Enter"]);
});

test("scrub CLI defaults to a read-only plan, backs up every changed file and is idempotent", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-secret-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const files: Record<string, string> = {
    "workflows/old.json": JSON.stringify(workflow({ value: "ghp_fixture123" })),
    "workflows/sensitive.json": JSON.stringify(workflow({ value: "private-entry", sensitive: true })),
    "reports/old.json": JSON.stringify({ workflowId: "old", failure: "ghp_fixture123", steps: [null], inputs: { entry: "ghp_fixture123" } }),
    "resumes/old.json": JSON.stringify({ workflowId: "old", publicInputs: { entry: "ghp_fixture123" } }),
    "versions/old.json": JSON.stringify([{ document: workflow({ value: "private-entry", identity: { surface: "dom", role: "password", path: [] } }) }]),
    "trail.jsonl": JSON.stringify({ op: "type", value: "private-entry", sensitive: true }) + "\n",
    "runs/old.json": JSON.stringify({ failure: "sk-fixture123", trail: [{ op: "type", value: "private-entry", identity: { inputType: "password" } }] }),
    "trails/old.json": JSON.stringify([{ op: "key", key: "Shift+q", identity: { autocomplete: "one-time-code" } }]),
    "live-session/trail.jsonl": JSON.stringify({ op: "type", value: "private-entry", identity: { autocomplete: "cc-name" } }) + "\n",
  };
  const unchanged: Record<string, string> = {
    "heals/old.json": JSON.stringify({ heal: { note: "sk-fixture123" } }),
    "live-session/session.json": JSON.stringify({ intent: "Use github_pat_fixture123", note: "github_pat_fixture123" }),
  };
  for (const [file, contents] of Object.entries({ ...files, ...unchanged })) {
    mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
    writeFileSync(path.join(home, file), contents);
  }
  mkdirSync(path.join(home, "shots"));
  writeFileSync(path.join(home, "shots", "image.png"), "ghp_fixture123");
  writeFileSync(path.join(home, "settings.json"), '{"key":"ghp_fixture123"}');
  symlinkSync(path.join(home, "settings.json"), path.join(home, "trails", "linked.json"));
  const cli = (args: string[]) => {
    const child = spawnSync(process.execPath, [path.resolve(__dirname, "../../src/app/cli.js"), "scrub-secrets", ...args], { encoding: "utf8", env: { ...process.env, HOME: home, BAO_HEAL_CURSOR_ACCOUNT: "0" } });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout) as { mode: string; files: string[]; backup?: string };
  };
  const plan = cli(["--home", home]);
  assert.equal(plan.mode, "dry-run");
  assert.deepEqual(plan.files, Object.keys(files).sort());
  assert.equal(plan.backup, undefined);
  assert.equal(existsSync(path.join(home, "secret-scrub-backups")), false);
  for (const [file, contents] of Object.entries(files)) assert.equal(readFileSync(path.join(home, file), "utf8"), contents);
  const result = cli(["--home", home, "--write"]);
  assert.equal(result.mode, "write");
  assert.deepEqual(result.files, plan.files);
  assert.ok(result.backup);
  for (const [file, contents] of Object.entries(files)) {
    assert.equal(readFileSync(path.join(result.backup!, file), "utf8"), contents);
    assert.equal(statSync(path.join(result.backup!, file)).mode & 0o777, 0o600);
    assert.ok(readFileSync(path.join(home, file), "utf8").includes(STRIPPED_SECRET));
  }
  for (const [file, contents] of Object.entries(unchanged)) {
    assert.equal(readFileSync(path.join(home, file), "utf8"), contents);
    assert.equal(existsSync(path.join(result.backup!, file)), false);
  }
  assert.equal(readFileSync(path.join(home, "shots", "image.png"), "utf8"), "ghp_fixture123");
  assert.equal(readFileSync(path.join(home, "settings.json"), "utf8"), '{"key":"ghp_fixture123"}');
  assert.deepEqual(validateWorkflow(new Library(home).read("sensitive")), []);
  assert.deepEqual(cli(["--home", home, "--write"]).files, []);
  assert.equal(readdirSync(path.join(home, "secret-scrub-backups")).length, 1);
});

test("invalid saved JSON fails before backups or writes and symlink homes are refused", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-secret-invalid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  mkdirSync(path.join(home, "runs"), { recursive: true });
  const original = '{"value":"ghp_fixture123"}';
  writeFileSync(path.join(home, "runs", "a.json"), original);
  writeFileSync(path.join(home, "runs", "z.json"), "{");
  assert.throws(() => scrubHome(home, true), /Cannot scrub invalid JSON/);
  assert.equal(readFileSync(path.join(home, "runs", "a.json"), "utf8"), original);
  assert.equal(existsSync(path.join(home, "secret-scrub-backups")), false);
  symlinkSync(home, path.join(root, "linked"));
  assert.throws(() => scrubHome(path.join(root, "linked"), true), /not a symlink/);
});

test("live typing reaches the page unchanged but saved text strips secrets", { timeout: 60_000 }, async (t) => {
  const dirs = applyHermeticApp("saved-secrets-live");
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end('<title>Local form</title><label>Holder<input autocomplete="cc-name"></label><label>Secret<input type="password"></label><label>New<input autocomplete="new-password"></label><label>Verify<input autocomplete="one-time-code"></label><label>Note<textarea></textarea></label>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await launchOwnedChrome({ userDataDir: dirs.chromeUserData, headless: true, childHome: dirs.nativeHostHome });
  t.after(() => browser.close());
  const host = createLiveHost({ home: dirs.home, lockFile: path.join(dirs.home, "live.lock"), target: { kind: "throwaway", portFile: path.join(dirs.chromeUserData, "DevToolsActivePort") } });
  t.after(() => host.close());
  type Reply = { session: string; outcome: { kind: string }; view: { controls: { label: string; ref: string }[] } };
  const call = (body: Record<string, unknown>) => host.call(body) as Promise<Reply>;
  let reply = await call({ op: "live_session_start", intent: "Fill local form", url });
  const entries = [["Holder", "Private card holder"], ["Secret", "Private password"], ["New", "Private new value"], ["Verify", "945621"], ["Note", "ghp_fixtureToken123"]];
  for (const [label, value] of entries) {
    reply = await call({ op: "live_type", ref: reply.view.controls.find((item) => item.label === label)!.ref, text: value });
    assert.equal(reply.outcome.kind, "applied");
    const page = browser.pages().find((page) => page.url() === url + "/")!;
    assert.equal(await page.getByLabel(label).inputValue(), value);
  }
  await call({ op: "live_stop" });
  const trail = readFileSync(path.join(dirs.home, "live-session", "trail.jsonl"), "utf8");
  const workflow = readFileSync(path.join(dirs.home, "workflows", `${reply.session}.json`), "utf8");
  for (const [, value] of entries) {
    assert.equal(trail.includes(value), false, `trail leaked ${value}`);
    assert.equal(workflow.includes(value), false, `workflow leaked ${value}`);
  }
  assert.ok(trail.includes(STRIPPED_SECRET));
  const run = await host.replay(new Library(dirs.home).read(reply.session));
  assert.equal(run.status, "failed");
  assert.equal(run.failure?.reason, NEEDS_SECRET_VALUE);
});
