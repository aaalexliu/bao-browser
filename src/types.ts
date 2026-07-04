// Bao — shared step schema. The one source of truth for what content.ts records,
// background.ts stores/routes, and popup.ts renders. Everything that crosses a
// chrome.runtime message boundary or lands in chrome.storage is typed here.

// ---------- selectors & targets (capture output, resolution input) ----------
export type SelectorType = "testid" | "aria" | "text" | "id" | "css" | "shadowpath";

export interface Selector {
  type: SelectorType;
  value: string;
  score: number;
}

// How reachable the captured element was — drives graceful degrade.
export type Reach = "light" | "open-shadow" | "canvas" | "opaque-custom";

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
export interface FrameRef {
  url?: string;
  origin?: string;
  top?: boolean;
  frameId?: number;
}

export type StepAction =
  | "click" | "input" | "select" | "setChecked" | "keypress" | "submit"
  | "assert" | "navigate" | "softNav" | "waitForUser";

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
}

// The lightweight shape the popup/harness lists (no step payloads).
export interface WorkflowSummary {
  id: string;
  name: string;
  startUrl: string;
  count: number;
  createdAt: number;
}

// ---------- replay results ----------
export interface StepResult {
  i: number;
  ok: boolean;
  via?: string;
  reason?: string;
  frameId?: number;
  url?: string;
  filename?: string; // completed download's basename (T10)
}

export interface ReplayResponse {
  ok: boolean;
  failedAt?: number;
  results: StepResult[];
}

// ---------- M1 storage state (SW-owned, rehydrated on every wake) ----------
export interface RecState {
  tabId: number;
  steps: Step[];
}

export type RunPhase =
  | "executing" | "awaiting_nav" | "awaiting_download" | "paused_for_user" | "done" | "failed";

export interface RunState {
  runId: string;
  tabId: number;
  steps: Step[];
  stepIndex: number;
  phase: RunPhase;
  dispatched: boolean;
  dispatchedAt?: number;
  results: StepResult[];
  lastError: { stepIndex: number; reason: string } | null;
  expectedNav?: { pattern: string; deadline: number };
  expectedDownload?: { deadline: number; filename?: string };
}

// ---------- runtime messages ----------
export type Msg =
  // content → SW
  | { cmd: "bao-reset" }
  | { cmd: "bao-frame-steps"; steps: Step[] }
  | { cmd: "bao-step"; step: Step }
  | { cmd: "bao-boot"; url: string; top: boolean }
  // popup/harness → SW
  | { cmd: "bao-rec-start"; tabId: number }
  | { cmd: "bao-rec-stop" }
  | { cmd: "bao-run-start"; tabId: number; steps: Step[] }
  | { cmd: "bao-run-status" }
  | { cmd: "bao-run-continue" }
  // named workflows (T14)
  | { cmd: "bao-wf-save"; name: string; startUrl: string; steps: Step[] }
  | { cmd: "bao-wf-list" }
  | { cmd: "bao-wf-delete"; id: string }
  | { cmd: "bao-wf-run"; tabId: number; id: string }
  // popup/SW → content
  | { cmd: "start-record" }
  | { cmd: "stop-record" }
  | { cmd: "status" }
  | { cmd: "replay"; steps: Step[] };
