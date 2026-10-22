// Ten hand labels for the intent judge. The good bit is the calibration key.
// The judge prompt does not receive it.

export interface HandLabel {
  id: string;
  kind: "step" | "summary";
  text: string;
  good: boolean;
}

export const JUDGE_RUBRIC = [
  "A text is good when it is one concrete sentence about the user action or the workflow goal, names the control or the outcome, and does not contain a password, pin, or other secret value.",
  "Naming a password or pin field is fine. Quoting the secret value is bad.",
  "A text is bad when it is empty, vague, treats Help as the goal, or contains a secret value.",
].join(" ");

export const HAND_LABELS: HandLabel[] = [
  { id: "l1", kind: "step", good: true, text: "Type the visitor's name into the Name field." },
  { id: "l2", kind: "step", good: true, text: "Click Save to store the form." },
  { id: "l3", kind: "step", good: false, text: "Type SuperSecretPassword! into the password box." },
  { id: "l4", kind: "step", good: false, text: "Open the Help menu." },
  { id: "l5", kind: "step", good: true, text: "Type {{city}} on the Address tab." },
  { id: "l6", kind: "step", good: false, text: "Click around the page." },
  { id: "l7", kind: "step", good: true, text: "Confirm deleting the item." },
  { id: "l8", kind: "step", good: true, text: "Type the pin into the pin field." },
  { id: "l9", kind: "step", good: false, text: "Type pin-9999 to unlock." },
  { id: "l10", kind: "summary", good: true, text: "Save the profile name and leave the page on Saved." },
];

export function calibrationPrompt(labels: readonly HandLabel[] = HAND_LABELS): string {
  const lines = labels.map((label) => `${label.id} ${label.kind}: ${label.text}`);
  return [
    "Score each intent text.",
    JUDGE_RUBRIC,
    "Reply with JSON only: {\"l1\":true,\"l2\":false}. true means good.",
    ...lines,
  ].join("\n");
}

export function caseJudgePrompt(summary: string, steps: { id: string; intent: string }[]): string {
  const lines = steps.map((step) => `${step.id}: ${step.intent}`);
  return [
    "Score this workflow summary and each step intent.",
    JUDGE_RUBRIC,
    "Reply with JSON only: {\"summary\":true,\"steps\":{\"step-id\":true}}.",
    `summary: ${summary || ""}`,
    ...lines,
  ].join("\n");
}
