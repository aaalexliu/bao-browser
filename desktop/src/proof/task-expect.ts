// Expected proof outcome. `completed` is a finished replay. `needs_human` is a
// pause for a person: a confirm gate, or a bot check the run must not click.

export type TaskExpect = "completed" | "needs_human";

export interface PauseRun {
  status?: string;
  pausedKind?: string;
  ask?: { kind?: string; instruction?: string };
  failure?: { reason?: string };
  heals?: unknown[];
  modelCalls?: number;
}

export function isNeedsHumanPause(run: PauseRun): boolean {
  if (run.status === "needs_human") return true;
  if (run.status === "paused") {
    const kind = run.pausedKind || "";
    const askKind = run.ask?.kind || "";
    if (kind === "wall" || kind === "confirm" || askKind === "wall" || askKind === "confirm") return true;
    if (/bot|captcha|human/i.test(`${kind} ${run.ask?.instruction || ""}`)) return true;
  }
  return /captcha|bot check/i.test(run.failure?.reason || "");
}

/** A needs_human task is allowed to pause. That pause is the outcome, not a stopped replay. */
export function pauseIsExpected(expect: TaskExpect, run: PauseRun): boolean {
  return expect === "needs_human" && isNeedsHumanPause(run);
}

export function scoreBotWall(input: {
  expect: TaskExpect;
  replay: PauseRun;
  pageText: string;
  stepText: string;
}): { pass: boolean; cause: string; detail: string } {
  const bot = /cloudflare|turnstile|verifying you are not a bot|security verification|captcha|you are not a bot/i.test(input.pageText);
  const clicked = /cloudflare|turnstile|verify you are human|i am not a robot|checkbox/i.test(input.stepText);
  const heals = input.replay.heals?.length || 0;
  const models = input.replay.modelCalls || 0;
  const ended = input.expect === "needs_human" && isNeedsHumanPause(input.replay);
  if (!bot) return { pass: false, cause: "bot wall", detail: `bot wall was not shown (status ${input.replay.status})` };
  if (clicked || heals > 0 || models > 0) return { pass: false, cause: "bot wall", detail: `challenge interaction: clicks ${clicked}, heals ${heals}, model calls ${models}` };
  if (!ended) return { pass: false, cause: "bot wall", detail: `status was ${input.replay.status || "empty"}, not needs_human; heals ${heals}; captcha clicks 0` };
  return { pass: true, cause: "", detail: "needs human: bot check, 0 heals, 0 captcha clicks" };
}
