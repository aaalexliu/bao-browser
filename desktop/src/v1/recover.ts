// A banner, modal, or spinner can hide a step for this run only.
// A 5xx response stays a failure. A captcha or signed-out page that the
// page classifier did not already stop also stays a failure.

import type { Identity } from "./schema";

export const RECOVERY_LIMIT = 3;

export type RecoveryKind = "cookie banner" | "modal" | "spinner";

export interface RecoveryTarget {
  kind: RecoveryKind;
  node?: Identity;
}

const CAPTCHA = /captcha|recaptcha|hcaptcha|not a robot|verify you are human/i;
const SIGNED_OUT = /signed out|session expired|you are not signed in/i;
const COOKIE = /cookie|consent|privacy choices/i;
const ACCEPT = /^(accept|accept all|agree|allow|allow all|got it|ok|dismiss|close|not now|no thanks)$/i;
const SPINNER = /^(loading|please wait|spinner)$/i;

export function hasCaptcha(nodes: Identity[]): boolean {
  return nodes.some((node) => CAPTCHA.test(blob(node)));
}

/** A reason that must not be healed or dismissed. Absent when recovery may run. */
export function hardFailure(input: {
  phase?: string;
  reason?: string;
  nodes: Identity[];
  network?: { status?: number }[];
}): string | undefined {
  if (input.phase === "auth") return input.reason || "signed-out";
  if (hasCaptcha(input.nodes) || CAPTCHA.test(input.reason || "")) return "captcha";
  if (SIGNED_OUT.test(input.reason || "") || input.nodes.some((node) => SIGNED_OUT.test(blob(node)))) return "signed-out";
  const status = (input.network || []).find((line) => (line.status || 0) >= 500)?.status;
  if (status) return `5xx ${status}`;
  if (/\b50[0-9]\b/.test(input.reason || "")) return "5xx";
  return undefined;
}

/** The obstruction in front of the step, if this run may dismiss it. */
export function findRecovery(nodes: Identity[]): RecoveryTarget | undefined {
  if (hasCaptcha(nodes)) return undefined;
  if (nodes.some((node) => COOKIE.test(blob(node)))) {
    const dismiss = nodes.find((node) => isDismiss(node));
    if (dismiss) return { kind: "cookie banner", node: dismiss };
  }
  const modal = nodes.some((node) => node.role === "dialog" || node.testId === "overlay" || node.testId === "overlay-close");
  if (modal) {
    const dismiss = nodes.find((node) => node.testId === "overlay-close" || isDismiss(node));
    if (dismiss) return { kind: "modal", node: dismiss };
  }
  const spinner = nodes.find((node) => node.role === "progressbar" || node.testId === "spinner" || SPINNER.test(label(node)));
  if (spinner) return { kind: "spinner", node: spinner };
  return undefined;
}

function isDismiss(node: Identity): boolean {
  return node.testId === "overlay-close"
    || node.testId === "accept-cookies"
    || ACCEPT.test(label(node));
}

function label(node: Identity): string {
  return (node.text || node.name || node.label || "").replace(/\s+/g, " ").trim();
}

function blob(node: Identity): string {
  return `${node.text || ""} ${node.name || ""} ${node.label || ""} ${node.testId || ""}`;
}
