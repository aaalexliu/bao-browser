import assert from "node:assert/strict";
import test from "node:test";
import { activeNativeTab, parseNativeTabs } from "../../src/engines/agent-browser-tabs";

test("native tabs preserve row order, labels, and extra wire fields", () => {
  const rows = [
    { tabId: "t1", targetId: "FIRST", label: null, active: false, title: "Extra wire field" },
    { tabId: "t2", targetId: "ACTIVE", label: "work", active: true },
    { tabId: "t3", targetId: "LAST", active: true },
  ];
  const tabs = parseNativeTabs(JSON.stringify({ data: { tabs: rows } }));
  assert.deepEqual(tabs, rows);
  assert.deepEqual(activeNativeTab(tabs), { targetId: "ACTIVE" });
});

for (const stdout of ["{}", '{"data":{}}', '{"data":null}', '{"data":{"tabs":null}}', '{"data":{"tabs":[]}}']) {
  test(`native tabs treat ${stdout} as an empty list`, () => {
    const tabs = parseNativeTabs(stdout);
    assert.deepEqual(tabs, []);
    assert.equal(activeNativeTab(tabs), undefined);
  });
}

test("native tabs keep invalid JSON and a null root as errors", () => {
  assert.throws(() => parseNativeTabs("not JSON"), SyntaxError);
  assert.throws(() => parseNativeTabs("null"), /Cannot read properties of null \(reading 'data'\)/);
});

test("a non-array native tab list still fails rather than becoming no active tab", () => {
  assert.throws(() => activeNativeTab(parseNativeTabs('{"data":{"tabs":{}}}')), /tabs.find is not a function/);
});

test("native tabs without an active row have no active target", () => {
  assert.equal(activeNativeTab(parseNativeTabs('{"data":{"tabs":[{"targetId":"INACTIVE"}]}}')), undefined);
});

for (const first of [{ active: true }, { active: true, targetId: "" }]) {
  test(`an active row with ${JSON.stringify(first)} does not select a later row`, () => {
    const tabs = parseNativeTabs(JSON.stringify({ data: { tabs: [first, { active: true, targetId: "LATER" }] } }));
    assert.equal(activeNativeTab(tabs), undefined);
  });
}
