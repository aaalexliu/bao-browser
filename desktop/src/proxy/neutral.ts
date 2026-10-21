// Vendor-neutral actions. Adapters unpack a published schema into these and
// never touch the page. The executor is the only thing that hit-tests or clicks.

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

export type NeutralAction =
  | { op: "click"; x: number; y: number; button: "left" | "right" | "wheel" | "back" | "forward" }
  | { op: "type"; text: string }
  | { op: "keypress"; keys: string[] }
  | { op: "unsupported"; vendor: string; type: string };

export interface ActResult {
  unresolved: boolean;
  reason?: string;
}

/** One vendor's wire types in, that vendor's wire types out. */
export interface VendorAdapter<Call, Output> {
  readonly vendor: string;
  handle(call: Call, executor: Executor): Promise<Output>;
}

export interface Executor {
  /** Present for a browser surface. A macOS accessibility executor has no page. */
  readonly page?: Page;
  readonly trail: AuditTrail;
  observe(origin: AuditOrigin): Promise<Observation>;
  act(action: NeutralAction, origin: AuditOrigin): Promise<ActResult>;
  workflow(startUrl: string): Workflow;
}
