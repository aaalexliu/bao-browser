import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { receiptOutline, type OutlineRun, type OutlineStep } from "../../src/app/receipt-outline";
import { runReceipt } from "../../src/app/views";
import { inspectRunView } from "../../src/mcp/run-view";
import { Library } from "../../src/v1/store";

function step(input: {
  label: string;
  status?: string;
  command?: string;
  args?: string[];
  title?: string;
  url?: string;
  summary?: string;
  stderr?: string;
  shot?: string;
  shotNote?: string;
  at?: number;
}): OutlineStep {
  return {
    status: input.status || "passed",
    label: input.label,
    startedAt: input.at,
    endedAt: input.at === undefined ? undefined : input.at + 200,
    afterShot: input.shot,
    shotNote: input.shotNote,
    summary: input.title || input.url || input.summary ? { text: input.summary, page: { title: input.title, url: input.url } } : undefined,
    native: input.command ? {
      command: input.command,
      args: input.args,
      results: input.stderr ? [{ stderr: input.stderr, stdout: "", exitCode: 1 }] : undefined,
    } : undefined,
  };
}

function receipt(run: OutlineRun): string {
  return runReceipt({
    view: "receipt",
    run: {
      id: run.id || "run",
      workflowId: "agent-browser",
      name: "Receipt",
      status: run.status || "passed",
      at: run.at ?? 1_000,
      kind: "capture",
      stepCount: run.steps?.length || 0,
      modelCalls: null,
      healCount: 0,
    },
    reason: run.envelope?.reason,
    steps: [],
    stepOffset: 0,
    nextStepOffset: null,
    workflow: null,
  } as unknown as ReturnType<typeof inspectRunView>, "Receipt", run as never);
}

function chapters(html: string): string {
  return html.match(/aria-label="Chapters"[\s\S]*?<h3 id="receipt-step-heading"/)?.[0] || "";
}

