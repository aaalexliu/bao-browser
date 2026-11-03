export interface LiveBlocker {
  role: string;
  text: string;
  region: { x: number; y: number; width: number; height: number };
  dismissRef?: string;
}

/** Page function. Diagnose a covered target without clicking through it or closing anything. */
export function readLiveBlocker(ask: { markIndex: number }): (Omit<LiveBlocker, "dismissRef"> & { dismissHandle?: string }) | null {
  const target = document.querySelector(`[data-bao-live="${ask.markIndex}"]`);
  if (!target) return null;
  const box = target.getBoundingClientRect();
  let hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  if (!hit || hit === target || target.contains(hit)) return null;
  const root = hit.closest('[role="status"], [role="alert"], [role="dialog"], [role="alertdialog"], dialog') || hit;
  const region = root.getBoundingClientRect();
  const candidates = Array.from(root.querySelectorAll('button, [role="button"]')).filter((el) => {
    if (root === document.body || root === document.documentElement || el.matches(':disabled, [aria-disabled="true"]')) return false;
    const label = el.getAttribute("aria-label") || el.textContent || "";
    if (!/^(?:(?:dismiss|close)(?: (?:notice|notification|dialog|popup|message|banner))?|[x×])$/i.test(label.trim())) return false;
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return r.width > 0 && r.height > 0 && !!top && (top === el || el.contains(top));
  });
  const dismissHandle = candidates.length === 1 ? candidates[0]!.getAttribute("data-bao-i") || undefined : undefined;
  return {
    role: /^(status|alert|dialog|alertdialog)$/.test(root.getAttribute("role") || "") ? root.getAttribute("role")! : root.tagName.toLowerCase(),
    text: (root.textContent || "").replace(/\s+/g, " ").trim(),
    region: { x: region.x, y: region.y, width: region.width, height: region.height },
    ...(dismissHandle ? { dismissHandle } : {}),
  };
}
