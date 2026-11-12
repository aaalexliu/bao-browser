import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { receiptOutline, type OutlineRun, type OutlineStep } from "../../src/app/receipt-outline";
import { runReceipt, runsList } from "../../src/app/views";
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
  target?: string;
}): OutlineStep {
  return {
    status: input.status || "passed",
    label: input.label,
    caption: input.target ? { text: input.label, citation: { text: input.target } } : undefined,
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
      step({ label: "Click Saved", target: "Saved", status: "failed", command: "click", args: ["@e1"], title: "Google Gemini", url: "https://gemini.google.com/app", stderr: "✗ Could not locate element with role=button name=Saved", at: 12_000 }),
      step({ label: "Click Saved", target: "Saved", command: "click", args: ["@e2"], title: "Google Maps", url: "https://www.google.com/maps", at: 13_000 }),
      step({ label: "Type", command: "fill", args: ["@e3", "nytimes pizza"], title: "Untitled list - Google Maps", url: "https://www.google.com/maps/search/nytimes+pizza", at: 14_000 }),
      step({ label: "Type", command: "fill", args: ["@e4", "Ceres Mott St"], title: "Google Maps", url: "https://www.google.com/maps/search/ceres", at: 15_000 }),
      step({ label: "Click Ceres pizza", target: "Ceres pizza", command: "click", args: ["@e5"], title: "Google Maps", url: "https://www.google.com/maps/search/ceres", at: 16_000 }),
      step({ label: "Type", command: "fill", args: ["@e6", "Amore Pizza 30-27 Stratton Street"], title: "Google Maps", url: "https://www.google.com/maps/search/amore", at: 17_000 }),
      step({ label: "Click Amore Pizza 30-27 Stratton Street Flushing Queens", target: "Amore Pizza 30-27 Stratton Street Flushing Queens", command: "click", args: ["@e7"], title: "Amore Pizza - Google Maps", url: "https://www.google.com/maps/place/Amore", shot: "amore.png", at: 18_000 }),
      step({ label: "Type", command: "fill", args: ["@e8", "Brooklyn DOP 237 5th Ave"], title: "Google Maps", url: "https://www.google.com/maps/search/brooklyn", at: 19_000 }),
      step({ label: "Click Brooklyn DOP 237 5th Ave", target: "Brooklyn DOP 237 5th Ave", command: "click", args: ["@e9"], title: "Brooklyn DOP - Google Maps", url: "https://www.google.com/maps/place/Brooklyn", shot: "brooklyn.png", at: 20_000 }),
      step({ label: "Click nytimes pizza Private · 3 places", target: "nytimes pizza Private · 3 places", command: "click", args: ["@e10"], title: "nytimes pizza - Google Maps", url: "https://www.google.com/maps/placelists/1", shot: "list.png", at: 21_000 }),
    ],
  };
  const outline = receiptOutline(run);
  assert.equal(outline.pageTitle, "nytimes pizza - Google Maps");
  assert.equal(outline.shot?.file, "list.png");
  assert.equal(outline.shot?.label, "nytimes pizza - Google Maps");
  assert.equal(outline.passed, 10);
  assert.equal(outline.failed, 1);
  assert.equal(outline.chapters.some((chapter) => chapter.title === "Amore Pizza" && chapter.clicks.some((click) => click.label.includes("Amore Pizza") && click.status === "passed")), true);
  assert.equal(outline.chapters.some((chapter) => chapter.title.endsWith("Google Maps") && chapter.title !== "Google Maps"), false);
  assert.equal(outline.chapters.some((chapter) => chapter.clicks.some((click) => click.label === "Click Ceres pizza" && click.status === "passed")), true);
  assert.equal(outline.open[0]?.label, "Click Saved");
  assert.equal(outline.open[0]?.status, "failed");

  const html = receipt(run);
  assert.match(html, /Last recorded page: nytimes pizza - Google Maps\./);
  assert.match(html, /10 passed\. <span class="run-state failed">1 failed<\/span>\./);
  assert.match(html, /Agent said[\s\S]*Created a list and verified it shows exactly 3 places\./);
  assert.match(html, /Agent listed[\s\S]*Added Ceres Mott St/);
  assert.match(html, /Step 2, Click Saved, <span class="run-state failed">failed<\/span>\./);
  assert.match(chapters(html), /Clicked &quot;Ceres pizza&quot;/);
  assert.match(chapters(html), /Typed &quot;nytimes pizza&quot; into a text field/);
  assert.match(chapters(html), /Opened https:\/\/www\.google\.com\/maps/);
  const listed = chapters(html);
  assert.equal(listed.match(/<ul class="receipt-items"><li/g)?.length, listed.match(/class="receipt-chapter"/g)?.length);
  assert.match(chapters(html), /Step 2/);
  assert.doesNotMatch(chapters(html), /@e5|#|4–4|4-4/);
  assert.match(html, /Recorded as passed/);
  assert.match(html, /class="run-state failed">1 failed</);
  assert.doesNotMatch(html, /class="run-state passed"/);
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
    step({ label: "Click Submit", target: "Submit", command: "click", args: ["@submit"], title: "Order", url: "https://fixture.test/order" }),
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
  assert.match(html, /<details><summary>Evidence<\/summary>[\s\S]*fill @email Hidden/);
  assert.match(html, /<details><summary>Evidence<\/summary>[\s\S]*fill @password Hidden/);
  assert.doesNotMatch(html, /ada@fixture\.test|s3cret-value/);
  assert.doesNotMatch(html, /<h3>Submitted<\/h3>|Saved draft|Confirmation was not captured|Submission was not observed/);
});

