import { withListeningConnection } from "../cdp-live/current-chrome";
import { readSavedProfileTabs, type ProfileSessions, type SessionFailure } from "./snss-tabs";

/**
 * Ten tabs is enough to spot the site the task needs, such as robinhood.com.
 * Five profiles at that size stay a small tool reply.
 */
export const PROFILE_TAB_CAP = 10;
export const PROFILE_TAB_TITLE_MAX = 80;
export const PROFILE_TAB_HOST_MAX = 80;

/** A tab the model may see. Host only: a full URL can carry an OAuth code or a mail id in its query. */
export interface ProfileTab {
  title: string;
  host: string;
}

export interface ProfileTabGroup {
  tabs: ProfileTab[];
  omitted: number;
}

export interface ProfileTabListing {
  byDirectory: Record<string, ProfileTabGroup>;
  /** Set when the live tab list was not read. A fixed phrase, never an error that might contain a URL. */
  unread?: string;
  /** Live tabs whose profile folder could not be matched. Titles and hosts only, never under a folder. */
  unmatched?: ProfileTabGroup;
  /** A profile whose session file could not be used to match live tabs. A fixed phrase, never a URL. */
  unavailable?: Record<string, string>;
}

const UNAVAILABLE_TEXT: Record<SessionFailure, string> = {
  denied: "Chrome's folder is not readable",
  unreadable: "the session file could not be read",
  absent: "no session file",
};

interface TargetInfo {
  targetId?: string;
  type?: string;
  url?: string;
  title?: string;
  browserContextId?: string;
}

