import { testWorkflow,  } from "../support/workflow";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { guideCrops, guideHtml } from "../../src/v1/guide";
import { blankPng, redactedPng } from "../../src/v1/redacted-png";
import type { WorkflowV2 } from "../../src/v1/schema";
import { guideShotName, shotFile, workflowShotName } from "../../src/v1/shots";
import { Library } from "../../src/v1/store";

const secret = "SuperSecretPassword!";
const file = "/Users/alex/notes.txt";
const home = "/home/alex/drop.txt";

function document(): WorkflowV2 {
  return testWorkflow({
    schema: "bao.workflow/v4", id: "guide-wf", name: "Sign in and apply", startUrl: "http://127.0.0.1:9/fixture", createdAt: 1,
    inputs: [
      { name: "username", type: "text", label: "username", supply: "saved", default: "demo" },
      { name: "password", type: "secret", label: "password", supply: "saved", default: secret },
      { name: "note", type: "text", label: "note", supply: "saved", default: "alpha note" },
      { name: "upload", type: "text", label: "upload", supply: "saved", default: file },
    ],
    steps: [
      {
        id: "username",
        index: 0,
        timeoutMs: 8000,
        caption: { text: "Type {{username}}" },
        action: "type",
        target: { locators: [{ kind: "role", role: "textbox", name: "Type {{username}}" }] },
        text: { input: "username" },
      },
      {
        id: "password",
        index: 1,
        timeoutMs: 8000,
        caption: { text: "Type secret" },
        action: "type",
        target: { locators: [{ kind: "role", role: "textbox", name: "Type secret" }] },
        text: { input: "password" },
        sensitive: true,
      },
      {
        id: "note",
        index: 2,
        timeoutMs: 8000,
        caption: { text: "Type {{note}}" },
        action: "type",
        target: { locators: [{ kind: "role", role: "textbox", name: "Type {{note}}" }] },
        text: { input: "note" },
      },
      {
        id: "apply",
        index: 3,
        timeoutMs: 8000,
        caption: { text: "Click Apply" },
        action: "click",
        target: { locators: [{ kind: "role", role: "button", name: "Click Apply" }] },
      },
    ],
  });
}

