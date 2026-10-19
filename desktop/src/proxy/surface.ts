// Which surface owns a screen pixel. A Chrome window is resolved against the
// DOM. Everything else is the OS accessibility tree.

export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function surfaceAt(x: number, y: number, chrome: readonly ScreenRect[]): "dom" | "os" {
  for (const rect of chrome) {
    if (x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h) return "dom";
  }
  return "os";
}
