import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { guideCrops, guideHtml } from "../../src/v1/guide";
import { blankPng, redactedPng } from "../../src/v1/redacted-png";
import type { WorkflowStep, WorkflowV2 } from "../../src/v1/schema";
import { guideShotName, shotFile, workflowShotName } from "../../src/v1/shots";
import { Library } from "../../src/v1/store";

const secret = "SuperSecretPassword!";
const file = "/Users/alex/notes.txt";
const home = "/home/alex/drop.txt";

function step(partial: Partial<WorkflowStep> & Pick<WorkflowStep, "id" | "action" | "label">, index: number): WorkflowStep {
  return { surface: "dom", timeoutMs: 8000, index, ...partial };
}

function field(name: string): WorkflowStep["identity"] {
  return { surface: "dom", role: "input", tag: "input", id: name, nameAttr: name, path: [] };
}

function document(): WorkflowV2 {
  return {
    schema: "bao.workflow/v2", version: 2, id: "guide-wf", name: "Sign in and apply", startUrl: "http://127.0.0.1:9/fixture", createdAt: 1,
    inputs: [
      { name: "username", type: "text", default: "demo" },
      { name: "password", type: "secret", default: secret },
      { name: "note", type: "text", default: "alpha note" },
      { name: "upload", type: "text", default: file },
    ],
    steps: [
      step({ id: "username", action: "type", label: "Type {{username}}", input: "username", value: "{{username}}" }, 0),
      step({ id: "password", action: "type", label: "Type secret", input: "password", value: "{{password}}", sensitive: true }, 1),
      step({ id: "note", action: "type", label: "Type {{note}}", input: "note", value: "{{note}}" }, 2),
      step({ id: "apply", action: "click", label: "Click Apply" }, 3),
    ],
  };
}

