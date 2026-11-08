export interface OwnerPage {
  url: string;
  title: string;
}

export type OwnerWall = "login_wall" | "bot_wall";

/** Metadata only. An unclear page must stay private until its URL or title changes. */
export function ownerWall(page: OwnerPage): OwnerWall | null {
  let url: URL;
  try { url = new URL(page.url); } catch { return null; }
  const path = url.pathname;
  if (/^\/(?:_Incapsula_Resource|_ips_check)(?:\/|$)/i.test(path)
    || /^(?:newassets\.)?hcaptcha\.com$/i.test(url.hostname)
    || /^(?:www\.)?(?:google\.com|recaptcha\.net)$/i.test(url.hostname) && /^\/recaptcha\/(?:api2|enterprise)\/(?:anchor|bframe)(?:\/|$)/i.test(path)
    || /\b(?:captcha|hcaptcha|recaptcha|verify (?:that )?you are (?:a )?human|not a robot|request unsuccessful|just a moment|checking your browser|pardon our interruption|imperva|incapsula)\b/i.test(page.title)) return "bot_wall";
  if (/(?:^|\/)(?:login|signin|sign-in|log-in|verify|verification|2fa|mfa|otp)(?:\/|$)/i.test(path) || /\b(?:sign[ -]?in|log[ -]?in|verification code|one.time code|verify your (?:identity|account)|two.factor|security check)\b/i.test(page.title)) return "login_wall";
  return null;
}

export function ownerCanResume(before: OwnerPage, now: OwnerPage): boolean {
  if (!/^https?:\/\//.test(now.url) || !now.title.trim() || ownerWall(now)) return false;
  return before.url !== now.url || before.title !== now.title;
}

export const ownerWaitInstruction = (current: boolean) => `Keep this session open. Ask the owner to sign in or clear the check in ${current ? "Bao's task tab in their own Chrome" : "this Bao window"}, then call agent_browser with command=wait_for_owner and args=[\"60000\"]. Repeat it while the result is waiting; do not end your turn or start another session. On ready, take a fresh snapshot and continue in this same agent_browser session. Bao reads only URL and title while waiting. If those do not change, it keeps waiting. On closed, report that ${current ? "the owner's Chrome session ended" : "the owner closed the window"}.`;

export function ownerWaitTimeout(value: unknown): number {
  if (value === undefined) return 60_000;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 120_000) throw new Error("timeoutMs must be an integer from 1 to 120000");
  return value;
}
