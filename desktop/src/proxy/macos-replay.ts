// Replay a macOS OS-plane workflow by accessibility lookup.
// press and set-value take role and name. They do not take x or y.

import path from "node:path";
import { resolveHome } from "../home";
import type { Workflow } from "../../../src/types";
import { bundledWindowVideoApp, openOsReplayVideo } from "../v1/replay-video";
import type { MacOsHelper } from "./os-macos";

function isTextRole(role: string): boolean {
  return role === "AXTextArea" || role === "AXTextField" || role === "AXTextView" || role === "AXSearchField" || role === "AXComboBox";
}

export async function replayOsWorkflow(
  helper: MacOsHelper,
  workflow: Workflow,
  between?: () => Promise<void>,
): Promise<{ pressed: number; skipped: number; video?: string }> {
  let pressed = 0;
  let skipped = 0;
  const bundle = workflow.steps.find((step) => step.os?.target.app)?.os?.target.app;
  const dest = path.join(resolveHome(), "videos", `os-${Date.now().toString(36)}.webm`);
  let video: Awaited<ReturnType<typeof openOsReplayVideo>> | undefined;
  let recorded: { wrote: boolean } | undefined;
  if (bundle && bundledWindowVideoApp() && process.env.BAO_REPLAY_VIDEO !== "0") {
    try {
      const info = await helper.windows(bundle) as { pid?: number };
      if (info.pid) video = await openOsReplayVideo(info.pid, dest);
    } catch { /* the target app is not a single window */ }
  }
  try {
  for (const step of workflow.steps) {
    if (step.unresolved || !step.os || step.surface !== "os") {
      skipped++;
      continue;
    }
    if (step.action === "osClick") {
      if (isTextRole(step.os.target.role)) await helper.focusRole(step.os.target.app, step.os.target.role, step.os.target.name);
      else await helper.press(step.os.target);
      pressed++;
      if (between) await between();
      continue;
    }
    if (step.action === "osKey") {
      const combo = step.os.key || step.os.target.name;
      if (!combo) throw new Error("osKey has no combo");
      await helper.key(step.os.target.app, combo);
      pressed++;
      if (between) await between();
      continue;
    }
    if (step.action === "osSetValue") {
      if (step.os.value == null) throw new Error(`osSetValue "${step.label}" has no value`);
      await helper.setValue(step.os.target, step.os.value);
      pressed++;
      if (between) await between();
      continue;
    }
    skipped++;
  }
  } finally {
    recorded = await video?.stop();
  }
  return { pressed, skipped, ...(recorded?.wrote ? { video: dest } : {}) };
}

/** True when a replay command carried a coordinate flag. That is a fail. */
export function replayUsedCoordinates(calls: string[][]): boolean {
  return calls.some((args) => {
    const cmd = args[0];
    if (cmd !== "press" && cmd !== "set-value" && cmd !== "read" && cmd !== "key") return false;
    return args.includes("--x") || args.includes("--y");
  });
}
