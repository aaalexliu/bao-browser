// Vendor-neutral actions. Adapters unpack a published schema into these and
// never touch the page. The executor is the only thing that hit-tests or clicks.
// Buttons are left | middle | right. A vendor button that is not one of those
// (OpenAI wheel, back, forward) stays on the vendor side as unsupported.

import type { Page } from "playwright";
import type { Workflow } from "../../../src/types";
import type { AuditOrigin, AuditTrail } from "./audit";

export interface DomSnap {
  tag: string;
  id: string;
  type: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AxSnap {
  role: string;
  name: string;
}

export interface Observation {
  png: Buffer;
  url: string;
  viewport: { w: number; h: number };
  dom: DomSnap[];
  ax: AxSnap[];
}

export type MouseButton = "left" | "middle" | "right";

/** The pixel a vendor named. Replay never reads this. */
export interface Provenance {
  x: number;
  y: number;
  space: "viewport" | "image";
}

export type NeutralAction =
  | { op: "screenshot" }
  | { op: "zoom"; x0: number; y0: number; x1: number; y1: number }
  | {
      op: "click";
      x: number;
      y: number;
      button: MouseButton;
      count?: number;
      modifiers?: string[];
      provenance?: Provenance;
    }
  | {
      op: "drag";
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      modifiers?: string[];
      provenance?: Provenance;
    }
  | { op: "move"; x: number; y: number; provenance?: Provenance }
  | { op: "mousedown" }
  | { op: "mouseup" }
  | { op: "cursor" }
  | { op: "scroll"; x: number; y: number; dx: number; dy: number; provenance?: Provenance }
  | { op: "type"; text: string }
  | { op: "keypress"; keys: string[]; holdMs?: number }
  | { op: "wait"; ms: number }
  | { op: "unsupported"; vendor: string; type: string };

export interface ActResult {
  unresolved: boolean;
  reason?: string;
  /** cursor_position, in viewport pixels, "x,y". The adapter rescales. */
  text?: string;
  /** zoom crop, full viewport resolution. The adapter fits it to the screenshot. */
  png?: Buffer;
}

/** One vendor's wire types in, that vendor's wire types out. */
export interface VendorAdapter<Call, Output> {
  readonly vendor: string;
  handle(call: Call, executor: Executor): Promise<Output>;
}

export interface Executor {
  readonly page: Page;
  readonly trail: AuditTrail;
  observe(origin: AuditOrigin): Promise<Observation>;
  act(action: NeutralAction, origin: AuditOrigin): Promise<ActResult>;
  workflow(startUrl: string): Workflow;
}
