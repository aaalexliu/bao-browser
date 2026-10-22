import assert from "node:assert/strict";
import test from "node:test";
import { heldoutSplit } from "../../src/eval/heldout/split";
import { modelCondensePrompt, reviseDecision, reviseStepGates, type ModelDecision } from "../../src/eval/intent/revise";
import type { TrailEvent } from "../../src/v1/interpret";
import type { WorkflowStep } from "../../src/v1/schema";

test("the prompt states the three condenser rules", () => {
  const text = modelCondensePrompt([]);
  assert.match(text, /Never drop a step whose effect a later step depends on/);
  assert.match(text, /Never mark a click as login or confirm when it changed nothing/);
  assert.match(text, /keep only the final value/);
});

test("a typo and its correction collapse to the final value", () => {
  const events = [
    act("t1", "type", { nameAttr: "q", value: "ajaxx" }),
    act("b1", "key", { nameAttr: "q", key: "Backspace" }),
    act("t2", "type", { nameAttr: "q", value: "ajax" }),
    act("k1", "key", { key: "Enter" }),
  ];
  const revised = reviseDecision(events, decision(["t1", "t2", "k1"], []));
  assert.deepEqual(revised.keep, ["t2", "k1"]);
});

test("keeping only the wiped value still resolves to the replacement", () => {
  const events = [
    act("t1", "type", { nameAttr: "q", value: "Beatless" }),
    act("b1", "key", { nameAttr: "q", key: "Backspace" }),
    act("t2", "type", { nameAttr: "q", value: "Beatles" }),
  ];
  const revised = reviseDecision(events, decision(["t1"], []));
  assert.deepEqual(revised.keep, ["t2"]);
});

test("a kept submit pulls the type it depends on", () => {
  const events = [
    act("t1", "type", { nameAttr: "q", value: "Ada Lovelace", afterUrl: "https://ex.test/" }),
    act("go", "click", {
      name: "Search",
      beforeUrl: "https://ex.test/",
      afterUrl: "https://ex.test/?q=Ada+Lovelace",
    }),
  ];
  const revised = reviseDecision(events, decision(["go"], []));
  assert.deepEqual(revised.keep, ["t1", "go"]);
});

test("a later step on the opened page keeps the click that opened it", () => {
  const events = [
    act("open", "click", { name: "Manual", beforeUrl: "https://ex.test/", afterUrl: "https://ex.test/manual" }),
    act("t1", "type", { nameAttr: "q", value: "vec", beforeUrl: "https://ex.test/manual", afterUrl: "https://ex.test/manual" }),
  ];
  const revised = reviseDecision(events, decision(["t1"], []));
  assert.deepEqual(revised.keep, ["open", "t1"]);
});

test("a click inside a control keeps the click that revealed it", () => {
  const events = [
    act("menu", "click", {
      cssPath: "nav > details",
      beforeUrl: "https://ex.test/",
      afterUrl: "https://ex.test/",
      subtreeBefore: "Docs",
      subtreeAfter: "Docs Vec",
    }),
    act("item", "click", {
      name: "Vec",
      cssPath: "nav > details > a",
      beforeUrl: "https://ex.test/",
      afterUrl: "https://ex.test/vec",
    }),
  ];
  const revised = reviseDecision(events, decision(["item"], []));
  assert.ok(revised.keep.includes("menu"));
  assert.ok(revised.keep.includes("item"));
});

test("an undone click is dropped and cannot be login", () => {
  const events = [
    act("miss", "click", { name: "About", beforeUrl: "https://ex.test/docs", afterUrl: "https://ex.test/about" }),
    act("scroll", "scroll"),
    act("back", "back"),
    act("goal", "click", { name: "git-add", beforeUrl: "https://ex.test/docs", afterUrl: "https://ex.test/docs/git-add" }),
  ];
  const revised = reviseDecision(events, decision(["miss"], [{ id: "miss", gate: "login" }]));
  assert.deepEqual(revised.keep, ["goal"]);
  assert.deepEqual(revised.human, []);
});

test("a click that changed nothing is not retagged login or confirm", () => {
  const events = [
    act("head", "click", { name: "Forms", beforeUrl: "https://ex.test/forms", afterUrl: "https://ex.test/forms" }),
    act("pw", "type", { name: "Password", nameAttr: "password", value: "secret", sensitive: true }),
  ];
  const revised = reviseDecision(events, decision(
    ["head", "pw"],
    [{ id: "head", gate: "login" }, { id: "pw", gate: "login" }],
  ));
  assert.deepEqual(revised.keep, ["pw"]);
  assert.deepEqual(revised.human, [{ id: "pw", gate: "login" }]);
});

