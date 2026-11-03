// Live tools and saved-workflow replay share these action checks.
// The live session's mode selects its guards; replay stays careful.

import { navigationGuard } from "./allowlist";
import { canonicalKey, keyMayInsertText } from "./keys";
import { readLiveBlocker, type LiveBlocker } from "./live-coverage";
import type { CdpLiveDriver } from "./driver";
import {
  buildView,
  EXPERIAN_COMMIT_INSTRUCTION,
  focusLiveMark,
  markedFieldValue,
  planClick,
  planKey,
  planScroll,
  planType,
  readLivePage,
  sameTarget,
  scrollLivePage,
  selectLiveMark,
  targetVerdict,
  selectLiveOption,
  type LabelGuard,
  type LiveRead,
  type PageFacts,
  type ScrollFacts,
} from "./live-ops";
import type { CdpSocket } from "./socket";

/** The open page an act runs on. */
export interface LiveActTarget {
  driver: Pick<
    CdpLiveDriver,
    "evaluateFunction" | "pressMarked" | "clickCss" | "actionPoint" | "markTrust" | "insertText" | "takeBlockedNav" | "returnFromBlock" | "sleep"
  >;
  read: LiveRead;
  guard: LabelGuard;
  stopPath: string;
  hosts: readonly string[];
  origins: readonly string[];
  /** Writes the audit row. It runs after every check and before the page is touched. */
  before(action: string, label: string): Promise<void>;
  /** Reads the page again under a new epoch. */
  reread(): Promise<LiveRead>;
}

export type LiveActOutcome =
  | { kind: "refused" | "halted"; reason: string; blocker?: LiveBlocker }
  | { kind: "reached"; reason: "experian_commit"; instruction: string }
  | { kind: "applied"; label: string; control: string; scroll?: ScrollFacts };

function planRefusal(reason: string): LiveActOutcome {
  if (reason === "login_wall") return { kind: "halted", reason };
  return reason === "experian_commit"
    ? { kind: "reached", reason, instruction: EXPERIAN_COMMIT_INSTRUCTION }
    : { kind: "refused", reason };
}

/** Marks the control again and keeps the plan only if the mark is still the control the plan named. */
async function stillMarked(target: Pick<LiveActTarget, "driver" | "read" | "guard">, ref: string, index: number): Promise<boolean> {
  const marked = await target.driver.evaluateFunction<PageFacts>(readLivePage, { markIndex: index });
  return sameTarget(target.read, buildView(marked, target.read.view.epoch, target.guard), ref);
}

async function refuseBlocked(target: LiveActTarget, reason: string): Promise<LiveActOutcome> {
  if (reason !== "login_wall") {
    await target.driver.returnFromBlock();
    await target.reread();
  }
  return planRefusal(reason);
}

function controlOf(read: LiveRead, ref: string) {
  return ref ? read.view.controls.find((item) => item.ref === ref) : undefined;
}

