export const KEY_EVENTS: Record<string, { code: string; keyCode: number; text: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9, text: "" },
  Escape: { code: "Escape", keyCode: 27, text: "" },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37, text: "" },
  ArrowUp: { code: "ArrowUp", keyCode: 38, text: "" },
  ArrowRight: { code: "ArrowRight", keyCode: 39, text: "" },
  ArrowDown: { code: "ArrowDown", keyCode: 40, text: "" },
  Backspace: { code: "Backspace", keyCode: 8, text: "" },
  Delete: { code: "Delete", keyCode: 46, text: "" },
  Space: { code: "Space", keyCode: 32, text: " " },
  Home: { code: "Home", keyCode: 36, text: "" },
  End: { code: "End", keyCode: 35, text: "" },
  PageUp: { code: "PageUp", keyCode: 33, text: "" },
  PageDown: { code: "PageDown", keyCode: 34, text: "" },
};

const MODIFIERS: Record<string, string> = { meta: "Meta", cmd: "Meta", control: "Control", ctrl: "Control", alt: "Alt", shift: "Shift" };

export function canonicalKey(key: string): string {
  const parts = key.split("+");
  const raw = parts.pop() || "";
  const name = raw === " " ? "Space" : raw.toLowerCase() === "return" ? "Enter"
    : raw.length === 1 ? raw : Object.keys(KEY_EVENTS).find((name) => name.toLowerCase() === raw.toLowerCase()) || raw;
  return [...parts.map((part) => MODIFIERS[part.toLowerCase()] || part), name].join("+");
}

export function keyMayInsertText(key: string): boolean {
  const parts = canonicalKey(key).split("+");
  const name = parts.pop() || "";
  return (name.length === 1 || name === "Space") && !parts.includes("Meta") && (!parts.includes("Control") || parts.includes("Alt"));
}