test("a lone click with no recorded effect stays, and is still not a gate", () => {
  const events = [
    act("only", "click", { name: "Click for JS Alert", beforeUrl: "https://ex.test/alerts", afterUrl: "https://ex.test/alerts" }),
  ];
  const revised = reviseDecision(events, decision(["only"], [{ id: "only", gate: "login" }]));
  assert.deepEqual(revised.keep, ["only"]);
  assert.deepEqual(revised.human, []);
});

test("confirm is only a confirm control, and login is only a credential or login control", () => {
  const events = [
    act("usage", "click", { name: "Usage", beforeUrl: "https://ex.test/a", afterUrl: "https://ex.test/usage" }),
    act("ok", "click", { name: "Confirm", idAttr: "confirm", beforeUrl: "https://ex.test/usage", afterUrl: "https://ex.test/usage", afterText: "Confirmed" }),
  ];
  const revised = reviseDecision(events, decision(
    ["usage", "ok"],
    [{ id: "usage", gate: "confirm" }, { id: "ok", gate: "confirm" }],
  ));
  assert.deepEqual(revised.human, [{ id: "ok", gate: "confirm" }]);
});

test("the last remaining effect stays when the model drops it", () => {
  const events = [
    act("noise", "click", { name: "Option", beforeUrl: "https://ex.test/std", afterUrl: "https://ex.test/std/option" }),
    act("back", "back"),
    act("goal", "click", { name: "Vec", beforeUrl: "https://ex.test/std", afterUrl: "https://ex.test/std/vec" }),
  ];
  const revised = reviseDecision(events, decision(["noise"], [{ id: "goal", gate: "confirm" }, { id: "noise", gate: "login" }]));
  assert.deepEqual(revised.keep, ["goal"]);
  assert.deepEqual(revised.human, []);
});

test("hybrid gates follow the same login and confirm rule", () => {
  const steps = [
    step("h", "click", "Forms overview"),
    step("p", "type", "Password", { sensitive: true }),
    step("c", "click", "Confirm purchase", {
      postcondition: { kind: "text", match: "Confirmed", timeoutMs: 8000 },
    }),
  ];
  const human = reviseStepGates(steps, [
    { id: "h", gate: "login" },
    { id: "p", gate: "login" },
    { id: "c", gate: "confirm" },
  ]);
  assert.deepEqual(human, [
    { id: "p", gate: "login" },
    { id: "c", gate: "confirm" },
  ]);
});

test("the held-out split is a fixed function of the case id", () => {
  const dev = [
    "httpbin-order", "redirect", "quotes-tag", "w3c-shipping", "w3c-check", "mdn-button",
    "playwright-todo", "mdn-name-form", "mdn-get-say", "mdn-postcard", "backbone-todo",
    "eslint-search", "jquery-api-search", "rfc-search", "selenium-greeting", "hockey-search",
    "sauce-username", "htmx-edit", "gutenberg-search", "musicbrainz-search", "git-add",
    "httpwg-semantics", "nginx-core", "pico-email",
  ];
  const heldOut = [
    "status-200", "quotes-author", "quotes-login", "books-travel", "alerts", "mdn-styled-mail",
    "httpbingo-topping", "jquery-todo", "sqlite-search", "bootstrap-email", "selenium-confirm",
    "selenium-agree", "caniuse-search", "globalsqa-search", "bulma-text", "parabank-username",
    "webscraper-laptop", "playwright-locators", "hn-search", "rust-vec", "node-synopsis",
    "markdown-cheat", "pptr-api", "lua-manual",
  ];
  assert.deepEqual(dev.map((id) => heldoutSplit(id)), dev.map(() => "dev"));
  assert.deepEqual(heldOut.map((id) => heldoutSplit(id)), heldOut.map(() => "test"));
});

function decision(keep: string[], human: ModelDecision["human"]): ModelDecision {
  return { keep, human, secrets: [] };
}

function act(id: string, op: string, extra: Partial<TrailEvent> & { name?: string; nameAttr?: string; cssPath?: string; idAttr?: string } = {}): TrailEvent {
  const { name, nameAttr, cssPath, idAttr, ...rest } = extra;
  const identity = name || nameAttr || cssPath || idAttr
    ? {
      surface: "dom" as const,
      role: name === "Password" ? "password" : "button",
      name,
      nameAttr,
      cssPath,
      id: idAttr,
      path: [],
    }
    : undefined;
  return {
    id,
    ts: 0,
    kind: op === "scroll" ? "read" : "act",
    op,
    identity,
    ...rest,
  };
}

function step(id: string, action: WorkflowStep["action"], name: string, extra: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id,
    index: 0,
    action,
    label: name,
    surface: "dom",
    timeoutMs: 8000,
    identity: { surface: "dom", role: action === "type" ? "textbox" : "button", name, path: [] },
    expect: { kind: "settled", timeoutMs: 8000 },
    ...extra,
  };
}
