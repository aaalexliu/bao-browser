import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv from "ajv/dist/2020";
import { canonical } from "../../src/v1/canonical";
import {
  civilInZone,
  composeFilesDatesSchema,
  datePreview,
  downloadFileName,
  fileDigest,
  FILES_DATES_REVISION,
  formatCivil,
  isoOf,
  migrateFilesDates,
  NEEDS_MAC_TEST,
  openTarget,
  planOpen,
  prepareFilesDatesRun,
  renderTemplate,
  resolveRelative,
} from "../../src/v1/files-dates";
import { interpret, type TrailEvent } from "../../src/v1/interpret";
import { recorderSource } from "../../src/v1/recorder";
import { replay, type Driver, type LiveTree } from "../../src/v1/replay";
import { migrate, validateWorkflow, WORKFLOW_SCHEMA_ID, type Identity, type WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";

const v2Schema = JSON.parse(readFileSync(path.join(process.cwd(), "schema/workflow-v2.schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validateV2 = ajv.compile(v2Schema);
const validateV3 = ajv.compile(composeFilesDatesSchema(v2Schema));

const OCT_22 = new Date("2026-10-22T15:00:00Z");
const ZONE = "UTC";

function ident(partial: Partial<Identity> = {}): Identity {
  return { surface: "dom", role: "button", path: [], ...partial };
}

function event(partial: Partial<TrailEvent> & Pick<TrailEvent, "id" | "op">): TrailEvent {
  return { ts: OCT_22.getTime(), kind: "act", ...partial };
}

function tree(): LiveTree {
  return { nodes: [], texts: [], values: [] };
}

function driver(extra: Partial<Driver> = {}): Driver {
  return {
    tree: async () => tree(),
    snapshot: async () => ({ dom: "", ax: "" }),
    click: async () => {},
    fill: async () => {},
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    sleep: async () => {},
    ...extra,
  };
}

test("relative dates resolve in the run zone and keep the recorded format", () => {
  const utc = civilInZone(OCT_22, "UTC");
  assert.deepEqual(utc, { y: 2026, m: 10, d: 22 });
  assert.equal(isoOf(resolveRelative("today", utc)), "2026-10-22");
  assert.equal(isoOf(resolveRelative("+14d", utc)), "2026-11-05");
  assert.equal(isoOf(resolveRelative("+17d", utc)), "2026-11-08");
  assert.equal(isoOf(resolveRelative("-1d", { y: 2026, m: 10, d: 1 })), "2026-09-30");
  assert.equal(isoOf(resolveRelative("next monday", utc)), "2026-10-26");
  assert.equal(isoOf(resolveRelative("next monday", { y: 2026, m: 10, d: 19 })), "2026-10-26");
  assert.equal(isoOf(resolveRelative("first of next month", { y: 2026, m: 12, d: 15 })), "2027-01-01");
  assert.equal(formatCivil(resolveRelative("+14d", utc), "D MMM YYYY"), "5 Nov 2026");
  assert.equal(formatCivil(resolveRelative("+17d", utc), "D MMM YYYY"), "8 Nov 2026");
  assert.equal(datePreview("next monday", "D MMM YYYY", "UTC", OCT_22), "26 Oct 2026");
  assert.equal(datePreview("first of next month", "D MMM YYYY", "UTC", OCT_22), "1 Nov 2026");

  const nearMidnight = new Date("2026-10-22T02:30:00Z");
  assert.deepEqual(civilInZone(nearMidnight, "America/New_York"), { y: 2026, m: 10, d: 21 });
  assert.equal(isoOf(resolveRelative("+1d", civilInZone(nearMidnight, "America/New_York"))), "2026-10-22");
  assert.equal(isoOf(resolveRelative("+1d", civilInZone(nearMidnight, "UTC"))), "2026-10-23");
});

test("slash dates follow the field, and an ambiguous pair stays day/month", () => {
  const doc = interpret([
    event({
      id: "in",
      op: "type",
      value: "05/11/2026",
      dateField: true,
      inputType: "text",
      identity: ident({ role: "textbox", tag: "input", id: "checkin", nameAttr: "checkin" }),
    }),
  ], { id: "wf-slash", startUrl: "https://fixture.test/", zone: ZONE });
  assert.equal(doc.version, 3);
  assert.equal(doc.inputs[0]?.type, "date");
  assert.equal(doc.inputs[0]?.relative, "+14d");
  assert.equal(doc.inputs[0]?.format, "DD/MM/YYYY");
  assert.equal(doc.inputs[0]?.zone, "UTC");
  assert.equal(doc.steps[0]?.action, "click");
  assert.equal(doc.steps[0]?.datePicker?.input, doc.inputs[0]?.name);
  assert.equal(JSON.stringify(doc).includes("05/11/2026"), false);
});

test("a native date field stays a type step and a picker range becomes one plan", () => {
  const native = interpret([
    event({
      id: "n",
      op: "type",
      value: "2026-11-05",
      dateField: true,
      inputType: "date",
      identity: ident({ role: "textbox", tag: "input", id: "when", nameAttr: "when" }),
    }),
  ], { id: "wf-native", startUrl: "https://fixture.test/", zone: ZONE });
  assert.equal(native.steps[0]?.action, "type");
  assert.equal(native.inputs[0]?.relative, "+14d");

  const range = interpret([
    event({ id: "nav", op: "click", picker: true, identity: ident({ text: "Next" }) }),
    event({
      id: "stay",
      op: "click",
      picker: true,
      value: "2026-11-05",
      endValue: "2026-11-08",
      identity: ident({ role: "group", text: "Calendar" }),
    }),
  ], { id: "wf-range", startUrl: "https://fixture.test/reservation", zone: ZONE });
  assert.equal(range.steps.length, 1);
  assert.equal(range.steps[0]?.datePicker?.input, "checkIn");
  assert.equal(range.steps[0]?.datePicker?.endInput, "checkOut");
  assert.equal(range.inputs.find((item) => item.name === "checkIn")?.relative, "+14d");
  assert.equal(range.inputs.find((item) => item.name === "checkOut")?.relative, "+17d");
  assert.equal(JSON.stringify(range).includes("2026-11-05"), false);
  assert.deepEqual(validateWorkflow(range), []);
  assert.equal(validateV3(range), true, JSON.stringify(validateV3.errors));
});

test("a download folds the trigger click into a templated step and binds a later upload", () => {
  const doc = interpret([
    event({ id: "c", op: "click", identity: ident({ role: "link", tag: "a", id: "dl", text: "Download" }) }),
    event({ id: "d", op: "download", suggestedFilename: "note.txt" }),
    event({
      id: "u",
      op: "upload",
      fileName: "note.txt",
      fileFrom: "note",
      identity: ident({ role: "textbox", tag: "input", id: "file-upload" }),
    }),
  ], { id: "wf-dl", startUrl: "https://fixture.test/files", zone: ZONE });
  assert.equal(doc.steps.length, 2);
  assert.equal(doc.steps[0]?.action, "download");
  assert.equal(doc.steps[0]?.download?.output, "note");
  assert.equal(doc.steps[0]?.download?.name, "{{run.date}}-{{suggested}}");
  assert.equal(doc.steps[0]?.identity?.id, "dl");
  assert.equal(doc.steps[1]?.action, "upload");
  assert.equal(doc.steps[1]?.fileFrom, "note");
  assert.equal(doc.inputs.find((item) => item.type === "file")?.fromOutput, "note");
  const blob = JSON.stringify(doc);
  assert.equal(blob.includes("/tmp"), false);
  assert.equal(blob.includes("note.txt"), false);
  assert.deepEqual(validateWorkflow(doc), []);
});

test("an ordinary trail stays version 2 and byte-identical", () => {
  const events = [event({ id: "c", op: "click", identity: ident({ id: "go", testId: "go", text: "Go" }) })];
  const meta = { id: "wf-plain", startUrl: "https://fixture.test/" };
  const doc = interpret(events, meta);
  assert.equal(doc.version, 2);
  assert.equal(doc.filesDates, undefined);
  assert.equal(canonical(doc), canonical(interpret(events, meta)));
  assert.equal(validateV2(doc), true, JSON.stringify(validateV2.errors));
});

test("old workflows load, and the files-dates door bumps them without changing steps", () => {
  const raw = {
    id: "wf-old",
    name: "Old",
    version: 1,
    startUrl: "https://example.test/login",
    createdAt: 1,
    variables: [],
    steps: [
      {
        id: "go",
        action: "click",
        label: "Go",
        ts: 1,
        target: { selectors: [{ type: "id", value: "#go" }], text: "Go" },
      },
    ],
  };
  const v2 = migrate(raw);
  assert.equal(v2.version, 2);
  assert.equal(v2.filesDates, undefined);
  assert.equal(validateV2(v2), true, JSON.stringify(validateV2.errors));
  const v3 = migrateFilesDates(raw);
  assert.equal(v3.version, 3);
  assert.equal(v3.filesDates, FILES_DATES_REVISION);
  assert.equal(v3.steps.length, v2.steps.length);
  assert.equal(v3.steps[0]?.action, v2.steps[0]?.action);
  assert.deepEqual(validateWorkflow(v3), []);
  assert.equal(validateV3(v3), true, JSON.stringify(validateV3.errors));
  assert.equal(migrateFilesDates(v3), v3);

  const root = mkdtempSync(path.join(tmpdir(), "bao-lib-"));
  const library = new Library(root);
  library.save(v2);
  assert.equal(JSON.parse(readFileSync(path.join(root, "workflows", "wf-old.json"), "utf8")).version, 2);
  const loaded = library.read("wf-old");
  assert.equal(loaded.version, 3);
  assert.equal(loaded.filesDates, 1);
  assert.equal(loaded.steps[0]?.label, v2.steps[0]?.label);
});

test("a download name is a template, and a path is refused", () => {
  const scope = {
    args: { company: "irs" },
    run: { date: "2026-10-22", id: "run-1" },
    outputs: new Map(),
    suggested: "fw9.pdf",
  };
  assert.equal(renderTemplate("{{run.date}}-{{company}}-statement.pdf", scope), "2026-10-22-irs-statement.pdf");
  assert.equal(downloadFileName("{{run.date}}-{{suggested}}", scope), "2026-10-22-fw9.pdf");
  assert.throws(() => downloadFileName("../{{suggested}}", scope), /download name/);
  assert.throws(() => downloadFileName("{{company}}/x", { ...scope, args: { company: "a/b" } }), /download name/);
  const dir = mkdtempSync(path.join(tmpdir(), "bao-digest-"));
  const file = path.join(dir, "note.txt");
  writeFileSync(file, "hello bao\n");
  const digest = fileDigest(file);
  assert.equal(digest.kind, "file");
  assert.equal(digest.size, 10);
  assert.match(digest.sha256, /^[a-f0-9]{64}$/);
});

test("open on macOS is open -a, and Linux runs xdg-open and marks the app", async () => {
  const mac = planOpen({ target: "file", path: "/tmp/fw9.pdf", app: "Preview" }, "darwin");
  assert.deepEqual(mac.argv, ["open", "-a", "Preview", "/tmp/fw9.pdf"]);
  assert.equal(mac.needsMacTest, undefined);
  assert.deepEqual(planOpen({ target: "url", url: "https://example.test/a" }, "darwin").argv, ["open", "https://example.test/a"]);

  const dir = mkdtempSync(path.join(tmpdir(), "bao-open-"));
  const bin = path.join(dir, "bin");
  const log = path.join(dir, "opened.txt");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "xdg-open"), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved || ""}`;
  try {
    const plan = await openTarget({ target: "file", path: "/tmp/fw9.pdf", app: "Preview" }, { platform: "linux" });
    assert.deepEqual(plan.argv, ["xdg-open", "/tmp/fw9.pdf"]);
    assert.equal(plan.needsMacTest, NEEDS_MAC_TEST);
    assert.equal(readFileSync(log, "utf8").trim(), "/tmp/fw9.pdf");
  } finally {
    process.env.PATH = saved;
  }
});

test("replay resolves dates at run start and picks those cells, with no model call", async () => {
  const workflow: WorkflowV2 = {
    schema: WORKFLOW_SCHEMA_ID,
    version: 3,
    filesDates: 1,
    id: "wf-pick",
    name: "Pick",
    startUrl: "https://fixture.test/reservation",
    createdAt: 1,
    inputs: [
      { name: "checkIn", type: "date", relative: "+14d", format: "YYYY-MM-DD", zone: "UTC", required: true },
      { name: "checkOut", type: "date", relative: "+17d", format: "YYYY-MM-DD", zone: "UTC", required: true },
    ],
    steps: [{
      id: "stay",
      index: 0,
      action: "click",
      label: "Pick dates",
      surface: "dom",
      timeoutMs: 1000,
      identity: ident({ role: "button", tag: "button", id: "trap", text: "1" }),
      datePicker: { input: "checkIn", endInput: "checkOut" },
    }],
  };
  const picked: { iso?: string; endIso?: string }[] = [];
  const result = await replay(workflow, { checkIn: "+21d", checkOut: "+23d" }, driver({
    pickDate: async (spec) => { picked.push(spec); },
  }), { clock: OCT_22, zone: "UTC", runId: "run-pick", heal: { available: () => false, propose: async () => null } });
  assert.equal(result.status, "passed");
  assert.equal(result.modelCalls, 0);
  assert.deepEqual(picked, [{ iso: "2026-11-12", endIso: "2026-11-14", node: workflow.steps[0]?.identity }]);
});

test("replay saves a templated download and a later upload reads that file", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-runs-"));
  const workflow: WorkflowV2 = {
    schema: WORKFLOW_SCHEMA_ID,
    version: 3,
    filesDates: 1,
    id: "wf-chain",
    name: "Chain",
    startUrl: "https://fixture.test/",
    createdAt: 1,
    inputs: [
      { name: "company", type: "text", default: "irs" },
      { name: "upload", type: "file", fromOutput: "statement", required: false },
    ],
    steps: [
      {
        id: "dl",
        index: 0,
        action: "download",
        label: "Download",
        surface: "dom",
        timeoutMs: 1000,
        download: { output: "statement", name: "{{run.date}}-{{company}}-statement.pdf", url: "https://example.test/fw9.pdf" },
      },
      {
        id: "up",
        index: 1,
        action: "upload",
        label: "Upload",
        surface: "dom",
        timeoutMs: 1000,
        input: "upload",
        value: "{{upload}}",
        identity: ident({ role: "textbox", tag: "input", id: "file-upload" }),
      },
    ],
  };
  let uploaded: { name: string; path: string }[] = [];
  const uploadNode = ident({ role: "textbox", tag: "input", id: "file-upload" });
  const run = async (runId: string) => replay(workflow, { company: "irs" }, driver({
    tree: async () => ({ nodes: [uploadNode], texts: [], values: [] }),
    download: async (spec) => {
      const file = path.join(spec.dir, "fw9.pdf");
      writeFileSync(file, "%PDF-1.7 fake");
      return { suggestedFilename: "fw9.pdf", path: file };
    },
    upload: async (_node, files) => { uploaded = files; },
  }), { clock: OCT_22, zone: "UTC", runId, downloadDir: root, heal: { available: () => false, propose: async () => null } });

  const first = await run("run-a");
  const second = await run("run-b");
  assert.equal(first.status, "passed", first.failure?.reason);
  assert.equal(second.status, "passed", second.failure?.reason);
  assert.equal(first.modelCalls, 0);
  const a = first.outputs?.statement;
  const b = second.outputs?.statement;
  assert.ok(a && b);
  assert.equal(a.name, "2026-10-22-irs-statement.pdf");
  assert.equal(b.name, a.name);
  assert.equal(a.sha256, b.sha256);
  assert.equal(readFileSync(a.path).subarray(0, 4).toString(), "%PDF");
  assert.equal(readFileSync(b.path).subarray(0, 4).toString(), "%PDF");
  assert.notEqual(a.path, b.path);
  assert.equal(uploaded[0]?.name, a.name);
  assert.equal(uploaded[0]?.path, b.path);

  const loose: WorkflowV2 = {
    ...workflow,
    id: "wf-loose",
    inputs: [{ name: "upload", type: "file", required: true }],
    steps: [{
      id: "up",
      index: 0,
      action: "upload",
      label: "Upload",
      surface: "dom",
      timeoutMs: 1000,
      input: "upload",
      value: "{{upload}}",
      identity: ident({ id: "file-upload", tag: "input", role: "textbox" }),
    }],
  };
  let looseFiles: { name: string }[] = [];
  const kept = await replay(loose, { upload: { name: "alpha.txt", path: "/tmp/alpha.txt" } }, driver({
    tree: async () => ({ nodes: [uploadNode], texts: [], values: [] }),
    upload: async (_node, files) => { looseFiles = files; },
  }), { runId: "run-loose", heal: { available: () => false, propose: async () => null } });
  assert.equal(kept.status, "passed", kept.failure?.reason);
  assert.equal(looseFiles[0]?.name, "alpha.txt");
});

test("replay open file records needs Mac test on Linux", async () => {
  const seen: string[][] = [];
  const workflow: WorkflowV2 = {
    schema: WORKFLOW_SCHEMA_ID,
    version: 3,
    filesDates: 1,
    id: "wf-open",
    name: "Open",
    startUrl: "https://fixture.test/",
    createdAt: 1,
    inputs: [],
    steps: [{
      id: "open",
      index: 0,
      action: "open",
      label: "Open file",
      surface: "os",
      timeoutMs: 1000,
      open: { target: "file", file: "/tmp/fw9.pdf", app: "Preview" },
    }],
  };
  const result = await replay(workflow, {}, driver(), {
    runId: "run-open",
    openExec: async (argv) => { seen.push(argv); },
    heal: { available: () => false, propose: async () => null },
  });
  assert.equal(result.status, "passed", result.failure?.reason);
  assert.equal(result.modelCalls, 0);
  if (process.platform === "darwin") {
    assert.equal(result.steps[0]?.reason, undefined);
    assert.deepEqual(seen[0], ["open", "-a", "Preview", "/tmp/fw9.pdf"]);
  } else {
    assert.equal(result.steps[0]?.reason, NEEDS_MAC_TEST);
    assert.deepEqual(seen[0], ["xdg-open", "/tmp/fw9.pdf"]);
  }
});

test("dates are prepared once, and a bad expression fails before the first step", () => {
  const workflow: WorkflowV2 = {
    schema: WORKFLOW_SCHEMA_ID,
    version: 3,
    filesDates: 1,
    id: "wf-prep",
    name: "Prep",
    startUrl: "https://fixture.test/",
    createdAt: 1,
    inputs: [{ name: "checkIn", type: "date", relative: "+14d", format: "DD/MM/YYYY", zone: "UTC" }],
    steps: [],
  };
  const run = prepareFilesDatesRun(workflow, {}, { now: OCT_22, zone: "UTC", runId: "r", downloadDir: "/tmp" });
  assert.equal(run.dates.get("checkIn")?.iso, "2026-11-05");
  assert.equal(run.args.checkIn, "05/11/2026");
  assert.throws(() => prepareFilesDatesRun(workflow, { checkIn: "nope" }, { now: OCT_22, runId: "r2", downloadDir: "/tmp" }), /bad date/);
});

test("the recorder marks picked and typed dates", () => {
  const src = recorderSource();
  new Function(src);
  assert.match(src, /dateField/);
  assert.match(src, /react-datepicker/);
  assert.match(src, /rbc-calendar/);
  assert.match(src, /endValue/);
  assert.match(src, /data-bao-picker/);
});