test("a ten-place run reads as the page's clicks", () => {
  const steps: OutlineStep[] = [];
  for (let n = 1; n <= 10; n++) {
    const name = `Place ${n} Example Street`;
    steps.push(step({ label: "Type", command: "fill", args: ["@search", name], title: "Google Maps", url: "https://www.google.com/maps" }));
    steps.push(step({ label: `Click ${name}`, target: name, command: "click", args: [`@e${n}`], title: "Google Maps", url: "https://www.google.com/maps", shot: n === 10 ? "last.png" : undefined }));
  }
  steps.splice(2, 0, step({ label: "Type", command: "fill", args: ["@search", "Missing Place Road"], title: "Google Maps", url: "https://www.google.com/maps" }));
  const outline = receiptOutline({ status: "passed", steps });
  assert.equal(outline.chapters.length, 1);
  assert.equal(outline.chapters[0]?.fields.at(-1)?.value, "Place 10 Example Street");
  assert.equal(outline.chapters[0]?.clicks.length, 10);
  assert.equal(outline.chapters[0]?.clicks[0]?.label, "Click Place 1 Example Street");
  assert.equal(outline.chapters[0]?.clicks[9]?.status, "passed");
  const html = receipt({ status: "passed", steps });
  assert.equal(chapters(html).match(/Clicked &quot;Place \d+ Example Street&quot;/g)?.length, 10);
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
  assert.equal(listed.match(/Typed a hidden value into Email/g)?.length, 4);
  assert.match(listed, /class="failed"/);
  assert.doesNotMatch(listed, /Cleared Email/);
  assert.doesNotMatch(listed, /other@bad\.test|pending@fixture\.test|ada@fixture\.test|grace@fixture\.test/);
  const evidence = html.match(/<details><summary>Evidence<\/summary>[\s\S]*?<\/details>/g)?.join("\n") || "";
  assert.equal(evidence.match(/fill @email Hidden/g)?.length, 4);
  assert.doesNotMatch(evidence, /ada@fixture\.test|grace@fixture\.test|other@bad\.test|pending@fixture\.test/);
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
  assert.match(html, /<details><summary>Evidence<\/summary>[\s\S]*fill @password Hidden --json/);
  assert.doesNotMatch(html, /s3cret-value/);
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
  assert.deepEqual(outline.readBack, ["Read back from the page, heading: \"Thank you. Order submitted\""]);
  const outcome = receipt(run).match(/aria-label="Outcome"[\s\S]*?<\/section>/)?.[0] || "";
  assert.match(outcome, /Read back from the page, heading: &quot;Thank you\. Order submitted&quot;/);
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
  assert.match(html, /alt="The active tab could not be pictured, so Bao kept a picture of another tab\."/);
  assert.doesNotMatch(html, /task tab/);
  assert.doesNotMatch(html, /alt="Amore Pizza - Google Maps"|alt="Click Amore Pizza"/);
  const titled = receipt({
    status: "passed",
    steps: [step({
      label: "Click Save",
      command: "click",
      args: ["@save"],
      title: "Review a task tab",
      url: "https://fixture.test/task",
      shot: "title.png",
      shotNote: "Kept the picture titled Review a task tab.",
    })],
  });
  assert.match(titled, /alt="Kept the picture titled Review a task tab\."/);
  assert.match(titled, /Last recorded page: Review a task tab\./);
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
  assert.match(html, /Read back from the page, heading: expected &quot;Done&quot;, saw &quot;Done&quot;\. It matches\./);
  assert.doesNotMatch(html, /submitted\. matches\./);
  assert.match(html, /data-search="[^"]*Open the last report/);
  assert.doesNotMatch(html, /Next steps|Previous steps/);
  assert.doesNotMatch(html, /<h3>Chapters<\/h3>/);
});

