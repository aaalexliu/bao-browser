// Step text tokens and the run form share one default. A secret stays masked.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runField, workflowDetail } from "../../src/app/views";
import { editInput, tokenFields } from "../../src/v1/input-token";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { draftVersion, promoteVersion } from "../../src/v1/versions";

function doc(): WorkflowV2 {
  return {
    schema: "bao.workflow/v4",
    version: 2,
    id: "wf-note",
    name: "Note",
    startUrl: "http://127.0.0.1/fixture",
    createdAt: 1,
    inputs: [
      { name: "note", type: "text", label: "Note", default: "ada", required: true },
      { name: "password", type: "secret", label: "Password", required: true },
    ],
    steps: [
      {
        id: "type",
        index: 0,
        action: "type",
        label: "Type {{note}}",
        value: "{{note}}",
        input: "note",
        surface: "dom",
        timeoutMs: 0,
      },
      {
        id: "secret",
        index: 1,
        action: "type",
        label: "Type {{password}}",
        input: "password",
        sensitive: true,
        surface: "dom",
        timeoutMs: 0,
      },
    ],
  };
}

test("the selected step and input summary offer tokens with the run form's default", () => {
  const workflow = doc();
  const html = workflowDetail(workflow);
  const headline = html.slice(html.indexOf('data-step-panel="type"'), html.indexOf('data-step-panel="secret"'));
  assert.match(headline, /class="token"/);
  assert.match(headline, /data-edit-input="note"/);
  assert.match(headline, /token-label">Note/);
  assert.match(headline, /token-meta">text/);
  assert.match(headline, /token-meta">ada/);
  assert.match(headline, /token-meta">required/);
  assert.match(headline, /<h2>Type Note<\/h2>/);
  const secret = html.slice(html.indexOf('data-step-panel="secret"'));
  assert.match(secret, /class="token secret"/);
  assert.match(secret, /token-label">Password/);
  assert.match(secret, /token-meta">secret/);
  assert.match(secret, /token-meta">••••/);
  assert.equal(html.includes("SuperSecretPassword!"), false);
  assert.equal(html.includes("BaoSecretFixture9kQ7m"), false);
  const fields = tokenFields(workflow.inputs[0]!);
  const form = runField(workflow.inputs[0]!);
  assert.match(form, new RegExp(`>${fields.default}<`));
  assert.equal(fields.default, "ada");
  const secretFields = tokenFields({ name: "password", type: "secret", label: "Password", default: "BaoSecretFixture9kQ7m" });
  assert.equal(secretFields.masked, true);
  assert.equal(secretFields.default, "BaoSecretFixture9kQ7m");
  const secretForm = runField({ name: "password", type: "secret", label: "Password" }, "••••");
  assert.match(secretForm, /type="password"/);
  assert.match(secretForm, /value=""/);
  assert.equal(secretForm.includes("BaoSecretFixture9kQ7m"), false);
  const retained = { name: "password", type: "secret", default: " saved password " };
  assert.match(runField(retained), /value=" saved password "/);
  assert.match(runField(retained, "runtime override"), /value="runtime override"/);
  assert.match(runField(retained, "[secret stripped]"), /value=" saved password "/);
  assert.match(runField({ ...retained, default: "[secret stripped]" }), /value=""/);
});

test("an untouched choice submits the saved default, not the first option", () => {
  const field = runField({ name: "size", type: "choice", label: "Size", choices: ["S", "M", "L"], default: "M" });
  assert.match(field, /<option selected>M<\/option>/);
  assert.equal(field.includes("<option selected>S</option>"), false);
  const previous = runField({ name: "size", type: "choice", label: "Size", choices: ["S", "M", "L"], default: "M" }, "L");
  assert.match(previous, /<option selected>L<\/option>/);
  assert.equal(previous.includes("<option selected>M</option>"), false);
});

test("editing an imported input marks it saved only when the value changes", () => {
  const imported: WorkflowV2 = { ...doc(), imported: true };
  const labelOnly = editInput(imported, { name: "note", label: "Desk note", default: "ada" });
  assert.equal(labelOnly.doc?.inputs.find((input) => input.name === "note")?.label, "Desk note");
  assert.equal(labelOnly.doc?.inputs.find((input) => input.name === "note")?.ownerSaved, undefined);
  const changed = editInput(imported, { name: "note", default: "mine" });
  assert.equal(changed.doc?.inputs.find((input) => input.name === "note")?.default, "mine");
  assert.equal(changed.doc?.inputs.find((input) => input.name === "note")?.ownerSaved, true);
  const kept = editInput(changed.doc!, { name: "note", label: "Still mine", default: "mine" });
  assert.equal(kept.doc?.inputs.find((input) => input.name === "note")?.ownerSaved, true);
});

test("editing a token saves ordinary and secret defaults for the run form", () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-token-"));
  const library = new Library(home);
  library.save(doc());
  const edited = editInput(library.read("wf-note"), { name: "note", label: "Note", type: "text", default: "ada lovelace", required: true });
  assert.ok(edited.doc);
  const drafted = draftVersion(library, edited.doc!, "edit");
  promoteVersion(library, "wf-note", drafted.n);
  const live = library.read("wf-note");
  assert.equal(live.inputs[0]?.default, "ada lovelace");
  assert.match(runField(live.inputs[0]!), />ada lovelace</);
  const masked = editInput(live, { name: "password", type: "secret", label: "Password", default: "BaoSecretFixture9kQ7m", required: true });
  assert.ok(masked.doc);
  assert.equal(masked.doc?.inputs.find((input) => input.name === "password")?.default, "BaoSecretFixture9kQ7m");
  assert.equal(JSON.stringify(masked.doc).includes("BaoSecretFixture9kQ7m"), true);
  const spaced = editInput(live, { name: "password", default: " saved password " });
  assert.equal(spaced.doc?.inputs.find((input) => input.name === "password")?.default, " saved password ");
});