/** The socket methods this read uses. A test can pass a fake. */
export interface TabSocket {
  send<T>(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<T>;
}

/** One live page, still carrying its URL so a context can be matched. The URL is not a model-facing field. */
export interface LivePage {
  targetId: string;
  url: string;
  title: string;
}

export interface LiveContext {
  tabs: LivePage[];
}

export interface LivePages {
  contexts: LiveContext[];
  unread?: string;
}

export function trimField(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim().replace(/"/g, "'");
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 3))}...`;
}

/** The site name only. Drops userinfo, path, port, fragment, and query. */
export function tabHost(url: string): string | undefined {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { return undefined; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  const host = parsed.hostname.replace(/\.$/, "");
  if (!host) return undefined;
  return trimField(host, PROFILE_TAB_HOST_MAX);
}

export function capTabs(tabs: ProfileTab[]): ProfileTabGroup {
  return { tabs: tabs.slice(0, PROFILE_TAB_CAP), omitted: Math.max(0, tabs.length - PROFILE_TAB_CAP) };
}

/** A title that is itself a URL, or that carries a query, must not reach the model. A question mark in ordinary words stays. */
function safeTitle(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  try {
    const parsed = new URL(flat);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return "";
  } catch { /* a title, not an address */ }
  const query = flat.indexOf("?");
  const cut = query >= 0 && flat.includes("=", query) ? flat.slice(0, query) : flat;
  return trimField(cut, PROFILE_TAB_TITLE_MAX);
}

/**
 * Live page targets grouped by browser context. Does not open a tab and does not assign a profile folder.
 * Does not close the caller's socket.
 */
export async function readLivePages(cdp: TabSocket): Promise<LiveContext[]> {
  const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets", {}, undefined, 2000);
  const byContext = new Map<string, LivePage[]>();
  for (const target of targetInfos) {
    if (target.type !== "page" || !target.url || !tabHost(target.url)) continue;
    const key = target.browserContextId ?? "";
    const list = byContext.get(key) ?? [];
    list.push({ targetId: target.targetId ?? `${key}:${list.length}`, url: target.url, title: target.title ?? "" });
    byContext.set(key, list);
  }
  return [...byContext.values()].map((tabs) => ({ tabs }));
}

/**
 * Open tabs for the profile question. Session URLs only name which profile a live context belongs to.
 * The listed tabs are that context's live tabs. A saved tab with no live match is not listed.
 * When the live list is unavailable, no saved tab is shown as open.
 */
export async function listProfileTabs(root: string, directories: readonly string[]): Promise<ProfileTabListing> {
  const sessions = await readSavedProfileTabs(root, directories).catch(() => ({
    urls: {},
    failed: Object.fromEntries(directories.filter((directory) => /^(?:Default|Profile \d+)$/.test(directory)).map((directory) => [directory, "unreadable" as const])),
  }));
  return confirmOpenTabs(sessions, await readListeningProfileTabs(root));
}

/**
 * Match each live context to one profile only when that profile's session URLs cover most of its live tabs exactly
 * and no other profile comes close. A weak match, including one while another session could not be read, stays unassigned.
 * URLs are stripped here, at the output boundary.
 */
export function confirmOpenTabs(sessions: ProfileSessions, live: LivePages): ProfileTabListing {
  const unavailable: Record<string, string> = {};
  for (const [directory, reason] of Object.entries(sessions.failed)) unavailable[directory] = UNAVAILABLE_TEXT[reason];
  const failed = Object.keys(unavailable).length ? { unavailable } : {};
  if (live.unread) return { byDirectory: {}, unread: live.unread, ...failed };
  const assigned = new Map<string, LivePage[]>();
  const loose: LivePage[] = [];
  const anyFailed = Object.keys(sessions.failed).length > 0;
  for (const context of live.contexts) {
    const directory = clearProfile(context, sessions.urls, anyFailed);
    if (!directory) {
      loose.push(...context.tabs);
      continue;
    }
    assigned.set(directory, [...(assigned.get(directory) ?? []), ...context.tabs]);
  }
  const byDirectory: Record<string, ProfileTabGroup> = {};
  for (const [directory, pages] of assigned) byDirectory[directory] = capTabs(pagesToTabs(pages));
  const unmatched = capTabs(pagesToTabs(loose));
  return { byDirectory, ...(unmatched.tabs.length ? { unmatched } : {}), ...failed };
}

function clearProfile(context: LiveContext, urls: Record<string, string[]>, anyFailed: boolean): string | undefined {
  const live = context.tabs.map((tab) => tab.url);
  if (!live.length) return undefined;
  let best: { directory: string; count: number } | undefined;
  let second = 0;
  for (const [directory, saved] of Object.entries(urls)) {
    const keys = new Set(saved);
    let count = 0;
    for (const url of live) if (keys.has(url)) count++;
    if (!count) continue;
    if (!best || count > best.count) {
      second = best?.count ?? 0;
      best = { directory, count };
    } else if (count > second) second = count;
  }
  if (!best || best.count * 2 <= live.length) return undefined;
  if (second > 0 && second * 2 >= best.count) return undefined;
  if (anyFailed && best.count !== live.length) return undefined;
  return best.directory;
}

function pagesToTabs(pages: LivePage[]): ProfileTab[] {
  const seen = new Set<string>();
  const tabs: ProfileTab[] = [];
  for (const page of pages) {
    if (seen.has(page.targetId)) continue;
    seen.add(page.targetId);
    const host = tabHost(page.url);
    if (!host) continue;
    tabs.push({ title: safeTitle(page.title), host });
  }
  return tabs;
}

/**
 * Live pages from a debugger that is already listening on this Chrome folder.
 * A hermetic run does not scan or connect: a test that did would raise the owner's Allow sheet.
 * This joins Bao's shared connection and releases that join before returning. It does not turn debugging on.
 */
export async function readListeningProfileTabs(root: string): Promise<LivePages> {
  const contexts = await withListeningConnection(root, (cdp) => readLivePages(cdp));
  if (!contexts) return { contexts: [], unread: "remote debugging is off" };
  return { contexts };
}

function profileLabel(profile: { directory: string; name: string; email: string }): string {
  return `"${profile.directory}" (${profile.name}${profile.email ? `, ${profile.email}` : ""})`;
}

function tabText(tab: ProfileTab): string {
  return tab.title ? `"${tab.title}" ${tab.host}` : tab.host;
}

/** The agent_browser sentence. run_workflow keeps ChromeProfileQuestion.message. */
export function agentProfileText(root: string, profiles: { directory: string; name: string; email: string }[], settings: string | undefined, listing?: ProfileTabListing): string {
  const read = listing ?? { byDirectory: {}, unread: "remote debugging is off" };
  const head = `Chrome has ${profiles.length} profiles in ${root}, so Bao opened nothing. Pick one yourself from this list. Ask the person only if no profile fits the task.`;
  const lines = profiles.map((profile) => {
    const mark = profile.directory === settings ? "; picked in Bao Settings" : "";
    const name = profileLabel(profile);
    const failed = read.unavailable?.[profile.directory];
    if (failed) return `${name}: open tabs were not read (${failed})${mark}`;
    if (read.unread) return `${name}: open tabs were not read (${read.unread})${mark}`;
    const group = read.byDirectory[profile.directory];
    if (!group && read.unmatched) return `${name}: open tabs were not matched to this folder${mark}`;
    const tabs = group?.tabs ?? [];
    const body = tabs.length ? tabs.map(tabText).join("; ") : "no open tabs";
    const more = group?.omitted ? `; and ${group.omitted} more` : "";
    return `${name}: ${body}${more}${mark}`;
  });
  const unmatched = read.unmatched ? [unmatchedText(read.unmatched)] : [];
  return [head, ...lines, ...unmatched].join("\n");
}

function unmatchedText(group: ProfileTabGroup): string {
  const more = group.omitted ? `; and ${group.omitted} more` : "";
  return `open in a profile Bao could not match: ${group.tabs.map(tabText).join("; ")}${more}`;
}

/** The example folder is a call shape, not the profile the model should pick. */
export function agentProfileRetry(call: Record<string, unknown>, example: string): string {
  const retry = { ...call, profile: example, profile_reason: "why this profile" };
  return `Pick the folder yourself. Ask the person only if no profile fits the task. The example folder is a call shape, not the answer. Then call agent_browser again with that folder and a short profile_reason: ${JSON.stringify(retry)}`;
}
