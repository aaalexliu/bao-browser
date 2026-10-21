// Turn a live OS-plane trail into a workflow with inputs.
// Reads and unresolved clicks are dropped. A clear wipes the attempt before it.

import type { Step, Workflow } from "../../../src/types";
import { deriveWorkflow, trimTrail, type AuditEvent } from "./audit";

const CLEAR = /^(all clear|clear|delete|ac)$/i;

export interface InterpretResult {
  workflow: Workflow;
  kept: number;
  trimmed: number;
  unresolved: number;
  screenshots: number;
  misclicks: number;
}

export function interpretOs(events: readonly AuditEvent[], kind: "calc" | "textedit"): InterpretResult {
  const screenshots = events.filter((e) => e.kind === "read" && e.op === "screenshot").length;
  const unresolved = events.filter((e) => e.kind === "act" && e.unresolved).length;
  const start = kind === "calc" ? "os://com.apple.calculator" : "os://com.apple.TextEdit";
  const workflow = deriveWorkflow(trimTrail(events), start, {
    id: kind === "calc" ? "wf-live-calc" : "wf-live-edit",
    name: kind === "calc" ? "live calculator" : "live textedit",
  });
  const before = workflow.steps.length;
  let steps = workflow.steps.filter((step) => !step.unresolved);
  steps = trimClears(steps);
  if (kind === "textedit") {
    steps = keepLastValue(steps).filter((step) => step.action === "osSetValue");
  }
  parameterize(steps, kind);
  workflow.steps = steps.map((step, index) => ({ ...step, index, id: `${workflow.id}-${index}` }));
  workflow.variables = kind === "calc" ? ["a", "b"] : ["text"];
  return {
    workflow,
    kept: steps.length,
    trimmed: before - steps.length,
    unresolved,
    screenshots,
    misclicks: unresolved + clearedPresses(events),
  };
}

function trimClears(steps: Step[]): Step[] {
  let last = -1;
  steps.forEach((step, index) => {
    if (step.action === "osClick" && step.os && CLEAR.test(step.os.target.name)) last = index;
  });
  return last < 0 ? steps : steps.slice(last + 1);
}

function keepLastValue(steps: Step[]): Step[] {
  let last = -1;
  steps.forEach((step, index) => {
    if (step.action === "osSetValue") last = index;
  });
  if (last < 0) return steps;
  return steps.filter((step, index) => step.action !== "osSetValue" || index === last);
}

function parameterize(steps: Step[], kind: "calc" | "textedit"): void {
  if (kind === "textedit") {
    for (const step of steps) {
      if (step.action === "osSetValue" && step.os) {
        step.os.value = "{{text}}";
        // The window title flips between Untitled and Untitled.rtf. Match the text area by role and name.
        step.os.target.path = [];
      }
    }
    return;
  }
  let digits = 0;
  for (const step of steps) {
    if (!step.os) continue;
    if (step.action === "osClick" && /^[0-9]$/.test(step.os.target.name)) {
      digits += 1;
      if (digits === 1) step.os.target.name = "{{a}}";
      else if (digits === 2) step.os.target.name = "{{b}}";
    } else if (step.action === "osKey" && step.os.key && /^[0-9]$/.test(step.os.key)) {
      digits += 1;
      if (digits === 1) step.os.key = "{{a}}";
      else if (digits === 2) step.os.key = "{{b}}";
    }
  }
}

function clearedPresses(events: readonly AuditEvent[]): number {
  let n = 0;
  let pending = 0;
  for (const event of events) {
    if (event.kind !== "act" || event.unresolved || !event.os) continue;
    if (event.op === "osClick" && CLEAR.test(event.os.name)) {
      n += pending;
      pending = 0;
      continue;
    }
    if (event.op === "osClick" || event.op === "osKey") pending += 1;
  }
  return n;
}

export function bindWorkflow(workflow: Workflow, vars: Record<string, string>): Workflow {
  let raw = JSON.stringify(workflow);
  for (const [key, value] of Object.entries(vars)) {
    raw = raw.split(`{{${key}}}`).join(value);
  }
  return JSON.parse(raw) as Workflow;
}
