// Teach corrections in the intent-case shape the harness loads.
// INTENT_CASES stays the hand-written set. These files are the labelled
// corrections: events, human marks, and the corrected workflow.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { TeachIntentCase } from "../../v1/teach";

export type { TeachIntentCase };

export function loadTeachIntentCases(dir: string): TeachIntentCase[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    const doc = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as TeachIntentCase;
    if (doc.schema !== "bao.intent-case/v1") throw new Error(`intent case ${name}`);
    if (!doc.id || !doc.name || !doc.startUrl) throw new Error(`intent case ${name}`);
    if (!Array.isArray(doc.events) || !Array.isArray(doc.human) || !Array.isArray(doc.replays)) {
      throw new Error(`intent case ${name}`);
    }
    if (!Array.isArray(doc.secrets) || !Array.isArray(doc.secretIds) || !Array.isArray(doc.nodes)) {
      throw new Error(`intent case ${name}`);
    }
    if (!doc.workflow || !Array.isArray(doc.decisions)) throw new Error(`intent case ${name}`);
    return doc;
  });
}