test("a pizza run shows its pages, clicks, and the agent's own words", () => {
  const run: OutlineRun = {
    id: "pizza-shaped",
    status: "passed",
    at: 10_000,
    done: ["Added Ceres Mott St"],
    envelope: { status: "passed", reason: "Created a list and verified it shows exactly 3 places." },
    steps: [
      step({ label: "Open www.google.com/maps", command: "open", args: ["https://www.google.com/maps"], title: "Google Maps", url: "https://www.google.com/maps", at: 11_000 }),
      step({ label: "Click Saved", status: "failed", command: "click", args: ["@e1"], title: "Google Gemini", url: "https://gemini.google.com/app", stderr: "✗ Could not locate element with role=button name=Saved", at: 12_000 }),
      step({ label: "Click Saved", command: "click", args: ["@e2"], title: "Google Maps", url: "https://www.google.com/maps", at: 13_000 }),
      step({ label: "Type", command: "fill", args: ["@e3", "nytimes pizza"], title: "Untitled list - Google Maps", url: "https://www.google.com/maps/search/nytimes+pizza", at: 14_000 }),
      step({ label: "Type", command: "fill", args: ["@e4", "Ceres Mott St"], title: "Google Maps", url: "https://www.google.com/maps/search/ceres", at: 15_000 }),
      step({ label: "Click Ceres pizza", command: "click", args: ["@e5"], title: "Google Maps", url: "https://www.google.com/maps/search/ceres", at: 16_000 }),
      step({ label: "Type", command: "fill", args: ["@e6", "Amore Pizza 30-27 Stratton Street"], title: "Google Maps", url: "https://www.google.com/maps/search/amore", at: 17_000 }),
      step({ label: "Click Amore Pizza 30-27 Stratton Street Flushing Queens", command: "click", args: ["@e7"], title: "Amore Pizza - Google Maps", url: "https://www.google.com/maps/place/Amore", shot: "amore.png", at: 18_000 }),
      step({ label: "Type", command: "fill", args: ["@e8", "Brooklyn DOP 237 5th Ave"], title: "Google Maps", url: "https://www.google.com/maps/search/brooklyn", at: 19_000 }),
      step({ label: "Click Brooklyn DOP 237 5th Ave", command: "click", args: ["@e9"], title: "Brooklyn DOP - Google Maps", url: "https://www.google.com/maps/place/Brooklyn", shot: "brooklyn.png", at: 20_000 }),
      step({ label: "Click nytimes pizza Private · 3 places", command: "click", args: ["@e10"], title: "nytimes pizza - Google Maps", url: "https://www.google.com/maps/placelists/1", shot: "list.png", at: 21_000 }),
    ],
  };
  const outline = receiptOutline(run);
  assert.equal(outline.pageTitle, "nytimes pizza - Google Maps");
  assert.equal(outline.shot?.file, "list.png");
  assert.equal(outline.shot?.label, "nytimes pizza - Google Maps");
  assert.equal(outline.passed, 10);
  assert.equal(outline.failed, 1);
  assert.equal(outline.chapters.some((chapter) => chapter.title === "Amore Pizza - Google Maps" && chapter.clicks.some((click) => click.label.includes("Amore Pizza") && click.status === "passed")), true);
  assert.equal(outline.chapters.some((chapter) => chapter.clicks.some((click) => click.label === "Click Ceres pizza" && click.status === "passed")), true);
  assert.equal(outline.open[0]?.label, "Click Saved");
  assert.equal(outline.open[0]?.status, "failed");

  const html = receipt(run);
  assert.match(html, /Last recorded page: nytimes pizza - Google Maps\./);
  assert.match(html, /10 passed\. 1 failed\./);
  assert.match(html, /Agent said[\s\S]*Created a list and verified it shows exactly 3 places\./);
  assert.match(html, /Agent listed[\s\S]*Added Ceres Mott St/);
  assert.match(html, /Step 2, Click Saved, failed\./);
  assert.match(chapters(html), /Click Ceres pizza/);
  assert.match(html, /alt="nytimes pizza - Google Maps"/);
  assert.doesNotMatch(html, /the agent claimed|not confirmed|Submitted|Confirmation was not captured|Submission was not observed|Saved draft/i);
  assert.doesNotMatch(html, /<h3 id="receipt-step-heading" class="section"/);
  assert.match(html, /Command inspector/);
  assert.doesNotMatch(html, /Next steps|Previous steps/);
  assert.match(html, /data-search="[^"]*fill @e8 Brooklyn DOP 237 5th Ave/);
});

test("a form lists every passed fill in order and hides email", () => {
  const steps = [
    step({ label: "Type into \"Name\"", command: "fill", args: ["@name", "Ada Lovelace"], title: "Order", url: "https://fixture.test/order" }),
    step({ label: "Type into \"Email\"", command: "fill", args: ["@email", "ada@fixture.test"], title: "Order", url: "https://fixture.test/order" }),
    step({ label: "Type into \"Email\"", command: "fill", args: ["@email", "other@bad.test"], status: "failed", title: "Order", url: "https://fixture.test/order" }),
    step({ label: "Type into \"Password\"", command: "fill", args: ["@password", "s3cret-value"], title: "Order", url: "https://fixture.test/order" }),
    step({ label: "Type into \"Note\"", command: "fill", args: ["@note", "old note"], title: "Order", url: "https://fixture.test/order" }),
    step({ label: "Type into \"Note\"", command: "fill", args: ["@note", ""], title: "Order", url: "https://fixture.test/order" }),
    step({ label: "Type into \"Notes\"", command: "type", args: ["@notes", "Thank you for your help"], title: "Order", url: "https://fixture.test/order", summary: "Typed \"Thank you for your help\" into \"Notes\"." }),
    step({ label: "Click Submit", command: "click", args: ["@submit"], title: "Order", url: "https://fixture.test/order" }),
    step({ label: "Read the page", command: "snapshot", title: "Thank you. Your order could not be submitted.", url: "https://fixture.test/thanks" }),
  ];
  const outline = receiptOutline({ status: "passed", steps });
  assert.equal(outline.pageTitle, "Thank you. Your order could not be submitted.");
  assert.equal(outline.chapters.length, 2);
  assert.deepEqual(outline.chapters[0]?.fields.map((field) => [field.label, field.value]), [
    ["Name", "Ada Lovelace"],
    ["Email", "Hidden"],
    ["Password", "Hidden"],
    ["Note", "old note"],
    ["Note", "Cleared"],
  ]);
  assert.equal(outline.chapters[0]?.clicks[0]?.label, "Click Submit");
  assert.equal(outline.chapters[0]?.clicks[0]?.status, "passed");
  const html = receipt({ id: "synthetic-form", status: "passed", steps });
  assert.match(html, /<p class="receipt-recorded">Last recorded page: Thank you\. Your order could not be submitted\.<\/p>/);
  assert.doesNotMatch(html, /submitted\.\./);
  assert.match(chapters(html), /old note[\s\S]*Cleared/);
  assert.doesNotMatch(chapters(html), /ada@fixture\.test|other@bad\.test|s3cret-value|Thank you for your help/);
  assert.match(html, /<details><summary>Evidence<\/summary>[\s\S]*ada@fixture\.test/);
  assert.match(html, /<details><summary>Evidence<\/summary>[\s\S]*s3cret-value/);
  assert.doesNotMatch(html, /<h3>Submitted<\/h3>|Saved draft|Confirmation was not captured|Submission was not observed/);
});

