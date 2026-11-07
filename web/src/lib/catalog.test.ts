import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { query } from "./db";
import { catalog } from "./registry";

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
      const unlinked = await catalog(principal, "Blueberries", { source });
      assert.deepEqual(unlinked.map((hit) => hit.id), [`${source}-normal`]);
      const linked = await catalog(principal, "Blueberries", { source }, { extensionLinked: true });
      assert.deepEqual(linked.map((hit) => hit.id).sort(), [`${source}-extension`, `${source}-normal`]);
      assert.deepEqual(await catalog(principal, "Blueberries", { source }, { extensionLinked: true, pageEngine: "agent-browser" }), []);
    }
  } finally {
    if (previousDir === undefined) delete process.env.BAO_PG_DIR;
    else process.env.BAO_PG_DIR = previousDir;
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    rmSync(root, { recursive: true, force: true });
  }
});
