import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fromAxNode, lookup, type AxDumpNode } from "../../src/v1/identity";

const dir = path.join(process.cwd(), "fixtures/ax/macos-26");

test("observed Calculator keypad buttons are unique under the scorer", () => {
  const raw = JSON.parse(readFileSync(path.join(dir, "calculator.observed.json"), "utf8")) as {
    bundleId: string;
    nodes: AxDumpNode[];
  };
  const nodes = raw.nodes.map((node) => fromAxNode(node, { bundleId: raw.bundleId }));
  for (const name of ["7", "Add", "5", "Equals"]) {
    const query = nodes.find((node) => node.name === name);
    assert.ok(query, name);
    const hit = lookup(query, nodes);
    assert.equal(hit.ok, true, `${name} ${hit.reason} ${hit.brokenAttr}`);
    assert.equal(nodes[hit.index!]?.name, name);
  }
});

test("full macOS 26 dumps, when present, keep every named button unique", () => {
  const dumps = readdirSync(dir).filter((name) => name.endsWith(".dump.json"));
  for (const file of dumps) {
    const raw = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as {
      nodes?: AxDumpNode[];
      bundle?: string;
    };
    const nodes = (raw.nodes ?? []).map((node) => fromAxNode(node));
    const buttons = nodes.filter((node) => /button/i.test(node.role) && node.name);
    const seen = new Set<string>();
    for (const button of buttons) {
      if (seen.has(button.name || "")) continue;
      seen.add(button.name || "");
      const same = buttons.filter((item) => item.name === button.name);
      const hit = lookup(button, nodes);
      if (same.length === 1) assert.equal(hit.ok, true, `${file} ${button.name} ${hit.reason}`);
      else assert.equal(hit.ok, false, `${file} duplicate ${button.name} should refuse`);
    }
  }
  assert.ok(true);
});
