// Import questions clear personal values. bao:// opens the running app.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { decideOpen, parseBaoLink } from "../../src/app/deeplink";
import { runThrowawayGate } from "../../src/v1/publish-gate";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { applyImportAnswers, importQuestions, missingAnswers, prepareImport, publicSamples } from "../../../web/src/lib/import-sheet";
import { plainReplayReason } from "../../../web/src/lib/review-gate";

function workflow(id: string, name: string): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id,
    name,
    startUrl: "https://example.com",
    createdAt: 1,
    inputs: [
      { name: "email", type: "text", label: "Email", required: true, default: "ada@acme.com" },
      { name: "who", type: "text", label: "Name", required: true, default: "Ada Lovelace" },
      { name: "note", type: "text", label: "Note", required: true, default: "/home/ada/note.txt" },
      { name: "desk", type: "text", label: "Desk", required: true, default: "front", askOnImport: true },
      { name: "password", type: "secret", label: "Password", required: true },
    ],
    steps: [{
      id: "go",
      index: 0,
      action: "key",
      key: "Enter",
      label: "Submit",
      surface: "dom",
      timeoutMs: 1000,
    }],
  };
}

test("personal defaults become import questions and leave the shared copy", () => {
  const doc = workflow("sheet", "Sheet");
  const released = prepareImport(doc);
  const text = JSON.stringify(released.document);
  assert.equal(text.includes("@"), false);
  assert.equal(text.includes("/home/ada"), false);
  assert.equal(text.includes("Ada Lovelace"), false);
  const names = released.questions.map((question) => question.name);
  assert.deepEqual(names, ["email", "who", "note", "desk", "password"]);
  const email = released.questions.find((question) => question.name === "email");
  assert.equal(email?.cleared, "email");
  assert.equal(email?.prompt, "Email to use");
  assert.equal(email?.hint, "The sharer's email was removed.");
  const note = released.questions.find((question) => question.name === "note");
  assert.equal(note?.type, "file");
  assert.equal(note?.prompt, "Which file");
  assert.equal(note?.hint, "The sharer's file was removed.");
  const desk = released.questions.find((question) => question.name === "desk");
  assert.equal(desk?.prompt, "Desk");
  assert.equal(desk?.example, "front");
  assert.equal(desk?.hint, "For example, front.");
  assert.equal(released.questions.find((question) => question.name === "password")?.required, false);
  assert.equal(plainReplayReason("below-threshold"), "bao couldn't find this control confidently enough.");
  const stored = released.document as { inputs: { name: string; cleared?: string; default?: string; askOnImport?: boolean }[] };
  assert.equal(stored.inputs.find((input) => input.name === "email")?.cleared, "email");
  assert.equal(stored.inputs.find((input) => input.name === "email")?.default, undefined);
  assert.equal(stored.inputs.find((input) => input.name === "desk")?.askOnImport, true);
  assert.equal(missingAnswers(importQuestions(released.document), {}).includes("email"), true);
  assert.throws(() => applyImportAnswers(released.document, {}), /answer email/);
  const saved = applyImportAnswers(released.document, {
    email: "ada@other.com",
    who: "front desk",
    note: "inbox",
    desk: "west",
  }) as { inputs: { name: string; default?: string }[] };
  assert.equal(JSON.stringify(saved).includes("@"), false);
  assert.equal(JSON.stringify(saved).includes("/home/"), false);
  assert.equal(saved.inputs.find((input) => input.name === "desk")?.default, "west");
  assert.equal(saved.inputs.find((input) => input.name === "email")?.default, undefined);
});

test("public samples keep a search query and drop a secret", () => {
  const samples = publicSamples({
    query: "Ada Lovelace",
    username: "grace",
    email: "ada@acme.com",
    note: "/Users/ada/note.txt",
    password: "fixture-pass-value",
  });
  assert.equal(samples.query, "Ada Lovelace");
  assert.equal(samples.username, "grace");
  assert.equal(samples.email, undefined);
  assert.equal(samples.note, undefined);
  assert.equal(samples.password, undefined);
});

test("bao links open a workflow or an unsaved import", () => {
  const local = workflow("local-one", "Local one");
  assert.deepEqual(parseBaoLink("bao://workflow/local-one"), { kind: "workflow", id: "local-one" });
  assert.equal(parseBaoLink("https://example.com/local-one"), null);
  const opened = decideOpen("bao://workflow/local-one", local, null);
  assert.equal("opened" in opened && opened.opened.kind, "workflow");
  assert.equal("pending" in opened && opened.pending, null);
  const sheet = decideOpen("bao://import/import-me", null, workflow("import-me", "Import me"));
  assert.equal("opened" in sheet && sheet.opened.kind, "import");
  assert.equal("opened" in sheet && sheet.opened.saved, false);
  assert.equal("pending" in sheet && sheet.pending?.id, "import-me");
  assert.equal(sheet && "pending" in sheet && JSON.stringify(sheet.pending).includes("@"), true);
  const missing = decideOpen("bao://workflow/absent", null, null);
  assert.equal("error" in missing && missing.error, "workflow not on this Mac");
});

