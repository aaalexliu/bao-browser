import assert from "node:assert/strict";
import test from "node:test";
import { listingStat, workflowCountLabel } from "../../../web/src/lib/listing";

test("a gated listing with no device run says it was verified by that replay", () => {
  assert.equal(listingStat(0, "just now · Oct 22, 4:32 AM EDT", true), "Verified by 1 replay");
  assert.equal(listingStat(0, "Not replayed yet", false), "No runs yet");
  assert.equal(listingStat(0, "just now · Oct 22, 4:32 AM EDT").includes("0 runs"), false);
});

test("device runs keep the count and still name last green", () => {
  const clock = "1 min ago · Oct 22, 4:31 AM EDT";
  assert.equal(listingStat(1, clock, true), `1 run · last green ${clock}`);
  assert.equal(listingStat(2, clock), `2 runs · last green ${clock}`);
});

test("a paired Mac's workflow count is singular only for one", () => {
  assert.equal(workflowCountLabel(0), "0 workflows");
  assert.equal(workflowCountLabel(1), "1 workflow");
  assert.equal(workflowCountLabel(3), "3 workflows");
});
