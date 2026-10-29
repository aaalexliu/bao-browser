import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the required files and dates demo stays on local fixtures", () => {
  const demo = readFileSync("desktop/test/unit/files-dates-demo.test.ts", "utf8");
  assert.equal(demo.includes("/opt/cursor"), false);
  assert.equal(demo.includes("automationintesting.online"), false);
  assert.equal(demo.includes("www.irs.gov"), false);
  assert.equal(demo.includes("the-internet.herokuapp.com"), false);
});
