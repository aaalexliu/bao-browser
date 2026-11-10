import assert from "node:assert/strict";
import test from "node:test";
import { diffView, findView, snapshotView } from "../../src/engines/snapshot-view";
import { INSTRUCTIONS, TOOLS } from "../../src/mcp/server";

const page = `- banner
  - link "Home" [ref=e1]
- main
  - heading "Results" [level=1, ref=e2]
  - list
    - listitem
      - button "Kirkland Organic Blueberries, 3 lbs $9.89" [ref=e3]
        - StaticText "Kirkland Organic Blueberries"
      - button "Add" [ref=e4]
    - listitem
      - button "Dole Strawberries, 2 lbs $5.49" [ref=e5]
      - button "Add" [ref=e6]
  - LabelText
    - textbox "Name" [ref=e7]: Ann
`;

test("find returns matching lines with their refs, the lines that hold them, and what is inside them", () => {
  assert.equal(findView(page, { text: "blueberries", role: "button" }), `1 of 14 snapshot lines match text "blueberries" and role button. Each is shown with the lines that hold it and everything inside it.
- main
  - list
    - listitem
      - button "Kirkland Organic Blueberries, 3 lbs $9.89" [ref=e3]
        - StaticText "Kirkland Organic Blueberries"`);
  assert.match(findView(page, { role: "BUTTON" }), /^4 of 14 snapshot lines match role BUTTON\./);
  assert.match(findView(page, { text: "ann" }), /textbox "Name" \[ref=e7\]: Ann$/, "a field's value is searchable");
  assert.doesNotMatch(findView(page, { text: "ref" }), /^\d+ of/, "refs and attributes are not searched");
  assert.equal(findView(page, { text: "Checkout", role: "link" }),
    "No snapshot line matches text \"Checkout\" and role link (14 lines on the page). Try a shorter text, another role, or a plain snapshot.");
});

test("diff shows added and removed lines under the lines that hold them, and falls back to the full tree", () => {
  assert.equal(diffView(undefined, page), `No earlier snapshot with these args in this session, so this is the full snapshot.\n${page}`);
  assert.equal(diffView(page, page), "No change since the last snapshot (14 lines).");
  const after = page.replace("      - button \"Dole Strawberries, 2 lbs $5.49\" [ref=e5]\n", "")
    .replace("  - LabelText\n", "  - dialog \"Cart\"\n    - button \"Checkout\" [ref=e8]\n  - LabelText\n");
  assert.equal(diffView(page, after), `Changed since the last snapshot: 2 lines added (+), 1 removed (-). Unchanged lines are left out except the ones that hold a change.
  - main
    - list
      - listitem
-       - button "Dole Strawberries, 2 lbs $5.49" [ref=e5]
+   - dialog "Cart"
+     - button "Checkout" [ref=e8]`);
  const other = "- main\n  - heading \"Another page\" [level=1, ref=e20]\n  - link \"Back\" [ref=e21]\n";
  assert.equal(diffView(page, other), `Most of the page changed since the last snapshot, so this is the full snapshot.\n${other}`);
  const tiny = "- main\n  - button \"Save\" [ref=e1]\n";
  const edited = tiny.replace("Save", "Saved");
  assert.equal(diffView(tiny, edited), `Changed since the last snapshot: 1 line added (+), 1 removed (-). Unchanged lines are left out except the ones that hold a change.
  - main
+   - button "Saved" [ref=e1]
-   - button "Save" [ref=e1]`);
});

test("a few edits on a small page stay a diff, and a longer nested diff returns the full tree", () => {
  const cart = `- main
  - heading "Cart" [level=1, ref=e1]
  - list
    - listitem "Tea 1"
    - listitem "Milk 1"
    - listitem "Bread 1"
    - listitem "Eggs 1"
  - text "Total $10"
  - button "Checkout" [ref=e2]
  - link "Home" [ref=e3]
`;
  const next = cart.replace("Tea 1", "Tea 2").replace("Milk 1", "Milk 2").replace("Total $10", "Total $12");
  const edited = diffView(cart, next);
  assert.match(edited, /^Changed since the last snapshot: 3 lines added \(\+\), 3 removed/);
  assert.match(edited, /\+\s+- listitem "Tea 2"/);
  assert.match(edited, /\+\s+- text "Total \$12"/);
  assert.doesNotMatch(edited, /Most of the page changed/);
  assert.equal(edited.includes(next), false, "three of ten lines is a diff, not the full tree");

  const item = (price: number) => `    - listitem\n      - link "Item"\n        - generic\n          - text "$${price}"`;
  const before = ["- main", "  - list", ...Array.from({ length: 200 }, () => item(10))].join("\n") + "\n";
  const after = ["- main", "  - list", ...Array.from({ length: 200 }, () => item(11))].join("\n") + "\n";
  assert.equal(diffView(before, after), `The changed lines are longer than the full snapshot, so this is the full snapshot.\n${after}`);
});

test("find and diff are snapshot options, one at a time, and the tool teaches both", () => {
  assert.equal(snapshotView("snapshot", undefined, undefined), undefined);
  assert.equal(snapshotView("click", undefined, false), undefined);
  assert.deepEqual(snapshotView("snapshot", { text: " Save ", role: "" }, undefined), { kind: "find", find: { text: "Save" } });
  assert.deepEqual(snapshotView("snapshot", undefined, true), { kind: "diff" });
  assert.throws(() => snapshotView("open", undefined, true), /only accepted on snapshot/);
  assert.throws(() => snapshotView("snapshot", { name: "Save" }, undefined), /non-empty text, role, or both/);
  assert.throws(() => snapshotView("snapshot", "Save", undefined), /non-empty text, role, or both/);
  assert.throws(() => snapshotView("snapshot", undefined, "yes"), /diff must be true or false/);
  const tool = TOOLS.find((candidate) => candidate.name === "agent_browser")!;
  assert.ok("find" in tool.inputSchema.properties && "diff" in tool.inputSchema.properties);
  assert.match(tool.description, /find=\{\\?"text\\?":\\?"Sign in\\?",\\?"role\\?":\\?"button\\?"\}/);
  assert.match(INSTRUCTIONS, /snapshot with find=\{text, role\}.*diff=true/);
});
