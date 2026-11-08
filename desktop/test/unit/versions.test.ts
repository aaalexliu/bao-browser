import { stepTitle, stepQuery } from "../../src/v1/schema";
import { fixtureDoc, fixtureStep, fixtureInput, writeStep, withStep } from "../support/fixture-step";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPushBody } from "../../../web/src/lib/guard";
import { versionsPanel, workflowConflicts } from "../../src/app/views";
import { testChromium as chromium } from "../../src/test-browser.js";
import { BrowserDriver } from "../../src/v1/browser-driver";
import { keepPatch, unavailableHeal } from "../../src/v1/heal";
import { replay, type Driver, type LiveTree } from "../../src/v1/replay";
import type { Identity, WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { loadState, syncAll } from "../../src/v1/sync";
import { draftVersion, listVersions, noteConflict, promoteVersion, restoreVersion, versionDocument } from "../../src/v1/versions";

const AT = Date.parse("2026-10-22T04:50:16.442Z");

function ident(partial: Partial<Identity>): Identity {
  return { surface: "dom", role: "button", path: [], ...partial };
}

function workflow(id: string, testId: string): WorkflowV2 {
  return fixtureDoc({
    schema: "bao.workflow/v4",
    version: 2,
    id,
    name: "Fixture",
    startUrl: "https://example.com/fixture",
    createdAt: 1,
    inputs: [],
    steps: [fixtureStep({
      id: "s0",
      index: 0,
      action: "click",
      label: "Click go",
      surface: "dom",
      identity: ident({ testId }),
      timeoutMs: 0,
      postcondition: { kind: "element", timeoutMs: 0 },
    })],
  });
}

function driver(nodes: Identity[]): Driver & { clicks: number } {
  const state = { clicks: 0 };
  const tree: LiveTree = { nodes, texts: [], values: [] };
  return {
    get clicks() { return state.clicks; },
    tree: async () => tree,
    snapshot: async () => ({ dom: "fixture", ax: [] }),
    click: async () => { state.clicks += 1; },
    fill: async () => {},
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    sleep: async () => {},
  };
}

test("a heal is a draft, replay stays on the live version until promote, and restore v1 works", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-versions-"));
  const library = new Library(home);
  const original = workflow("wf-versions", "v1");
  library.save(original);
  const healed = keepPatch(original, "s0", { identity: ident({ testId: "healed" }) });
  const draft = draftVersion(library, healed, "heal");
  assert.equal(draft.role, "draft");
  assert.equal(draft.source, "heal");
  assert.equal((() => { const _step = library.read("wf-versions").steps[0]; return _step == null ? undefined : stepQuery(_step); })()?.testId, "v1");

  const live = library.read("wf-versions");
  const passed = await replay(live, {}, driver([ident({ testId: "v1" })]), { heal: unavailableHeal(), now: () => 1 });
  assert.equal(passed.status, "passed");
  assert.equal((() => { const _step = library.read("wf-versions").steps[0]; return _step == null ? undefined : stepQuery(_step); })()?.testId, "v1");

  const edited = { ...original, name: "Renamed", updatedAt: 2 };
  const edit = draftVersion(library, edited, "edit");
  assert.equal(edit.source, "edit");
  assert.equal(library.read("wf-versions").name, "Fixture");

  promoteVersion(library, "wf-versions", draft.n);
  assert.equal((() => { const _step = library.read("wf-versions").steps[0]; return _step == null ? undefined : stepQuery(_step); })()?.testId, "healed");
  const promotedReplay = await replay(library.read("wf-versions"), {}, driver([ident({ testId: "healed" })]), { heal: unavailableHeal(), now: () => 2 });
  assert.equal(promotedReplay.status, "passed");

  const restored = restoreVersion(library, "wf-versions", 1);
  assert.equal(restored.role, "draft");
  assert.equal(restored.source, "restore");
  assert.equal((restored.document.steps[0] == null ? undefined : stepQuery(restored.document.steps[0]))?.testId, "v1");
  assert.equal((() => { const _step = library.read("wf-versions").steps[0]; return _step == null ? undefined : stepQuery(_step); })()?.testId, "healed");
  promoteVersion(library, "wf-versions", restored.n);
  assert.equal((() => { const _step = library.read("wf-versions").steps[0]; return _step == null ? undefined : stepQuery(_step); })()?.testId, "v1");
  const listed = listVersions(library, "wf-versions");
  assert.equal(listed.find((row) => row.n === restored.n)?.role, "live");
  assert.equal(listed.find((row) => row.n === 1)?.role, "past");
});

