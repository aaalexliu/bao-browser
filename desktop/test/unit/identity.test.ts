import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ACCEPT, MARGIN, fromAtspiNode, fromAxNode, lookup, type Identity } from "../../src/v1/identity";

function dom(partial: Partial<Identity> & { role?: string }): Identity {
  return {
    surface: "dom",
    role: partial.role || "button",
    path: [],
    ...partial,
  };
}

test("thresholds are the refuse line", () => {
  assert.equal(ACCEPT, 60);
  assert.equal(MARGIN, 25);
});

test("a unique test id is accepted and a duplicate is refused", () => {
  const query = dom({ testId: "login", role: "button", name: "Login" });
  const one = lookup(query, [dom({ testId: "login", role: "button", text: "Sign in" })]);
  assert.equal(one.ok, true);
  assert.equal(one.index, 0);
  const two = lookup(query, [
    dom({ testId: "login", role: "button" }),
    dom({ testId: "login", role: "button" }),
  ]);
  assert.equal(two.ok, false);
  assert.equal(two.reason, "tie");
});

test("an unstable id is not enough, a stable id is", () => {
  const unstable = lookup(dom({ id: "ember1234", role: "button" }), [dom({ id: "ember1234", role: "button" })]);
  assert.equal(unstable.ok, false);
  assert.equal(unstable.reason, "below-threshold");
  const stable = lookup(dom({ id: "username", role: "textbox" }), [dom({ id: "username", role: "textbox" })]);
  assert.equal(stable.ok, true);
});

test("role and accessible name accept one button and refuse two with the same name", () => {
  const query = dom({ role: "button", name: "Save", text: "Save" });
  const hit = lookup(query, [
    dom({ role: "button", text: "Cancel" }),
    dom({ role: "button", text: "Save" }),
  ]);
  assert.equal(hit.ok, true);
  assert.equal(hit.index, 1);
  const tie = lookup(query, [
    dom({ role: "button", text: "Save", path: [{ role: "toolbar", name: "left" }] }),
    dom({ role: "button", text: "Save", path: [{ role: "toolbar", name: "right" }] }),
  ]);
  assert.equal(tie.ok, false);
  assert.equal(tie.reason, "tie");
});

test("macOS identifier wins when the title changed", () => {
  const query = fromAxNode({
    role: "AXButton",
    identifier: "login-button",
    title: "Log In",
    name: "Log In",
    app: "Safari",
    path: [],
  }, { bundleId: "com.apple.Safari" });
  const live = fromAxNode({
    role: "AXButton",
    identifier: "login-button",
    title: "Sign In",
    name: "Sign In",
    app: "Safari",
    path: [],
  }, { bundleId: "com.apple.Safari" });
  const other = fromAxNode({
    role: "AXButton",
    title: "Sign In",
    name: "Sign In",
    app: "Safari",
    path: [],
  }, { bundleId: "com.apple.Safari" });
  const hit = lookup(query, [other, live]);
  assert.equal(hit.ok, true);
  assert.equal(hit.index, 1);
});

test("two AX buttons with the same name are a tie even if the path differs", () => {
  const query = fromAxNode({ role: "AXButton", name: "7", title: "7", app: "Calculator", path: [{ role: "AXWindow", name: "Calculator" }] });
  const a = fromAxNode({ role: "AXButton", name: "7", title: "7", app: "Calculator", path: [{ role: "AXGroup", name: "left" }] });
  const b = fromAxNode({ role: "AXButton", name: "7", title: "7", app: "Calculator", path: [{ role: "AXGroup", name: "right" }] });
  const hit = lookup(query, [a, b]);
  assert.equal(hit.ok, false);
  assert.equal(hit.reason, "tie");
});

test("static text is the value, and the wrong app is refused", () => {
  const query = fromAxNode({ role: "AXStaticText", value: "12", name: "12", app: "Calculator", path: [] });
  const hit = lookup(query, [
    fromAxNode({ role: "AXStaticText", value: "0", name: "0", app: "Calculator", path: [] }),
    fromAxNode({ role: "AXStaticText", value: "12", name: "12", app: "Calculator", path: [] }),
  ]);
  assert.equal(hit.ok, true);
  assert.equal(hit.index, 1);
  const wrong = lookup(query, [fromAxNode({ role: "AXStaticText", value: "12", name: "12", app: "TextEdit", path: [] })]);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, "app-mismatch");
  assert.equal(wrong.brokenAttr, "app");
});

test("AT-SPI fixture: button 7 is unique and a drawing area is not a guess", () => {
  const file = path.join(process.cwd(), "fixtures/atspi/baocalc.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as { nodes: { app: string; role: string; name: string; path: { role: string; name?: string }[] }[] };
  const nodes = raw.nodes.map(fromAtspiNode);
  const seven = nodes.find((node) => node.name === "7");
  assert.ok(seven);
  const hit = lookup(seven, nodes);
  assert.equal(hit.ok, true);
  const drawing = nodes.find((node) => node.role === "drawing area");
  assert.ok(drawing);
  const guess = lookup({ ...drawing, name: undefined }, nodes.filter((node) => node.role === "drawing area" || node.role === "filler"));
  assert.equal(guess.ok, false);
});
