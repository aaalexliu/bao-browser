import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getRun } from "../../src/mcp/catalog";
import type { RecordedAgentBrowserCommand } from "../../src/engines/agent-browser-record";
import { Library, type StoredRun } from "../../src/v1/store";

const command: RecordedAgentBrowserCommand = {
  id: "command-1", label: 'click "@e7"', caption: { text: "Click Milk" }, status: "passed", startedAt: 1, endedAt: 2,
  target: { rect: { x: 10, y: 20, width: 30, height: 40 }, viewport: { width: 800, height: 600 } },
  native: { command: "click", args: ["@e7"], results: [{ stdout: "Clicked Milk\n", stderr: "native detail", exitCode: 0 }], isError: false, screenshots: [] },
};
const capture: StoredRun = {
  schema: "bao.run/v4",
  id: "run-capture", kind: "capture", workflowId: "agent-browser", status: "recording", at: 1, heals: [], steps: [command],
};

test("get_run leaves saved-workflow receipts and links unchanged", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-replay-status-"));
  try {
    const library = new Library(root);
    library.saveRun({ ...capture, kind: "replay", workflowId: "groceries", status: "passed" });
    const result = getRun(library, capture.id);
    assert.equal(result.outcome, "ok");
    assert.equal(result.status, "passed");
    assert.equal(result.link, "bao://workflow/groceries");
    assert.deepEqual(result.receipts, [{ id: command.id, status: "passed", readBack: "" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