test("a replay with a recorded page shows that page as a chapter", () => {
  const html = receipt({
    id: "replay-page",
    status: "passed",
    steps: [
      step({ label: "Open the confirmation", command: "click", args: ["@confirm"], title: "Thank you - Order", url: "https://fixture.test/thanks", at: 1_000 }),
    ],
  });
  assert.match(html, /<h3>Chapters<\/h3>/);
  assert.match(html, /Thank you - Order/);
  assert.match(html, /Clicked a button/);
  assert.doesNotMatch(html, /Clicked &quot;Open the confirmation&quot;/);
  assert.match(html, /Step 1/);
});

test("ten distinct place pages drop the repeated site suffix and name the step", () => {
  const steps = Array.from({ length: 10 }, (_, index) => {
    const name = `Place ${index + 1} Example Street`;
    return [
      step({ label: "Type", command: "fill", args: ["@search", name], title: "Google Maps", url: "https://www.google.com/maps" }),
      step({ label: `Click ${name}`, target: name, command: "click", args: [`@e${index + 1}`], title: `${name} - Google Maps`, url: `https://www.google.com/maps/place/${index + 1}` }),
    ];
  }).flat();
  const html = receipt({ status: "passed", steps });
  const listed = chapters(html);
  assert.equal(listed.match(/Steps \d+-\d+|Step \d+/g)?.length, 20);
  assert.match(listed, /Step 1/);
  assert.doesNotMatch(listed, /\d+-\d+|\d+–\d+/);
  assert.doesNotMatch(listed, /- Google Maps/);
  assert.match(listed, /Place 10 Example Street/);
  assert.match(listed, /Typed &quot;Place 1 Example Street&quot; into a text field/);
  assert.match(listed, /Clicked &quot;Place 1 Example Street&quot;/);
  assert.doesNotMatch(listed, /@search|@e1/);
});

test("a short replay does not say it took 0 s, and agent words are labeled", () => {
  const html = runsList([
    {
      id: "replay-short",
      workflowId: "bill",
      status: "passed",
      kind: "replay",
      at: 1_000,
      steps: [
        { id: "step-1", status: "passed", startedAt: 1_000, endedAt: 1_200 },
        { id: "step-2", status: "failed", startedAt: 1_200, endedAt: 1_400 },
      ],
    },
    {
      id: "agent-long",
      workflowId: "agent-browser",
      kind: "capture",
      pageEngine: "agent-browser",
      status: "passed",
      at: 2_000,
      task: "Add ten places",
      envelope: { status: "passed", reason: "Added these 10 places: " + "Place Example Street, Springfield. ".repeat(12) },
      steps: [{ id: "step-1", status: "passed", startedAt: 2_000, endedAt: 3_000 }],
    },
    {
      id: "agent-field",
      workflowId: "agent-browser",
      kind: "capture",
      pageEngine: "agent-browser",
      status: "passed",
      at: 3_000,
      envelope: { status: "passed", reason: "Set first_name on the form." },
      steps: [{ id: "step-1", status: "passed", startedAt: 3_000, endedAt: 4_000 }],
    },
  ], []);
  assert.match(html, /under 1 s/);
  assert.doesNotMatch(html, /0 s/);
  assert.match(html, /class="run-state recorded">Recorded as passed<\/span> <span class="run-state failed">1 failed<\/span>/);
  assert.doesNotMatch(html, /class="run-state passed"|class="run-glyph passed"/);
  assert.match(html, /class="run-agent">Agent said: Added these 10 places/);
  assert.match(html, /data-open-run="agent-field"[\s\S]*?class="run-agent">Agent said: Set first_name on the form\./);
  assert.doesNotMatch(html, /Agent said: Set Bao stopped/);
});

