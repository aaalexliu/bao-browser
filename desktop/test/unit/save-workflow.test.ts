import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { completeFor, configuredModel, saveModel } from "../../src/eval/intent/model";
import { libraryTable, saveSheetView, workflowDetail } from "../../src/app/views";
import { interpret, type TrailEvent } from "../../src/v1/interpret";
import { selectCardPoster } from "../../src/v1/poster";
import { blankPng, isElementCrop, isFullPageShot, redactedPng } from "../../src/v1/redacted-png";
import { applySaveEdits, inferSavedWorkflow, redactModelText, saveIntentPrompt } from "../../src/v1/save-intent";
import { Library } from "../../src/v1/store";
import { workflowFloorTitle } from "../../src/v1/workflow-name";
import type { WorkflowV2 } from "../../src/v1/schema";

const HOST = "https://restful-booker.herokuapp.com/";
const SECRET = "SuperSecretPassword!";

function act(partial: Partial<TrailEvent> & { id: string; op: string }): TrailEvent {
  return { ts: 1, kind: "act", ...partial };
}

function booking(): TrailEvent[] {
  return [
    act({ id: "e0", op: "navigate", beforeUrl: HOST, afterUrl: HOST }),
    act({
      id: "e1",
      op: "click",
      beforeUrl: HOST,
      afterUrl: `${HOST}booking`,
      identity: { surface: "dom", role: "button", name: "Book a table", path: [] },
    }),
  ];
}

test("a saved workflow is named from the verb and the first host", () => {
  const events = booking();
  const doc = interpret(events, { id: "wf-book", startUrl: HOST });
  assert.equal(workflowFloorTitle({
    startUrl: HOST,
    events,
    steps: doc.steps,
    pageTitle: "Book a table",
  }), "Book a table · restful-booker.herokuapp.com");
  assert.equal(workflowFloorTitle({ startUrl: "https://www.example.com/in" }), "example.com");
  assert.equal(workflowFloorTitle({
    startUrl: "https://example.com/page",
    events: [
      act({ id: "n", op: "navigate", afterUrl: "https://example.com/page" }),
      act({ id: "c", op: "click", identity: { surface: "dom", role: "link", name: "More", path: [] } }),
    ],
    steps: [{ action: "click", label: 'Click "More"' }],
  }), "example.com");
  assert.notEqual(workflowFloorTitle({}), "Captured workflow");
  assert.equal(workflowFloorTitle({}), "Untitled workflow");
});

test("the primary host is the first navigate, otherwise the most-used host", () => {
  assert.equal(workflowFloorTitle({
    events: [
      act({ id: "n", op: "navigate", afterUrl: "https://first.test/" }),
      act({ id: "a", op: "click", beforeUrl: "https://other.test/", afterUrl: "https://other.test/" }),
      act({ id: "b", op: "click", beforeUrl: "https://other.test/a", afterUrl: "https://other.test/a" }),
    ],
  }), "first.test");
  assert.equal(workflowFloorTitle({
    events: [
      act({ id: "a", op: "click", beforeUrl: "https://a.test/", afterUrl: "https://a.test/" }),
      act({ id: "b", op: "click", beforeUrl: "https://b.test/1", afterUrl: "https://b.test/1" }),
      act({ id: "c", op: "type", beforeUrl: "https://b.test/1", afterUrl: "https://b.test/1" }),
    ],
  }), "b.test");
  assert.equal(workflowFloorTitle({
    startUrl: "https://files.test/doc",
    events: [act({ id: "o", op: "open", afterUrl: "https://files.test/doc" })],
  }), "files.test");
});

test("the card poster is the full page, never an element crop", () => {
  const page = blankPng(800, 600);
  const crop = blankPng(80, 40);
  const stripe = redactedPng(1);
  assert.equal(isFullPageShot(page), true);
  assert.equal(isElementCrop(page), false);
  assert.equal(isElementCrop(crop), true);
  assert.equal(isFullPageShot(crop), false);
  assert.equal(isFullPageShot(stripe), false);
  assert.equal(selectCardPoster([
    { name: "wf-0.png", bytes: crop },
    { name: "wf-1.png", bytes: crop },
  ]), undefined);
  assert.equal(selectCardPoster([{ name: "poster.png", bytes: crop }]), undefined);
  assert.equal(selectCardPoster([{ name: "poster.png", bytes: stripe }]), undefined);
  assert.equal(selectCardPoster([
    { name: "wf-0.png", bytes: crop },
    { name: "poster.png", bytes: page },
  ]), "poster.png");
});

