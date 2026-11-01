import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { replay, type Driver } from "../../src/v1/replay";
import type { Identity, WorkflowStep, WorkflowV2 } from "../../src/v1/schema";

function dismiss(patch: Partial<Identity> = {}): Identity {
  return { surface: "dom", role: "button", name: "Close", path: [{ role: "dialog", name: "Welcome" }], ...patch };
}

async function run(t: TestContext, want: Identity, nodes: (elapsed: number) => Identity[], expect?: WorkflowStep["expect"], finalOptional = false) {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  let elapsed = 0;
  const clicked: Identity[] = [];
  const driver: Driver = {
    async tree() { return { nodes: nodes(elapsed), texts: [], values: [], url: "https://www.instacart.com/store/costco/storefront" }; },
    async snapshot() { return {}; },
    async click(node) { clicked.push(node); },
    async fill() {},
    async key() {},
    async upload() { throw new Error("unexpected upload"); },
    async drop() { throw new Error("unexpected drop"); },
    async digits() { throw new Error("unexpected digits"); },
    async check() {},
    async notify() {},
    async sleep(ms) { elapsed += ms; t.mock.timers.tick(ms); },
  };
  const workflow: WorkflowV2 = {
    schema: "bao.workflow/v2", version: 2, id: "welcome", name: "Dismiss welcome", startUrl: "https://www.instacart.com/store/costco/storefront", createdAt: 0, driver: "cdp-live", inputs: [],
    steps: [
      { id: "dismiss", index: 0, surface: "dom", action: "click", label: "Close", optional: "dismiss", identity: want, timeoutMs: 2000, expect },
      ...(finalOptional ? [] : [{ id: "resume", index: 1, surface: "dom" as const, action: "key" as const, label: "Resume", key: "Tab", timeoutMs: 2000 }]),
    ],
  };
  const result = await replay(workflow, {}, driver);
  return { result, clicked, elapsed };
}

for (const field of ["testId", "id", "nameAttr", "cssPath", "path"] as const) {
  test(`optional dismiss matches its recorded ${field}, not another Close`, async (t) => {
    const want = dismiss(field === "path" ? {} : { path: [], [field]: "welcome-close" });
    const target = { ...want };
    const other = dismiss(field === "path" ? { path: [{ role: "dialog", name: "Cart" }] } : { path: [], [field]: "cart-close" });
    const { result, clicked } = await run(t, want, () => [other, target]);
    assert.equal(result.status, "passed", JSON.stringify(result.failure));
    assert.equal(result.steps[0]?.status, "passed");
    assert.deepEqual(clicked, [target]);
  });

  test(`optional dismiss skips an absent recorded ${field} despite another Close`, async (t) => {
    const want = dismiss(field === "path" ? {} : { path: [], [field]: "welcome-close" });
    const other = dismiss(field === "path" ? { path: [{ role: "dialog", name: "Cart" }] } : { path: [], [field]: "cart-close" });
    const { result, clicked, elapsed } = await run(t, want, () => [other]);
    assert.equal(result.status, "passed", JSON.stringify(result.failure));
    assert.equal(result.steps[0]?.status, "skipped");
    assert.deepEqual(clicked, []);
    assert.equal(elapsed, 2000);
  });
}

for (const field of ["id", "nameAttr"] as const) {
  for (const moved of [false, true]) {
    test(`an optional dismiss survives a generated ${field} change with ${moved ? "moved" : "unchanged"} CSS`, async (t) => {
      const want = dismiss({ [field]: ":r5:", cssPath: "#old-close" });
      const target = dismiss({ [field]: ":r7:", cssPath: moved ? "#new-close" : want.cssPath });
      const other = dismiss({ [field]: ":r9:", cssPath: "#cart-close", path: [{ role: "dialog", name: "Cart" }] });
      const { result, clicked } = await run(t, want, () => [other, target]);
      assert.equal(result.status, "passed", JSON.stringify(result.failure));
      assert.equal(result.steps[0]?.status, "passed");
      assert.deepEqual(clicked, [target]);
    });
  }

  test(`a generated ${field} does not match another popup`, async (t) => {
    const want = dismiss({ [field]: ":r5:", cssPath: "#old-close" });
    const other = dismiss({ [field]: ":r7:", cssPath: "#new-close", path: [{ role: "dialog", name: "Cart" }] });
    const { result, clicked } = await run(t, want, () => [other]);
    assert.equal(result.steps[0]?.status, "skipped");
    assert.deepEqual(clicked, []);
  });

  test(`a stable ${field} still constrains candidates inside the recorded popup`, async (t) => {
    const want = dismiss({ [field]: "welcome-close", cssPath: "#old-close" });
    const other = dismiss({ [field]: "other-close", cssPath: "#new-close" });
    const { result, clicked } = await run(t, want, () => [other]);
    assert.equal(result.steps[0]?.status, "skipped");
    assert.deepEqual(clicked, []);
  });
}

for (const field of ["testId", "id", "cssPath"] as const) {
  test(`a reused ${field} in another popup is not the recorded dismiss`, async (t) => {
    const want = dismiss({ [field]: "close" });
    const other = { ...want, path: [{ role: "dialog", name: "Cart" }] };
    const { result, clicked } = await run(t, want, () => [other]);
    assert.equal(result.steps[0]?.status, "skipped");
    assert.deepEqual(clicked, []);
  });
}

test("the recorded CSS path distinguishes two Close controls in the same popup", async (t) => {
  const want = dismiss({ cssPath: "#welcome > button:nth-of-type(1)" });
  const other = dismiss({ cssPath: "#welcome > button:nth-of-type(2)" });
  const { result, clicked } = await run(t, want, () => [other, want]);
  assert.equal(result.status, "passed", JSON.stringify(result.failure));
  assert.deepEqual(clicked, [want]);
});

for (const kind of ["settled", "text"] as const) {
  test(`an optional dismiss's ${kind} check never dismisses another popup`, async (t) => {
    const want = dismiss({ testId: "welcome-close" });
    const other = dismiss({ testId: "cart-close", path: [{ role: "dialog", name: "Cart" }] });
    const cart: Identity = { surface: "dom", role: "dialog", name: "Cart", path: [] };
    const { result, clicked } = await run(t, want, () => [other, want, cart], { kind, match: "missing result", timeoutMs: 100 }, kind === "settled");
    assert.equal(result.status, kind === "settled" ? "passed" : "failed", JSON.stringify(result.failure));
    assert.deepEqual(clicked, [want]);
  });
}

for (const delay of [1950, 2050]) {
  test(`an optional popup appearing at ${delay} ms respects the two-second wait`, async (t) => {
    const want = dismiss({ testId: "welcome-close" });
    const other = dismiss({ testId: "cart-close" });
    const { result, clicked } = await run(t, want, (elapsed) => elapsed >= delay ? [other, want] : [other]);
    assert.equal(result.status, "passed", JSON.stringify(result.failure));
    assert.equal(result.steps[0]?.status, delay < 2000 ? "passed" : "skipped");
    assert.deepEqual(clicked, delay < 2000 ? [want] : []);
  });
}

test("two matches for the recorded optional target remain a tie without clicks", async (t) => {
  const want = dismiss({ testId: "welcome-close" });
  const { result, clicked } = await run(t, want, () => [{ ...want }, { ...want }]);
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.reason, "tie");
  assert.deepEqual(clicked, []);
});
