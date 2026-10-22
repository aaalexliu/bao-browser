// Agreement between a person's labels and the intent judge.
// The sheet at docs/evals/judge-labels.md has an empty Label column until
// someone fills good or bad. This file does not write that column.

import { readFileSync } from "node:fs";
import { JUDGE_RUBRIC } from "./intent/labels";
import { complete, parseFlagMap } from "./intent/model";

export interface SheetRow {
  id: string;
  intent: string;
  label: "" | "good" | "bad";
}

export function parseJudgeSheet(markdown: string): SheetRow[] {
  const rows: SheetRow[] = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 3) continue;
    const id = cells[0] || "";
    if (!/^j\d+$/.test(id)) continue;
    const label = (cells[2] || "").toLowerCase();
    if (label !== "" && label !== "good" && label !== "bad") {
      throw new Error(`${id} label must be good, bad, or empty`);
    }
    rows.push({ id, intent: cells[1] || "", label });
  }
  return rows;
}

export function agreementRate(pairs: { human: boolean; judge: boolean }[]): { n: number; agree: number; rate: number } {
  const agree = pairs.filter((pair) => pair.human === pair.judge).length;
  const n = pairs.length;
  return { n, agree, rate: n ? agree / n : 0 };
}

export function unlabeled(rows: readonly SheetRow[]): SheetRow[] {
  return rows.filter((row) => row.label === "");
}

export async function judgeSheet(rows: readonly SheetRow[]): Promise<Record<string, boolean>> {
  const lines = rows.map((row) => `${row.id} step: ${row.intent}`);
  const prompt = [
    "Score each intent text.",
    JUDGE_RUBRIC,
    "Reply with JSON only: {\"j01\":true}. true means good. Use these ids.",
    ...lines,
  ].join("\n");
  const reply = await complete(prompt);
  return parseFlagMap(reply.text);
}

export async function runJudgeAgree(sheetPath: string): Promise<{ code: number; text: string }> {
  const rows = parseJudgeSheet(readFileSync(sheetPath, "utf8"));
  const open = unlabeled(rows);
  if (!rows.length) return { code: 2, text: `No rows in ${sheetPath}.` };
  if (open.length) {
    return {
      code: 2,
      text: `${rows.length - open.length}/${rows.length} labels filled. The Label column in ${sheetPath} is still empty for ${open.map((row) => row.id).join(", ")}.`,
    };
  }
  const judged = await judgeSheet(rows);
  const pairs = rows.map((row) => ({ human: row.label === "good", judge: judged[row.id] === true }));
  const missing = rows.filter((row) => !Object.prototype.hasOwnProperty.call(judged, row.id)).map((row) => row.id);
  const score = agreementRate(pairs);
  const pct = (score.rate * 100).toFixed(1);
  const lines = [
    `Agreement ${score.agree}/${score.n} (${pct}%).`,
    missing.length ? `Judge omitted ${missing.join(", ")}.` : "",
  ].filter(Boolean);
  return { code: 0, text: lines.join(" ") };
}
