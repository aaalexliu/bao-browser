// Shared step schema used by desktop capture, proxy replay, and OS adapters.

// ---------- selectors & targets (capture output, resolution input) ----------
export type SelectorType = "testid" | "aria" | "text" | "id" | "css" | "shadowpath" | "ax";

export interface Selector {
  type: SelectorType;
  value: string;
  score: number;
}

// How reachable the captured element was — drives graceful degrade.
export type Reach = "light" | "open-shadow" | "canvas" | "opaque-custom" | "closed-shadow" | "os";

// The nearest uniquely-identifiable ancestor of an ambiguous target.
export type AnchorDescriptor =
  | { kind: "selector"; value: string }
  | { kind: "href"; id: string }
  | { kind: "text"; id: string };

// How to find the target *within* its anchor's subtree.
export interface WithinDescriptor {
  role: string | null;
  name: string;
  index: number;
  attr?: { attr: string; value: string };
  rel?: string;
}

export interface Target {
  selectors: Selector[];
  reach: Reach;
  unique: boolean;
  degraded?: boolean;
  // Per-target grounding (T11), captured on EVERY step as self-healing fuel. bbox is
  // stored viewport-relative (x/y/w/h as % of the viewport, one decimal) so it survives
  // a resize; vw/vh are the capture-time viewport pixels, enough to derive a crop from
  // a full-frame screenshot (fullFrame ✂ bbox). text/role are unused at replay today.
  bbox?: { x: number; y: number; w: number; h: number; vw: number; vh: number };
  text?: string;
  role?: string | null;
  // Tier-2 (T13): outerHTML of the anchor node (or a ~3-hop ancestor when unanchored),
  // value-attributes stripped, capped at 64KB. Offline anchor re-derivation fuel.
  snapshot?: string;
  scroll?: { container: string };
  anchor?: AnchorDescriptor;
  within?: WithinDescriptor;
}

// ---------- steps ----------
// Which frame a step was captured in. frameId/url are stamped on by the SW from
// `sender` (authoritative); origin/top come from the content script.
/** Which tab a desktop step belongs to. CDP targetId is intentionally absent — it changes every run. */
export interface TabHint {
  index: number;
  openerIndex?: number;
  urlPattern?: string;
}

export interface FrameRef {
  url?: string;
  origin?: string;
  top?: boolean;
  frameId?: number;
  // Desktop only. The extension's frameId stays the Chrome-extension id.
  tab?: TabHint;
}

// Browser and OS actions used by the desktop adapters.
export type StepSurface = "dom" | "browser" | "os";

export type StepAction =
  | "click" | "input" | "select" | "setChecked" | "keypress" | "submit"
  | "assert" | "navigate" | "softNav" | "waitForUser"
  | "uploadFile" | "switchTab" | "handleDialog"
  | "osClick" | "osType" | "osKey" | "osSetValue" | "osConfirm";

/** A file the workflow names. Never an absolute path on the author's machine. */
export interface UploadRef {
  name: string;
  names?: string[];
  accept?: string;
}

export interface BrowserDialog {
  kind: "alert" | "confirm" | "prompt" | "beforeunload";
  action: "accept" | "dismiss";
  promptText?: string;
}

export type OsPlatform = "macos" | "windows" | "linux";
export type OsDialogKind = "open" | "save" | "print" | "auth" | "permission" | "other";

export interface OsTarget {
  platform: OsPlatform;
  app: string;
  role: string;
  name: string;
  path: { role: string; name?: string }[];
  bbox?: { x: number; y: number; w: number; h: number; sw: number; sh: number };
  dialog?: OsDialogKind;
  // macOS AX. Absent on Linux AT-SPI workflows.
  subrole?: string;
  title?: string;
  description?: string;
  identifier?: string;
}

// QA expectations (T6): checked at replay, recorded pass/fail, without acting.
export type AssertKind = "textPresent" | "elementVisible" | "elementAbsent" | "urlMatches";

export interface Step {
  action: StepAction;
  label: string;
  ts: number;
  seq?: string;
  // Stable IR identity within a saved Workflow (T14). Assigned at save time.
  id?: string;
  index?: number;
  frame?: FrameRef;
  // click / input / select
  target?: Target;
  value?: string;
  mode?: "contenteditable";
  // A sensitive field (password / SSN / card / CVV / OTP).
  sensitive?: boolean;
  // setChecked (T3): the recorded end-state, replayed as SET not toggle
  checked?: boolean;
  // keypress (T4): a whitelisted key (Enter | Escape | Tab)
  key?: string;
  // click / keypress that caused a form submit (T4): replay ensures the submit fires
  submits?: boolean;
  // assert (T6): an expectation checked at replay, not an action
  assert?: { kind: AssertKind; value?: string };
  // navigate (full-document, SW-recorded)
  url?: string;
  wait?: { type: "navigation" };
  // click that triggers a browser download (T10): SW-correlated at record via
  // chrome.downloads.onCreated; replay waits for onChanged state:complete.
  download?: { filename?: string; id?: number };
  // softNav (SPA route change, content-recorded)
  urlAfter?: string;
  urlPattern?: string;
  // record-time frame grounding (T11): the viewport the step was captured in and when.
  // goldenScreenshotRef (T12) is an IndexedDB key for the full-viewport golden frame.
  meta?: { viewport: { w: number; h: number }; recordedAt: number; goldenScreenshotRef?: string };
  // --- desktop (all optional; absent on every workflow the extension writes) ---
  surface?: StepSurface;
  requires?: "trustedInput" | "fileUpload" | "closedShadow" | null;
  upload?: UploadRef;
  dialog?: BrowserDialog;
  os?: { target: OsTarget; value?: string; key?: string };
  // Proxy capture audit. The pixel the vendor asked for. Replay does not click it.
  // "viewport" is the page's CSS pixel. "image" is the screenshot the model saw,
  // which may be a scaled-down copy of that viewport. "screen" is an OS pixel.
  provenance?: { x: number; y: number; space: "viewport" | "image" | "screen" };
  // Hit-test missed an actionable element, or the action is not one this spike performs.
  // The step is stored so the miss is visible. Replay skips it.
  unresolved?: { reason: string };
}

// ---------- named workflows (T14): the durable IR wrapper ----------
// A recording becomes a first-class, named Workflow instead of an anonymous array
// under one storage key. `variables` is empty until M4 parameterization; `startUrl`
// lets replay land on the right page first.
export interface Workflow {
  id: string;
  name: string;
  version: number;
  startUrl: string;
  variables: string[];
  steps: Step[];
  createdAt: number;
  pinned?: boolean;    // T15: pin favorites to the top of the panel
  updatedAt?: number;  // T15: bumped on rename/pin; createdAt stays immutable
}
