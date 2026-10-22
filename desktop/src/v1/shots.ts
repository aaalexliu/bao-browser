// Shot file names shared by replay and the window. No Node APIs, so the
// browser bundle can import this too.

export function shotFile(stepId: string, which: "before" | "after"): string {
  const safe = stepId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "step";
  return `${safe}-${which}.png`;
}

export function workflowShotName(stepId: string): string {
  return shotFile(stepId, "after").replace(/-after\.png$/, ".png");
}

export interface ShotBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Pad a target box so a thumbnail shows the control, not a shrunken page. */
export function paddedClip(box: ShotBox, view: { width: number; height: number }, pad = 32): ShotBox {
  const minW = 240;
  const minH = 140;
  const maxW = 560;
  const maxH = 360;
  const wide = box.width + pad * 2 > maxW;
  const tall = box.height + pad * 2 > maxH;
  let width = Math.min(view.width, Math.max(minW, Math.min(box.width + pad * 2, maxW)));
  let height = Math.min(view.height, Math.max(minH, Math.min(box.height + pad * 2, maxH)));
  let x = wide ? box.x : box.x + box.width / 2 - width / 2;
  let y = tall ? box.y : box.y + box.height / 2 - height / 2;
  x = Math.max(0, Math.min(x, Math.max(0, view.width - width)));
  y = Math.max(0, Math.min(y, Math.max(0, view.height - height)));
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}