test("a missing model keeps the deterministic title and skips the summary", async () => {
  const events = booking();
  const doc = interpret(events, { id: "wf-floor", name: "Captured workflow", startUrl: HOST });
  const saved = await inferSavedWorkflow(doc, {
    floorTitle: workflowFloorTitle({ startUrl: HOST, events, steps: doc.steps }),
    startUrl: HOST,
    events,
    steps: doc.steps,
  }, null, 10);
  assert.equal(saved.name, "Book a table · restful-booker.herokuapp.com");
  assert.equal(saved.summary, undefined);
  assert.equal(saved.intent, undefined);
  assert.equal(saved.inference?.status, "skipped");
  assert.equal(saved.inference?.provider, "none");
  let calls = 0;
  const again = await inferSavedWorkflow(saved, {
    floorTitle: saved.name,
    startUrl: HOST,
  }, { provider: "grok", model: "grok-4.7", complete: async () => { calls += 1; return "{}"; } });
  assert.equal(calls, 0);
  assert.equal(again, saved);
});

test("a model failure still saves the floor title", async () => {
  const events = booking();
  const doc = interpret(events, { id: "wf-down", startUrl: HOST });
  const floor = workflowFloorTitle({ startUrl: HOST, events, steps: doc.steps });
  const saved = await inferSavedWorkflow(doc, { floorTitle: floor, startUrl: HOST, events, steps: doc.steps }, {
    provider: "grok",
    model: "grok-4.7",
    complete: async () => { throw new Error("down"); },
  });
  assert.equal(saved.name, floor);
  assert.equal(saved.summary, undefined);
  assert.equal(saved.inference?.status, "skipped");
  const named = await inferSavedWorkflow(doc, { floorTitle: floor, startUrl: HOST, events, steps: doc.steps }, {
    provider: "grok",
    model: "grok-4.7",
    complete: async () => JSON.stringify({
      title: "Reserve a room",
      summary: "Reserves a room for tonight.",
      intent: "Get a room at the hotel.",
      steps: [{ id: doc.steps[0]!.id, intent: "Open the booking page." }],
    }),
  });
  assert.equal(named.name, "Reserve a room");
  assert.equal(named.summary, "Reserves a room for tonight.");
  assert.equal(named.intent, "Get a room at the hotel.");
  assert.equal(named.steps[0]?.intent, "Open the booking page.");
  assert.equal(named.inference?.status, "ok");
  assert.equal(named.inference?.provider, "grok");
});

test("the model prompt is redacted before it is sent", async () => {
  const workflow = interpret([
    act({
      id: "e0",
      op: "navigate",
      beforeUrl: "https://example.com/login",
      afterUrl: "https://example.com/login",
    }),
    act({
      id: "e1",
      op: "type",
      sensitive: true,
      value: SECRET,
      beforeUrl: "https://example.com/login?code=123456",
      afterUrl: "https://example.com/login?code=123456",
      identity: { surface: "dom", role: "password", name: "Password", path: [] },
    }),
  ], { id: "wf-secret", startUrl: "https://example.com/login" });
  const secrets = [SECRET, "123456"];
  const leaked: WorkflowV2 = {
    ...workflow,
    steps: workflow.steps.map((step) => step.action === "type" ? { ...step, label: `Type ${SECRET}` } : step),
  };
  const prompt = saveIntentPrompt({
    floorTitle: "example.com",
    host: "example.com",
    pageTitle: `Code ${SECRET}`,
    steps: [{ id: "wf-secret-1", action: "type", url: "https://example.com/login?code=123456", label: `Type ${SECRET}` }],
    secrets: [SECRET],
  });
  assert.equal(prompt.includes(SECRET), false);
  assert.equal(prompt.includes("123456"), false);
  assert.match(prompt, /\[redacted\]/);
  assert.match(prompt, /\[code\]/);
  assert.equal(redactModelText(`pin ${SECRET} 123456`, secrets).includes(SECRET), false);
  let seen = "";
  const saved = await inferSavedWorkflow(leaked, {
    floorTitle: "example.com",
    startUrl: "https://example.com/login",
    pageTitle: SECRET,
    groups: [[], [{ afterUrl: "https://example.com/login?code=123456" }]],
    secrets,
  }, {
    provider: "grok",
    model: "grok-4.7",
    complete: async (text) => {
      seen = text;
      return JSON.stringify({
        title: `Login ${SECRET}`,
        summary: `Uses code 123456`,
        intent: "Sign in to the site.",
        steps: [{ id: leaked.steps.find((step) => step.action === "type")!.id, intent: `Enter ${SECRET}` }],
      });
    },
  });
  assert.equal(seen.includes(SECRET), false);
  assert.equal(seen.includes("123456"), false);
  assert.equal(saved.name, "example.com");
  assert.equal(saved.summary, undefined);
  assert.equal(saved.intent, "Sign in to the site.");
  assert.equal(JSON.stringify(saved.steps).includes(SECRET), false);
});