async function coverageRefusal(target: LiveActTarget, index: number): Promise<LiveActOutcome> {
  const outcome: LiveActOutcome = { kind: "refused", reason: "element is covered" };
  if (target.guard.careful !== false) return outcome;
  const found = await target.driver.evaluateFunction<ReturnType<typeof readLiveBlocker>>(readLiveBlocker, { markIndex: index });
  if (!found) return outcome;
  const { dismissHandle, ...blocker } = found;
  blocker.text = blocker.text.replace(/(?:sk-|ghp_|gho_|xox[bp]-|AKIA|eyJ|GOCSPX-)[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 240);
  let dismissIdentity: string | undefined;
  if (dismissHandle) {
    const facts = await target.driver.evaluateFunction<PageFacts>(readLivePage, { markIndex: -1, markHandle: dismissHandle });
    dismissIdentity = facts.controls.find((control) => control.index === facts.marked)?.identity;
  }
  const fresh = await target.reread();
  if (dismissIdentity) {
    const entry = [...fresh.targets.byRef].find(([, target]) => target.identity === dismissIdentity);
    const dismiss = fresh.view.controls.find((control) => control.ref === entry?.[0]);
    if (dismiss) return { ...outcome, blocker: { ...blocker, dismissRef: dismiss.ref } };
  }
  return { ...outcome, blocker };
}

/** Guard checks run before dispatch; the final Experian freeze stop returns reached without a click. */
export async function clickLive(target: LiveActTarget, ref: string): Promise<LiveActOutcome> {
  const plan = planClick(target.read, ref);
  if (!plan.ok) return planRefusal(plan.refusal);
  const entry = target.read.targets.byRef.get(ref);
  if (entry?.href) {
    const why = navigationGuard(entry.href, target.hosts, target.origins, target.stopPath, target.guard.careful);
    if (why) return planRefusal(why);
  }
  const index = entry?.index ?? -1;
  if (!await stillMarked(target, ref, index)) return { kind: "refused", reason: "stale_ref" };
  const control = controlOf(target.read, ref);
  const label = control?.label || ref;
  await target.before("click", label);
  target.driver.takeBlockedNav();
  target.driver.markTrust();
  try {
    await target.driver.clickCss(plan.selector);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "click failed";
    if (reason === "element is covered") return coverageRefusal(target, index);
    throw err;
  }
  const blockedNav = target.driver.takeBlockedNav();
  if (blockedNav) return refuseBlocked(target, blockedNav);
  return { kind: "applied", label, control: control?.kind || "" };
}

/**
 * Types into one listed field. A credential field and secret-looking text are refused.
 * `replace` selects the field's text first, so the field ends up holding exactly `text`.
 * Without it the text goes in at the caret, and the refusal checks the text already there too.
 */
export async function typeLive(target: LiveActTarget, ref: string, text: string, replace = false): Promise<LiveActOutcome> {
  const early = planType(target.read, ref, text);
  if (!early.ok) return { kind: "refused", reason: early.refusal };
  const index = target.read.targets.byRef.get(ref)?.index ?? -1;
  if (!await stillMarked(target, ref, index)) return { kind: "refused", reason: "stale_ref" };
  const prior = replace ? "" : await target.driver.evaluateFunction<string>(markedFieldValue, { markIndex: index });
  const plan = planType(target.read, ref, text, prior);
  if (!plan.ok) return { kind: "refused", reason: plan.refusal };
  const control = controlOf(target.read, ref);
  const label = control?.label || ref;
  await target.before("type", label);
  await target.driver.evaluateFunction(focusLiveMark, { markIndex: index });
  if (replace) await target.driver.evaluateFunction(selectLiveMark, { markIndex: index });
  try {
    if (replace && !text) await target.driver.pressMarked("Backspace", index);
    else await target.driver.insertText(text, prior, index);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "focus_moved";
    if (reason === "credential_field" || reason === "focus_moved") return { kind: "halted", reason };
    throw err;
  }
  if (replace && target.guard.careful === false && await target.driver.evaluateFunction<string>(markedFieldValue, { markIndex: index }) !== text) {
    return { kind: "refused", reason: "field_value_mismatch" };
  }
  return { kind: "applied", label, control: control?.kind || "" };
}

export async function selectLive(target: LiveActTarget, ref: string, option: string): Promise<LiveActOutcome> {
  const plan = planClick(target.read, ref);
  if (!plan.ok) return { kind: "refused", reason: plan.refusal };
  const entry = target.read.targets.byRef.get(ref)!;
  if (!await stillMarked(target, ref, entry.index)) return { kind: "refused", reason: "stale_ref" };
  const control = controlOf(target.read, ref);
  if (control?.kind !== "select") return { kind: "refused", reason: "not_a_select" };
  await target.before("select", control.label);
  try {
    await target.driver.actionPoint(plan.selector);
  } catch (error) {
    if (error instanceof Error && error.message === "element is covered") return coverageRefusal(target, entry.index);
    if (error instanceof Error && error.message === "element has no box") return { kind: "refused", reason: error.message };
    throw error;
  }
  const reason = await target.driver.evaluateFunction<string | null>(selectLiveOption, { markIndex: entry.index, option });
  if (reason) return { kind: "refused", reason };
  return { kind: "applied", label: control.label, control: "select" };
}

/** Press a key on the same guards as a click. */
export async function pressLiveKey(target: LiveActTarget, key: string, ref: string): Promise<LiveActOutcome> {
  key = canonicalKey(key);
  const plan = planKey(target.read, key, ref);
  if (!plan.ok) return planRefusal(plan.refusal);
  const entry = ref ? target.read.targets.byRef.get(ref) : undefined;
  const control = controlOf(target.read, ref);
  if (key === "Enter" && entry?.href) {
    const why = navigationGuard(entry.href, target.hosts, target.origins, target.stopPath, target.guard.careful);
    if (why) return planRefusal(why);
  }
  const index = entry?.index ?? -1;
  if (entry && !await stillMarked(target, ref, index)) return { kind: "refused", reason: "stale_ref" };
  const label = control?.label || "";
  const text = keyMayInsertText(key);
  await target.before("key", text ? "[redacted key]" : key);
  target.driver.takeBlockedNav();
  try {
    await target.driver.pressMarked(key, index);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "focus_moved";
    if (reason === "credential_field" || reason === "focus_moved") return { kind: "halted", reason };
    throw err;
  }
  const blockedNav = target.driver.takeBlockedNav();
  if (blockedNav) return refuseBlocked(target, blockedNav);
  return { kind: "applied", label, control: control?.kind || "" };
}

/** Scrolls the page, or the box around one listed control, so more of a long page loads. */
export async function scrollLive(target: LiveActTarget, direction: string, ref: string): Promise<LiveActOutcome> {
  const plan = planScroll(target.read, direction, ref);
  if (!plan.ok) return { kind: "refused", reason: plan.refusal };
  const entry = ref ? target.read.targets.byRef.get(ref) : undefined;
  const control = controlOf(target.read, ref);
  const index = entry?.index ?? -1;
  if (entry && !await stillMarked(target, ref, index)) return { kind: "refused", reason: "stale_ref" };
  const label = control?.label || "";
  await target.before("scroll", `${direction} ${label}`.trim());
  target.driver.takeBlockedNav();
  const scroll = await target.driver.evaluateFunction<ScrollFacts>(scrollLivePage, { markIndex: index, direction });
  if (scroll.target === "none") return { kind: "refused", reason: "stale_ref" };
  await target.driver.sleep(500);
  const blockedNav = target.driver.takeBlockedNav();
  if (blockedNav) return refuseBlocked(target, blockedNav);
  return { kind: "applied", label, control: control?.kind || "", scroll };
}

/**
 * Tracks pages opened by this session's tabs, never unrelated pages.
 * Careful mode closes each new owned page and calls `closed()`; YOLO leaves it usable.
 */
export async function watchNewTargets(cdp: CdpSocket, ownId: string, active: () => boolean, closed: () => void, careful = true, owned = new Set<string>([ownId])): Promise<void> {
  const baseline = new Set<string>([ownId]);
  let ready = false;
  cdp.on("Target.targetCreated", undefined, (params) => {
    const info = (params as { targetInfo?: { type?: string; targetId?: string; openerId?: string } }).targetInfo;
    if (!ready || !info?.targetId || !active() || info.type !== "page") return;
    if (!info.openerId || !owned.has(info.openerId)) return;
    owned.add(info.targetId);
    if (!careful || targetVerdict(info, ownId, baseline) !== "close") return;
    void cdp.send("Target.closeTarget", { targetId: info.targetId }).catch(() => undefined);
    closed();
  });
  const listed = await cdp.send<{ targetInfos?: { targetId?: string }[] }>("Target.getTargets");
  for (const info of listed.targetInfos || []) {
    if (info.targetId) baseline.add(info.targetId);
  }
  ready = true;
  await cdp.send("Target.setDiscoverTargets", { discover: true }).catch(() => undefined);
}
