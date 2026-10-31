import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openInspect, closeInspectTab } from "../../src/cdp-live/ax";
import { REMOTE_CHECKBOX } from "../../src/cdp-live/consent";
import { MacOsHelper, type AxHit, type AxNode } from "../../src/proxy/os-macos";

function checkboxNode(): AxNode {
  return {
    role: "AXCheckBox", subrole: "", title: "", description: "", identifier: "",
    name: REMOTE_CHECKBOX, value: "0", actions: ["AXPress"], frame: null,
    path: [], pid: 5151, app: "com.google.Chrome", useful: true,
  };
}

class RecordingHelper extends MacOsHelper {
  nodesUntilCheckbox = 0;
  nodesSeen = 0;
  override exec(args: string[]): Promise<AxHit> {
    this.calls.push(args);
    if (args[0] === "nodes") {
      this.nodesSeen += 1;
      if (this.nodesSeen >= this.nodesUntilCheckbox) return Promise.resolve({ ok: true, nodes: [checkboxNode()] });
    }
    return Promise.resolve({ ok: true });
  }
}

test("cgKey, cgType, and raiseWindow pass --pid only when the caller knows one", async () => {
  const helper = new RecordingHelper("/tmp/bao-os-helper-test.app");
  await helper.cgKey("com.google.Chrome", "cmd+t");
  await helper.cgType("com.google.Chrome", "chrome://inspect/");
  await helper.raiseWindow("com.google.Chrome", "New Tab - Google Chrome");
  await helper.cgKey("com.google.Chrome", "cmd+l", 4242);
  await helper.cgType("com.google.Chrome", "remote-debugging", 4242);
  await helper.raiseWindow("com.google.Chrome", "New Tab - Google Chrome", 4242);
  await helper.cgKey("com.google.Chrome", "return", 4242, "session");
  assert.deepEqual(helper.calls, [
    ["cg-key", "--bundle", "com.google.Chrome", "--combo", "cmd+t"],
    ["cg-type", "--bundle", "com.google.Chrome", "--text", "chrome://inspect/"],
    ["raise-window", "--bundle", "com.google.Chrome", "--title", "New Tab - Google Chrome"],
    ["cg-key", "--bundle", "com.google.Chrome", "--combo", "cmd+l", "--pid", "4242"],
    ["cg-type", "--bundle", "com.google.Chrome", "--text", "remote-debugging", "--pid", "4242"],
    ["raise-window", "--bundle", "com.google.Chrome", "--title", "New Tab - Google Chrome", "--pid", "4242"],
    ["cg-key", "--bundle", "com.google.Chrome", "--combo", "return", "--pid", "4242", "--tap", "session"],
  ]);
});

test("openInspect sends an Apple Event to the Chrome pid and close uses that tab id", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bao-open-inspect-"));
  try {
    const helper = new RecordingHelper("/tmp/bao-os-helper-test.app");
    helper.exec = async (args) => {
      helper.calls.push(args);
      if (args[0] === "ae-open") return { ok: true, tabId: "tab-9", restored: 1 };
      return { ok: true };
    };
    await openInspect(helper, path.join(dir, "ae.jsonl"), 5151);
    await closeInspectTab(helper, path.join(dir, "ae.jsonl"), 5151);
    assert.deepEqual(helper.calls.filter((call) => call[0] === "ae-open" || call[0] === "ae-close"), [
      ["ae-open", "--pid", "5151"],
      ["ae-close", "--pid", "5151", "--id", "tab-9", "--restore", "1"],
    ]);
    assert.equal(helper.calls.some((call) => call[0] === "cg-key" || call[0] === "raise-window"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("openInspect activates the app make_tab covered, and close does it again if Chrome is still front", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bao-restore-front-"));
  try {
    const helper = new RecordingHelper("/tmp/bao-os-helper-test.app");
    let fronts = 0;
    helper.exec = async (args) => {
      helper.calls.push(args);
      if (args[0] === "ae-open") return { ok: true, tabId: "tab-9", restored: 1 };
      if (args[0] === "frontmost") {
        fronts += 1;
        return { ok: true, pid: fronts === 1 ? 75976 : 5151 };
      }
      return { ok: true };
    };
    await openInspect(helper, path.join(dir, "ae.jsonl"), 5151);
    await closeInspectTab(helper, path.join(dir, "ae.jsonl"), 5151);
    const restores = helper.calls.filter((call) => call[0] === "activate");
    assert.deepEqual(restores, [
      ["activate", "--pid", "75976"],
      ["activate", "--pid", "75976"],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