test("chapter rows follow the recorded command, including a failed fill and a typed Cleared", () => {
  const sequence = receipt({
    status: "passed",
    steps: [
      step({ label: "Open example.com", command: "open", args: ["https://example.com"], title: "Example", url: "https://example.com" }),
      step({ label: "Read the page", command: "snapshot", title: "Example", url: "https://example.com" }),
      step({ label: "Type into \"Name\"", command: "fill", args: ["@name", "Ada"], title: "Example", url: "https://example.com" }),
      step({ label: "Press Enter", command: "press", args: ["Enter"], title: "Example", url: "https://example.com" }),
      step({ label: "Click \"Save\"", target: "Save", command: "click", args: ["@save"], title: "Example", url: "https://example.com" }),
      step({ label: "Click \"Save [draft]\"", target: "Save [draft]", command: "click", args: ["@draft"], title: "Example", url: "https://example.com" }),
      step({ label: "Click the checkbox", command: "click", args: ["@box"], title: "Example", url: "https://example.com" }),
    ],
  });
  const listed = chapters(sequence);
  assert.match(listed, /Opened https:\/\/example\.com/);
  assert.match(listed, /Typed &quot;Ada&quot; into Name/);
  assert.match(listed, /Pressed &quot;Enter&quot;/);
  assert.match(listed, /Clicked &quot;Save&quot;/);
  assert.match(listed, /Clicked &quot;Save \[draft\]&quot;/);
  assert.doesNotMatch(listed, /Clicked &quot;&quot;Save&quot;&quot;/);
  assert.doesNotMatch(listed, /Clicked &quot;the checkbox&quot;/);
  assert.match(listed, /Clicked a button/);
  assert.doesNotMatch(listed, /Read the page/);
  assert.doesNotMatch(listed, /Opened Example/);

  const failed = receipt({
    status: "failed",
    steps: [
      step({ label: "Type into \"Name\"", command: "fill", args: ["@name", "Ada"], status: "failed", title: "Order", url: "https://fixture.test/order" }),
      step({ label: "Type into \"Status\"", command: "fill", args: ["@status", "Cleared"], title: "Order", url: "https://fixture.test/order" }),
      step({ label: "Type into \"Note\"", command: "fill", args: ["@note", ""], title: "Order", url: "https://fixture.test/order" }),
    ],
  });
  const form = chapters(failed);
  assert.match(failed, /class="receipt-recorded-status run-state failed">Recorded as failed/);
  assert.match(form, /<li class="failed"><span>Typed &quot;Ada&quot; into Name<\/span><span class="receipt-status run-state failed">Failed<\/span>/);
  assert.match(form, /Typed &quot;Cleared&quot; into Status/);
  assert.match(form, /Cleared Note/);
  assert.doesNotMatch(form, /Cleared Status/);
  assert.doesNotMatch(form, /Opened /);

  const read = receipt({
    status: "passed",
    steps: [step({ label: "Read the page", command: "snapshot", title: "Example", url: "https://example.com" })],
  });
  assert.match(chapters(read), /Read the page/);
  assert.doesNotMatch(chapters(read), /Opened /);
  const waited = receipt({
    status: "passed",
    steps: [step({ label: "Wait for you to sign in", command: "wait_for_owner", title: "Example", url: "https://example.com" })],
  });
  assert.match(chapters(waited), /Waited/);
  assert.doesNotMatch(chapters(waited), /Opened /);
});
