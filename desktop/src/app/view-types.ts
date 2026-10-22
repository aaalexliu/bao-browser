// Fields the run viewer and heal review render. Replay fills them.

export interface AttrCompare {
  attr: string;
  recorded: string;
  live: string;
  matched: boolean;
  points?: number;
}

export interface SnapshotNode {
  role?: string;
  name?: string;
  text?: string;
  testId?: string;
  id?: string;
}

export interface StepSnapshot {
  dom?: SnapshotNode[];
  ax?: string;
}

export interface ConsoleLine {
  stepId?: string;
  type?: string;
  text: string;
  ts?: number;
}

export interface NetworkLine {
  stepId?: string;
  method?: string;
  url: string;
  status?: number;
  ts?: number;
}

export interface CandidateView {
  label: string;
  score: number;
  attrs: AttrCompare[];
}

export interface IdentityView {
  accepted: boolean;
  score?: number;
  lead?: number;
  reason?: string;
  brokenAttr?: string;
  /** Recorded value and the live value, when they differ. */
  changed?: string;
  candidates: CandidateView[];
}

export interface StepView {
  id: string;
  status: "passed" | "failed" | "paused" | "pending" | "skipped";
  reason?: string;
  phase?: string;
  startedAt?: number;
  endedAt?: number;
  label?: string;
  action?: string;
  identity?: IdentityView;
  beforeShot?: string;
  afterShot?: string;
  /** Why auto-heal did not run. Absent when the step was not sorted out of healing. */
  triage?: string;
  snapshot?: StepSnapshot;
}
