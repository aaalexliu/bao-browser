// Short run-output values stay on one line. Long text wraps at spaces.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { testChromium as chromium } from "../../src/test-browser.js";
import { outputsHtml, type OutputTable } from "../../src/v1/data-steps";
import { testWorkflow } from "../support/workflow";

const title = "Forever and Forever: The Courtship of Henry Longfellow and Fanny Appleton";

function booksTable(): OutputTable {
  return {
    name: "books",
    label: "books",
    type: "table",
    columns: [
      { name: "rating", type: "text" },
      { name: "title", type: "text" },
      { name: "price", type: "text" },
      { name: "amount", type: "text" },
      { name: "count", type: "number" },
      { name: "link", type: "url" },
      { name: "code", type: "text" },
    ],
    rows: [{
      rating: "Three",
      title,
      price: "£29.69",
      amount: "USD 12.00",
      count: "1280",
      link: "https://books.toscrape.com/catalogue/forever_1/index.html",
      code: "abcdefghijklmnopq",
    }],
  };
}

test("short output columns stay whole and long text does not", () => {
  const html = outputsHtml("run-1", [booksTable()]);
  assert.match(html, /<th class="output-whole">rating<\/th>/);
  assert.match(html, /<td class="output-whole">Three<\/td>/);
  assert.match(html, /<th class="output-whole">price<\/th>/);
  assert.match(html, /<td class="output-whole">£29\.69<\/td>/);
  assert.match(html, /<td class="output-whole">USD 12\.00<\/td>/);
  assert.match(html, /<td class="output-whole">1280<\/td>/);
  assert.match(html, /<th>title<\/th>/);
  assert.match(html, /<td>Forever and Forever:/);
  assert.match(html, /<th>link<\/th>/);
  assert.match(html, /<td>abcdefghijklmnopq<\/td>/);
  assert.doesNotMatch(html, /class="output-whole"[^<]*>Forever/);
  assert.doesNotMatch(html, /class="output-whole"[^<]*>https:/);
  assert.doesNotMatch(html, /class="output-whole"[^<]*>abcdefghijklmnopq/);
  const marked = outputsHtml("run-1", [{
    ...booksTable(),
    rows: [{ ...booksTable().rows[0]!, price: "£5<6" }],
  }]);
  assert.match(marked, /<td class="output-whole">£5&lt;6<\/td>/);
});

test("a long number column wraps while short numbers stay whole", () => {
  const html = outputsHtml("run-1", [{
    name: "counts",
    label: "counts",
    type: "table",
    columns: [
      { name: "count", type: "number" },
      { name: "rating", type: "number" },
      { name: "reviews", type: "number" },
    ],
    rows: [{
      count: "1280",
      rating: "4.5",
      reviews: "1,234 customer reviews in the last 30 days",
    }],
  }]);
  assert.match(html, /<td class="output-whole">1280<\/td>/);
  assert.match(html, /<td class="output-whole">4\.5<\/td>/);
  assert.match(html, /<td>1,234 customer reviews in the last 30 days<\/td>/);
  assert.doesNotMatch(html, /class="output-whole"[^<]*>1,234 customer reviews/);
});

test("the running output table keeps ratings and prices whole in a narrow window", { timeout: 60_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-output-wrap-"));
  const app = await startApp({
    home,
    port: 0,
    extensionHost: false,
    chromeProfilesRoot: path.join(home, "profiles"),
  });
  const browser = await chromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  try {
    app.library.save(testWorkflow({
      schema: "bao.workflow/v4",
      id: "books",
      name: "Books by category",
      startUrl: "https://books.toscrape.com/",
      createdAt: 1,
      inputs: [],
      steps: [],
    }));
    app.library.saveRun({
      id: "run-books",
      workflowId: "books",
      status: "passed",
      at: 2,
      heals: [],
      steps: [],
      outputs: [booksTable()],
    });
    const read = () => page.locator("#run-outputs").evaluate((section) => {
      const cells = [...section.querySelectorAll("th, td")].map((cell) => {
        const node = cell.firstChild;
        const split: string[] = [];
        if (node?.nodeType === Node.TEXT_NODE) {
          const value = node.textContent ?? "";
          for (const match of value.matchAll(/\S+/g)) {
            const range = document.createRange();
            const start = match.index ?? 0;
            range.setStart(node, start);
            range.setEnd(node, start + match[0].length);
            if (range.getClientRects().length > 1) split.push(match[0]);
          }
        }
        const style = getComputedStyle(cell);
        return {
          text: cell.textContent ?? "",
          whole: cell.classList.contains("output-whole"),
          whiteSpace: style.whiteSpace,
          overflowWrap: style.overflowWrap,
          split,
          clipped: cell.scrollWidth > cell.clientWidth + 1,
        };
      });
      return {
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
        cells,
      };
    });
    for (const theme of ["light", "dark"]) {
      await page.goto(`http://127.0.0.1:${app.port}/`, { waitUntil: "domcontentloaded" });
      await page.evaluate((value) => localStorage.setItem("bao-theme", value), theme);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator('[data-open-run="run-books"]').click();
      await page.getByText("Detailed evidence", { exact: true }).click();
      await page.locator("#run-outputs").waitFor();
      for (const width of [1280, 426, 320]) {
        await page.setViewportSize({ width, height: 820 });
        await page.locator("#run-outputs").scrollIntoViewIfNeeded();
        const measured = await read();
        assert.equal(measured.pageOverflow, false, `${theme} ${width}`);
        const rating = measured.cells.find((cell) => cell.text === "Three");
        const price = measured.cells.find((cell) => cell.text === "£29.69");
        const amount = measured.cells.find((cell) => cell.text === "USD 12.00");
        const count = measured.cells.find((cell) => cell.text === "1280");
        const titleCell = measured.cells.find((cell) => cell.text.startsWith("Forever"));
        for (const cell of [rating, price, amount, count]) {
          assert.equal(cell?.whole, true, `${theme} ${width} ${cell?.text}`);
          assert.equal(cell?.whiteSpace, "nowrap", `${theme} ${width} ${cell?.text}`);
          assert.equal(cell?.split.length, 0, `${theme} ${width} ${cell?.text}`);
          assert.equal(cell?.clipped, false, `${theme} ${width} ${cell?.text}`);
        }
        assert.equal(titleCell?.whole, false, `${theme} ${width}`);
        assert.equal(titleCell?.overflowWrap, "break-word", `${theme} ${width}`);
        assert.equal(titleCell?.split.length, 0, `${theme} ${width} ${titleCell?.split.join(",")}`);
        if (width < 1280) {
          const titleLines = await page.locator("#run-outputs td", { hasText: "Forever and Forever" }).evaluate((cell) => {
            const range = document.createRange();
            range.selectNodeContents(cell);
            return range.getClientRects().length;
          });
          assert.ok(titleLines > 1, `${theme} ${width} title lines ${titleLines}`);
        }
      }
    }
  } finally {
    await page.close();
    await browser.close();
    await app.close();
  }
});
