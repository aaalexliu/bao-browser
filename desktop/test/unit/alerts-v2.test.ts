import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { condense } from "../../src/v1/condense";
import type { TrailEvent } from "../../src/v1/interpret";
import type { HeldTruth } from "../../src/eval/heldout/capture";

test("alerts v1 stays in history and v2 keeps the dialog click", () => {
  const v1 = JSON.parse(readFileSync("docs/eval/heldout/batch2/history/alerts.v1.json", "utf8")) as TrailEvent[];
  const old = v1.find((event) => event.identity?.text === "Click for JS Alert");
  assert.ok(old);
  assert.equal(old.dialog, undefined);
  assert.equal(old.beforeUrl, old.afterUrl);

  const truths = JSON.parse(readFileSync("docs/eval/heldout/batch2/truth.json", "utf8")) as HeldTruth[];
  const truth = truths.find((item) => item.id === "alerts");
  assert.ok(truth);
  assert.equal(truth.version, 2);
  assert.equal(truth.trail, "alerts.v2");
  assert.match(truth.reason || "", /dialog/);

  const v2 = JSON.parse(readFileSync("docs/eval/heldout/batch2/alerts.v2.json", "utf8")) as TrailEvent[];
  const alert = v2.find((event) => event.dialogType === "alert");
  assert.ok(alert?.dialog);
  assert.match(alert.subtreeAfter || "", /successfully clicked an alert/);
  assert.deepEqual(truth.keep, [alert.id]);

  const dropped = condense(v1, { id: "alerts", name: truth.name, startUrl: truth.startUrl, secrets: [] });
  assert.equal(dropped.steps.length, 0);
  const kept = condense(v2, { id: "alerts", name: truth.name, startUrl: truth.startUrl, secrets: [] });
  assert.ok(kept.steps.length >= 1);
  assert.match(kept.steps.map((step) => step.expect?.match || "").join(" "), /successfully clicked an alert/);
});
