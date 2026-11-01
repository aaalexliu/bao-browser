// Filmstrip shots, labeled inputs, and the failure side panel.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { runViewer } from "../../src/app/views";
import { scoreLocator } from "../../src/v1/locators";
import { replay, type Driver, type LiveTree } from "../../src/v1/replay";
import type { Identity, WorkflowStep, WorkflowV2 } from "../../src/v1/schema";

function ident(partial: Partial<Identity>): Identity {
  return { surface: "dom", role: "button", path: [], ...partial };
}

function step(partial: Partial<WorkflowStep> & Pick<WorkflowStep, "id" | "action">): WorkflowStep {
  return { index: 0, label: partial.label || partial.action, surface: "dom", timeoutMs: 0, ...partial };
}

function doc(steps: WorkflowStep[]): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id: "wf",
    name: "upload note",
    startUrl: "http://127.0.0.1/fixture",
    createdAt: 1,
    inputs: [],
    steps: steps.map((item, index) => ({ ...item, index })),
  };
}

function tree(nodes: Identity[]): LiveTree {
  return { nodes, texts: [], values: [] };
}

function fake(pages: LiveTree[]): Driver {
  let n = 0;
  const current = () => pages[Math.min(n, pages.length - 1)]!;
  return {
    tree: async () => current(),
    snapshot: async () => ({}),
    click: async () => { n += 1; },
    fill: async () => {},
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    sleep: async () => {},
    markStep: () => {},
  };
}

const noHeal = { available: () => false, propose: async () => { throw new Error("no model"); } };

test("a stored input is name, colon, value", () => {
  const html = runViewer({
    id: "run-9",
    workflowId: "wf",
    status: "passed",
    inputs: { note: "ada", password: "••••" },
    steps: [{ id: "type", status: "passed", label: "type the note" }],
  }, { name: "upload note", steps: [{ id: "type", label: "type the note" }] });
  assert.match(html, /id="stored-inputs"[^>]*>note: ada · password: ••••\./);
  assert.equal(html.includes("note ada"), false);
});

test("a filmstrip frame uses the cropped shot and an icon when the step has none", () => {
  const html = runViewer({
    id: "run-gap",
    workflowId: "wf",
    status: "failed",
    steps: [
      { id: "type", status: "passed", label: "type the note", action: "type", beforeShot: "type-before.png", afterShot: "type-after.png", startedAt: 0, endedAt: 400 },
      { id: "save", status: "failed", label: "save", phase: "find", startedAt: 800, endedAt: 900 },
    ],
    failure: {
      stepId: "save",
      phase: "find",
      reason: "below-threshold",
      locators: [
        { kind: "testid", label: "testid missing-save", score: 0 },
        { kind: "role", label: "role button Save", score: 42 },
      ],
    },
  }, { name: "upload note", steps: [{ id: "type", label: "type the note" }, { id: "save", label: "save" }] }, "save");
  assert.match(html, /class="frame has-shot[^"]*" data-select-step="type"/);
  assert.match(html, /src="\/api\/runs\/run-gap\/shots\/type-after\.png"/);
  assert.match(html, /data-before="\/api\/runs\/run-gap\/shots\/type-before\.png"/);
  assert.match(html, /data-frame="before"/);
  assert.match(html, /data-frame="after"/);
  const save = html.slice(html.indexOf('data-select-step="save"'));
  assert.match(save, /class="ph"/);
  assert.equal(save.slice(0, save.indexOf("</button>")).includes("<img"), false);
  assert.match(html, /id="failure-panel" data-phase="find"/);
  assert.match(html, /Phase <strong>find<\/strong>/);
  assert.match(html, /data-score="0"/);
  assert.match(html, /data-score="42"/);
  assert.match(html, /testid missing-save/);
  assert.match(html, /role button Save/);
});

test("a locator scores 100 for one hit, 40 for two, and 0 for a miss", () => {
  const nodes = [
    ident({ testId: "save", text: "Save" }),
    ident({ testId: "save", text: "Save again" }),
    ident({ role: "button", text: "Continue" }),
  ];
  assert.equal(scoreLocator({ kind: "text", value: "Continue" }, nodes).score, 100);
  assert.equal(scoreLocator({ kind: "testid", value: "save" }, nodes).score, 40);
  assert.equal(scoreLocator({ kind: "testid", value: "missing-save" }, nodes).score, 0);
  const hidden = [ident({ testId: "note", text: "Note" })];
  assert.equal(scoreLocator({ kind: "testid", value: "note" }, hidden, [{ x: 0, y: 0, w: 0, h: 0 }]).score, 15);
});

test("a missed step keeps every locator it tried, with the score", async () => {
  const live = tree([ident({ testId: "save", text: "Continue" })]);
  const missed = await replay(doc([step({
    id: "save",
    action: "click",
    label: "save",
    identity: ident({ testId: "missing-save", text: "Save" }),
    locators: [
      { kind: "testid", value: "missing-save" },
      { kind: "text", value: "Save" },
    ],
  })]), {}, fake([live]), { heal: noHeal });
  assert.equal(missed.status, "failed");
  assert.equal(missed.failure?.phase, "find");
  assert.deepEqual(missed.failure?.locators?.map((item) => item.score), [0, 0]);
  assert.match(missed.failure?.locators?.[0]?.label || "", /missing-save/);
  assert.match(missed.failure?.locators?.[1]?.label || "", /Save/);

  const ranked = await replay(doc([step({
    id: "save",
    action: "click",
    label: "save",
    identity: ident({ role: "button", text: "Save" }),
  })]), {}, fake([live]), { heal: noHeal });
  assert.equal(ranked.failure?.phase, "find");
  assert.ok((ranked.failure?.locators || []).length >= 1);
  assert.equal(typeof ranked.failure?.locators?.[0]?.score, "number");
  assert.equal(ranked.failure?.locators?.[0]?.kind, "identity");
});

for (const format of ["mp4", "webm"] as const) test(`run ${format} video answers byte ranges with its media type`, async () => {
  process.env.BAO_HEAL_CURSOR_ACCOUNT = "0";
  const home = mkdtempSync(path.join(tmpdir(), "bao-video-"));
  const app = await startApp({ home, port: 0 });
  try {
    const run = {
      id: "run-video", workflowId: "wf", status: "passed", at: 1, heals: [], steps: [], video: `recorded.${format}`,
    };
    app.library.saveRun(run);
    const file = path.join(home, "videos", run.video);
    mkdirSync(path.dirname(file), { recursive: true });
    const body = Buffer.from("0123456789".repeat(100));
    writeFileSync(file, body);
    const url = `http://127.0.0.1:${app.port}/api/runs/run-video/video`;
    const full = await fetch(url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), `video/${format}`);
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.equal(Number(full.headers.get("content-length")), body.length);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), body);
    const part = await fetch(url, { headers: { range: "bytes=0-9" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-type"), `video/${format}`);
    assert.equal(part.headers.get("content-range"), `bytes 0-9/${body.length}`);
    assert.equal(await part.text(), "0123456789");
    const invalid = await fetch(url, { headers: { range: `bytes=${body.length}-` } });
    assert.equal(invalid.status, 416);
    await invalid.arrayBuffer();
    writeFileSync(file, Buffer.alloc(0));
    const empty = await fetch(url);
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get("content-type"), `video/${format}`);
    assert.equal((await empty.arrayBuffer()).byteLength, 0);
    app.library.saveRun({ ...run, video: `../recorded.${format}` });
    assert.equal((await fetch(url)).status, 404);
  } finally {
    await app.close();
  }
});