test("a version row names the step change and lists before and after", () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-version-diff-"));
  const library = new Library(home);
  const original = workflow("wf-diff", "signed-in");
  writeStep(original.steps[0]!, { label: "Click signed in" });
  library.save(original);
  const healed = keepPatch(original, "s0", { identity: ident({ role: "button", name: "Signed in" }) });
  draftVersion(library, healed, "heal");
  const listed = listVersions(library, "wf-diff");
  const row = listed.find((item) => item.source === "heal");
  assert.equal(row?.diff, 'Click signed in: testId signed-in → role button "Signed in"');
  assert.equal(row?.steps[0]?.before, "testId signed-in");
  assert.equal(row?.steps[0]?.after, 'role button "Signed in"');
  assert.equal(row?.steps[0]?.changed, true);
  assert.equal(listed[0]?.diff, "Click signed in: testId signed-in");
  const html = versionsPanel(listed);
  assert.match(html, /data-testid="version-diff"/);
  assert.match(html, /data-testid="version-steps"/);
  assert.match(html, /Before and after/);
  assert.match(html, /testId signed-in/);
  assert.match(html, /role button &quot;Signed in&quot;/);
  assert.equal((() => { const _step = library.read("wf-diff").steps[0]; return _step == null ? undefined : stepQuery(_step); })()?.testId, "signed-in");
});

test("a conflict draft names both Macs and leaves the live file alone", () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-conflict-"));
  const library = new Library(home);
  const mine = workflow("wf-conflict", "mine");
  writeStep(mine.steps[0]!, { label: "Click mine" });
  library.save(mine);
  const theirs = workflow("wf-conflict", "theirs");
  writeStep(theirs.steps[0]!, { label: "Click theirs" });
  noteConflict(library, {
    mine,
    theirs,
    mineDevice: "Home Mac",
    theirsDevice: "Ada's Mac",
    remoteVersion: 2,
  });
  assert.equal((() => { const _step = library.read("wf-conflict").steps[0]; return _step == null ? undefined : stepTitle(_step); })(), "Click mine");
  const listed = listVersions(library, "wf-conflict");
  const html = workflowConflicts(listed) + versionsPanel(listed);
  assert.match(html, /Changed on Ada&#39;s Mac and Home Mac/);
  assert.match(html, /data-testid="conflict-diff"/);
  assert.match(html, /data-testid="keep-mine"/);
  assert.match(html, /Keep theirs/);
  assert.match(html, /Keep both as a copy/);
  assert.match(html, /Click mine/);
  assert.match(html, /Click theirs/);
  assert.match(html, /data-testid="version-changed">1 step</);
  assert.match(html, /data-changed="true"><strong>Click mine</);
  assert.equal(html.includes("bao://"), false);
});

test("a conflict draft counts only the steps that differ and leaves a matching step plain", () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-conflict-count-"));
  const library = new Library(home);
  const mine = workflow("wf-conflict-count", "open");
  mine.steps = [
    withStep(mine.steps[0]!, { id: "one", label: "Open" }),
    withStep(mine.steps[0]!, { id: "two", index: 1, label: "Save", identity: ident({ testId: "save" }) }),
  ];
  library.save(mine);
  const theirs = workflow("wf-conflict-count", "open");
  theirs.steps = [
    withStep(theirs.steps[0]!, { id: "one", label: "Open Ada" }),
    withStep(theirs.steps[0]!, { id: "two", index: 1, label: "Save", identity: ident({ testId: "save" }) }),
  ];
  noteConflict(library, {
    mine,
    theirs,
    mineDevice: "Home Mac",
    theirsDevice: "Ada's Mac",
    remoteVersion: 2,
  });
  const listed = listVersions(library, "wf-conflict-count");
  const html = workflowConflicts(listed) + versionsPanel(listed);
  assert.match(html, /data-testid="version-changed">1 step</);
  assert.equal(html.includes(">2 steps<"), false);
  assert.match(html, /data-changed="true"><strong>Open Ada</);
  assert.match(html, /data-changed="true"><strong>Open</);
  assert.match(html, /data-changed="false"><strong>Save</);
  assert.equal(/data-changed="true"><strong>Save</.test(html), false);
});

