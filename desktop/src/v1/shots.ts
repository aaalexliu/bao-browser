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

/**
 * Crop around the target's own rect. Pad, then center.
 * The pad fits the 2px outline and its offset. A taller minimum pulls the next
 * control into the card, which is how a password step was showing Log in.
 */
export function paddedClip(box: ShotBox, view: { width: number; height: number }, pad = 8): ShotBox {
  const viewW = Math.max(1, Math.round(view.width));
  const viewH = Math.max(1, Math.round(view.height));
  const width = Math.min(viewW, Math.max(1, Math.round(box.width) + pad * 2));
  const height = Math.min(viewH, Math.max(1, Math.round(box.height) + pad * 2));

  let x = box.x + box.width / 2 - width / 2;
  let y = box.y + box.height / 2 - height / 2;
  if (box.width <= width) {
    x = Math.min(x, box.x);
    x = Math.max(x, box.x + box.width - width);
  } else {
    x = box.x;
  }
  if (box.height <= height) {
    y = Math.min(y, box.y);
    y = Math.max(y, box.y + box.height - height);
  } else {
    y = box.y;
  }
  x = Math.max(0, Math.min(x, viewW - width));
  y = Math.max(0, Math.min(y, viewH - height));
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}
