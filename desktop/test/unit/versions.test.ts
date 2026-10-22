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
import { draftVersion, listVersions, promoteVersion, restoreVersion } from "../../src/v1/versions";

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
