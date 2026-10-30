// Deliberately bad intent texts. Scored with the existing judge rubric.
// These are not added to the calibration labels, and the rubric is not changed.
// Each text is paired with the step it claims to describe, so the lint can
// check the target, the verb, and a secret or param literal.

import type { LintTarget } from "../intent/lint";
import { JUDGE_RUBRIC, type HandLabel } from "../intent/labels";

export interface BadIntent extends HandLabel {
  target: LintTarget;
  secrets?: string[];
}

export const BAD_INTENT_TEXTS: BadIntent[] = [
  { id: "b1", kind: "step", good: false, text: "Click button.", target: { action: "click", role: "button", name: "Save", label: "Save" } },
  { id: "b2", kind: "step", good: false, text: "Click the button.", target: { action: "click", role: "button", name: "Save", label: "Save" } },
  { id: "b3", kind: "step", good: false, text: "Do the thing.", target: { action: "click", role: "button", name: "Save", label: "Save" } },
  {
    id: "b4",
    kind: "step",
    good: false,
    text: "Type HeldOutDemoSecret! into the password field.",
    target: { action: "type", role: "textbox", name: "password", label: "password", input: "password" },
    secrets: ["HeldOutDemoSecret!"],
  },
  {
    id: "b5",
    kind: "step",
    good: false,
    text: "Type pin-9999 to unlock the account.",
    target: { action: "type", role: "textbox", name: "pin", label: "pin", input: "pin" },
    secrets: ["pin-9999"],
  },
  {
    id: "b6",
    kind: "step",
    good: false,
    text: "Type SuperSecretPassword! and log in.",
    target: { action: "type", role: "textbox", name: "password", label: "password", input: "password" },
    secrets: ["SuperSecretPassword!"],
  },
  {
    id: "b7",
    kind: "step",
    good: false,
    text: "Delete the search field.",
    target: { action: "type", role: "textbox", name: "search", label: "search", input: "query" },
  },
  {
    id: "b8",
    kind: "step",
    good: false,
    text: "Uncheck subscribe and clear the form.",
    target: { action: "type", role: "textbox", name: "subscribe", label: "subscribe", input: "note" },
  },
  {
    id: "b9",
    kind: "step",
    good: false,
    text: "Type Ada Lovelace into the search box.",
    target: { action: "type", role: "textbox", name: "search", label: "search", input: "query", literal: "Ada Lovelace" },
  },
  { id: "b10", kind: "step", good: false, text: "Open the Help menu.", target: { action: "click", role: "button", name: "Help", label: "Help" } },
];

// Same rubric as calibration. The example uses these ids. The shared
// calibration prompt's example is l1/l2, and the first held-out call followed
// that example instead of b1-b10.
export function badJudgePrompt(texts: readonly { id: string; kind: string; text: string }[] = BAD_INTENT_TEXTS): string {
  const lines = texts.map((label) => `${label.id} ${label.kind}: ${label.text}`);
  const first = texts[0]?.id || "b1";
  const second = texts[1]?.id || "b2";
  return [
    "Score each intent text.",
    JUDGE_RUBRIC,
    `Reply with JSON only: {"${first}":true,"${second}":false}. true means good. Use these ids.`,
    ...lines,
  ].join("\n");
}
