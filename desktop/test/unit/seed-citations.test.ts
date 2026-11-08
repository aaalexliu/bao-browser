import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { SEED_WORKFLOWS } from "../../../web/src/lib/seeds";

type SeedStep = { id: string; sensitive?: boolean; caption: { text: string; citation?: { text: string; source: string } } };

test("seed citations quote a string the page element carries, and the password step cites nothing", () => {
  const fixture = readFileSync(path.join(process.cwd(), "web/public/fixture.html"), "utf8");
  for (const seed of SEED_WORKFLOWS) {
    for (const step of seed.document.steps as SeedStep[]) {
      const citation = step.caption.citation;
      if (step.sensitive) assert.equal(citation, undefined, `${seed.id}/${step.id}`);
      if (!citation) continue;
      assert.notEqual(citation.text, step.caption.text, `${seed.id}/${step.id}`);
      assert.equal(citation.text.includes("{{"), false, `${seed.id}/${step.id}`);
      if (seed.id.startsWith("fixture-")) assert.ok(fixture.includes(`>${citation.text} <`) || fixture.includes(`>${citation.text}<`), `${seed.id}/${step.id}: ${citation.text}`);
    }
  }
});
