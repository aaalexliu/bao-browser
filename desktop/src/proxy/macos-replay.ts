// Replay a macOS OS-plane workflow by accessibility lookup.
// press and set-value take role and name. They do not take x or y.

import type { Workflow } from "../../../src/types";
import type { MacOsHelper } from "./os-macos";

function isTextRole(role: string): boolean {
  return role === "AXTextArea" || role === "AXTextField" || role === "AXTextView" || role === "AXSearchField" || role === "AXComboBox";
}

export async function replayOsWorkflow(
  helper: MacOsHelper,
  workflow: Workflow,
  between?: () => Promise<void>,
): Promise<{ pressed: number; skipped: number }> {
  let pressed = 0;
  let skipped = 0;
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
  return { pressed, skipped };
}

/** True when a replay command carried a coordinate flag. That is a fail. */
export function replayUsedCoordinates(calls: string[][]): boolean {
  return calls.some((args) => {
    const cmd = args[0];
    if (cmd !== "press" && cmd !== "set-value" && cmd !== "read" && cmd !== "key") return false;
    return args.includes("--x") || args.includes("--y");
  });
}
