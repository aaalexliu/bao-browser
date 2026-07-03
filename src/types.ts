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
  bbox?: { x: number; y: number; w: number; h: number };
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

export type StepAction = "click" | "input" | "select" | "navigate" | "softNav" | "waitForUser";

export interface Step {
  action: StepAction;
  label: string;
  ts: number;
  seq?: string;
  frame?: FrameRef;
  // click / input / select
  target?: Target;
  value?: string;
  mode?: "contenteditable";
  // navigate (full-document, SW-recorded)
  url?: string;
  wait?: { type: "navigation" };
  // softNav (SPA route change, content-recorded)
  urlAfter?: string;
  urlPattern?: string;
}

// ---------- replay results ----------
export interface StepResult {
  i: number;
  ok: boolean;
  via?: string;
  reason?: string;
  frameId?: number;
  url?: string;
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

export type RunPhase = "executing" | "awaiting_nav" | "paused_for_user" | "done" | "failed";

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
  // popup/SW → content
  | { cmd: "start-record" }
  | { cmd: "stop-record" }
  | { cmd: "status" }
  | { cmd: "replay"; steps: Step[] };
