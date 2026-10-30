import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { driftMarkdown, driftReport, macChangeApplicability, windowChangeRows } from "../../src/v1/drift";
import { boundsApplied } from "../../src/v1/window-bounds";
import { fromAxNode, lookup, normRole, type AxDumpNode } from "../../src/v1/identity";
import type { Identity } from "../../src/v1/schema";

const dir = path.join(process.cwd(), "fixtures/ax/macos-26");

interface RawNode {
  role?: string;
  subrole?: string;
  title?: string;
  description?: string;
  identifier?: string;
  name?: string;
  value?: string;
  children?: RawNode[];
}

test("observed Calculator keypad buttons are unique under the scorer", () => {
  const raw = JSON.parse(readFileSync(path.join(dir, "calculator.observed.json"), "utf8")) as {
    bundleId: string;
    nodes: AxDumpNode[];
  };
  const nodes = raw.nodes.map((node) => fromAxNode(node, { bundleId: raw.bundleId }));
  for (const name of ["7", "Add", "5", "Equals"]) {
    const query = nodes.find((node) => node.name === name);
    assert.ok(query, name);
    const hit = lookup(query, nodes);
    assert.equal(hit.ok, true, `${name} ${hit.reason} ${hit.brokenAttr}`);
    assert.equal(nodes[hit.index!]?.name, name);
  }
});

test("macOS 26 Calculator keys resolve by description and by identifier", () => {
  const nodes = load("calculator.json");
  for (const [description, identifier] of [
    ["7", "Seven"],
    ["5", "Five"],
    ["Add", "Add"],
    ["Equals", "Equals"],
    ["All Clear", "AllClear"],
  ] as const) {
    const query = nodes.find((node) => node.identifier === identifier && node.description === description);
    assert.ok(query, identifier);
    const hit = lookup(query, nodes);
    assert.equal(hit.ok, true, `${identifier} ${hit.reason} ${hit.score} ${hit.margin}`);
    assert.equal(nodes[hit.index!]?.identifier, identifier);
    const byToken = lookup({ surface: "ax", role: "AXButton", identifier, path: [] }, nodes);
    assert.equal(byToken.ok, true, identifier);
    assert.equal(nodes[byToken.index!]?.identifier, identifier);
  }
  const display = nodes.find((node) => node.role === "AXStaticText" && node.value === "0");
  assert.ok(display, "display value keeps the digits and drops the LRM");
  const marked = lookup({ ...display, value: "\u200e0" }, nodes);
  assert.equal(marked.ok, true, marked.reason);
});

test("TextEdit body is First Text View, and Untitled.rtf is the same window", () => {
  const nodes = load("textedit.json");
  const area = nodes.find((node) => node.identifier === "First Text View");
  assert.ok(area);
  assert.equal(area.title, undefined);
  assert.equal(area.description, undefined);
  const hit = lookup(area, nodes);
  assert.equal(hit.ok, true, `${hit.reason} ${hit.margin}`);
  assert.equal(nodes[hit.index!]?.identifier, "First Text View");
  const titled = nodes.map((node) => node.identifier === "First Text View" ? { ...node, windowTitle: "Untitled.rtf" } : node);
  const query = { ...area, windowTitle: "Untitled" };
  const renamed = lookup(query, titled);
  assert.equal(renamed.ok, true, renamed.reason);
  const byTitle = lookup({
    surface: "ax",
    role: "AXTextArea",
    name: "First Text View",
    title: "First Text View",
    path: [],
  }, nodes);
  assert.equal(byTitle.ok, false);
});

test("Finder file names are text field values", () => {
  const nodes = load("finder.json");
  for (const name of ["a.txt", "b.txt"]) {
    const query = nodes.find((node) => node.name === name && normRole(node.role) === "textbox");
    assert.ok(query, name);
    const hit = lookup(query, nodes);
    assert.equal(hit.ok, true, `${name} ${hit.reason} ${hit.score} ${hit.margin}`);
    assert.equal(nodes[hit.index!]?.name, name);
  }
});

