// Pure checks for the files-dates revision. No Node builtins, so the window bundle can validate.
import { resolveRelative, zoneOk } from "./dates";
import type { WorkflowV2 } from "./schema";

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export function filesDatesErrors(doc: WorkflowV2): string[] {
  const errors: string[] = [];
  const uses = usesFilesDates(doc);
  if (uses) {
    if (doc.version !== 3) errors.push("filesDates version");
    if (doc.filesDates !== 1) errors.push("filesDates");
  } else if (doc.filesDates != null) {
    errors.push("filesDates");
  }
  const outputs = new Map<string, number>();
  doc.steps.forEach((step, index) => {
    if (step.action === "download") {
      if (!step.download || !NAME_RE.test(step.download.output) || !step.download.name) errors.push(`download ${step.id}`);
      else if (/[\\/]|\.\./.test(step.download.name)) errors.push(`download name ${step.id}`);
      else outputs.set(step.download.output, index);
    }
    if (step.action === "open") {
      if (!step.open) errors.push(`open ${step.id}`);
      else if (step.open.target === "url" && !step.open.url) errors.push(`open url ${step.id}`);
      else if (step.open.target === "file" && !step.open.file) errors.push(`open file ${step.id}`);
    }
    if (step.datePicker) {
      const input = doc.inputs.find((item) => item.name === step.datePicker?.input);
      if (!input || input.type !== "date") errors.push(`datePicker ${step.id}`);
      if (step.datePicker.endInput) {
        const end = doc.inputs.find((item) => item.name === step.datePicker?.endInput);
        if (!end || end.type !== "date") errors.push(`datePicker end ${step.id}`);
      }
    }
    const bound = step.fileFrom;
    if (bound) {
      const at = outputs.get(bound);
      if (at == null || at >= index) errors.push(`fileFrom ${step.id}`);
    }
  });
  for (const input of doc.inputs) {
    if (input.type === "date") {
      if (input.relative) {
        try {
          resolveRelative(input.relative, { y: 2026, m: 1, d: 1 });
        } catch {
          errors.push(`date ${input.name}`);
        }
      }
      if (input.format === "") errors.push(`date format ${input.name}`);
      if (input.zone && !zoneOk(input.zone)) errors.push(`date zone ${input.name}`);
    }
    if (input.fromOutput && !outputs.has(input.fromOutput)) errors.push(`fromOutput ${input.name}`);
  }
  return errors;
}

export function usesFilesDates(doc: WorkflowV2): boolean {
  if (doc.inputs.some((input) => input.type === "date" || input.fromOutput || input.relative || input.format)) return true;
  return doc.steps.some((step) => step.action === "download" || step.action === "open" || step.datePicker || step.fileFrom || step.download || step.open);
}
