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
import { SessionLog } from "../../src/cdp-live/audit";
import { interpret, type TrailEvent } from "../../src/v1/interpret";
import { replay, type Driver } from "../../src/v1/replay";
import { toPuppeteerReplay } from "../../src/v1/export-replay";
import { Library } from "../../src/v1/store";
import { NEEDS_SECRET_VALUE, scrubSaved, STRIPPED_SECRET } from "../../src/v1/saved-secrets";
import { scrubHome } from "../../src/v1/scrub-home";
import { validateWorkflow, WORKFLOW_SCHEMA_ID, type Identity, type WorkflowStep, type WorkflowV2 } from "../../src/v1/schema";

function workflow(step: Partial<WorkflowStep> = {}): WorkflowV2 {
  return {
    schema: WORKFLOW_SCHEMA_ID, version: 2, id: "saved", name: "Saved form", createdAt: 1,
    startUrl: "https://example.test/", inputs: [],
    steps: [{ id: "entry", index: 0, action: "type", label: "Fill form", surface: "dom", timeoutMs: 50, ...step }],
  };
}

const cases: { name: string; value: string; field?: Partial<Identity>; secret: boolean }[] = [
  { name: "password type", value: "private-entry", field: { inputType: "password" }, secret: true },
  { name: "password role", value: "private-entry", field: { role: "password" }, secret: true },
  ...["current-password", "new-password", "one-time-code", "cc-name", "cc-number", "cc-csc", "cc-exp", "section-pay shipping cc-given-name"].map((autocomplete) => ({ name: autocomplete, value: "private-entry", field: { autocomplete }, secret: true })),
  ...["4111111111111111", "4111 1111 1111 1111", "4111-1111-1111-1111", "4111111111111111 12/26", "123-45-6789", "123 45 6789", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.c2lnbmF0dXJl", "sk-fixture123", "ghp_fixture123", "gho_fixture123", "github_pat_fixture123", "xoxb-fixture123", "xoxp-fixture123", "xoxa-fixture123", "AKIAFIXTURE123456789", "GOCSPX-fixture123"].map((value) => ({ name: value, value, secret: true })),
  ...["ordinary text", "Password", "4111111111111112", "2026-11-03", "742", "hello@example.com"].map((value) => ({ name: value, value, secret: false })),
  { name: "Password button", value: "ordinary text", field: { role: "button", tag: "button", name: "Password" }, secret: false },
];

test("each detection rule crosses every trail, run and workflow save surface", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-secret-table-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  for (const sample of cases) {
    for (const op of ["type", "key"] as const) {
      const value = sample.field && sample.secret && op === "key" ? "Shift+q" : sample.value;
      const identity: Identity = { surface: "dom", role: "textbox", tag: "input", path: [], ...sample.field };
      const event: TrailEvent = { id: "entry", ts: 1, kind: "act", op, identity, ...(op === "key" ? { key: value } : { value }), note: `Copied: ${value}` };
      const surfaces: [string, () => Promise<string> | string][] = [
        ["live trail", async () => { const trail = await LiveTrail.open(home); await trail.add(event); return readFileSync(trail.file, "utf8"); }],
        ["library trail", () => { library.saveTrail("saved", [event]); return JSON.stringify(library.readTrail("saved")); }],
        ["appended trail", () => { library.saveTrail("saved", []); library.appendTrail("saved", event); return JSON.stringify(library.readTrail("saved")); }],
        ["run", () => { library.saveRun({ id: "saved", workflowId: "saved", at: 1, status: "passed", heals: [], steps: [event], trail: [event], failure: { message: `Copied: ${value}` } }); return JSON.stringify(library.readRun("saved")); }],
        ["workflow literal", () => { library.save(workflow({ action: op, identity, ...(op === "key" ? { key: value } : { value }) })); return JSON.stringify(library.read("saved")); }],
        ...[0, 1, 2].flatMap((depth) => [true, false].map((explicit) => [
          `workflow default depth ${depth} / explicit ${explicit}`,
          () => {
            const doc = workflow({ identity, ...(explicit ? { input: "entry" } : {}), value: "{{entry}}" });
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
        assert.equal(saved.includes(value), !sample.secret, context);
        assert.equal(saved.includes(STRIPPED_SECRET), sample.secret, context);
        const parsed = JSON.parse(saved) as unknown;
        assert.deepEqual(scrubSaved(parsed), parsed, `${context} must be idempotent`);
      }
    }
  }
});

test("structural redaction keeps schema words and input bindings intact", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-secret-bindings-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  for (const value of ["type", "password", "entry", "{{private}}", `new secret ${STRIPPED_SECRET}`]) {
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

test("session summaries use the value nets without treating a Password label as a secret", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-secret-session-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const log = new SessionLog(home, "Use ghp_fixture123");
  await log.flush("passed");
  assert.ok(readFileSync(path.join(home, "session.json"), "utf8").includes(STRIPPED_SECRET));
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
    assert.throws(() => toPuppeteerReplay(saved, { entry: STRIPPED_SECRET, "row.code": STRIPPED_SECRET }), /This step needs a value/);
  }
  assert.deepEqual(calls, ["key:Enter"]);
});

test("scrub CLI defaults to a read-only plan, backs up every changed file and is idempotent", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-secret-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const files: Record<string, string> = {
    "workflows/old.json": JSON.stringify(workflow({ value: "ghp_fixture123" })),
    "workflows/sensitive.json": JSON.stringify(workflow({ value: "private-entry", sensitive: true })),
    "reports/old.json": JSON.stringify({ failure: "ghp_fixture123", steps: [null], inputs: [null] }),
    "resumes/old.json": JSON.stringify({ publicInputs: { entry: "ghp_fixture123" } }),
    "versions/old.json": JSON.stringify([{ document: workflow({ value: "private-entry", identity: { surface: "dom", role: "password", path: [] } }) }]),
    "heals/old.json": JSON.stringify({ heal: { note: "sk-fixture123" } }),
    "trail.jsonl": JSON.stringify({ op: "type", value: "private-entry", sensitive: true }) + "\n",
    "runs/old.json": JSON.stringify({ failure: "sk-fixture123", trail: [{ op: "type", value: "private-entry", identity: { inputType: "password" } }] }),
    "trails/old.json": JSON.stringify([{ op: "key", key: "Shift+q", identity: { autocomplete: "one-time-code" } }]),
    "live-session/trail.jsonl": JSON.stringify({ op: "type", value: "private-entry", identity: { autocomplete: "cc-name" } }) + "\n",
    "live-session/session.json": JSON.stringify({ intent: "Use github_pat_fixture123" }),
  };
  for (const [file, contents] of Object.entries(files)) {
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
  const host = createLiveHost({ home: dirs.home, lockFile: path.join(dirs.home, "live.lock"), target: { kind: "throwaway", portFile: path.join(dirs.chromeUserData, "DevToolsActivePort") }, idleMs: 0 });
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
