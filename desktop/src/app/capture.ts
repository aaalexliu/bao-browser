// In-progress capture. Pause drops UI events. Notes and checks are annotations.
// A sensitive note is refused and not stored.

import { isSensitiveValue } from "../../../src/mask";
import type { TrailEvent } from "../v1/interpret";

export interface CaptureStep {
  id: string;
  label: string;
}

export interface ActNotice {
  title: string;
  body: string;
  badge: "!";
  /** Same string as title and body. The Dock tooltip uses it too. */
  tooltip: string;
}

export class Capture {
  recording = false;
  paused = false;
  events: TrailEvent[] = [];
  steps: CaptureStep[] = [];

  start(): void {
    this.recording = true;
    this.paused = false;
    this.events = [];
    this.steps = [];
  }

  pause(): void {
    if (this.recording) this.paused = true;
  }

  resume(): void {
    if (this.recording) this.paused = false;
  }

  /** A handoff line is the record of the pause. It is kept while UI events are dropped. */
  handoff(text: string): void {
    if (!this.recording) return;
    const clean = text.replace(/\s+/g, " ").trim().slice(0, 180);
    if (!clean) return;
    this.events.push(this.stamp({ kind: "act", op: "note", afterText: clean }));
  }

  /** False while idle or paused, so the UI event is not stored. */
  push(event: Omit<TrailEvent, "id" | "ts"> & { id?: string; ts?: number }): boolean {
    if (!this.recording || this.paused) return false;
    const stored = this.stamp(event);
    this.events.push(stored);
    const label = stepLabel(stored);
    if (label) this.steps.push({ id: stored.id, label });
    return true;
  }

  note(text: string): CaptureStep {
    return this.annotate("note", text, (clean) => `Note: ${clean}`);
  }

  check(text: string): CaptureStep {
    return this.annotate("expect", text, (clean) => `Check: ${clean}`);
  }

  discard(): void {
    this.recording = false;
    this.paused = false;
    this.events = [];
    this.steps = [];
  }

  stop(): TrailEvent[] {
    const events = this.events;
    this.recording = false;
    this.paused = false;
    return events;
  }

  private annotate(op: "note" | "expect", text: string, label: (clean: string) => string): CaptureStep {
    if (!this.recording) throw new Error("not recording");
    const clean = cleanAnnotation(text);
    const stored = this.stamp({ kind: "act", op, afterText: clean });
    this.events.push(stored);
    const step = { id: stored.id, label: label(clean) };
    this.steps.push(step);
    return step;
  }

  private stamp(event: Omit<TrailEvent, "id" | "ts"> & { id?: string; ts?: number }): TrailEvent {
    return { ...event, id: event.id || `evt-${this.events.length}`, ts: event.ts || Date.now() };
  }
}

export function actNotice(text: string): ActNotice {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 240) || "Bao is waiting.";
  return { title: clean, body: clean, badge: "!", tooltip: clean };
}

function cleanAnnotation(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean || clean.length > 80) throw new Error("note");
  if (isSensitiveValue(clean) || /\d{6,}/.test(clean)) throw new Error("note");
  return clean;
}

function stepLabel(event: TrailEvent): string {
  if (event.op === "note") return `Note: ${event.afterText || ""}`;
  if (event.op === "expect") return `Check: ${event.afterText || ""}`;
  const name = event.identity?.name || event.identity?.text || event.identity?.label;
  if (event.op === "click") return name ? `Click ${name}` : "Click";
  if (event.op === "type" || event.op === "input") return event.sensitive ? "Type secret" : "Type";
  if (event.op === "upload") return "Upload file";
  if (event.op === "drop") return "Drop file";
  return event.op;
}
