import { realpathSync } from "node:fs";
import path from "node:path";
import { connectCdp, type CdpSocket } from "../cdp-live/socket";
import { readDevToolsActivePort, type DevToolsEndpoint } from "../cdp-live/endpoint";
import { readSavedProfileTabs, type SavedTab } from "./snss-tabs";

/**
 * Ten tabs is enough to spot the site the task needs, such as robinhood.com.
 * Five profiles at that size stay a small tool reply.
 */
export const PROFILE_TAB_CAP = 10;
export const PROFILE_TAB_TITLE_MAX = 80;
export const PROFILE_TAB_HOST_MAX = 80;
const READ_BUDGET_MS = 8_000;
const CONTEXT_MS = 2_500;
const PROFILE_DIRECTORY = /^(?:Default|Profile \d+)$/;

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
  /** Set when Bao did not read tabs. A fixed phrase, never an error that might contain a URL. */
  unread?: string;
  /** Page targets whose profile folder could not be read. Their URLs are not included. */
  unmatched?: number;
  /** Extra sentence. Does not hide tabs the listing already has. */
  note?: string;
}

const SAVED_NOTE = {
  denied: "Chrome's folder is not readable, so tabs were not read from disk.",
  unreadable: "A session file could not be read, so tabs were not read from disk.",
} as const;

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

