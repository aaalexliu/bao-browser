export interface OwnerPage {
  url: string;
  title: string;
}

export type OwnerWall = "login_wall" | "bot_wall";

/** A redirect to a sign-in or check address. A title on the page the agent was already on is not one. */
function addressWall(url: URL): OwnerWall | null {
  const path = url.pathname;
  if (/^\/(?:_Incapsula_Resource|_ips_check)(?:\/|$)/i.test(path)
    || /^(?:newassets\.)?hcaptcha\.com$/i.test(url.hostname)
    || /^(?:www\.)?(?:google\.com|recaptcha\.net)$/i.test(url.hostname) && /^\/recaptcha\/(?:api2|enterprise)\/(?:anchor|bframe)(?:\/|$)/i.test(path)) return "bot_wall";
  if (/(?:^|\/)(?:login|signin|sign-in|log-in|verify|verification|2fa|mfa|otp)(?:\/|$)/i.test(path)) return "login_wall";
  return null;
}

/** Metadata only. An unclear page must stay private until its URL or title changes. */
export function ownerWall(page: OwnerPage): OwnerWall | null {
  let url: URL;
  try { url = new URL(page.url); } catch { return null; }
  if (/\b(?:captcha|hcaptcha|recaptcha|verify (?:that )?you are (?:a )?human|not a robot|request unsuccessful|just a moment|checking your browser|pardon our interruption|imperva|incapsula)\b/i.test(page.title)) return "bot_wall";
  const address = addressWall(url);
  if (address) return address;
  if (/\b(?:sign[ -]?in|log[ -]?in|verification code|one.time code|verify your (?:identity|account)|two.factor|security check)\b/i.test(page.title)) return "login_wall";
  return null;
}

/** The wall matched the address, not only the title. */
export function ownerWallOnAddress(page: OwnerPage): boolean {
  try { return addressWall(new URL(page.url)) !== null; } catch { return false; }
}

/** What the page asks the owner to do, read from its title first, then its address. */
export type OwnerAsk = "sign-in" | "check" | "other";

export function ownerAsk(page: OwnerPage): OwnerAsk {
  if (ownerWall(page) === "bot_wall") return "check";
  const { title } = page;
  if (/\b(?:confirm|verify|verification|code|two.factor|two.step|2.step)\b/i.test(title)) return "other";
  if (/\b(?:sign[ -]?in|log[ -]?in)\b/i.test(title)) return "sign-in";
  let path = "";
  try { path = new URL(page.url).pathname; } catch {}
  if (/(?:^|\/)(?:login|signin|sign-in|log-in)(?:\/|$)/i.test(path)) return "sign-in";
  return "other";
}

export function ownerSite(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/** The owner's task as a verb phrase, such as "sign in to nytimes.com". A page Bao does not recognize gets neutral words. */
export function ownerTask(page: OwnerPage | undefined): string {
  if (!page) return "finish the check on the page";
  const site = ownerSite(page.url);
  switch (ownerAsk(page)) {
    case "sign-in": return `sign in to ${site}`;
    case "check": return `clear the check on ${site}`;
    case "other": return `finish the check on ${site}`;
  }
}

/** A recognized sign-in or check wait ends by itself this long after it started or the latest wait_for_owner call returned. A wait on any other page ends at the call deadline. */
export const OWNER_WAIT_LIMIT_MS = 30 * 60 * 1000;

export function ownerCanResume(before: OwnerPage, now: OwnerPage): boolean {
  if (!/^https?:\/\//.test(now.url) || !now.title.trim() || ownerWall(now)) return false;
  return before.url !== now.url || before.title !== now.title;
}

export const ownerWaitInstruction = (current: boolean, raised: boolean, runId: string, page?: OwnerPage) => `Keep this session open. ${raised ? "Bao brought this window to the front for the owner. " : ""}Ask the owner to ${ownerTask(page)} in ${current ? "Bao's task tab in their own Chrome" : "this Bao window"}, then call agent_browser with command=wait_for_owner, args=[\"60000\"], and run_id=\"${runId}\". Repeat a waiting reply only while the result still says waiting and this page is a recognized sign-in or check; do not end your turn or start another session. On a recognized sign-in or check, Bao ends the wait if no wait_for_owner call continues it for ${OWNER_WAIT_LIMIT_MS / 60_000} minutes. On a page that is not a sign-in or check, this call's deadline ends the wait and the run returns to recording. Once a result says recording, the wait is over and you continue. On ready, take a fresh snapshot and continue in this same agent_browser session. Bao reads only URL and title while waiting. On a recognized sign-in or check, an unchanged URL and title keep waiting. On closed, report that ${current ? "the owner's Chrome session ended" : "the owner closed the window"}.`;

export function ownerWaitTimeout(value: unknown): number {
  if (value === undefined) return 60_000;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 120_000) throw new Error("timeoutMs must be an integer from 1 to 120000");
  return value;
}
