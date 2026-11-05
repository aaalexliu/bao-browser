import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("./essential.json", import.meta.url), "utf8"));

test("the workflow runs every manifest group exactly once", () => {
  const workflow = readFileSync(new URL("../.github/workflows/guardrails-pr.yml", import.meta.url), "utf8");
  const groups = workflow.match(/group: \[([^\]]+)\]/)?.[1].split(",").map((name) => name.trim());
  assert.deepEqual(groups?.sort(), Object.keys(manifest).sort());
});

test("the essential manifest names real tests, gives reasons, and has no overlapping selections", () => {
  assert.ok(Object.keys(manifest).length > 0);
  const seen = new Map();
  for (const [group, entry] of Object.entries(manifest)) {
    assert.match(group, /^[a-z][a-z0-9-]*$/);
    assert.ok(["desktop", "web"].includes(entry.kind), group);
    assert.ok(entry.reason?.length > 0, group);
    assert.ok(entry.tests?.length > 0, group);
    assert.ok(!entry.names || entry.tests.length === 1, "name filters belong to one file");
    assert.ok(!entry.names || entry.names.length > 0, group);
    for (const file of entry.tests) {
      assert.match(file, entry.kind === "desktop" ? /^desktop\/test\/unit\/[a-z0-9-]+\.test\.ts$/ : /^web\/src\/.+\.test\.ts$/);
      assert.ok(existsSync(file), file);
      const selections = seen.get(file) ?? [];
      assert.ok(!selections.includes("*"), `duplicate unfiltered file: ${file}`);
      assert.ok(entry.names || selections.length === 0, `filtered and unfiltered file: ${file}`);
      if (entry.names) {
        const source = readFileSync(file, "utf8");
        const registrations = new Set([...source.matchAll(/^\s*(?:test|it)\(("(?:[^"\\]|\\.)*")/gm)].map((match) => JSON.parse(match[1])));
        for (const name of entry.names) {
          assert.ok(!selections.includes(name), `duplicate test: ${name}`);
          assert.ok(registrations.has(name), `test registration missing: ${name}`);
          selections.push(name);
        }
      } else selections.push("*");
      seen.set(file, selections);
    }
  }
});
