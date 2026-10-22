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

/** Crop around the target. Padding, then center. The element stays fully in frame. */
export function paddedClip(box: ShotBox, view: { width: number; height: number }, pad = 32): ShotBox {
  const viewW = Math.max(1, Math.round(view.width));
  const viewH = Math.max(1, Math.round(view.height));
  const minW = Math.min(240, viewW);
  const minH = Math.min(140, viewH);
  let width = Math.min(viewW, Math.max(box.width + pad * 2, minW));
  let height = Math.min(viewH, Math.max(box.height + pad * 2, minH));
  if (box.width <= viewW) width = Math.min(viewW, Math.max(width, box.width));
  else width = viewW;
  if (box.height <= viewH) height = Math.min(viewH, Math.max(height, box.height));
  else height = viewH;

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
