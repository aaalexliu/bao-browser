import assert from "node:assert/strict";
import test from "node:test";
import { receiptOutline, type OutlineRun, type OutlineStep } from "../../src/app/receipt-outline";
import { runReceipt } from "../../src/app/views";
import type { inspectRunView } from "../../src/mcp/run-view";

function step(input: {
  label: string;
  status?: string;
  command?: string;
  args?: string[];
  title?: string;
  url?: string;
  stderr?: string;
  shot?: string;
  at?: number;
}): OutlineStep {
  return {
    status: input.status || "passed",
    label: input.label,
    startedAt: input.at,
    endedAt: input.at === undefined ? undefined : input.at + 200,
    afterShot: input.shot,
    summary: input.title || input.url ? { page: { title: input.title, url: input.url } } : undefined,
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

test("a redacted list receipt leads with recorded evidence and keeps the agent claim separate", () => {
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
  assert.equal(outline.proof.kind, "list");
  if (outline.proof.kind !== "list") return;
  assert.equal(outline.proof.name, "nytimes pizza");
  assert.equal(outline.proof.quoted, "nytimes pizza Private · 3 places");
  assert.deepEqual(outline.proof.items.map((item) => item.state), ["not confirmed", "selected", "selected"]);
  assert.equal(outline.proof.items[0]?.name, "Ceres Mott St");
  assert.match(outline.recorded, /The page said “nytimes pizza Private · 3 places”/);
  assert.match(outline.recorded, /2 selections passed/);
  assert.doesNotMatch(outline.recorded, /verified|exactly 3/);
  assert.equal(outline.problems.length, 1);
  assert.match(outline.problems[0]?.error || "", /Could not locate element/);
  assert.equal(outline.problems[0]?.later?.step, 3);
  assert.ok(outline.chapters.length >= 2);
  assert.equal(outline.chapters.some((chapter) => /phase|review|recover/i.test(chapter.title)), false);

  const html = receipt(run);
  const recorded = html.match(/class="receipt-recorded">([^<]+)/)?.[1] || "";
  assert.doesNotMatch(recorded, /verified/);
  assert.match(html, /Agent said[\s\S]*verified it shows exactly 3 places/);
  assert.match(html, /Agent listed[\s\S]*Added Ceres Mott St/);
  assert.match(html, /Ceres Mott St[\s\S]*not confirmed/);
  assert.match(html, /Step 2, Click Saved, failed\. Could not locate element/);
  assert.match(html, /Step 3 clicked Saved and passed/);
  assert.doesNotMatch(html, /retried|Retry/);
  assert.match(html, /Command inspector/);
  assert.doesNotMatch(html, /Next steps|Previous steps/);
  assert.match(html, /data-search="[^"]*fill @e8 Brooklyn DOP 237 5th Ave/);
});

test("a synthetic form fixture reports submission, a missing confirmation, and a masked password", () => {
  const fields = (password: string): OutlineStep[] => [
    step({ label: "Type into \"Name\"", command: "fill", args: ["@name", "Ada Lovelace"], title: "Order", url: "https://fixture.test/order" }),
    step({ label: "Type into \"Email\"", command: "fill", args: ["@email", "ada@fixture.test"], title: "Order", url: "https://fixture.test/order" }),
    step({ label: "Type into \"Password\"", command: "fill", args: ["@password", password], title: "Order", url: "https://fixture.test/order" }),
  ];
  const submitted = receiptOutline({
    status: "passed",
    steps: [
      ...fields("s3cret-value"),
      step({ label: "Click Submit", command: "click", args: ["@submit"], title: "Order", url: "https://fixture.test/order" }),
      step({ label: "Read the page", command: "snapshot", title: "Thank you. Reference 42", url: "https://fixture.test/thanks" }),
    ],
  });
  assert.equal(submitted.proof.kind, "form");
  if (submitted.proof.kind !== "form") return;
  assert.equal(submitted.proof.state, "Submitted.");
  assert.match(submitted.proof.confirmation || "", /Thank you/);
  assert.deepEqual(submitted.proof.fields.map((field) => [field.label, field.value]), [
    ["Name", "Ada Lovelace"],
    ["Email", "ada@fixture.test"],
    ["Password", "Hidden"],
  ]);

  const unconfirmed = receiptOutline({
    status: "passed",
    steps: [
      ...fields("s3cret-value"),
      step({ label: "Click Submit", command: "click", args: ["@submit"], title: "Order", url: "https://fixture.test/order" }),
    ],
  });
  assert.equal(unconfirmed.proof.kind, "form");
  if (unconfirmed.proof.kind === "form") assert.equal(unconfirmed.proof.state, "A submit click passed. Confirmation was not captured.");

  const draft = receiptOutline({
    status: "passed",
    steps: [
      ...fields("s3cret-value"),
      step({ label: "Click Save draft", command: "click", args: ["@save"], title: "Order", url: "https://fixture.test/order" }),
      step({ label: "Read the page", command: "snapshot", title: "Draft saved", url: "https://fixture.test/order" }),
    ],
  });
  assert.equal(draft.proof.kind, "form");
  if (draft.proof.kind === "form") assert.equal(draft.proof.state, "Saved draft.");

  const unsent = receiptOutline({ status: "failed", steps: fields("s3cret-value") });
  assert.equal(unsent.proof.kind, "form");
  if (unsent.proof.kind === "form") assert.equal(unsent.proof.state, "Submission was not observed.");
  const html = receipt({ id: "synthetic-form", status: "failed", steps: fields("s3cret-value") });
  const proof = html.match(/class="receipt-proof"[\s\S]*?<\/section>/)?.[0] || "";
  assert.match(proof, /Hidden/);
  assert.doesNotMatch(proof, /s3cret-value/);
  assert.match(html, /<details><summary>Evidence<\/summary>[\s\S]*s3cret-value/);
  assert.doesNotMatch(html, /Agent said/);
});

test("a synthetic ten-item list stays one compact list and a quiet run has no chapters", () => {
  const steps: OutlineStep[] = [];
  for (let n = 1; n <= 10; n++) {
    const name = `Place ${n} Example Street`;
    steps.push(step({ label: "Type", command: "fill", args: ["@search", name], title: "Google Maps", url: "https://www.google.com/maps" }));
    steps.push(step({ label: `Click ${name}`, command: "click", args: [`@e${n}`], title: "Google Maps", url: "https://www.google.com/maps", shot: n === 10 ? "last.png" : undefined }));
  }
  steps.splice(2, 0, step({ label: "Type", command: "fill", args: ["@search", "Missing Place Road"], title: "Google Maps", url: "https://www.google.com/maps" }));
  const outline = receiptOutline({ status: "passed", steps });
  assert.equal(outline.proof.kind, "list");
  if (outline.proof.kind !== "list") return;
  assert.equal(outline.proof.items.length, 11);
  assert.equal(outline.proof.items[0]?.state, "not confirmed");
  assert.equal(outline.proof.items.filter((item) => item.state === "selected").length, 10);
  const html = receipt({ status: "passed", steps });
  assert.match(html, /class="receipt-items"/);
  assert.equal(html.match(/class="receipt-items"[\s\S]*?<\/ul>/)?.[0].match(/<li>/g)?.length, 11);

  const quiet = receiptOutline({
    status: "passed",
    steps: [
      step({ label: "Read fixture", command: "snapshot" }),
      step({ label: "Read fixture", command: "snapshot" }),
    ],
  });
  assert.deepEqual(quiet.chapters, []);
  assert.equal(quiet.proof.kind, "text");
  assert.doesNotMatch(receipt({
    status: "passed",
    steps: [step({ label: "Read fixture" }), step({ label: "Read fixture" })],
  }), /<h3>Chapters<\/h3>|verified/);
});

test("repeated notes and page visits stay a list, not a form", () => {
  const steps: OutlineStep[] = [
    step({ label: "Type into \"Search Google Maps\"", command: "fill", args: ["@search", "nytimes pizza"], title: "Google Maps", url: "https://www.google.com/maps" }),
  ];
  for (let n = 1; n <= 4; n++) {
    steps.push(step({ label: "Type into \"Add note\"", command: "fill", args: ["@note", `note ${n}`], title: `Place ${n} - Google Maps`, url: `https://www.google.com/maps/place/${n}` }));
    steps.push(step({ label: "Click Save", command: "click", args: ["@save"], title: `Place ${n} - Google Maps`, url: `https://www.google.com/maps/place/${n}` }));
  }
  steps.push(step({ label: "Open Ceres", command: "open", args: ["https://www.google.com/maps/place/ceres"], title: "Ceres - Google Maps", url: "https://www.google.com/maps/place/ceres" }));
  steps.push(step({ label: "Read the page", command: "snapshot", title: "Ceres - Google Maps", url: "https://www.google.com/maps/place/ceres" }));
  steps.push(step({ label: "Click nytimes pizza Private · 4 places", command: "click", args: ["@list"], title: "nytimes pizza - Google Maps", url: "https://www.google.com/maps/placelists/1" }));
  const outline = receiptOutline({ status: "passed", envelope: { status: "passed", reason: "Verified all 22 places." }, steps });
  assert.equal(outline.proof.kind, "list");
  if (outline.proof.kind !== "list") return;
  assert.equal(outline.proof.items[0]?.name, "Ceres");
  assert.equal(outline.proof.items[0]?.state, "not confirmed");
  assert.equal(outline.proof.items.filter((item) => item.state === "clicked").length, 4);
  assert.match(outline.recorded, /The page said “nytimes pizza Private · 4 places”/);
  assert.doesNotMatch(outline.recorded, /Verified|22/);
  assert.equal(outline.chapters.some((chapter) => chapter.title === "Ceres - Google Maps"), true);
});