test("Safari address field identifier is unique", () => {
  const nodes = load("safari.json");
  const field = nodes.find((node) => node.identifier === "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD" && node.description);
  assert.ok(field);
  const hit = lookup(field, nodes);
  assert.equal(hit.ok, true, `${hit.reason} ${hit.margin}`);
  assert.equal(nodes[hit.index!]?.identifier, "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD");
});

test("Electron bao-button is in the tree when the app enabled accessibility", () => {
  for (const file of ["electron.json", "electron-manual-off.json"]) {
    const nodes = load(file);
    const button = nodes.find((node) => node.name === "bao-button" || node.title === "bao-button");
    assert.ok(button, file);
    const hit = lookup(button, nodes);
    assert.equal(hit.ok, true, `${file} ${hit.reason}`);
    assert.equal(nodes[hit.index!]?.name, "bao-button");
  }
});

test("Calculator resize drift is n/a because AXSize returns -25200", () => {
  assert.equal(macChangeApplicability("resize", "com.apple.calculator"), "na");
  assert.equal(macChangeApplicability("move", "com.apple.calculator"), "run");
  const report = driftReport([
    { workflow: "calc", change: "resize", stepId: "s", passed: false, na: true, reason: "AXSize -25200" },
    { workflow: "calc", change: "move", stepId: "s", passed: true },
  ], "2026-10-21");
  const resize = report.summary.find((row) => row.change === "resize");
  assert.equal(resize?.na, 1);
  assert.equal(resize?.passed, 0);
  assert.equal(resize?.failed, 0);
  const move = report.summary.find((row) => row.change === "move");
  assert.equal(move?.passed, 1);
  const step = report.steps.find((row) => row.stepId === "s");
  assert.equal(step?.passed, 1);
  assert.equal(step?.na, 1);
  assert.equal(step?.failed, 0);
  assert.equal(step?.rate, 1);
  const md = driftMarkdown(report);
  assert.match(md, /## Steps/);
  assert.match(md, /\| s \| {2}\| 1 \| 0 \| 1 \| 100% \|/);
  assert.match(md, /\| resize \| 0 \| 0 \| 1 \| 0% \|/);
});

test("a window move that never applied is n/a-harness", () => {
  assert.equal(boundsApplied({ x: 22, y: 55, width: 1282, height: 846 }, { x: 48, y: 72, width: 980, height: 640 }), false);
  assert.equal(boundsApplied({ x: 48, y: 72, width: 980, height: 640 }, { x: 48, y: 72, width: 980, height: 640 }), true);
  const missed = windowChangeRows({
    workflow: "browser-form",
    change: "window-move",
    applied: false,
    reason: "requested 48,72; origin stayed 22,55",
    steps: [{ id: "s", passed: false, brokenAttr: "testId", reason: "should not count" }],
  });
  assert.equal(missed.length, 1);
  assert.equal(missed[0]?.na, true);
  const missedReport = driftReport(missed, "t");
  assert.equal(missedReport.summary[0]?.failed, 0);
  assert.equal(missedReport.summary[0]?.na, 1);
  const missedMd = driftMarkdown(missedReport);
  assert.match(missedMd, /n\/a-harness/);
  assert.match(missedMd, /none/);
  const hit = windowChangeRows({
    workflow: "browser-form",
    change: "window-move",
    applied: true,
    reason: "48,72",
    steps: [{ id: "s", label: "Type", passed: false, brokenAttr: "testId", reason: "below-threshold" }],
  });
  assert.equal(hit[0]?.passed, true);
  assert.equal(hit[1]?.brokenAttr, "testId");
  const hitReport = driftReport(hit, "t");
  assert.equal(hitReport.summary[0]?.failed, 1);
  assert.match(driftMarkdown(hitReport), /testId/);
});

function load(file: string): Identity[] {
  const raw = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as { bundle?: string; nodes: RawNode[] };
  // `children` on these dumps are short briefs of nodes that are also full
  // records in `nodes`. Scoring the briefs twice makes one control look like two.
  return raw.nodes.filter((node) => node.role).map((node) => fromAxNode({
    role: node.role || "",
    subrole: node.subrole,
    title: node.title,
    description: node.description,
    identifier: node.identifier,
    name: node.name,
    value: node.value,
    path: [],
  }, { bundleId: raw.bundle }));
}
