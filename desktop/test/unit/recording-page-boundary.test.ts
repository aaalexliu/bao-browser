import assert from "node:assert/strict";
import test from "node:test";
import { reviseDecision } from "../../src/eval/intent/revise";
import { condense } from "../../src/v1/condense";
import { interpret, trailDrops, type TrailEvent } from "../../src/v1/interpret";
import type { Identity } from "../../src/v1/schema";

const meta = { id: "wf-pages", startUrl: "https://local.test/new" };
const event = (id: number, op: string, identity: Identity, page: string, value?: string): TrailEvent => ({ id: String(id), ts: id, kind: "act", op, identity, beforeUrl: page, afterUrl: `${page}/next`, value });

for (const identity of [
  { id: "field" }, { testId: "field" }, { nameAttr: "field" }, { identifier: "field" },
  { name: "Same", role: "button" }, { cssPath: "form > button" },
] as Partial<Identity>[]) test(`recording keeps page boundaries for ${Object.keys(identity).join("+")}`, () => {
  const target: Identity = { surface: "dom", role: "button", path: [], ...identity };
  for (const secondPage of ["https://local.test/confirm", "https://local.test/new?stage=confirm", "https://local.test/new#confirm", "https://other.test/new"]) {
    const clicks = [event(1, "click", target, meta.startUrl), event(2, "click", target, secondPage)];
    assert.equal(condense(clicks, meta).steps.length, 2, secondPage);
    const types = [event(1, "type", target, meta.startUrl, "first"), event(2, "type", target, secondPage, "second")];
    for (const run of [condense, interpret]) assert.equal(run(types, meta).steps.length, 2, secondPage);
    assert.deepEqual(trailDrops(types), [], secondPage);
    const chooser = [event(1, "click", target, meta.startUrl), { ...event(2, "upload", target, secondPage), fileName: "local.txt" }];
    assert.equal(interpret(chooser, meta).steps.length, 2, secondPage);
    assert.deepEqual(trailDrops(chooser), [], secondPage);
    const typo = [event(1, "type", target, meta.startUrl, "wrong"), { ...event(2, "key", target, meta.startUrl), key: "Backspace" }, event(3, "type", target, secondPage, "right")];
    assert.equal(condense(typo, meta).steps.length, 3, secondPage);
    assert.ok(reviseDecision(typo, { keep: ["1", "2", "3"], human: [], secrets: [] }).keep.includes("1"), secondPage);
  }
  assert.equal(condense([event(1, "click", target, meta.startUrl), event(2, "click", target, meta.startUrl)], meta).steps.length, 1, "same-page retry still condenses");
});

test("full field snapshots keep replacement and empty values, while chunks still join", () => {
  const identity: Identity = { surface: "dom", role: "textbox", name: "Name", path: [] };
  for (const run of [interpret, condense]) {
    for (const final of ["replacement", ""]) {
      const events = [event(1, "type", identity, meta.startUrl, "prefix"), { ...event(2, "type", identity, meta.startUrl, final), valueMode: "full" as const }];
      const workflow = run(events, meta);
      assert.equal(workflow.steps.length, 1);
      assert.equal(workflow.inputs[0]?.default, final);
      assert.equal(trailDrops(events)[0]?.reason, "merged into the previous type");
    }
    assert.equal(run([event(1, "type", identity, meta.startUrl, "hello"), event(2, "type", identity, meta.startUrl, " world")], meta).inputs[0]?.default, "hello world");
  }
});
