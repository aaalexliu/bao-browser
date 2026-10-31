import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openInspect, closeInspectTab } from "../../src/cdp-live/ax";
import { MacOsHelper, type AxHit } from "../../src/proxy/os-macos";

class RecordingHelper extends MacOsHelper {
  override exec(args: string[]): Promise<AxHit> {
    this.calls.push(args);
    return Promise.resolve({ ok: true });
  }
}

test("bundle keyboard and window commands keep their existing arguments", async () => {
  const helper = new RecordingHelper("unused");
  await helper.cgKey("com.google.Chrome", "cmd+t");
  await helper.cgType("com.google.Chrome", "about:blank");
  await helper.raiseWindow("com.google.Chrome", "New Tab - Google Chrome");
  assert.deepEqual(helper.calls, [
    ["cg-key", "--bundle", "com.google.Chrome", "--combo", "cmd+t"],
    ["cg-type", "--bundle", "com.google.Chrome", "--text", "about:blank"],
    ["raise-window", "--bundle", "com.google.Chrome", "--title", "New Tab - Google Chrome"],
  ]);
});

test("inspect open and close leave focus ownership to the pid-addressed helper", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bao-open-inspect-"));
  try {
    const helper = new RecordingHelper("unused");
    helper.exec = async (args) => {
      helper.calls.push(args);
      if (args[0] === "ae-open") return { ok: true, tabId: "tab-9", restored: 1, windowId: "window-4", frame: [10, 20, 800, 600] };
      if (args[0] === "ae-close") return { ok: true };
      throw new Error(`unexpected focus command ${args[0]}`);
    };
    assert.deepEqual(await openInspect(helper, path.join(dir, "ae.jsonl"), 5151), { windowId: "window-4", frame: [10, 20, 800, 600] });
    await closeInspectTab(helper, path.join(dir, "ae.jsonl"), 5151);
    assert.deepEqual(helper.calls, [
      ["ae-open", "--pid", "5151"],
      ["ae-close", "--pid", "5151", "--id", "tab-9", "--restore", "1", "--window-id", "window-4"],
    ]);
    await assert.rejects(closeInspectTab(helper, path.join(dir, "ae.jsonl"), 5151), /no inspect tab id/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