function embedded(html: string): Buffer[] {
  return [...html.matchAll(/data:image\/png;base64,([^"]+)/g)].map((match) => Buffer.from(match[1], "base64"));
}

test("an exported guide keeps saved values, paths, labels, choices, and exact picture bytes", () => {
  const doc = document();
  doc.name = `Notes ${secret} ${home}`;
  doc.inputs.push({ name: "route", type: "choice", choices: ["Log in first", "Already signed in", secret] });
  doc.steps.push(
    step({ id: "open", action: "click", label: `Click ${home}` }, 4),
    step({ id: "win", action: "click", label: "Click C:\\Users\\alex\\notes.txt" }, 5),
    step({ id: "literal", action: "type", label: `Type ${secret}`, value: secret, sensitive: true }, 6),
    step({ id: "escape", action: "click", label: "Click <script>alert(1)</script>" }, 7),
  );
  const crops = new Map([
    ["username", blankPng(80, 60)],
    ["password", blankPng(81, 61)],
    ["note", blankPng(82, 62)],
  ]);
  const html = guideHtml(doc, crops);
  for (const value of [secret, file, home, "demo", "alpha note", "C:\\Users\\alex\\notes.txt"]) assert.ok(html.includes(value), value);
  assert.match(html, /Log in first \/ Already signed in \/ SuperSecretPassword!/);
  assert.match(html, /Type \{\{username\}\} in Username/);
  assert.match(html, /Type \{\{password\}\} in Password/);
  assert.match(html, /Click Apply/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script/i);
  assert.deepEqual(embedded(html), [...crops.values()]);
  assert.match(html, /id="guide"/);
  assert.match(html, /prefers-color-scheme: dark/);
});

test("unnamed targets and file actions keep their standard guide instructions", () => {
  const doc = document();
  doc.steps = [
    step({ id: "unnamed", action: "click", label: "Click" }, 0),
    step({ id: "field", action: "click", label: "Click", identity: field("") }, 1),
    step({ id: "not-a-target", action: "click", label: "username" }, 2),
    step({ id: "username", action: "type", label: "Type {{username}}", input: "username", identity: field("username") }, 3),
    step({ id: "upload", action: "upload", label: "Upload file", value: file }, 4),
    step({ id: "drop", action: "drop", label: "Drop file", value: home }, 5),
    step({ id: "bound-upload", action: "upload", label: "Upload file", input: "upload" }, 6),
    step({ id: "bound-drop", action: "drop", label: "Drop file", input: "upload" }, 7),
  ];
  const html = guideHtml(doc, new Map());
  const lines = [...html.matchAll(/<li class="step">.*?<p>(.*?)<\/p><\/li>/g)].map((match) => match[1]);
  assert.deepEqual(lines, ["Click", "Click the field", "Click", "Type {{username}} in Username", "Add a file", "Add a file", "Add {{upload}}", "Add {{upload}}"]);
});

test("a focus click folds into typing without rewriting typed or password pictures", () => {
  const doc = document();
  doc.steps = [
    step({ id: "c-user", action: "click", label: "Click username", identity: field("username") }, 0),
    step({ id: "username", action: "type", label: "Type demo", input: "username", value: "demo", identity: field("username") }, 1),
    step({ id: "c-pass", action: "click", label: "Click password", identity: field("password") }, 2),
    step({ id: "password", action: "type", label: "Type secret", input: "password", value: secret, sensitive: true, identity: field("password") }, 3),
    step({ id: "login", action: "click", label: "Click Log in", identity: { surface: "dom", role: "button", tag: "button", text: "Log in", path: [] } }, 4),
    step({ id: "note", action: "type", label: "Type alpha note", input: "note", value: "alpha note", identity: field("note") }, 5),
    step({ id: "apply", action: "click", label: "Click Apply" }, 6),
    step({ id: "only-note", action: "click", label: "Click note", identity: field("note") }, 7),
  ];
  const crops = new Map(["username", "password", "note", "apply", "only-note"].map((id, i) => [id, blankPng(64 + i, 40)]));
  const html = guideHtml(doc, crops);
  assert.equal((html.match(/<li class="step"/g) || []).length, 6);
  assert.match(html, /Type \{\{username\}\} in Username/);
  assert.match(html, /Type \{\{password\}\} in Password/);
  assert.match(html, /Click Log in/);
  assert.match(html, /Click the Note field/);
  assert.doesNotMatch(html, /Click username|Click password|Click note/);
  assert.deepEqual(embedded(html), [...crops.values()]);
});

test("guide crops prefer the original capture over an old empty-field copy and skip page pictures", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-guide-"));
  const library = new Library(root);
  const doc = document();
  library.save(doc);
  writeFileSync(path.join(root, "runs", "run-1.json"), JSON.stringify({ id: "run-1", workflowId: doc.id, at: 2 }));
  const shotDir = path.join(root, "shots", "workflows", doc.id);
  const runDir = path.join(root, "shots", "runs", "run-1");
  mkdirSync(shotDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  const original = blankPng(80, 60);
  const password = blankPng(81, 61);
  const run = blankPng(82, 62);
  writeFileSync(path.join(shotDir, workflowShotName("username")), original);
  writeFileSync(path.join(shotDir, guideShotName("username")), blankPng(90, 70));
  writeFileSync(path.join(shotDir, workflowShotName("password")), password);
  writeFileSync(path.join(shotDir, workflowShotName("note")), redactedPng(1));
  writeFileSync(path.join(runDir, shotFile("note", "after")), run);
  writeFileSync(path.join(shotDir, workflowShotName("apply")), blankPng(1280, 720));
  const crops = guideCrops(root, doc);
  assert.deepEqual(crops.get("username"), original);
  assert.deepEqual(crops.get("password"), password);
  assert.deepEqual(crops.get("note"), run);
  assert.equal(crops.has("apply"), false);
});

test("GET /guide returns stored evidence without reading separate replay input files", { timeout: 60000 }, async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "bao-guide-http-"));
  const app = await startApp({ home: homeDir, port: 0, extensionHost: false, chromeProfilesRoot: path.join(homeDir, "profiles") });
  try {
    const doc = document();
    app.library.save(doc);
    app.library.savePublicInputs(doc.id, { password: "separate-replay-value", upload: "/separate/replay/file" });
    const res = await fetch(`http://127.0.0.1:${app.port}/api/workflows/${doc.id}/guide`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    for (const value of [secret, file, "alpha note", "demo"]) assert.ok(html.includes(value), value);
    assert.doesNotMatch(html, /separate-replay-value|\/separate\/replay\/file/);
    assert.match(html, /id="guide"/);
    const missing = await fetch(`http://127.0.0.1:${app.port}/api/workflows/missing/guide`);
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
  }
});