function directoryOf(reported: string | undefined, root: string, directories: readonly string[]): string | undefined {
  if (!reported || !path.isAbsolute(reported)) return undefined;
  const directory = path.basename(reported);
  if (!PROFILE_DIRECTORY.test(directory) || !directories.includes(directory)) return undefined;
  const parent = path.dirname(reported);
  if (path.resolve(parent) === path.resolve(root)) return directory;
  try { if (realpathSync(parent) === realpathSync(root)) return directory; }
  catch { return undefined; }
  return undefined;
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

function keptTab(target: TargetInfo): ProfileTab | undefined {
  if (target.type !== "page" || !target.url) return undefined;
  const host = tabHost(target.url);
  if (!host) return undefined;
  return { title: safeTitle(target.title ?? ""), host };
}

interface ContextFolder {
  directory?: string;
  /** The context the version tab landed in. Chrome's default id cannot be passed back to createTarget. */
  contextId?: string;
}

/**
 * Groups page targets by profile folder. The focused profile is the one a hidden chrome://version tab
 * lands in when no context is named. Chrome rejects createTarget for another profile's context, and the
 * only other way to learn that folder is to open a window. This does not open one. Those tabs are counted,
 * and their addresses are not returned. Closes each version tab it opens. Does not close the caller's socket.
 */
export async function readProfileTabs(cdp: TabSocket, root: string, directories: readonly string[]): Promise<ProfileTabListing> {
  const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets", {}, undefined, 2000);
  const byContext = new Map<string, ProfileTab[]>();
  for (const target of targetInfos) {
    const tab = keptTab(target);
    if (!tab) continue;
    const key = target.browserContextId ?? "";
    const list = byContext.get(key) ?? [];
    list.push(tab);
    byContext.set(key, list);
  }
  const folderOf = new Map<string, string>();
  const deadline = Date.now() + READ_BUDGET_MS;
  const focused = await contextDirectory(cdp, undefined, root, directories).catch(() => undefined);
  if (focused?.directory) {
    folderOf.set(focused.contextId ?? "", focused.directory);
    folderOf.set("", focused.directory);
  }
  for (const contextId of byContext.keys()) {
    if (!contextId || folderOf.has(contextId) || Date.now() >= deadline) continue;
    const found = await contextDirectory(cdp, contextId, root, directories).catch(() => undefined);
    if (found?.directory) folderOf.set(contextId, found.directory);
  }
  const byDirectory: Record<string, ProfileTabGroup> = {};
  let unmatched = 0;
  for (const [contextId, tabs] of byContext) {
    const directory = folderOf.get(contextId);
    if (!directory) {
      unmatched += tabs.length;
      continue;
    }
    const prior = byDirectory[directory]?.tabs ?? [];
    byDirectory[directory] = capTabs([...prior, ...tabs]);
  }
  return { byDirectory, ...(unmatched ? { unmatched } : {}) };
}

async function contextDirectory(cdp: TabSocket, contextId: string | undefined, root: string, directories: readonly string[]): Promise<ContextFolder | undefined> {
  const params: Record<string, unknown> = { url: "chrome://version", background: true, hidden: true };
  if (contextId) params.browserContextId = contextId;
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", params, undefined, CONTEXT_MS);
  try {
    const info = await cdp.send<{ targetInfo?: { browserContextId?: string } }>("Target.getTargetInfo", { targetId }, undefined, CONTEXT_MS).catch(() => undefined);
    const landed = contextId ?? info?.targetInfo?.browserContextId;
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, undefined, CONTEXT_MS);
    const deadline = Date.now() + CONTEXT_MS;
    while (Date.now() < deadline) {
      const { result } = await cdp.send<{ result: { value?: unknown } }>("Runtime.evaluate",
        { expression: "document.getElementById('profile_path')?.textContent || ''", returnByValue: true }, sessionId, 1000);
      if (typeof result.value === "string" && result.value.trim()) {
        return { directory: directoryOf(result.value.trim(), root, directories), contextId: landed };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { contextId: landed };
  } finally {
    await cdp.send("Target.closeTarget", { targetId }, undefined, 1000).catch(() => undefined);
  }
}

/**
 * Open tabs for the profile question. Reads each profile's session files, so an unfocused profile is named without opening a window.
 * A failed disk read keeps the listener counts, when Chrome is already listening, and says why the files were not used.
 */
export async function listProfileTabs(root: string, directories: readonly string[]): Promise<ProfileTabListing> {
  let saved;
  try {
    saved = await readSavedProfileTabs(root, directories);
  } catch {
    saved = { ok: false as const, reason: "unreadable" as const };
  }
  const live = await readListeningProfileTabs(root, directories);
  if (!saved.ok) return { ...live, note: SAVED_NOTE[saved.reason] };
  return withLiveTitles(savedListing(saved.byDirectory), live);
}

function savedListing(byDirectory: Record<string, SavedTab[]>): ProfileTabListing {
  const listed: Record<string, ProfileTabGroup> = {};
  for (const [directory, tabs] of Object.entries(byDirectory)) listed[directory] = capTabs(tabs.flatMap(savedTab));
  return { byDirectory: listed };
}

function savedTab(tab: SavedTab): ProfileTab[] {
  const host = tabHost(tab.url);
  return host ? [{ title: safeTitle(tab.title), host }] : [];
}

/** Live titles replace saved ones for the same host. A live tab the session file has not flushed yet is added to that profile. */
function withLiveTitles(saved: ProfileTabListing, live: ProfileTabListing): ProfileTabListing {
  if (live.unread) return saved;
  const byDirectory = { ...saved.byDirectory };
  for (const [directory, liveGroup] of Object.entries(live.byDirectory)) {
    const group = byDirectory[directory] ?? { tabs: [], omitted: 0 };
    const hosts = new Set(group.tabs.map((tab) => tab.host));
    const titled = group.tabs.map((tab) => {
      const liveTab = liveGroup.tabs.find((item) => item.host === tab.host && item.title);
      return liveTab ? { ...tab, title: liveTab.title } : tab;
    });
    byDirectory[directory] = capTabs([...titled, ...liveGroup.tabs.filter((tab) => !hosts.has(tab.host))]);
  }
  return { byDirectory };
}

/**
 * Tabs from a debugger that is already listening on this Chrome folder.
 * A hermetic run does not scan or connect: a test that did would raise the owner's Allow sheet.
 * This connects its own socket and closes it before returning. It does not turn debugging on,
 * and it does not join the Chrome hold, so nothing is left on for a later session to end.
 */
export async function readListeningProfileTabs(root: string, directories: readonly string[]): Promise<ProfileTabListing> {
  if (process.env.BAO_LANE === "hermetic") return { byDirectory: {}, unread: "remote debugging is off" };
  const endpoint = await listeningEndpoint(root);
  if (!endpoint) return { byDirectory: {}, unread: "remote debugging is off" };
  let cdp: CdpSocket | undefined;
  try {
    cdp = await connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 2000 });
    return await readProfileTabs(cdp, root, directories);
  } catch {
    return { byDirectory: {}, unread: "remote debugging is off" };
  } finally {
    cdp?.close();
  }
}

async function listeningEndpoint(root: string): Promise<DevToolsEndpoint | undefined> {
  try { return await readDevToolsActivePort(path.join(root, "DevToolsActivePort")); }
  catch { return undefined; }
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
    if (read.unread) return `${name}: open tabs were not read (${read.unread})${mark}`;
    const group = read.byDirectory[profile.directory];
    const tabs = group?.tabs ?? [];
    const body = tabs.length ? tabs.map(tabText).join("; ") : "no open tabs";
    const more = group?.omitted ? `; and ${group.omitted} more` : "";
    return `${name}: ${body}${more}${mark}`;
  });
  const unmatched = read.unmatched ? [`${read.unmatched} open tabs could not be matched to a profile.`] : [];
  const note = read.note ? [read.note] : [];
  return [head, ...lines, ...unmatched, ...note].join("\n");
}

/** The example folder is a call shape, not the profile the model should pick. */
export function agentProfileRetry(call: Record<string, unknown>, example: string): string {
  const retry = { ...call, profile: example, profile_reason: "why this profile" };
  return `Pick the folder yourself. Ask the person only if no profile fits the task. The example folder is a call shape, not the answer. Then call agent_browser again with that folder and a short profile_reason: ${JSON.stringify(retry)}`;
}