test("a conflict draft uses the cloud version numbers and device names", () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-conflict-cloud-"));
  const library = new Library(home);
  const mine = workflow("wf-cloud", "open");
  writeStep(mine.steps[0]!, { label: "Open" });
  library.save(mine);
  const first = workflow("wf-cloud", "open");
  writeStep(first.steps[0]!, { label: "Open" });
  const second = workflow("wf-cloud", "open");
  writeStep(second.steps[0]!, { label: "Open Ada" });
  noteConflict(library, {
    mine,
    theirs: second,
    mineDevice: "Home Mac",
    theirsDevice: "Ada's Mac",
    remoteVersion: 2,
    draftVersion: 3,
    history: [
      { version: 1, kind: "version", device_name: "Ada's Mac", document: first, created_at: AT },
      { version: 2, kind: "version", device_name: "Ada's Mac", document: second, created_at: AT },
      { version: 3, kind: "conflict", device_name: "Home Mac", document: mine, created_at: AT },
    ],
  });
  const listed = listVersions(library, "wf-cloud");
  assert.deepEqual(listed.map((row) => row.n), [1, 2, 3]);
  assert.equal(listed[0]?.deviceName, "Ada's Mac");
  assert.equal(listed[1]?.deviceName, "Ada's Mac");
  assert.equal(listed[2]?.source, "conflict");
  assert.equal(listed[2]?.deviceName, "Home Mac");
  assert.equal(listed.some((row) => row.role === "live"), false);
  const html = versionsPanel(listed);
  assert.match(html, /data-version="1"/);
  assert.match(html, /data-version="3"/);
  assert.match(html, /data-testid="version-device">Ada&#39;s Mac/);
  assert.match(html, /data-testid="version-device">Home Mac/);
});

