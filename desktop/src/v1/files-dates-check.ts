// Pure checks for the files-dates revision. No Node builtins, so the window bundle can validate.
import { resolveRelative, zoneOk } from "./dates";
import type { WorkflowV2 } from "./schema";

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export function filesDatesErrors(doc: WorkflowV2): string[] {
  const errors: string[] = [];
  const outputs = new Map<string, number>();
  doc.steps.forEach((step, index) => {
    if (step.action === "download") {
      const download = step.download;
      if (!NAME_RE.test(download.output) || !download.name) errors.push(`download ${step.id}`);
      else if (/[\\/]|\.\./.test(download.name)) errors.push(`download name ${step.id}`);
      else outputs.set(download.output, index);
    }
    if (step.action === "open") {
      const open = step.open;
      if (open.target === "url" && !open.url) errors.push(`open url ${step.id}`);
      else if (open.target === "file" && !open.file) errors.push(`open file ${step.id}`);
    }
    if (step.action === "pickDate") {
      const input = doc.inputs.find((item) => item.name === step.date.input);
      if (!input || input.type !== "date") errors.push(`pickDate ${step.id}`);
      if (step.date.endInput) {
        const end = doc.inputs.find((item) => item.name === step.date.endInput);
        if (!end || end.type !== "date") errors.push(`pickDate end ${step.id}`);
      }
    }
    const bound = step.action === "upload" || step.action === "drop"
      ? ("fromOutput" in step.file ? step.file.fromOutput : undefined)
      : undefined;
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

