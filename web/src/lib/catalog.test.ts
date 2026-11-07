import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { query } from "./db";
import { catalog } from "./registry";
import { catalogContext, workflowSearchEligible } from "./catalog-eligibility";
import { workflowSearchEligible as desktopSearchEligible } from "../../../desktop/src/cdp-live/launch-guard";

test("web and desktop search eligibility agree with the caller contract", () => {
  const contexts = [
    "", "extensionLinked=true", "pageEngine=agent-browser", "pageEngine=agent-browser&extensionLinked=true",
    "relay=true", "relay=true&extensionLinked=true", "relay=true&pageEngine=agent-browser", "relay=true&pageEngine=agent-browser&extensionLinked=true",
  ].map((query) => catalogContext(new URLSearchParams(query)));
  const cases = [
    { workflow: {}, expected: [true, true, false, false, true, true, false, false] },
    { workflow: { driver: null }, expected: [true, true, false, false, true, true, false, false] },
    { workflow: { driver: "playwright" }, expected: [true, true, true, true, true, true, true, true] },
    { workflow: { driver: "extension" }, expected: [false, true, false, false, false, true, false, true] },
    { workflow: { driver: "cdp-live" }, expected: [false, false, false, false, false, false, false, false] },
    { workflow: { provenance: "fixture" }, expected: [false, false, false, false, false, false, false, false] },
    { workflow: { driver: "extension", provenance: "fixture" }, expected: [false, false, false, false, false, false, false, false] },
    { workflow: { driver: "playwright", provenance: "fixture" }, expected: [false, false, false, false, false, false, false, false] },
  ];
  for (const { workflow, expected } of cases) {
    for (const [index, context] of contexts.entries()) {
      assert.equal(workflowSearchEligible(workflow, context), expected[index]);
      assert.equal(desktopSearchEligible(workflow, context), expected[index]);
    }
  }
  assert.deepEqual(catalogContext(new URLSearchParams("extensionLinked=TRUE&relay=1&pageEngine=unknown")), { extensionLinked: false, relay: false, pageEngine: "old" });
});

test("catalog filters every source before limiting and respects caller replay support", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-registry-catalog-"));
  const previousDir = process.env.BAO_PG_DIR;
  const previousUrl = process.env.DATABASE_URL;
  process.env.BAO_PG_DIR = root;
  delete process.env.DATABASE_URL;
  try {
    await query("INSERT INTO users (id, email, name) VALUES ('owner', 'owner@example.test', 'Owner'), ('other', 'other@example.test', 'Other')");
    for (const source of ["mine", "team", "public"] as const) {
      const owner = source === "mine" ? "owner" : "other";
      const documents = [
        ...Array.from({ length: 5 }, (_, i) => ({ id: `retired-${i}`, driver: "cdp-live" })),
        { id: "fixture", provenance: "fixture" },
        { id: "extension", driver: "extension" },
        { id: "playwright", driver: "playwright" },
        { id: "normal" },
      ];
      for (const document of documents) {
        const id = `${source}-${document.id}`;
        await query(
          "INSERT INTO workflows (id, owner_id, name, visibility, head_version, published_version) VALUES ($1, $2, $3, $4, 1, 1)",
          [id, owner, document.id === "normal" ? "Blueberries z-owner" : "Blueberries a-sample", source === "public" ? "public" : "private"],
        );
        await query("INSERT INTO workflow_versions (workflow_id, version, document) VALUES ($1, 1, $2)", [id, JSON.stringify({ ...document, steps: [] })]);
        if (source === "team") await query("INSERT INTO grants (workflow_id, user_id, permission) VALUES ($1, 'owner', 'read')", [id]);
      }
      const principal = { userId: "owner" };
      const unlinked = await catalog(principal, "Blueberries", { source }, catalogContext(new URLSearchParams()));
      assert.deepEqual(unlinked.map((hit) => hit.id).sort(), [`${source}-normal`, `${source}-playwright`]);
      const linked = await catalog(principal, "Blueberries", { source }, catalogContext(new URLSearchParams("extensionLinked=true")));
      assert.deepEqual(linked.map((hit) => hit.id).sort(), [`${source}-extension`, `${source}-normal`, `${source}-playwright`]);
      const trial = await catalog(principal, "Blueberries", { source }, catalogContext(new URLSearchParams("extensionLinked=true&pageEngine=agent-browser")));
      assert.deepEqual(trial.map((hit) => hit.id), [`${source}-playwright`]);
      const relay = await catalog(principal, "Blueberries", { source }, catalogContext(new URLSearchParams("extensionLinked=true&pageEngine=agent-browser&relay=true")));
      assert.deepEqual(relay.map((hit) => hit.id).sort(), [`${source}-extension`, `${source}-playwright`]);
      const unlinkedRelay = await catalog(principal, "Blueberries", { source }, catalogContext(new URLSearchParams("pageEngine=agent-browser&relay=true")));
      assert.deepEqual(unlinkedRelay.map((hit) => hit.id), [`${source}-playwright`]);
    }
  } finally {
    if (previousDir === undefined) delete process.env.BAO_PG_DIR;
    else process.env.BAO_PG_DIR = previousDir;
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    rmSync(root, { recursive: true, force: true });
  }
});
