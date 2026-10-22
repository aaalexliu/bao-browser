import assert from "node:assert/strict";
import test from "node:test";
import { droppedNoEffectIds } from "../../src/v1/condense";
import { SETTLED_EXPECT } from "../../src/v1/expect";
import { interpret, type TrailEvent } from "../../src/v1/interpret";
import { holdsExpect, type LiveTree } from "../../src/v1/replay";
import type { Identity } from "../../src/v1/schema";

function ident(partial: Partial<Identity>): Identity {
  return { surface: "dom", role: "button", path: [], ...partial };
}

function act(partial: Partial<TrailEvent> & Pick<TrailEvent, "id" | "op">): TrailEvent {
  return { ts: 1, kind: "act", ...partial };
}

test("subtree text is the check, ahead of a url change", () => {
  const doc = interpret([
    act({
      id: "go",
      op: "click",
      identity: ident({ id: "save", text: "Save" }),
      subtreeBefore: "Save",
      subtreeAfter: "Saved the note",
      beforeUrl: "https://example.com/edit",
      afterUrl: "https://example.com/done",
    }),
  ], { id: "wf", startUrl: "https://example.com/edit" });
  assert.equal(doc.steps[0]?.postcondition?.kind, "text");
  assert.equal(doc.steps[0]?.expect?.match, "Saved the note");
  assert.equal(doc.steps[0]?.confidence, undefined);
});

test("a value change is the check, ahead of a url change", () => {
  const doc = interpret([
    act({
      id: "name",
      op: "type",
      value: "Ada",
      identity: ident({ id: "name", role: "textbox", nameAttr: "name" }),
    }),
    act({
      id: "go",
      op: "click",
      identity: ident({ id: "save", text: "Save" }),
      valueBefore: "",
      valueAfter: "Ada",
      beforeUrl: "https://example.com/edit",
      afterUrl: "https://example.com/done",
    }),
  ], { id: "wf", startUrl: "https://example.com/edit" });
  assert.equal(doc.steps[1]?.postcondition?.kind, "value");
  assert.equal(doc.steps[1]?.postcondition?.match, "{{name}}");
  assert.notEqual(doc.steps[1]?.expect?.kind, "url");
});

test("a checked change is the check, ahead of a url change", () => {
  const doc = interpret([
    act({
      id: "box",
      op: "click",
      checked: true,
      identity: ident({ id: "agree", role: "checkbox" }),
      beforeUrl: "https://example.com/form",
      afterUrl: "https://example.com/form/next",
    }),
  ], { id: "wf", startUrl: "https://example.com/form" });
  assert.equal(doc.steps[0]?.expect?.kind, "state");
  assert.equal(doc.steps[0]?.expect?.state, "checked");
  assert.equal(doc.steps[0]?.postcondition, undefined);
});

test("a url template uses a param only when the recorded url contained that value", () => {
  const typed = interpret([
    act({
      id: "q",
      op: "type",
      value: "http",
      identity: ident({ id: "search", role: "textbox", nameAttr: "q" }),
    }),
    act({
      id: "go",
      op: "key",
      key: "Enter",
      beforeUrl: "https://www.rfc-editor.org/",
      afterUrl: "https://www.rfc-editor.org/search/?q=http",
    }),
  ], { id: "wf", startUrl: "https://www.rfc-editor.org/" });
  assert.equal(typed.steps[1]?.expect?.kind, "url");
  assert.equal(typed.steps[1]?.expect?.match, "q={{q}}");
  assert.equal(typed.steps[1]?.expect?.match?.includes("https"), false);

  const plain = interpret([
    act({
      id: "q",
      op: "type",
      value: "http",
      identity: ident({ id: "search", role: "textbox", nameAttr: "q" }),
    }),
    act({
      id: "go",
      op: "click",
      identity: ident({ id: "next", text: "Next" }),
      beforeUrl: "https://example.com/start",
      afterUrl: "https://example.com/secure",
    }),
  ], { id: "wf", startUrl: "https://example.com/start" });
  assert.equal(plain.steps[1]?.expect?.match, "/secure");
  assert.equal(plain.steps[1]?.expect?.match?.includes("{{"), false);
});

test("a browser error page is not an oracle", () => {
  const doc = interpret([
    act({
      id: "q",
      op: "type",
      value: "Hi",
      identity: ident({ id: "say", role: "textbox", nameAttr: "say" }),
    }),
    act({
      id: "go",
      op: "click",
      identity: ident({ id: "send", text: "Send my greetings" }),
      subtreeBefore: "Send my greetings",
      subtreeAfter: "Go back",
      beforeUrl: "https://mdn.github.io/learning-area/html/forms/sending-form-data/get-method.html",
      afterUrl: "chrome-error://chromewebdata/",
    }),
  ], { id: "wf", startUrl: "https://mdn.github.io/learning-area/html/forms/sending-form-data/get-method.html" });
  assert.equal(doc.steps[1]?.expect?.kind, "settled");
  assert.equal(doc.steps[1]?.expect?.match, SETTLED_EXPECT);
  assert.equal(doc.steps[1]?.confidence, "low");
  assert.equal(doc.steps[1]?.postcondition, undefined);
});

test("nothing observed settles at low confidence instead of an element oracle", () => {
  const doc = interpret([
    act({
      id: "go",
      op: "key",
      key: "Enter",
      beforeUrl: "https://example.com/app",
      afterUrl: "https://example.com/app",
    }),
  ], { id: "wf", startUrl: "https://example.com/app" });
  assert.equal(doc.steps[0]?.expect?.match, SETTLED_EXPECT);
  assert.equal(doc.steps[0]?.confidence, "low");
  assert.equal(doc.steps[0]?.postcondition?.kind, undefined);
});

test("a javascript dialog counts as an effect and keeps the click", () => {
  const page = "https://the-internet.herokuapp.com/javascript_alerts";
  const click = act({
    id: "e6",
    op: "click",
    identity: ident({ id: "alert", text: "Click for JS Alert" }),
    beforeUrl: page,
    afterUrl: page,
    dialog: "I am a JS Alert",
  });
  const quiet = act({ ...click, id: "e7", dialog: undefined });
  assert.deepEqual(droppedNoEffectIds([click]), []);
  assert.deepEqual(droppedNoEffectIds([quiet]), ["e7"]);
});

test("settled means the page is not a browser error", () => {
  const expect = { kind: "settled" as const, match: SETTLED_EXPECT, timeoutMs: 4000 };
  const tree = (url: string, texts: string[] = []): LiveTree => ({ nodes: [], url, texts, values: [] });
  assert.equal(holdsExpect(expect, tree("https://example.com/?say=Hi"), {}), true);
  assert.equal(holdsExpect(expect, tree("chrome-error://chromewebdata/"), {}), false);
  assert.equal(holdsExpect(expect, tree("https://example.com/", ["This site can’t be reached"]), {}), false);
});
