// Score the sealed fresh-bad file once. The kind labels in that file are the
// ground truth. This writer does not edit them.

import { readFileSync, writeFileSync } from "node:fs";
import { GOOD_INTENTS } from "../intent/good-intents";
import { prejudgeLint, type LintTarget } from "../intent/lint";

interface FreshIntent {
  id: string;
  kind: string;
  text: string;
  target?: LintTarget;
  secrets?: string[];
}

export function scoreFreshFile(inputPath: string, outPath: string): string {
  const doc = JSON.parse(readFileSync(inputPath, "utf8")) as { note: string; intents: FreshIntent[] };
  const rows = doc.intents.map((item) => {
    const lint = prejudgeLint({ text: item.text, target: item.target, secrets: item.secrets || [] });
    return { ...item, lint };
  });
  const caught = rows.filter((row) => row.lint === "step-mismatch");
  const any = rows.filter((row) => row.lint);
  const goods = GOOD_INTENTS.flatMap((item) => {
    const reason = prejudgeLint({ text: item.text, target: item.target, secrets: item.secrets || [] });
    return reason ? [`${item.id} ${reason}`] : [];
  });
  const lines = [
    "# Fresh known-bad intents",
    "",
    doc.note,
    "",
    `Step-mismatch caught ${caught.length}/${rows.length}. Any prejudge reason caught ${any.length}/${rows.length}. Good intents rejected: ${goods.length}/${GOOD_INTENTS.length}.`,
    "",
    "| id | kind | lint | text |",
    "| --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.id} | ${row.kind} | ${row.lint || ""} | ${row.text.replace(/\|/g, "/")} |`),
    "",
    goods.length ? `False rejects: ${goods.join(", ")}.` : "False rejects: none.",
    "",
  ];
  const markdown = lines.join("\n");
  writeFileSync(outPath, markdown);
  return markdown;
}