test("a 409 history replacement retains each version's own local defaults for restore", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-conflict-history-defaults-"));
  const library = new Library(home);
  const first = workflow("wf-history-defaults", "open");
  first.inputs = [
    fixtureInput({ name: "token", type: "text", default: "sk-AdaFixture111" }),
    fixtureInput({ name: "rows", type: "table", default: "name,token\r\nAda,[secret stripped]\r\nGrace,sk-GraceFixture222\r\n" }),
  ];
  library.save(first);
  listVersions(library, first.id);
  const firstSnapshot = library.read(first.id);
  const second = structuredClone(first);
  second.inputs[0]!.default = "sk-SecondFixture333";
  second.inputs[1]!.default = "name,token\r\nAda,[secret stripped]\r\nGrace,sk-SecondTable444\r\n";
  const secondDraft = draftVersion(library, second, "edit");
  promoteVersion(library, first.id, secondDraft.n);
  const secondSnapshot = library.read(first.id);
  const mine = library.read(first.id);
  mine.name = "Current local edit";
  mine.inputs[0]!.default = "sk-CurrentFixture555";
  mine.inputs[1]!.default = "name,token\r\nAda,[secret stripped]\r\nGrace,sk-CurrentTable666\r\n";
  library.save(mine);
  const cloud = [firstSnapshot, secondSnapshot, { ...secondSnapshot, name: "Remote rename" }]
    .map((doc) => buildPushBody(doc, { baseVersion: 0 }).document as WorkflowV2);
  let conflicts = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/sync/snapshot") {
        res.writeHead(404).end("{}");
      } else if (req.url === "/api/devices") {
        res.end(JSON.stringify({ devices: [], categories: [] }));
      } else if (req.method === "POST" && req.url === `/api/workflows/${first.id}/versions`) {
        conflicts += 1;
        res.writeHead(409).end(JSON.stringify({
          error: "conflict", current: { version: 3, document: cloud[2], deviceName: "Other Mac" },
          draft: { version: 4 },
        }));
      } else if (req.url === `/api/workflows/${first.id}/versions`) {
        res.end(JSON.stringify({ versions: cloud.map((document, index) => ({
          version: index + 1, kind: "version", document, created_at: AT, device_name: "Other Mac",
        })) }));
      } else {
        res.writeHead(404).end("{}");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  writeFileSync(path.join(home, "sync.json"), JSON.stringify({
    server: `http://127.0.0.1:${address.port}`, deviceToken: "device-token", backedUp: true,
    workflows: {}, pushedRuns: [], remoteDevices: [], remoteCategories: [], conflicts: [],
  }));
  try {
    await syncAll(library, "push");
    assert.equal(conflicts, 1);
    assert.equal(loadState(home).conflicts.length, 1);
    assert.deepEqual(listVersions(library, first.id).map((row) => [row.n, row.role]),
      [[1, "past"], [2, "past"], [3, "past"], [4, "draft"]]);
    assert.deepEqual(versionDocument(library, first.id, 1).inputs, first.inputs);
    assert.deepEqual(versionDocument(library, first.id, 2).inputs, second.inputs);
    assert.deepEqual(versionDocument(library, first.id, 3).inputs, cloud[2]!.inputs);
    assert.deepEqual(versionDocument(library, first.id, 4).inputs, mine.inputs);
    assert.deepEqual(library.read(first.id).inputs, mine.inputs);
    const restored = restoreVersion(library, first.id, 1);
    assert.equal(restored.n, 5);
    assert.equal(restored.role, "draft");
    assert.equal(restored.source, "restore");
    assert.deepEqual(restored.document.inputs, first.inputs);
    assert.deepEqual(library.read(first.id).inputs, mine.inputs);
    promoteVersion(library, first.id, restored.n);
    assert.deepEqual(library.read(first.id).inputs, first.inputs);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("conflict history restores cloud v2 from promoted local n3, not unpromoted n2, and submits its password", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-conflict-misaligned-"));
  const library = new Library(home);
  const submitted: string[] = [];
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/submit") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => { body += chunk; });
      req.on("end", () => {
        submitted.push(new URLSearchParams(body).get("password") ?? "");
        res.setHeader("content-type", "text/html");
        res.end("<!doctype html><p>Saved fixture</p>");
      });
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end('<!doctype html><form method="post" action="/submit"><label>Password <input id="password" name="password" type="password" data-testid="password"></label><button data-testid="save" type="submit">Save fixture</button></form>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const first = workflow("wf-misaligned", "save");
    first.startUrl = `http://127.0.0.1:${address.port}/`;
    first.inputs = [fixtureInput({ name: "password", type: "secret", default: "Old-password-v1!" })];
    first.steps = [
      fixtureStep({
        id: "password", index: 0, action: "type", label: "Fill password", surface: "dom",
        identity: ident({ role: "textbox", id: "password", testId: "password" }),
        input: "password", sensitive: true, timeoutMs: 5000,
        postcondition: { kind: "element", timeoutMs: 5000 },
      }),
      withStep(first.steps[0]!, { id: "save", index: 1, timeoutMs: 5000, label: "Save fixture", identity: ident({ testId: "save", name: "Save fixture" }), postcondition: { kind: "text", match: "Saved fixture", timeoutMs: 5000 } }),
    ];
    library.save(first);
    listVersions(library, first.id);
    const firstSnapshot = library.read(first.id);
    const abandoned = structuredClone(firstSnapshot);
    abandoned.inputs[0]!.default = "Abandoned-password!";
    const abandonedDraft = draftVersion(library, abandoned, "edit");
    assert.equal(abandonedDraft.n, 2);
    const second = structuredClone(firstSnapshot);
    second.inputs[0]!.default = "New-password-v2!";
    const promotedDraft = draftVersion(library, second, "edit");
    assert.equal(promotedDraft.n, 3);
    promoteVersion(library, first.id, promotedDraft.n);
    const secondSnapshot = library.read(first.id);
    const projection = buildPushBody(secondSnapshot, { baseVersion: 1 }).document as WorkflowV2;
    const cloud = Object.fromEntries(Object.entries(projection).reverse()) as unknown as WorkflowV2;
    cloud.inputs = cloud.inputs.map((input) => Object.fromEntries(Object.entries(input).reverse()) as typeof input);
    cloud.heal = undefined;
    const current = structuredClone(secondSnapshot);
    current.name = "Later local revision";
    current.inputs[0]!.default = "Current-password!";
    const currentDraft = draftVersion(library, current, "edit");
    promoteVersion(library, first.id, currentDraft.n);
    assert.equal(listVersions(library, first.id).find((row) => row.n === 2)?.role, "draft");
    assert.equal(listVersions(library, first.id).find((row) => row.n === 3)?.role, "past");
    noteConflict(library, {
      mine: library.read(first.id), theirs: cloud, mineDevice: "Home Mac", theirsDevice: "Other Mac",
      remoteVersion: 2, draftVersion: 5,
      history: [
        { version: 1, kind: "version", document: buildPushBody(firstSnapshot, { baseVersion: 0 }).document },
        { version: 2, kind: "version", document: cloud },
      ],
    });
    assert.equal(versionDocument(library, first.id, 2).inputs[0]?.default, "New-password-v2!");
    assert.equal(library.read(first.id).inputs[0]?.default, "Current-password!");
    const restored = restoreVersion(library, first.id, 2);
    assert.equal(restored.role, "draft");
    assert.equal(restored.document.inputs[0]?.default, "New-password-v2!");
    promoteVersion(library, first.id, restored.n);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const live = library.read(first.id);
    await page.goto(live.startUrl);
    const result = await replay(live, {}, new BrowserDriver(page), { heal: unavailableHeal() });
    assert.equal(result.status, "passed");
    assert.equal(result.modelCalls, 0);
    assert.deepEqual(submitted, ["New-password-v2!"]);
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("conflict history leaves cloud defaults unchanged without a complete promoted projection match", () => {
  for (const difference of ["draft only", "name", "updatedAt", "startUrl", "step", "input"] as const) {
    const home = mkdtempSync(path.join(tmpdir(), "bao-conflict-no-match-"));
    const library = new Library(home);
    const first = workflow("wf-no-match", "open");
    first.updatedAt = AT;
    first.inputs = [fixtureInput({ name: "password", type: "secret", default: "Local-password!" })];
    library.save(first);
    listVersions(library, first.id);
    const snapshot = library.read(first.id);
    const cloud = buildPushBody(snapshot, { baseVersion: 0 }).document as WorkflowV2;
    if (difference === "draft only") {
      const abandoned = structuredClone(snapshot);
      abandoned.name = "Unpromoted edit";
      abandoned.inputs[0]!.default = "Abandoned-password!";
      const draft = draftVersion(library, abandoned, "edit");
      assert.equal(draft.n, 2);
      Object.assign(cloud, buildPushBody(draft.document, { baseVersion: 0 }).document);
    } else if (difference === "name") cloud.name = "Remote rename";
    else if (difference === "updatedAt") cloud.updatedAt = AT + 1;
    else if (difference === "startUrl") cloud.startUrl = "https://example.com/other";
    else if (difference === "step") writeStep(cloud.steps[0]!, { label: "Remote step" });
    else cloud.inputs.push(fixtureInput({ name: "extra", type: "text", default: "remote" }));
    const expected = structuredClone(cloud);
    noteConflict(library, {
      mine: snapshot, theirs: cloud, mineDevice: "Home Mac", theirsDevice: "Other Mac",
      remoteVersion: 1, draftVersion: 3,
      history: [{ version: 1, kind: "version", document: cloud }],
    });
    assert.deepEqual(versionDocument(library, first.id, 1), expected, difference);
    assert.equal(versionDocument(library, first.id, 1).inputs[0]?.default, undefined, difference);
    const restored = restoreVersion(library, first.id, 1);
    assert.deepEqual(restored.document.inputs, expected.inputs, difference);
    assert.equal(library.read(first.id).inputs[0]?.default, "Local-password!", difference);
  }
});

test("conflict history leaves cloud defaults unchanged when two promoted projections match", (t) => {
  t.mock.method(Date, "now", () => AT);
  const home = mkdtempSync(path.join(tmpdir(), "bao-conflict-ambiguous-"));
  const library = new Library(home);
  const first = workflow("wf-ambiguous", "open");
  first.updatedAt = AT;
  first.inputs = [fixtureInput({ name: "password", type: "secret", default: "First-password!" })];
  library.save(first);
  listVersions(library, first.id);
  const second = library.read(first.id);
  second.inputs[0]!.default = "Second-password!";
  const draft = draftVersion(library, second, "edit");
  promoteVersion(library, first.id, draft.n);
  assert.deepEqual(listVersions(library, first.id).map((row) => row.role), ["past", "live"]);
  const snapshot = library.read(first.id);
  const cloud = buildPushBody(snapshot, { baseVersion: 0 }).document as WorkflowV2;
  const expected = structuredClone(cloud);
  noteConflict(library, {
    mine: snapshot, theirs: cloud, mineDevice: "Home Mac", theirsDevice: "Other Mac",
    remoteVersion: 2, draftVersion: 3,
    history: [{ version: 2, kind: "version", document: cloud }],
  });
  assert.deepEqual(versionDocument(library, first.id, 2), expected);
  assert.equal(versionDocument(library, first.id, 2).inputs[0]?.default, undefined);
  const restored = restoreVersion(library, first.id, 2);
  assert.deepEqual(restored.document.inputs, expected.inputs);
  assert.equal(library.read(first.id).inputs[0]?.default, "Second-password!");
});

test("a saved version uses the real save time, not the epoch", () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-version-saved-"));
  const library = new Library(home);
  const before = Date.now();
  const doc = workflow("wf-saved-now", "go");
  doc.createdAt = 0;
  library.save(doc);
  const saved = listVersions(library, "wf-saved-now")[0];
  assert.ok(saved);
  assert.ok(saved.createdAt >= before, `saved at ${saved.createdAt}`);
  assert.ok(saved.createdAt >= 1_000_000_000_000);
  assert.ok((saved.history?.[0]?.at || 0) >= before);
  const one = workflow("wf-saved-one", "go");
  one.createdAt = 1;
  library.save(one);
  const sentinel = listVersions(library, "wf-saved-one")[0];
  assert.ok(sentinel && sentinel.createdAt >= before);
  const html = zoned(
    require.resolve("../../src/app/views"),
    `versionsPanel(${JSON.stringify([{ n: saved.n, role: saved.role, source: saved.source, createdAt: saved.createdAt, history: saved.history }])})`,
    "America/New_York",
  );
  assert.match(html, /EDT|EST/);
  assert.equal(html.includes("1970"), false);
  assert.equal(html.includes("12:00 AM UTC"), false);
});

test("the versions panel prints the local time with the zone label", () => {
  const html = zoned(
    require.resolve("../../src/app/views"),
    `versionsPanel([{n:1,role:"live",source:"saved",createdAt:${AT},locator:{stepId:"signed-in",source:"recorded",at:${AT},score:100,changed:["testId"]}},{n:2,role:"draft",source:"heal",createdAt:${AT}}])`,
    "America/New_York",
  );
  assert.match(html, /data-testid="versions"/);
  assert.match(html, /data-role="live"/);
  assert.match(html, /data-role="draft"/);
  assert.match(html, /Restore as draft/);
  assert.match(html, /Promote/);
  assert.match(html, /Oct 22, 12:50 AM EDT/);
  assert.match(html, /data-testid="locator-history"/);
  assert.match(html, /data-locator-source="recorded"/);
  assert.equal(html.includes("4:50 AM"), false);
  assert.equal(html.includes("UTC"), false);
  assert.equal(html.includes("2026-10-22T"), false);
  assert.equal(versionsPanel([{ n: 1, role: "live", source: "saved", createdAt: AT }]).includes("data-testid=\"version-time\""), true);
});

function zoned(compiled: string, call: string, tz: string): string {
  const result = spawnSync(process.execPath, ["-e", `process.stdout.write(String(require(${JSON.stringify(compiled)}).${call}))`], {
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
