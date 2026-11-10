import { ChromeFolderDenied } from "../chrome-access";
import { resolveNormalChrome } from "../launch";
import type { SignInImport } from "./bao-profile";
import { BOUND_REASON, boundSite } from "./bound-sign-in";
import { listChromeProfiles, type ChromeProfileChoice } from "./chrome-profile-copy";

export type ProfileWhy = "named by the agent" | "the only profile" | "picked in Bao Settings";
export const RUNNING_CHROME_FALLBACK = "fallback when running Chrome could not be used";
export const FILES_IN_BAO = "the workflow moves files, which running Chrome cannot do yet";
export type RouteWhy = "the default" | "named by the agent" | "fallback after a sign-in wall" | typeof BOUND_REASON
  | typeof RUNNING_CHROME_FALLBACK | typeof FILES_IN_BAO;

/** One of the owner's Chrome profiles, and why Bao uses it. */
export interface ChosenProfile extends ChromeProfileChoice {
  /** Chrome's user-data-dir, which holds the profile folder. */
  root: string;
  why: ProfileWhy;
}

export const ROUTE_LABELS = {
  bao: "Bao profile",
  copy: "Chrome copy",
  current: "Running Chrome over remote debugging",
  extension: "Running Chrome through the Bao extension",
} as const;

/** What a session runs on and why. Every open result and the saved run record carry it; later results carry shortPickLine. */
export type BrowserPick = { why: RouteWhy } & (
  /** With `unread`, Bao imports no sign-ins and it says why: Bao could not read Chrome's profiles, or could not use running Chrome. */
  | { route: "bao"; chrome: string; userDataDir: string; profile?: ChosenProfile; unread?: string }
  | { route: "copy" | "current"; chrome: string; userDataDir: string; profile: ChosenProfile; background?: boolean }
  | { route: "extension" }
);

/** The route and Chrome profile for a new session or workflow run, settled before Bao opens anything. */
export type BrowserPlan = { why: RouteWhy } & (
  /** With `unread`, Bao imports no sign-ins and says why. */
  | { route: "bao"; profile: ChosenProfile; unread?: string } | { route: "bao"; profile?: undefined; unread: string }
  /** `from` is the named route a bound site left, so a running-Chrome failure can open that route again. */
  | { route: "copy" | "current"; profile: ChosenProfile; from?: "bao" | "copy" } | { route: "extension" });

/**
 * The route a run takes. A run that named no browser uses running Chrome, except a workflow that moves files, which running
 * Chrome cannot do yet: that run uses Bao's profile.
 */
export function defaultRoute<B extends string>(browser: B, why: RouteWhy, movesFiles: boolean): { browser: B | "bao"; why: RouteWhy } {
  return browser === "current" && why === "the default" && movesFiles ? { browser: "bao", why: FILES_IN_BAO } : { browser, why };
}

/**
 * A site that ties its sign-in to the owner's Chrome runs there, whatever route was named, unless the run moves files, which
 * running Chrome cannot do yet. `profileDir` is the Chrome profile whose device-bound sessions count.
 */
export function boundRoute(route: string, site: string | undefined, profileDir: string | undefined, movesFiles = false): boolean {
  return route !== "current" && !movesFiles && !!site && boundSite(site, profileDir);
}

/**
 * The plan for a bound site. The extension gate sends it through the Bao extension. Otherwise it opens in running Chrome, and a
 * named Bao profile or copy is remembered so a failure there keeps that route.
 */
export function boundOpenPlan(route: "bao" | "copy" | "current", profile: ChosenProfile, extension: boolean): BrowserPlan {
  if (extension) return { route: "extension", why: BOUND_REASON };
  const from = route === "bao" || route === "copy" ? route : undefined;
  return { route: "current", why: BOUND_REASON, profile, ...(from ? { from } : {}) };
}

/**
 * Running Chrome that the agent did not name gives way to Bao's own profile when Bao cannot use it: the default route, and a site
 * sent there because it ties its sign-in to the owner's Chrome.
 */
export function fallsBack(route: string, why: RouteWhy): boolean {
  return route === "current" && (why === "the default" || why === BOUND_REASON);
}

/** The Bao-profile plan that replaces running Chrome. It imports no sign-ins, and `unread` says why. */
export function fallbackPlan(unread: string, profile?: ChosenProfile): Extract<BrowserPlan, { route: "bao" }> {
  return profile ? { route: "bao", why: RUNNING_CHROME_FALLBACK, profile, unread } : { route: "bao", why: RUNNING_CHROME_FALLBACK, unread };
}

