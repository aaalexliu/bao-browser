import assert from "node:assert/strict";
import test from "node:test";
import { condense } from "../../src/v1/condense";
import type { TrailEvent } from "../../src/v1/interpret";
import { recorderSource, smallestChange } from "../../src/v1/recorder";

test("a new leaf outranks a longer change", () => {
  const change = smallestChange(
    { "DIV:1/P:1": "Click for JS Alert" },
    { "DIV:1/P:1": "Click for JS Alert", "DIV:1/P:2": "You successfully clicked an alert" },
  );
  assert.deepEqual(change, { before: "", after: "You successfully clicked an alert" });
  assert.equal(smallestChange({ "P:1": "same" }, { "P:1": "same" }), undefined);
});

test("the recorder stores the dialog and the text that appears after it closes", async () => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const events: TrailEvent[] = [];
  try {
    const context = await browser.newContext();
    await context.exposeBinding("__baoRecord", async (_source, payload: TrailEvent) => {
      events.push(payload);
    });
    await context.addInitScript(recorderSource());
    const page = await context.newPage();
    page.on("dialog", (dialog) => {
      dialog.accept().catch(() => undefined);
    });
    await page.goto(htmlPage(`<button id="go">Click for JS Alert</button><p id="result"></p>
      <script>
        document.getElementById("go").onclick = () => {
          alert("I am a JS Alert");
          document.getElementById("result").textContent = "You successfully clicked an alert";
        };
      </script>`));
    await page.locator("#go").click();
    await page.waitForTimeout(50);
    const click = events.find((event) => event.op === "click");
    assert.ok(click);
    assert.equal(click.dialogType, "alert");
    assert.equal(click.dialog, "I am a JS Alert");
    assert.equal(click.dialogDecision, "accept");
    assert.equal(click.subtreeBefore, "");
    assert.match(click.subtreeAfter || "", /successfully clicked an alert/);
    const doc = condense([stamp(click)], { id: "wf", name: "Alert", startUrl: "https://fixture.test/alerts" });
    assert.equal(doc.steps.length, 1);
    assert.equal(doc.steps[0]?.expect?.kind, "text");
    assert.match(doc.steps[0]?.expect?.match || "", /successfully clicked an alert/);

    events.length = 0;
    page.removeAllListeners("dialog");
    page.on("dialog", (dialog) => {
      dialog.dismiss().catch(() => undefined);
    });
    await page.goto(htmlPage(`<button id="ask">Ask</button>
      <script>document.getElementById("ask").onclick = () => { confirm("Leave?"); };</script>`));
    await page.locator("#ask").click();
    await page.waitForTimeout(50);
    const confirm = events.find((event) => event.op === "click");
    assert.equal(confirm?.dialogType, "confirm");
    assert.equal(confirm?.dialogDecision, "dismiss");
    assert.equal(confirm?.dialog, "Leave?");
  } finally {
    await browser.close();
  }
});

function htmlPage(body: string): string {
  return `data:text/html,${encodeURIComponent(`<!doctype html>${body}`)}`;
}

function stamp(event: TrailEvent): TrailEvent {
  return { ...event, id: "e1", ts: 1, kind: "act" };
}
