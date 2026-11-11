import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { testChromium as chromium } from "../../src/test-browser.js";
import { SEED_WORKFLOWS } from "../../../web/src/lib/seeds";
import { scaledMs } from "../runtime";

type SeedLocator = { kind: string; value?: string; role?: string; name?: string };
type SeedStep = {
  id: string;
  sensitive?: boolean;
  caption: { text: string; citation?: { text: string; source: string } };
  target?: { locators: SeedLocator[] };
};

const steps = (seed: (typeof SEED_WORKFLOWS)[number]) => seed.document.steps as SeedStep[];

test("seed citations quote a string the targeted fixture element carries, and the password step cites nothing", { timeout: scaledMs(60000) }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(readFileSync(path.join(process.cwd(), "web/public/fixture.html"), "utf8"));
    let checked = 0;
    for (const seed of SEED_WORKFLOWS.filter((item) => item.id.startsWith("fixture-"))) {
      for (const step of steps(seed)) {
        const where = `${seed.id}/${step.id}`;
        const citation = step.caption.citation;
        if (step.sensitive) assert.equal(citation, undefined, where);
        if (!citation) continue;
        const locator = step.target?.locators[0];
        assert.ok(locator, where);
        const element = locator.kind === "css"
          ? page.locator(locator.value || "")
          : page.getByRole(locator.role as Parameters<typeof page.getByRole>[0], { name: locator.name, exact: true });
        assert.equal(await element.count(), 1, where);
        const carried = await element.evaluate((node) => {
          const labels = "labels" in node ? Array.from((node as HTMLInputElement).labels || []) : [];
          return {
            text: (node.textContent || "").trim(),
            label: labels.map((label) => (label.textContent || "").trim()),
            aria: node.getAttribute("aria-label") || "",
          };
        });
        const strings = citation.source === "label" ? [...carried.label, carried.aria] : [carried.text, carried.aria];
        assert.ok(strings.includes(citation.text), `${where}: ${citation.text} not in ${JSON.stringify(carried)}`);
        checked += 1;
      }
    }
    assert.ok(checked >= 3);
  } finally {
    await browser.close();
  }
});

test("a seed citation off the fixture names the element its role locator targets", () => {
  for (const seed of SEED_WORKFLOWS.filter((item) => !item.id.startsWith("fixture-"))) {
    for (const step of steps(seed)) {
      const citation = step.caption.citation;
      if (step.sensitive) assert.equal(citation, undefined, `${seed.id}/${step.id}`);
      if (!citation) continue;
      const named = step.target?.locators.find((locator) => locator.kind === "role")?.name;
      assert.equal(citation.text, named, `${seed.id}/${step.id}`);
    }
  }
});
