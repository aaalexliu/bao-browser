/** Pure checks for the Chrome remote-debugging approval dialog. No AX calls. */

export const ALLOW_DIALOG_TITLE = "Allow remote debugging?";
export const ALLOW_BUTTON = "Allow";
export const REMOTE_CHECKBOX = "Allow remote debugging for this browser instance";
export const ALLOW_CLICK_WINDOW_MS = 180_000;

const BANNER = /controlled by automated test software/i;

export interface AxLike {
  role: string;
  name?: string;
  title?: string;
  value?: string;
  description?: string;
  path?: { role: string; name?: string }[];
}

export interface DialogShape {
  present: boolean;
  buttonCount: number;
  windowTitle: string;
}

export interface AllowClickInput {
  openedByBao: boolean;
  connectionStartedAt: number | null;
  now: number;
  dialogPresentBeforeConnect: boolean;
  dialog: { present: boolean; buttonCount: number };
}

function clean(value: string | undefined): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

function fields(node: AxLike): string[] {
  return [node.name, node.title, node.value, node.description].map(clean).filter(Boolean);
}

function exact(node: AxLike, text: string): boolean {
  return fields(node).some((value) => value === text);
}

export function dialogFromNodes(nodes: AxLike[]): DialogShape {
  const titleHit = nodes.some((node) => exact(node, ALLOW_DIALOG_TITLE));
  const buttons = nodes.filter((node) => node.role === "AXButton" && exact(node, ALLOW_BUTTON));
  const titled = nodes.find((node) => node.role === "AXWindow" && exact(node, ALLOW_DIALOG_TITLE));
  const any = nodes.find((node) => exact(node, ALLOW_DIALOG_TITLE));
  return {
    present: titleHit && buttons.length > 0,
    buttonCount: buttons.length,
    windowTitle: clean(titled?.name || titled?.title || any?.name || any?.title),
  };
}

/**
 * Click Allow only for the dialog that appeared after this process opened the socket.
 * A dialog that was already on screen, a second Allow button, or a stale timestamp stays unclicked.
 */
export function mayClickAllow(input: AllowClickInput): boolean {
  if (!input.openedByBao) return false;
  if (input.connectionStartedAt == null) return false;
  const age = input.now - input.connectionStartedAt;
  if (age < 0 || age > ALLOW_CLICK_WINDOW_MS) return false;
  if (input.dialogPresentBeforeConnect) return false;
  return input.dialog.present && input.dialog.buttonCount === 1;
}

export function checkboxFromNodes(nodes: AxLike[]): { found: boolean; value: string } {
  const box = nodes.find((node) => node.role === "AXCheckBox" && exact(node, REMOTE_CHECKBOX));
  return { found: !!box, value: clean(box?.value) };
}

export function checkboxOn(value: string): boolean {
  const text = value.trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes";
}

export function bannerFromNodes(nodes: AxLike[]): { visible: boolean; text: string } {
  const hit = nodes.find((node) => fields(node).some((value) => BANNER.test(value)));
  const text = hit ? fields(hit).find((value) => BANNER.test(value)) || "" : "";
  return { visible: !!hit, text: text.slice(0, 200) };
}

export interface AxSummary {
  count: number;
  roles: Record<string, number>;
  dialog: DialogShape;
  checkbox: { found: boolean; value: string };
  banner: { visible: boolean; text: string };
  matches: { role: string; name: string; title: string; value: string; window: string }[];
}

const EXACT_NAMES = new Set(["Allow", "Cancel", "Turn off in settings", "Allow sites"]);

function interesting(node: AxLike): boolean {
  const blob = fields(node).join(" ");
  if (/allow remote debugging|controlled by automated test software/i.test(blob)) return true;
  if (EXACT_NAMES.has(clean(node.name)) || EXACT_NAMES.has(clean(node.title))) return true;
  if (node.role === "AXSheet" || node.role === "AXDialog") return true;
  return false;
}

function windowLabel(node: AxLike): string {
  const named = node.path?.find((seg) => seg.role === "AXWindow")?.name || "";
  const title = clean(named) || (node.role === "AXWindow" ? clean(node.name || node.title) : "");
  if (!title) return "";
  if (/allow remote debugging/i.test(title)) return title.slice(0, 120);
  if (/inspect with chrome developer tools/i.test(title)) return "Inspect with Chrome Developer Tools";
  if (/^new tab/i.test(title)) return "New Tab";
  return "";
}

/** Dialog vocabulary only. Other window titles are counted in `roles` and then dropped. */
export function summarizeAx(nodes: AxLike[]): AxSummary {
  const roles: Record<string, number> = {};
  for (const node of nodes) roles[node.role || ""] = (roles[node.role || ""] || 0) + 1;
  const matches = nodes.filter(interesting).slice(0, 40).map((node) => ({
    role: node.role,
    name: clean(node.name).slice(0, 160),
    title: clean(node.title).slice(0, 160),
    value: clean(node.value).slice(0, 40),
    window: windowLabel(node),
  }));
  return {
    count: nodes.length,
    roles,
    dialog: dialogFromNodes(nodes),
    checkbox: checkboxFromNodes(nodes),
    banner: bannerFromNodes(nodes),
    matches,
  };
}

/** No window in the AX tree means the checkbox cannot be reached. Do not type into Chrome. */
export function checkboxReach(summary: { checkbox: { found: boolean }; roles: Record<string, number> }): "ready" | "open-inspect" | "stop" {
  if (summary.checkbox.found) return "ready";
  if ((summary.roles.AXWindow || 0) > 0) return "open-inspect";
  return "stop";
}

export function publishWindow(title: string): string {
  const text = clean(title);
  if (!text) return "";
  if (/allow remote debugging/i.test(text)) return text.slice(0, 120);
  if (/inspect with chrome developer tools/i.test(text)) return "Inspect with Chrome Developer Tools";
  if (/^new tab/i.test(text)) return "New Tab";
  return "other-chrome-window";
}
