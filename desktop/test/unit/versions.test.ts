import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { versionsPanel } from "../../src/app/views";
import { keepPatch, unavailableHeal } from "../../src/v1/heal";
import { replay, type Driver, type LiveTree } from "../../src/v1/replay";
import type { Identity, WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { draftVersion, listVersions, noteConflict, promoteVersion, restoreVersion } from "../../src/v1/versions";

const AT = Date.parse("2026-10-22T04:50:16.442Z");

function ident(partial: Partial<Identity>): Identity {
  return { surface: "dom", role: "button", path: [], ...partial };
}

function workflow(id: string, testId: string): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id,
    name: "Fixture",
    startUrl: "https://example.com/fixture",
    createdAt: 1,
    inputs: [],
    steps: [{
      id: "s0",
      index: 0,
      action: "click",
      label: "Click go",
      surface: "dom",
      identity: ident({ testId }),
      timeoutMs: 0,
      postcondition: { kind: "element", timeoutMs: 0 },
    }],
  };
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
  assert.equal(library.read("wf-versions").steps[0]?.identity?.testId, "v1");

  const live = library.read("wf-versions");
  const passed = await replay(live, {}, driver([ident({ testId: "v1" })]), { heal: unavailableHeal(), now: () => 1 });
  assert.equal(passed.status, "passed");
  assert.equal(library.read("wf-versions").steps[0]?.identity?.testId, "v1");

  const edited = { ...original, name: "Renamed", updatedAt: 2 };
  const edit = draftVersion(library, edited, "edit");
  assert.equal(edit.source, "edit");
  assert.equal(library.read("wf-versions").name, "Fixture");

  promoteVersion(library, "wf-versions", draft.n);
  assert.equal(library.read("wf-versions").steps[0]?.identity?.testId, "healed");
  const promotedReplay = await replay(library.read("wf-versions"), {}, driver([ident({ testId: "healed" })]), { heal: unavailableHeal(), now: () => 2 });
  assert.equal(promotedReplay.status, "passed");

  const restored = restoreVersion(library, "wf-versions", 1);
  assert.equal(restored.role, "draft");
  assert.equal(restored.source, "restore");
  assert.equal(restored.document.steps[0]?.identity?.testId, "v1");
  assert.equal(library.read("wf-versions").steps[0]?.identity?.testId, "healed");
  promoteVersion(library, "wf-versions", restored.n);
  assert.equal(library.read("wf-versions").steps[0]?.identity?.testId, "v1");
  const listed = listVersions(library, "wf-versions");
  assert.equal(listed.find((row) => row.n === restored.n)?.role, "live");
  assert.equal(listed.find((row) => row.n === 1)?.role, "past");
});

test("a version row names the step change and lists before and after", () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-version-diff-"));
  const library = new Library(home);
  const original = workflow("wf-diff", "signed-in");
  original.steps[0]!.label = "Click signed in";
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
  assert.equal(library.read("wf-diff").steps[0]?.identity?.testId, "signed-in");
});

test("a conflict draft names both Macs and leaves the live file alone", () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-conflict-"));
  const library = new Library(home);
  const mine = workflow("wf-conflict", "mine");
  mine.steps[0]!.label = "Click mine";
  library.save(mine);
  const theirs = workflow("wf-conflict", "theirs");
  theirs.steps[0]!.label = "Click theirs";
  noteConflict(library, {
    mine,
    theirs,
    mineDevice: "Home Mac",
    theirsDevice: "Ada's Mac",
    remoteVersion: 2,
  });
  assert.equal(library.read("wf-conflict").steps[0]?.label, "Click mine");
  const html = versionsPanel(listVersions(library, "wf-conflict"));
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
    { ...mine.steps[0]!, id: "one", label: "Open" },
    { ...mine.steps[0]!, id: "two", index: 1, label: "Save", identity: ident({ testId: "save" }) },
  ];
  library.save(mine);
  const theirs = workflow("wf-conflict-count", "open");
  theirs.steps = [
    { ...theirs.steps[0]!, id: "one", label: "Open Ada" },
    { ...theirs.steps[0]!, id: "two", index: 1, label: "Save", identity: ident({ testId: "save" }) },
  ];
  noteConflict(library, {
    mine,
    theirs,
    mineDevice: "Home Mac",
    theirsDevice: "Ada's Mac",
    remoteVersion: 2,
  });
  const html = versionsPanel(listVersions(library, "wf-conflict-count"));
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
  mine.steps[0]!.label = "Open";
  library.save(mine);
  const first = workflow("wf-cloud", "open");
  first.steps[0]!.label = "Open";
  const second = workflow("wf-cloud", "open");
  second.steps[0]!.label = "Open Ada";
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
