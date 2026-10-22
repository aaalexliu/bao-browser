import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { loadState, restoreScheduledBackup, revealBackup, runScheduledBackup, saveState } from "../../src/v1/sync";

const DAY = 24 * 60 * 60 * 1000;

function workflow(): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id: "wf-backup",
    name: "Backup me",
    startUrl: "https://example.com/fixture",
    createdAt: 1,
    inputs: [],
    steps: [{
      id: "s0",
      index: 0,
      action: "click",
      label: "Open",
      surface: "dom",
      identity: { surface: "dom", role: "button", path: [], testId: "go" },
      timeoutMs: 1000,
    }],
  };
}

test("a daily backup file appears and restores the workflow", () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-backup-"));
  const library = new Library(home);
  library.save(workflow());
  library.updateSettings({ backupSchedule: "daily" });
  const now = Date.parse("2026-10-22T04:50:16.442Z");
  const first = runScheduledBackup(library, now);
  assert.equal(first.ran, true);
  assert.ok(first.path);
  const saved = path.join(first.path || "", "workflows", "wf-backup.json");
  assert.equal(existsSync(saved), true);
  assert.match(readFileSync(saved, "utf8"), /Backup me/);
  const state = loadState(home);
  assert.equal(state.lastBackupAt, new Date(now).toISOString());
  assert.equal(state.scheduledBackupPath, first.path);

  assert.equal(runScheduledBackup(library, now + DAY - 1000).ran, false);
  library.remove("wf-backup");
  assert.throws(() => library.read("wf-backup"));
  restoreScheduledBackup(library);
  assert.equal(library.read("wf-backup").name, "Backup me");

  const next = runScheduledBackup(library, now + DAY);
  assert.equal(next.ran, true);
  assert.notEqual(next.path, first.path);
  assert.equal(existsSync(path.join(next.path || "", "workflows", "wf-backup.json")), true);

  assert.equal(revealBackup(library), next.path);
  const moved = loadState(home);
  moved.scheduledBackupPath = "/tmp/not-ours";
  saveState(home, moved);
  assert.throws(() => revealBackup(library), /bad backup path/);
});
