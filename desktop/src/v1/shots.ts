// Shot file names shared by replay and the window. No Node APIs, so the
// browser bundle can import this too.

export function shotFile(stepId: string, which: "before" | "after"): string {
  const safe = stepId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "step";
  return `${safe}-${which}.png`;
}

export function workflowShotName(stepId: string): string {
  return shotFile(stepId, "after").replace(/-after\.png$/, ".png");
}