test("a workflow with no public site does not launch a browser", async () => {
  const doc = workflow("offline", "Offline");
  doc.startUrl = "about:blank";
  const result = await runThrowawayGate(doc);
  assert.equal(result.ok, false);
  assert.match(result.reason || "", /public site/);
});

test("bao open round trip", { timeout: 30_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-open-"));
  const app = await startApp({ home, port: 0 });
  try {
    app.library.save(workflow("local-one", "Local one"));
    const cli = path.join(process.cwd(), "desktop/dist/desktop/src/app/cli.js");
    const opened = await runCli(cli, ["open", "bao://workflow/local-one"], home);
    assert.equal(opened.status, 0, `${opened.stderr}\n${opened.stdout}`);
    const body = JSON.parse(opened.stdout) as { ok: boolean; opened: { kind: string; id: string } };
    assert.equal(body.ok, true);
    assert.equal(body.opened.kind, "workflow");
    assert.equal(body.opened.id, "local-one");
    const state = await (await fetch(`http://127.0.0.1:${app.port}/api/state`)).json() as { opened: { kind: string } };
    assert.equal(state.opened.kind, "workflow");

    const incoming = workflow("import-me", "Import me");
    const pending = await fetch(`http://127.0.0.1:${app.port}/api/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ link: "bao://import/import-me", document: incoming }),
    });
    const pendingBody = await pending.json() as { ok: boolean; opened: { kind: string; questions: { name: string }[] } };
    assert.equal(pending.ok, true, JSON.stringify(pendingBody));
    assert.equal(pendingBody.opened.kind, "import");
    assert.ok(pendingBody.opened.questions.some((question) => question.name === "email"));
    assert.throws(() => app.library.read("import-me"));
    const blocked = await fetch(`http://127.0.0.1:${app.port}/api/open/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: {} }),
    });
    assert.equal(blocked.status, 400);
    assert.throws(() => app.library.read("import-me"));
    const saved = await fetch(`http://127.0.0.1:${app.port}/api/open/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: { email: "ada@other.com", who: "front desk", note: "inbox", desk: "west" } }),
    });
    assert.equal(saved.status, 200, await saved.text());
    const stored = new Library(home).read("import-me");
    assert.equal(JSON.stringify(stored).includes("@"), false);
    assert.equal(JSON.stringify(stored).includes("/home/ada"), false);
    assert.equal(stored.inputs.find((input) => input.name === "desk")?.default, "west");
  } finally {
    await app.close();
  }
});

test("bao open round trip fills non-secret inputs", { timeout: 30_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-open-run-"));
  const app = await startApp({ home, port: 0 });
  try {
    app.library.save(workflow("local-one", "Local one"));
    const inputs = encodeURIComponent(JSON.stringify({ email: "ada@other.com", desk: "west" }));
    const link = `bao://run/local-one?inputs=${inputs}`;
    const cli = path.join(process.cwd(), "desktop/dist/desktop/src/app/cli.js");
    const opened = await runCli(cli, ["open", link], home);
    assert.equal(opened.status, 0, `${opened.stderr}\n${opened.stdout}`);
    const body = JSON.parse(opened.stdout) as { ok: boolean; opened: { kind: string; inputs?: Record<string, string> } };
    assert.equal(body.ok, true);
    assert.equal(body.opened.kind, "run");
    assert.equal(body.opened.inputs?.email, "ada@other.com");
    assert.equal(body.opened.inputs?.desk, "west");
    assert.equal(body.opened.inputs?.password, undefined);
    const state = await (await fetch(`http://127.0.0.1:${app.port}/api/state`)).json() as { opened: { kind: string; inputs?: Record<string, string> } };
    assert.equal(state.opened.kind, "run");
    assert.equal(state.opened.inputs?.email, "ada@other.com");
    assert.equal(state.opened.inputs?.password, undefined);
  } finally {
    await app.close();
  }
});

test("a secret key in a run link is refused", { timeout: 30_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-open-secret-"));
  const app = await startApp({ home, port: 0 });
  try {
    app.library.save(workflow("local-one", "Local one"));
    const inputs = encodeURIComponent(JSON.stringify({ password: "nope", email: "ada@other.com" }));
    const link = `bao://run/local-one?inputs=${inputs}`;
    const cli = path.join(process.cwd(), "desktop/dist/desktop/src/app/cli.js");
    const opened = await runCli(cli, ["open", link], home);
    assert.notEqual(opened.status, 0);
    assert.match(`${opened.stdout}\n${opened.stderr}`, /Secret inputs are re-asked on this device\. Remove Password from the link\./);
    const state = await (await fetch(`http://127.0.0.1:${app.port}/api/state`)).json() as { opened: { inputs?: Record<string, string> } | null };
    assert.equal(state.opened, null);
    assert.equal(`${opened.stdout}\n${opened.stderr}`.includes("nope"), false);
  } finally {
    await app.close();
  }
});

function runCli(cli: string, args: string[], home: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, BAO_HOME: home },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("close", (status) => {
      resolve({
        status: status ?? 1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}