test("a ten-place run reads as the page's clicks", () => {
  const steps: OutlineStep[] = [];
  for (let n = 1; n <= 10; n++) {
    const name = `Place ${n} Example Street`;
    steps.push(step({ label: "Type", command: "fill", args: ["@search", name], title: "Google Maps", url: "https://www.google.com/maps" }));
    steps.push(step({ label: `Click ${name}`, command: "click", args: [`@e${n}`], title: "Google Maps", url: "https://www.google.com/maps", shot: n === 10 ? "last.png" : undefined }));
  }
  steps.splice(2, 0, step({ label: "Type", command: "fill", args: ["@search", "Missing Place Road"], title: "Google Maps", url: "https://www.google.com/maps" }));
  const outline = receiptOutline({ status: "passed", steps });
  assert.equal(outline.chapters.length, 1);
  assert.equal(outline.chapters[0]?.fields.at(-1)?.value, "Place 10 Example Street");
  assert.equal(outline.chapters[0]?.clicks.length, 10);
  assert.equal(outline.chapters[0]?.clicks[0]?.label, "Click Place 1 Example Street");
  assert.equal(outline.chapters[0]?.clicks[9]?.status, "passed");
  const html = receipt({ status: "passed", steps });
  assert.equal(chapters(html).match(/Click Place \d+ Example Street/g)?.length, 10);
  assert.doesNotMatch(html, /not confirmed|selected|entries were|Submitted/);
  assert.doesNotMatch(receipt({
    status: "passed",
    steps: [step({ label: "Read fixture", command: "snapshot" }), step({ label: "Read fixture", command: "snapshot" })],
  }), /<h3>Chapters<\/h3>/);
});

test("passed fills stay in order, including css targets and a repeated email", () => {
  const html = receipt({
    status: "passed",
    steps: [
      step({ label: "Type", command: "fill", args: ["#name", "Ada"], title: "Order", url: "https://fixture.test/order" }),
      step({ label: "Type", command: "fill", args: ["#city", "London"], title: "Order", url: "https://fixture.test/order" }),
      step({ label: "Type into \"Email\"", command: "fill", args: ["@email", "ada@fixture.test"], title: "Order", url: "https://fixture.test/order" }),
      step({ label: "Type into \"Email\"", command: "fill", args: ["@email", "grace@fixture.test"], title: "Order", url: "https://fixture.test/order" }),
      step({ label: "Type into \"Email\"", command: "fill", args: ["@email", "other@bad.test"], status: "failed", title: "Order", url: "https://fixture.test/order" }),
      step({ label: "Type into \"Email\"", command: "fill", args: ["@email", "pending@fixture.test"], status: "pending", title: "Order", url: "https://fixture.test/order" }),
    ],
  });
  const listed = chapters(html);
  assert.match(listed, /Ada[\s\S]*London/);
  assert.equal(listed.match(/>Hidden</g)?.length, 2);
  assert.doesNotMatch(listed, /other@bad\.test|pending@fixture\.test|ada@fixture\.test|grace@fixture\.test/);
  const evidence = html.match(/<details><summary>Evidence<\/summary>[\s\S]*?<\/details>/g)?.join("\n") || "";
  assert.match(evidence, /ada@fixture\.test[\s\S]*grace@fixture\.test[\s\S]*other@bad\.test/);
  assert.doesNotMatch(listed, /other@bad\.test/);
});