function embedded(html: string): Buffer[] {
  return [...html.matchAll(/data:image\/png;base64,([^"]+)/g)].map((match) => Buffer.from(match[1], "base64"));
}

test("an exported guide keeps saved values, paths, labels, choices, and exact picture bytes", () => {
  const doc = document();
  doc.name = `Notes ${secret} ${home}`;
  doc.inputs.push({
    name: "route",
    type: "choice",
    label: "route",
    supply: "must",
    choices: ["Log in first", "Already signed in", secret],
  });
  doc.steps.push(
    {
      id: "open",
      index: 4,
      timeoutMs: 8000,
      caption: { text: `Click ${home}` },
      action: "click",
      target: { locators: [{ kind: "role", role: "button", name: `Click ${home}` }] },
    },
    {
      id: "win",
      index: 5,
      timeoutMs: 8000,
      caption: { text: "Click C:\\Users\\alex\\notes.txt" },
      action: "click",
      target: { locators: [{ kind: "role", role: "button", name: "Click C:\\Users\\alex\\notes.txt" }] },
    },
    {
      id: "literal",
      index: 6,
      timeoutMs: 8000,
      caption: { text: `Type ${secret}` },
      action: "type",
      target: { locators: [{ kind: "role", role: "textbox", name: `Type ${secret}` }] },
      text: { literal: secret },
      sensitive: true,
    },
    {
      id: "escape",
      index: 7,
      timeoutMs: 8000,
      caption: { text: "Click <script>alert(1)</script>" },
      action: "click",
      target: { locators: [{ kind: "role", role: "button", name: "Click <script>alert(1)</script>" }] },
    },
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
    {
      id: "unnamed",
      index: 0,
      timeoutMs: 8000,
      caption: { text: "Click" },
      action: "click",
      target: { locators: [{ kind: "role", role: "button", name: "Click" }] },
    },
    {
      id: "field",
      index: 1,
      timeoutMs: 8000,
      caption: { text: "Click" },
      action: "click",
      target: { locators: [], hint: { role: "input", surface: "dom", tag: "input" } },
    },
    {
      id: "not-a-target",
      index: 2,
      timeoutMs: 8000,
      caption: { text: "username" },
      action: "click",
      target: { locators: [{ kind: "role", role: "button", name: "username" }] },
    },
    {
      id: "username",
      index: 3,
      timeoutMs: 8000,
      caption: { text: "Type {{username}}" },
      action: "type",
      target: {
        locators: [{ kind: "css", value: "#username" }, { kind: "xpath", value: "//*[@id=\"username\"]" }],
        hint: { nameAttr: "username", role: "input", surface: "dom", tag: "input", id: "username" },
      },
      text: { input: "username" },
    },
    {
      id: "upload",
      index: 4,
      timeoutMs: 8000,
      caption: { text: "Upload file" },
      action: "upload",
      target: { locators: [{ kind: "css", value: "input[type=file]" }] },
      file: { input: "file" },
    },
    {
      id: "drop",
      index: 5,
      timeoutMs: 8000,
      caption: { text: "Drop file" },
      action: "drop",
      target: { locators: [{ kind: "css", value: "input[type=file]" }] },
      file: { input: "file" },
    },
    {
      id: "bound-upload",
      index: 6,
      timeoutMs: 8000,
      caption: { text: "Upload file" },
      action: "upload",
      target: { locators: [{ kind: "css", value: "input[type=file]" }] },
      file: { input: "upload" },
    },
    {
      id: "bound-drop",
      index: 7,
      timeoutMs: 8000,
      caption: { text: "Drop file" },
      action: "drop",
      target: { locators: [{ kind: "css", value: "input[type=file]" }] },
      file: { input: "upload" },
    },
  ];
  const html = guideHtml(doc, new Map());
  const lines = [...html.matchAll(/<li class="step">.*?<p>(.*?)<\/p><\/li>/g)].map((match) => match[1]);
  assert.deepEqual(lines, ["Click", "Click the field", "Click Username", "Type {{username}} in Username", "Add a file", "Add a file", "Add {{upload}}", "Add {{upload}}"]);
});

test("a focus click folds into typing without rewriting typed or password pictures", () => {
  const doc = document();
  doc.steps = [
    {
      id: "c-user",
      index: 0,
      timeoutMs: 8000,
      caption: { text: "Click username" },
      action: "click",
      target: {
        locators: [{ kind: "css", value: "#username" }, { kind: "xpath", value: "//*[@id=\"username\"]" }],
        hint: { nameAttr: "username", role: "input", surface: "dom", tag: "input", id: "username" },
      },
    },
    {
      id: "username",
      index: 1,
      timeoutMs: 8000,
      caption: { text: "Type demo" },
      action: "type",
      target: {
        locators: [{ kind: "css", value: "#username" }, { kind: "xpath", value: "//*[@id=\"username\"]" }],
        hint: { nameAttr: "username", role: "input", surface: "dom", tag: "input", id: "username" },
      },
      text: { input: "username" },
    },
    {
      id: "c-pass",
      index: 2,
      timeoutMs: 8000,
      caption: { text: "Click password" },
      action: "click",
      target: {
        locators: [{ kind: "css", value: "#password" }, { kind: "xpath", value: "//*[@id=\"password\"]" }],
        hint: { nameAttr: "password", role: "input", surface: "dom", tag: "input", id: "password" },
      },
    },
    {
      id: "password",
      index: 3,
      timeoutMs: 8000,
      caption: { text: "Type secret" },
      action: "type",
      target: {
        locators: [{ kind: "css", value: "#password" }, { kind: "xpath", value: "//*[@id=\"password\"]" }],
        hint: { nameAttr: "password", role: "input", surface: "dom", tag: "input", id: "password" },
      },
      text: { input: "password" },
      sensitive: true,
    },
    {
      id: "login",
      index: 4,
      timeoutMs: 8000,
      caption: { text: "Click Log in", citation: { text: "Log in", source: "text" } },
      action: "click",
      target: {
        locators: [{ kind: "role", role: "button", name: "Log in" }, { kind: "text", value: "Log in" }],
        hint: { role: "button", surface: "dom", tag: "button" },
      },
    },
    {
      id: "note",
      index: 5,
      timeoutMs: 8000,
      caption: { text: "Type alpha note" },
      action: "type",
      target: {
        locators: [{ kind: "css", value: "#note" }, { kind: "xpath", value: "//*[@id=\"note\"]" }],
        hint: { nameAttr: "note", role: "input", surface: "dom", tag: "input", id: "note" },
      },
      text: { input: "note" },
    },
    {
      id: "apply",
      index: 6,
      timeoutMs: 8000,
      caption: { text: "Click Apply" },
      action: "click",
      target: { locators: [{ kind: "role", role: "button", name: "Click Apply" }] },
    },
    {
      id: "only-note",
      index: 7,
      timeoutMs: 8000,
      caption: { text: "Click note" },
      action: "click",
      target: {
        locators: [{ kind: "css", value: "#note" }, { kind: "xpath", value: "//*[@id=\"note\"]" }],
        hint: { nameAttr: "note", role: "input", surface: "dom", tag: "input", id: "note" },
      },
    },
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

test("guides use human login copy and list defaults rather than import examples", () => {
  const doc = document();
  doc.inputs = [
    {
      name: "saved",
      type: "text",
      label: "saved",
      supply: "saved",
      default: "captured-value",
      example: "import-example",
    },
    { name: "sample", type: "text", label: "sample", supply: "must", example: "sample-only" },
    { name: "empty", type: "text", label: "empty", supply: "must", example: "empty-example" },
  ];
  doc.steps = [
    {
      id: "login",
      index: 0,
      timeoutMs: 8000,
      caption: { text: "ensure logged in (import from chrome, else wait for user)" },
      action: "handoff",
      reason: "sign-in",
    },
    {
      id: "secret",
      index: 1,
      timeoutMs: 8000,
      caption: { text: "Type stored secret" },
      action: "type",
      target: { locators: [{ kind: "role", role: "textbox", name: "Type stored secret" }] },
      text: { literal: "stored secret" },
      sensitive: true,
    },
  ];
  const html = guideHtml(doc, new Map());
  assert.match(html, /<li class="step"><p>Sign in<\/p><\/li>/);
  assert.match(html, /<li class="step"><p>Type stored secret<\/p><\/li>/);
  assert.match(html, /<li><code>\{\{saved\}\}<\/code> captured-value<\/li>/);
  assert.match(html, /<li><code>\{\{sample\}\}<\/code><\/li>/);
  assert.match(html, /<li><code>\{\{empty\}\}<\/code><\/li>/);
  assert.doesNotMatch(html, /ensure logged in|import-example|sample-only|empty-example/);
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
