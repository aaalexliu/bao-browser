// Live narration latency, a typed note as intent, and Guide Me on the fixture.
// The fixture page only. No vendor network and no real login.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { loadTeachIntentCases } from "../../src/eval/intent/teach-cases";
import type { Identity, WorkflowV2 } from "../../src/v1/schema";

process.env.BAO_DRIVE = "1";

interface TeachCard {
  id: string;
  intent: string;
  note: string;
  noteAsIntent?: boolean;
  action: string;
  human: boolean;
  at?: number;
  shownAt?: number;
  values: { role: string; name: string; label: string }[];
}

interface GuideState {
  status: string;
  actions: number;
  stepId: string;
  intent: string;
}

async function post(port: number, pathname: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) as { error?: string } : {};
  if (!res.ok) throw new Error(`${pathname} ${res.status} ${json.error || text}`);
  return json;
}

async function readState(port: number): Promise<{
  teach: {
    phase: string;
    cards: TeachCard[];
    decisions: { kind: string; detail: string; cardId: string }[];
  };
  guide: GuideState | null;
}> {
  return await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
}

async function until<T>(read: () => Promise<T>, pred: (value: T) => boolean, label: string): Promise<T> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < 8000) {
    const value = await read();
    if (pred(value)) return value;
    last = JSON.stringify(value);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`timed out waiting for ${label}: ${last}`);
}

test("a note lands on the step within a second and a fix is a labelled correction", { timeout: 120000 }, async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.BAO_TEACH_FIXTURE;
  const home = mkdtempSync(path.join(tmpdir(), "bao-note-"));
  const app = await startApp({ home, port: 0 });
  try {
    await post(app.port, "/api/sessions", { url: `http://127.0.0.1:${app.port}/fixture`, teach: true });
    const before = Date.now();
    await post(app.port, "/api/sessions/drive", { click: "#username" });
    const live = await readState(app.port);
    const card = live.teach.cards[0];
    assert.ok(card, "the step was not in the narration");
    assert.equal(typeof card.at, "number");
    assert.equal(typeof card.shownAt, "number");
    assert.ok(card.at! >= before, `event at ${card.at} is before the click ${before}`);
    assert.ok(card.shownAt! >= card.at!, `shown ${card.shownAt} is before the event ${card.at}`);
    assert.ok(card.shownAt! - card.at! <= 1000, `narration latency ${card.shownAt! - card.at!}ms`);

    await post(app.port, "/api/sessions/note", { text: "alpha note" });
    const noted = await readState(app.port);
    assert.equal(noted.teach.cards[0]?.intent, "Click username");
    assert.equal(noted.teach.cards[0]?.note, "alpha note");
    assert.equal(noted.teach.cards[0]?.noteAsIntent, true);
    assert.equal(noted.teach.cards[0]?.shownAt, card.shownAt);

    await post(app.port, "/api/sessions/drive", { fill: { selector: "#username", value: "demo" } });
    await post(app.port, "/api/sessions/drive", { fill: { selector: "#password", value: "demo-pass" } });
    await post(app.port, "/api/sessions/drive", { click: "#login-btn" });
    const filled = await readState(app.port);
    const typed = filled.teach.cards.find((item) => item.action === "type" && item.values.some((value) => value.role === "input"));
    const secret = filled.teach.cards.find((item) => item.values.some((value) => value.role === "secret"));
    const login = filled.teach.cards.find((item) => item.action === "click" && item.id !== card.id);
    assert.ok(typed && secret && login, JSON.stringify(filled.teach.cards));
    assert.equal(typed.intent, "Type {{username}} into Username");
    assert.equal(typed.values[0]?.role, "input");
    assert.equal(secret.intent, "Type secret into Password");
    assert.equal(secret.values[0]?.role, "secret");

    const corrected = await post(app.port, "/api/teach/correct", {
      kind: "rename",
      cardId: typed.id,
      intent: "type the demo name",
    }) as { decisions: { kind: string; detail: string }[] };
    assert.equal(corrected.decisions.some((decision) => decision.detail === "renamed intent"), true);
    await post(app.port, "/api/teach/correct", { kind: "human", cardId: login.id });
    const flagged = await readState(app.port);
    assert.equal(flagged.teach.cards.find((item) => item.id === login.id)?.human, true);
    assert.equal(flagged.teach.decisions.some((decision) => decision.detail === "you do this"), true);
    const notedCard = flagged.teach.cards.find((item) => item.id === card.id);
    assert.equal(notedCard?.intent, "Click username");
    assert.equal(notedCard?.note, "alpha note");
    assert.equal(notedCard?.noteAsIntent, true);

    await post(app.port, "/api/teach/stop");
    await post(app.port, "/api/teach/save", { name: "Noted fixture" });
    const cases = loadTeachIntentCases(path.join(home, "evals", "intent", "cases"));
    const saved = cases[0];
    assert.ok(saved, "the intent case was not written");
    assert.equal(saved.workflow.steps.some((item) => item.intent === "alpha note"), true);
    assert.equal(saved.events.some((event) => event.op === "note" && event.afterText === "alpha note"), true);
    assert.equal(saved.decisions.some((decision) => decision.detail === "renamed intent"), true);
    const blob = JSON.stringify(saved);
    assert.equal(blob.includes("demo-pass"), false);
    assert.equal(blob.includes("SuperSecretPassword!"), false);
  } finally {
    await app.close();
  }
});

