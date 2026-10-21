// Fields the run viewer and heal review render. Replay fills them.

export interface AttrCompare {
  attr: string;
  recorded: string;
  live: string;
  matched: boolean;
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
  status: "passed" | "failed" | "paused" | "pending";
  reason?: string;
  startedAt?: number;
  endedAt?: number;
  label?: string;
  action?: string;
  identity?: IdentityView;
  beforeShot?: string;
  afterShot?: string;
}