/** A running-Chrome open and its fallback both failed. The message names both routes and both reasons. */
export class RoutesFailed extends Error {
  readonly line: string;
  constructor(first: BrowserPlan, firstError: unknown, second: BrowserPlan, secondError: unknown) {
    const text = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
    const label = (plan: BrowserPlan) => `${ROUTE_LABELS[plan.route]}, ${plan.why}`;
    const line = `Browser: ${label(first)}, did not open: ${text(firstError)}. Browser: ${label(second)}, did not open: ${text(secondError)}.`;
    super(line);
    this.name = "RoutesFailed";
    this.line = line;
  }
}

/** A bound reroute from a named Bao profile or copy falls back to that route. The default falls back to an unread Bao profile. */
function namedBoundFallback(plan: BrowserPlan): BrowserPlan | undefined {
  if (plan.route !== "current" || plan.why !== BOUND_REASON || !plan.from) return undefined;
  return plan.from === "copy"
    ? { route: "copy", why: RUNNING_CHROME_FALLBACK, profile: plan.profile }
    : { route: "bao", why: RUNNING_CHROME_FALLBACK, profile: plan.profile };
}

/** Opens the plan. When it is running Chrome that gives way and Bao cannot use it, opens the named route, or Bao's own profile. */
export async function openOrFallBack<T>(plan: BrowserPlan, open: (plan: BrowserPlan) => Promise<T>, aborted: () => boolean = () => false): Promise<T> {
  if (plan.route !== "current" || !fallsBack(plan.route, plan.why)) return open(plan);
  try { return await open(plan); }
  catch (error) {
    if (aborted()) throw error;
    const next = namedBoundFallback(plan) ?? fallbackPlan(`Bao could not use your running Chrome: ${(error instanceof Error ? error.message : String(error)).replace(/\.$/, "")}.`, plan.profile);
    try { return await open(next); }
    catch (fallbackError) {
      if (aborted()) throw fallbackError;
      throw new RoutesFailed(plan, error, next, fallbackError);
    }
  }
}

/** Where a Bao-profile plan reads sign-ins from, or why it reads none. */
export function signInSource(plan: Extract<BrowserPlan, { route: "bao" }>): { sourceRoot: string; directory: string } | { unread: string } {
  return plan.profile && plan.unread === undefined ? { sourceRoot: plan.profile.root, directory: plan.profile.directory }
    : { unread: plan.unread ?? "it could not read Chrome's profiles" };
}

/** The pick of a Bao-profile plan. */
export function baoPick(plan: Extract<BrowserPlan, { route: "bao" }>, userDataDir: string): BrowserPick {
  return { route: "bao", why: plan.why, chrome: resolveNormalChrome(), userDataDir, ...plan.profile ? { profile: plan.profile } : {},
    ...plan.unread !== undefined ? { unread: plan.unread } : {} };
}

export function chromeApp(): string {
  try { return resolveNormalChrome(); }
  catch { return "not found"; }
}

function profileName(profile: ChromeProfileChoice): string {
  return `"${profile.directory}" (${profile.name}${profile.email ? `, ${profile.email}` : ""})`;
}

export function pickLine(pick: BrowserPick): string {
  const head = `Browser: ${ROUTE_LABELS[pick.route]}, ${pick.why}.`;
  if (pick.route === "extension") return `${head} It runs in the Chrome profile where the Bao extension is linked.`;
  const from = (profile: ChosenProfile) => `${profileName(profile)} in ${profile.root}, ${profile.why}`;
  const chrome = `Chrome app: ${pick.chrome}.`;
  switch (pick.route) {
    case "bao": return `${head} ${chrome} User data: ${pick.userDataDir}. ${pick.profile && pick.unread === undefined ? `Sign-ins come from Chrome profile ${from(pick.profile)}.`
      : `Bao imports no sign-ins: ${pick.unread ?? "it could not read Chrome's profiles."}`}`;
    case "copy": return `${head} ${chrome} User data: ${pick.userDataDir}, a copy of Chrome profile ${from(pick.profile)}.`;
    case "current": return `${head} ${chrome} User data: ${pick.userDataDir}. Profile: ${from(pick.profile)}. ${pick.background
      ? "Bao's task tab opened in the background." : "Chrome opened Bao's task tab in front, in a window of that profile."}`;
  }
}