test("guide me highlights the fixture and takes no automated actions", { timeout: 120000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-guide-"));
  const app = await startApp({ home, port: 0 });
  try {
    const user: Identity = { surface: "dom", role: "textbox", path: [], id: "username", nameAttr: "username" };
    const login: Identity = { surface: "dom", role: "button", path: [], id: "login-btn", name: "Log in", text: "Log in", testId: "login" };
    const doc: WorkflowV2 = {
      schema: "bao.workflow/v2",
      version: 2,
      id: "wf-guide-me",
      name: "Guide me fixture",
      startUrl: `http://127.0.0.1:${app.port}/fixture`,
      inputs: [],
      createdAt: 1,
      steps: [
        { id: "focus-user", index: 0, action: "click", label: "Click Username", intent: "Focus the username field", surface: "dom", timeoutMs: 8000, identity: user },
        { id: "type-user", index: 1, action: "type", label: "Type demo", intent: "Type the demo username", surface: "dom", timeoutMs: 8000, value: "demo", identity: user },
        { id: "login", index: 2, action: "click", label: "Click Log in", intent: "Log in", surface: "dom", timeoutMs: 8000, identity: login },
      ],
    };
    app.library.save(doc);
    const pending = post(app.port, "/api/replay", { id: doc.id, args: {}, guide: true });
    const focus = await until(() => readState(app.port), (state) => state.guide?.stepId === "focus-user" && state.guide.status === "highlight", "username highlight");
    assert.equal(focus.guide?.actions, 0);
    await post(app.port, "/api/replay/drive", { id: doc.id, click: "#username" });
    const typing = await until(() => readState(app.port), (state) => state.guide?.stepId === "type-user", "type highlight");
    assert.equal(typing.guide?.actions, 0);
    await post(app.port, "/api/replay/drive", { id: doc.id, fill: { selector: "#username", value: "demo" } });
    const signing = await until(() => readState(app.port), (state) => state.guide?.stepId === "login", "login highlight");
    assert.equal(signing.guide?.actions, 0);
    await post(app.port, "/api/replay/drive", { id: doc.id, click: "#login-btn" });
    const done = await pending as { status: string; actions: number; steps: { status: string }[] };
    assert.equal(done.status, "passed");
    assert.equal(done.actions, 0);
    assert.equal(done.steps.every((step) => step.status === "passed"), true);
    const after = await readState(app.port);
    assert.equal(after.guide?.actions, 0);
    assert.equal(after.guide?.status, "passed");
  } finally {
    await app.close();
  }
});
