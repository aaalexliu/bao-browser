import assert from "node:assert/strict";
import test from "node:test";
import { commandSentence } from "../../src/v1/caption";
import { interpret } from "../../src/v1/interpret";
import { stepTitle } from "../../src/v1/schema";

const snapshot = '- link "Issues" [ref=e12]\n- textbox "Search issues" [ref=e18]\n';

test("a click sentence cites the snapshot line, not the ref", () => {
  const spoken = commandSentence("click", "@e12", snapshot);
  assert.equal(spoken.text, "Click Issues");
  assert.equal(spoken.citation?.text, "Issues");
  assert.equal(spoken.citation?.source, "text");
  assert.equal(spoken.text.includes("@e12"), false);
  assert.equal(stepTitle({ caption: { text: spoken.text, citation: spoken.citation } }), 'Click "Issues"');
});

test("a type sentence cites the field name from the snapshot", () => {
  const spoken = commandSentence("fill", "@e18", snapshot);
  assert.equal(spoken.text, "Type into Search issues");
  assert.equal(spoken.citation?.text, "Search issues");
  const combo = commandSentence("fill", "@e414", '- combobox "Search issues" [expanded=false, ref=e414]: is:issue');
  assert.equal(combo.text, "Type into Search issues");
  assert.equal(combo.citation?.text, "Search issues");
});

test("open uses the host and path", () => {
  assert.equal(commandSentence("open", "https://github.com/aaalexliu/bao-browser", undefined).text, "Open github.com/aaalexliu/bao-browser");
});

test("a field with no words gets a plain Type sentence, never the typed value as its destination", () => {
  const doc = interpret([{ id: "t", ts: 1, kind: "act", op: "type", value: "alpha", identity: { surface: "dom", role: "textbox", path: [], cssPath: "form > input" } }], { id: "wf", startUrl: "https://example.test/" });
  const step = doc.steps.find((item) => item.action === "type");
  assert.equal(step?.caption.text, "Type");
  assert.equal(step?.caption.citation, undefined);
});