/** The route and profile of the open session, for every result after its open. */
export function shortPickLine(pick: BrowserPick): string {
  if (pick.route === "extension") return `Browser: ${ROUTE_LABELS.extension}.`;
  return `Browser: ${ROUTE_LABELS[pick.route]}, ${pick.profile ? `Chrome profile "${pick.profile.directory}"` : "no Chrome profile"}.`;
}

/** An open that did not start a session: what Bao tried. The error beside it says why. */
export function failedPickLine(route: BrowserPick["route"], why: RouteWhy, chrome: string, profile: { directory: string; root: string } | undefined): string {
  const head = `Browser: ${ROUTE_LABELS[route]}, ${why}, did not open.`;
  if (route === "extension") return `${head} It runs in the Chrome profile where the Bao extension is linked.`;
  return `${head} Chrome app: ${chrome}. Profile: ${profile ? `"${profile.directory}" in ${profile.root}` : "none chosen"}.`;
}

/**
 * A Bao profile or copy that stopped at a sign-in or check names its fallback: the owner's running Chrome on the same profile, which
 * holds his own sign-in and is a device the site already knows. Bao does not switch routes itself; the agent makes `calls`.
 */
export function fallbackLine(when: string, profile: string | undefined, tool: string, calls: readonly string[]): string {
  return `If ${when}, the fallback is the owner's running Chrome over remote debugging${profile ? ` on the same Chrome profile "${profile}"` : ""}. To take it, call ${tool} with ${calls.join(", then with ")}. Bao does not switch on its own.`;
}

/** What a sign-in import read from the Chrome profile and wrote into Bao's profile, or why it could not. */
export function signInLine(report: SignInImport, profile: string): string {
  const head = `Sign-in import for ${report.origin} from Chrome profile "${profile}"${report.retry ? ", again at the sign-in wall" : ""}`;
  if (report.bound) return `${head}: skipped, because ${BOUND_REASON}.`;
  if (report.error) return `${head} failed: ${report.error.replace(/\.$/, "")}. Bao's profile kept its saved sign-ins.`;
  if (!report.found && !report.storage) return `${head}: the profile has no cookies for this site.`;
  return `${head}: read ${report.found} site ${report.found === 1 ? "cookie" : "cookies"}, wrote ${report.cookies} new or changed ${report.cookies === 1 ? "cookie" : "cookies"} and ${report.storage} storage ${report.storage === 1 ? "item" : "items"} into Bao's profile.`;
}

/** The call named no Chrome profile and Chrome has more than one, so Bao opens nothing and asks. */
export class ChromeProfileQuestion extends Error {
  constructor(readonly root: string, readonly profiles: ChromeProfileChoice[], readonly settings: string | undefined) {
    const marked = profiles.map((profile) => `${profileName(profile)}${profile.directory === settings ? ", picked in Bao Settings" : ""}`);
    super(`Chrome has ${profiles.length} profiles in ${root}, so Bao opened nothing. Choose one: ${marked.join("; ")}.`);
  }

  /** The exact retry, with the Settings pick or else the first profile filled in. */
  retry(call: Record<string, unknown>, tool = "agent_browser"): string {
    const example = this.settings && this.profiles.some((profile) => profile.directory === this.settings) ? this.settings : this.profiles[0]!.directory;
    return `To continue, call ${tool} again with the folder of the profile you choose: ${JSON.stringify({ ...call, profile: example })}`;
  }
}

/**
 * The Chrome profile a session reads sign-ins from or runs on. A named folder must exist. With no name, the only profile is used;
 * with more than one, Bao asks. It never falls back to "Default".
 */
export async function chooseChromeProfile(root: string, named: { directory: string; by: "agent" | "settings" } | undefined, settings?: string): Promise<ChosenProfile> {
  let profiles: ChromeProfileChoice[];
  try { profiles = await listChromeProfiles(root); }
  catch (error) {
    if (error instanceof ChromeFolderDenied) throw error;
    throw new Error(`Bao could not read Chrome's profiles in ${root}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!profiles.length) throw new Error(`Chrome has no profile in ${root}.`);
  if (named) {
    const hit = profiles.find((profile) => profile.directory === named.directory);
    if (!hit) {
      throw new Error(`Chrome has no profile "${named.directory}" in ${root}. Choose one of: ${profiles.map(profileName).join("; ")}.${named.by === "settings" ? " Pick it again in Bao Settings." : ""}`);
    }
    return { ...hit, root, why: named.by === "agent" ? "named by the agent" : "picked in Bao Settings" };
  }
  if (profiles.length === 1) return { ...profiles[0]!, root, why: "the only profile" };
  throw new ChromeProfileQuestion(root, profiles, settings);
}