test("edited title and summary are what gets stored", () => {
  const events = booking();
  const doc = interpret(events, { id: "wf-edit", startUrl: HOST });
  const named = {
    ...doc,
    name: "Book a table · restful-booker.herokuapp.com",
    inference: { at: 1, provider: "none", model: "", status: "skipped" as const },
  };
  const saved = applySaveEdits(named, {
    name: "Morning book",
    summary: "Books a table.",
    intent: "Reserve a table.",
  }, [], named.name);
  assert.equal(saved.name, "Morning book");
  assert.equal(saved.summary, "Books a table.");
  assert.equal(saved.intent, "Reserve a table.");
  assert.equal(saved.inference?.status, "skipped");
  const home = mkdtempSync(path.join(tmpdir(), "bao-save-"));
  try {
    const library = new Library(home);
    library.save(saved);
    const read = library.read(saved.id);
    assert.equal(read.name, "Morning book");
    assert.equal(read.summary, "Books a table.");
    assert.equal(read.intent, "Reserve a table.");
    assert.equal(read.inference?.status, "skipped");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const blocked = applySaveEdits(named, { name: `Book ${SECRET}`, summary: "ok", intent: "Reserve a table." }, [SECRET], named.name);
  assert.equal(blocked.name, named.name);
  assert.equal(blocked.summary, "ok");
});

test("the save sheet and the card show the title, summary, and full-page poster", () => {
  const html = saveSheetView({
    id: "wf",
    name: "Book a table · restful-booker.herokuapp.com",
    summary: "Books a table.",
    intent: "Reserve a table.",
    poster: true,
  });
  assert.match(html, /id="save-title"/);
  assert.match(html, /Book a table · restful-booker\.herokuapp\.com/);
  assert.match(html, /id="save-summary"/);
  assert.match(html, /Books a table\./);
  assert.match(html, /id="save-intent"/);
  assert.match(html, /Reserve a table\./);
  assert.match(html, /\/api\/capture\/poster/);
  const card = libraryTable([{
    id: "wf",
    name: "Book a table · restful-booker.herokuapp.com",
    summary: "Books a table.",
    steps: 1,
    firstStep: { action: "click", label: "Book a table" },
  }], [{ id: "r1", workflowId: "wf", status: "passed", at: 2 }]);
  assert.match(card, /\/api\/workflows\/wf\/poster/);
  assert.equal(card.includes("/api/runs/"), false);
  assert.match(card, /class="wf-summary"/);
  assert.match(card, /Books a table\./);
  assert.equal(card.includes("data-shot-fallback"), false);
  const detail = workflowDetail({
    id: "wf",
    name: "Book a table · restful-booker.herokuapp.com",
    summary: "Books a table.",
    intent: "Reserve a table.",
    steps: [],
  });
  assert.match(detail, /id="workflow-summary"/);
  assert.match(detail, /id="workflow-intent"/);
});

test("grok is the save-pass default and the other providers stay available", async () => {
  const none = saveModel({});
  assert.equal(none.available, false);
  assert.match(none.reason, /XAI_API_KEY/);
  const grok = saveModel({ XAI_API_KEY: "xai-test", GROQ_API_KEY: "groq-test" });
  assert.equal(grok.provider, "grok");
  assert.equal(grok.model, "grok-4.7");
  assert.equal(saveModel({ XAI_API_KEY: "xai-test", BAO_XAI_MODEL: "grok-custom" }).model, "grok-custom");
  assert.equal(saveModel({ GROQ_API_KEY: "groq-test" }).provider, "groq");
  assert.equal(saveModel({ OPENAI_API_KEY: "openai-test" }).provider, "openai");
  assert.equal(saveModel({ ANTHROPIC_API_KEY: "anthropic-test" }).provider, "anthropic");
  assert.equal(configuredModel({ XAI_API_KEY: "xai-test", GROQ_API_KEY: "groq-test" }).provider, "groq");
  assert.equal(configuredModel({ XAI_API_KEY: "xai-test" }).provider, "grok");
  const original = globalThis.fetch;
  let auth = "";
  let url = "";
  let model = "";
  globalThis.fetch = async (input, init) => {
    url = String(input);
    const headers = new Headers(init?.headers);
    auth = headers.get("authorization") || "";
    model = JSON.parse(String(init?.body)).model;
    return new Response(JSON.stringify({
      choices: [{ message: { content: "pong" } }],
      usage: { total_tokens: 3 },
    }));
  };
  try {
    const reply = await completeFor(grok, "Reply with the single word pong", { XAI_API_KEY: "xai-test" });
    assert.equal(reply.text, "pong");
    assert.equal(url, "https://api.x.ai/v1/chat/completions");
    assert.equal(auth, "Bearer xai-test");
    assert.equal(model, "grok-4.7");
  } finally {
    globalThis.fetch = original;
  }
});
