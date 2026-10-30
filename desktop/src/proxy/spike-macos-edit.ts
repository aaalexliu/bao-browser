// One TextEdit typing step. The document must be a new Untitled window.
// A restored document aborts this case without reading its value.

import path from "node:path";
import type { Workflow } from "../../../src/types";
import { AuditTrail } from "./audit";
import { MacOsExecutor } from "./macos-exec";
import { replayOsWorkflow, replayUsedCoordinates } from "./macos-replay";
import { handleComputerCall } from "./openai";
import { targetFrom, type MacOsHelper, type AxNode } from "./os-macos";
import {
  artifactsDir, EDIT_BUNDLE, TEXTEDIT_AUTOSAVE, cleanupNewAutosave, launchIfDown,
  namesIn, quitOwned, sleep, workDir,
} from "./spike-macos-host";

const TEXT = "bao mac spike";

function windowTitles(nodes: AxNode[]): string[] {
  return nodes.filter((n) => n.role === "AXWindow").map((n) => n.title || n.name).filter(Boolean);
}

function textValue(nodes: AxNode[]): string {
  const area = nodes.find((n) => n.role === "AXTextArea" || n.role === "AXTextField");
  return area?.value ?? "";
}

async function waitUntitled(helper: MacOsHelper): Promise<AxNode[]> {
  for (let i = 0; i < 20; i++) {
    const tree = await helper.nodes(EDIT_BUNDLE);
    const nodes = tree.nodes ?? [];
    const titles = windowTitles(nodes);
    const foreign = titles.find((title) => title !== "Open" && !/^Untitled( \d+)?$/.test(title));
    if (foreign) throw new Error(`restored document ${foreign}; aborting without reading it`);
    if (titles.includes("Open")) {
      const create = nodes.find((n) => n.role === "AXButton" && n.name === "New Document" && n.actions.includes("AXPress"));
      if (!create) throw new Error("TextEdit open panel has no New Document button");
      await helper.press(targetFrom(create, { w: 0, h: 0 }));
      await sleep(400);
      continue;
    }
    if (titles.length > 0) return nodes;
    await sleep(250);
  }
  throw new Error("TextEdit opened no window");
}

export async function runTextEdit(helper: MacOsHelper): Promise<Record<string, unknown>> {
  const before = await namesIn(TEXTEDIT_AUTOSAVE);
  const owned = await launchIfDown("TextEdit", "TextEdit");
  if (owned == null) {
    return { skipped: true, reason: "TextEdit was already running" };
  }
  let pid = owned;
  try {
    const nodes = await waitUntitled(helper);
    await helper.shot(EDIT_BUNDLE, path.join(artifactsDir(), "textedit-before.png"));
    await helper.focusRole(EDIT_BUNDLE, "AXTextArea");
    const trail = new AuditTrail();
    const executor = new MacOsExecutor(trail, helper, EDIT_BUNDLE, workDir());
    await handleComputerCall({
      type: "computer_call",
      call_id: "edit-type",
      actions: [{ type: "type", text: TEXT }],
      status: "completed",
    }, executor);
    const recorded = textValue((await helper.nodes(EDIT_BUNDLE)).nodes ?? []);
    await helper.shot(EDIT_BUNDLE, path.join(artifactsDir(), "textedit-recorded.png"));
    const workflow: Workflow = executor.workflow(`os://${EDIT_BUNDLE}`);
    await quitOwned(pid, "TextEdit");
    pid = 0;
    await cleanupNewAutosave(before);
    const next = await launchIfDown("TextEdit", "TextEdit");
    if (next == null) throw new Error("TextEdit was still running after quit");
    pid = next;
    await sleep(600);
    await waitUntitled(helper);
    await helper.focusRole(EDIT_BUNDLE, "AXTextArea");
    const mark = helper.calls.length;
    const replay = await replayOsWorkflow(helper, workflow);
    const replayed = textValue((await helper.nodes(EDIT_BUNDLE)).nodes ?? []);
    await helper.shot(EDIT_BUNDLE, path.join(artifactsDir(), "textedit-replay.png"));
    return {
      recorded,
      replayed,
      pass: recorded === TEXT && replayed === TEXT,
      pressed: replay.pressed,
      coordinateReplay: replayUsedCoordinates(helper.calls.slice(mark)),
      sawWindow: windowTitles(nodes),
      workflow,
      trail: trail.events,
    };
  } finally {
    if (pid) await quitOwned(pid, "TextEdit");
    await cleanupNewAutosave(before);
  }
}