test("a fill with a trailing option uses the positional value", () => {
  const html = receipt({
    status: "passed",
    steps: [
      step({ label: "Type into \"Name\"", command: "fill", args: ["@name", "Ada", "--json"], title: "Order", url: "https://fixture.test/order" }),
      step({ label: "Type into \"City\"", command: "fill", args: ["@city", "", "--json"], title: "Order", url: "https://fixture.test/order" }),
      step({ label: "Type into \"Password\"", command: "fill", args: ["@password", "s3cret-value", "--json"], title: "Order", url: "https://fixture.test/order" }),
    ],
  });
  const listed = chapters(html);
  assert.match(listed, /Ada/);
  assert.match(listed, /Cleared/);
  assert.doesNotMatch(listed, /--json|s3cret-value/);
  const preview = (html.match(/<li id="receipt-step-[\s\S]*?<\/li>/g) || []).map((row) => row.split("<details>")[0]).join("\n");
  assert.match(preview, /fill · @name · Ada · --json/);
  assert.match(preview, /fill · @password · Hidden · --json/);
  assert.doesNotMatch(preview, /s3cret-value/);
  const search = preview.match(/data-search="[^"]*"/g)?.join("\n") || "";
  assert.match(search, /Ada/);
  assert.match(search, /Hidden/);
  assert.doesNotMatch(search, /s3cret-value/);
  assert.match(html, /<details><summary>Evidence<\/summary>[\s\S]*s3cret-value[\s\S]*--json/);
});

test("the same control on two query pages stays two fields", () => {
  const outline = receiptOutline({
    status: "passed",
    steps: [
      step({ label: "Type into \"Name\"", command: "fill", args: ["@e3", "Ada Lovelace"], title: "Application", url: "https://fixture.test/apply?person=applicant" }),
      step({ label: "Type into \"Email\"", command: "fill", args: ["@email", "ada@fixture.test"], title: "Application", url: "https://fixture.test/apply?person=applicant" }),
      step({ label: "Type into \"Name\"", command: "fill", args: ["@e3", "Grace Hopper"], title: "Application", url: "https://fixture.test/apply?person=reference#end" }),
    ],
  });
  assert.equal(outline.chapters.length, 2);
  assert.equal(outline.chapters[0]?.url, "https://fixture.test/apply?person=applicant");
  assert.equal(outline.chapters[1]?.url, "https://fixture.test/apply?person=reference#end");
  assert.deepEqual(outline.chapters.map((chapter) => chapter.fields.find((field) => field.label === "Name")?.value), ["Ada Lovelace", "Grace Hopper"]);
});

test("a long ten-place report appears once under Agent said", async () => {
  const places = Array.from({ length: 10 }, (_, index) => `Place ${index + 1} at ${100 + index} Example Street, Springfield, Massachusetts`);
  const report = `Added these 10 places: ${places.join("; ")}.`;
  assert.ok(report.length > 500);
  const root = await mkdtemp(path.join(tmpdir(), "bao-receipt-report-"));
  try {
    const library = new Library(root);
    library.saveRun({
      id: "ten-places",
      workflowId: "agent-browser",
      kind: "capture",
      pageEngine: "agent-browser",
      status: "passed",
      at: 1_000,
      heals: [],
      steps: places.map((place, index) => ({
        id: `command-${index + 1}`,
        status: "passed",
        label: `Click ${place}`,
        native: { command: "click", args: [`@e${index + 1}`] },
      })),
      envelope: { status: "passed", reason: report },
    } as never);
    const html = runReceipt(inspectRunView(library, { run_id: "ten-places" }), "Ten places", library.readRun("ten-places") as never);
    const said = html.match(/aria-label="Agent report"[\s\S]*?<\/section>/)?.[0] || "";
    const head = report.slice(0, 80);
    assert.equal(said.includes(report), true);
    assert.equal(html.split(head).length - 1, 1);
    assert.equal((html.split('aria-label="Outcome"')[0] || "").includes(head), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a replay read-back is shown as a read-back", () => {
  const run: OutlineRun = {
    id: "replay-read",
    status: "passed",
    at: 1_000,
    steps: [{ id: "step-1", status: "passed", startedAt: 1_000, endedAt: 1_200 }],
    receipts: [{ stepId: "step-1", source: "heading", expected: "Thank you. Order submitted", actual: "Thank you. Order submitted", pass: true }],
  };
  const outline = receiptOutline(run);
  assert.deepEqual(outline.readBack, ["Read back heading: Thank you. Order submitted"]);
  const outcome = receipt(run).match(/aria-label="Outcome"[\s\S]*?<\/section>/)?.[0] || "";
  assert.match(outcome, /Read back heading: Thank you\. Order submitted/);
  assert.doesNotMatch(outcome, /No page title or confirmation was recorded|Submitted/);
});

test("a task-tab fallback is captioned as the other tab", () => {
  const note = "The active tab could not be pictured, so Bao kept a picture of its task tab.";
  const run: OutlineRun = {
    status: "passed",
    steps: [
      step({ label: "Click Amore Pizza", command: "click", args: ["@amore"], title: "Amore Pizza - Google Maps", url: "https://www.google.com/maps/place/amore", shot: "fallback.png", shotNote: note }),
    ],
  };
  const outline = receiptOutline(run);
  assert.equal(outline.pageTitle, "Amore Pizza - Google Maps");
  assert.equal(outline.shot?.file, "fallback.png");
  assert.equal(outline.shot?.label, note);
  const html = receipt(run);
  assert.match(html, /Last recorded page: Amore Pizza - Google Maps\./);
  assert.match(html, /alt="The active tab could not be pictured, so Bao kept a picture of its task tab\."/);
  assert.doesNotMatch(html, /alt="Amore Pizza - Google Maps"|alt="Click Amore Pizza"/);
});

test("a replay inspector keeps the label and read-back past the first page", () => {
  const steps = Array.from({ length: 21 }, (_, index) => ({
    id: `step-${index + 1}`,
    status: "passed" as const,
    startedAt: 1_000 + index,
    endedAt: 1_200 + index,
  }));
  const workflowSteps = steps.map((item, index) => ({
    id: item.id,
    action: "click",
    caption: { text: index === 20 ? "Open the last report" : `Open report ${index + 1}` },
  }));
  const html = runReceipt({
    view: "receipt",
    run: {
      id: "replay-long",
      workflowId: "bill",
      name: "Bill",
      status: "passed",
      at: 1_000,
      kind: "replay",
      stepCount: 21,
      modelCalls: null,
      healCount: 0,
    },
    steps: steps.slice(0, 20).map((item) => ({ id: item.id, index: Number(item.id.slice(5)), label: "Step", status: "passed", durationMs: 200, picturesAllowed: true })),
    stepOffset: 0,
    nextStepOffset: 20,
    workflow: null,
  } as unknown as ReturnType<typeof inspectRunView>, "Bill", {
    id: "replay-long",
    workflowId: "bill",
    kind: "replay",
    status: "passed",
    at: 1_000,
    steps,
    receipts: [{ stepId: "step-21", source: "heading", expected: "Done", actual: "Done", pass: true }],
  }, workflowSteps);
  assert.match(html, /<strong>Open the last report<\/strong>/);
  assert.match(html, /Read back heading: expected Done, saw Done\. matches\./);
  assert.match(html, /data-search="[^"]*Open the last report/);
  assert.doesNotMatch(html, /Next steps|Previous steps/);
});
