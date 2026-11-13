/**
 * The newest Sessions/Session_* file maps a profile folder to the URLs Chrome last wrote for it.
 * Those URLs are not the open tabs. Tabs_ and Current Session are not read.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface SavedTab {
  url: string;
  title: string;
}

export type SessionFailure = "denied" | "unreadable" | "absent";

export interface ProfileSessions {
  urls: Record<string, string[]>;
  failed: Record<string, SessionFailure>;
}

const PROFILE_DIRECTORY = /^(?:Default|Profile \d+)$/;

export async function readSavedProfileTabs(root: string, directories: readonly string[]): Promise<ProfileSessions> {
  const urls: Record<string, string[]> = {};
  const failed: Record<string, SessionFailure> = {};
  for (const directory of directories) {
    if (!PROFILE_DIRECTORY.test(directory)) continue;
    try {
      const tabs = await readProfileSession(path.join(root, directory));
      if (!tabs) failed[directory] = "absent";
      else urls[directory] = tabs.map((tab) => tab.url);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      failed[directory] = code === "EPERM" || code === "EACCES" ? "denied" : "unreadable";
    }
  }
  return { urls, failed };
}

async function readProfileSession(profileDir: string): Promise<SavedTab[] | undefined> {
  const file = await newestSessionFile(profileDir);
  if (!file) return undefined;
  const session = openTabsFromSnss(await readFile(file));
  if (!session) throw new Error("session file could not be read");
  return session;
}

async function newestSessionFile(profileDir: string): Promise<string | undefined> {
  const dir = path.join(profileDir, "Sessions");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const session = newest(names, "Session_");
  return session ? path.join(dir, session) : undefined;
}

function newest(names: string[], prefix: string): string | undefined {
  let best: { name: string; stamp: bigint } | undefined;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    let stamp: bigint;
    try { stamp = BigInt(name.slice(prefix.length)); }
    catch { continue; }
    if (!best || stamp > best.stamp) best = { name, stamp };
  }
  return best?.name;
}

/**
 * Selected http(s) entries in one Session_* file. Undefined means the file is not a current session file or a command is cut off.
 * Command 6 is a session navigation. Command 24 deletes navigation entries and shifts the indexes that follow.
 */
export function openTabsFromSnss(buf: Buffer): SavedTab[] | undefined {
  if (buf.length < 8 || buf.subarray(0, 4).toString("latin1") !== "SNSS") return undefined;
  if (buf.readUInt32LE(4) !== 3) return undefined;
  const tabs = new Map<number, TabState>();
  const closedWindows = new Set<number>();
  let offset = 8;
  while (offset + 3 <= buf.length) {
    const size = buf.readUInt16LE(offset);
    if (size < 1 || offset + 2 + size > buf.length) return undefined;
    const id = buf[offset + 2];
    const payload = buf.subarray(offset + 3, offset + 2 + size);
    offset += 2 + size;
    if (id === 6 && payload.length >= 16) {
      const nav = readNavigation(payload);
      if (!nav) continue;
      const tab = state(tabs, nav.tab);
      tab.closed = false;
      tab.history.set(nav.index, { url: nav.url, title: nav.title });
    } else if (id === 24 && payload.length >= 12) {
      const count = payload.readInt32LE(8);
      if (count > 0) pruneHistory(state(tabs, payload.readUInt32LE(0)), payload.readInt32LE(4), count);
    } else if (id === 16 && payload.length >= 4) {
      state(tabs, payload.readUInt32LE(0)).closed = true;
    } else if (id === 17 && payload.length >= 4) {
      closedWindows.add(payload.readUInt32LE(0));
    } else if (id === 0 && payload.length >= 8) {
      state(tabs, payload.readUInt32LE(4)).window = payload.readUInt32LE(0);
    } else if (id === 7 && payload.length >= 8) {
      state(tabs, payload.readUInt32LE(0)).current = payload.readInt32LE(4);
    }
  }
  const open: SavedTab[] = [];
  for (const tab of tabs.values()) {
    if (tab.closed || (tab.window !== undefined && closedWindows.has(tab.window)) || !tab.history.size) continue;
    const entry = selectedEntry(tab);
    if (entry) open.push(entry);
  }
  return open;
}

interface TabState {
  history: Map<number, SavedTab>;
  current?: number;
  closed: boolean;
  window?: number;
}

function state(tabs: Map<number, TabState>, id: number): TabState {
  let tab = tabs.get(id);
  if (!tab) {
    tab = { history: new Map(), closed: false };
    tabs.set(id, tab);
  }
  return tab;
}

function pruneHistory(tab: TabState, index: number, count: number): void {
  if (index < 0) return;
  if (tab.current !== undefined) {
    if (tab.current >= index && tab.current < index + count) tab.current = index - 1;
    else if (tab.current >= index + count) tab.current -= count;
  }
  const next = new Map<number, SavedTab>();
  for (const [key, entry] of tab.history) {
    if (key >= index && key < index + count) continue;
    next.set(key >= index ? key - count : key, entry);
  }
  tab.history = next;
}

function selectedEntry(tab: TabState): SavedTab | undefined {
  const keys = [...tab.history.keys()].sort((a, b) => a - b);
  if (!keys.length) return undefined;
  const wanted = tab.current ?? keys[keys.length - 1]!;
  const found = keys.find((key) => key >= wanted) ?? keys[keys.length - 1]!;
  return tab.history.get(found);
}

function readNavigation(payload: Buffer): { tab: number; index: number; url: string; title: string } | undefined {
  const url = readString(payload, 12);
  if (!url || !/^https?:\/\//.test(url.text)) return undefined;
  const title = readString16(payload, url.offset);
  if (!title) return undefined;
  return { tab: payload.readUInt32LE(4), index: payload.readInt32LE(8), url: url.text, title: title.text };
}

function readString(buf: Buffer, offset: number): { text: string; offset: number } | undefined {
  if (offset + 4 > buf.length) return undefined;
  const len = buf.readInt32LE(offset);
  offset += 4;
  if (len < 0 || len > 100_000 || offset + len > buf.length) return undefined;
  const text = buf.subarray(offset, offset + len).toString("utf8");
  return { text, offset: offset + len + (4 - (len % 4)) % 4 };
}

function readString16(buf: Buffer, offset: number): { text: string; offset: number } | undefined {
  if (offset + 4 > buf.length) return undefined;
  const len = buf.readInt32LE(offset);
  offset += 4;
  const bytes = len * 2;
  if (len < 0 || len > 10_000 || offset + bytes > buf.length) return undefined;
  const chars: number[] = [];
  for (let i = 0; i < bytes; i += 2) chars.push(buf.readUInt16LE(offset + i));
  return { text: String.fromCharCode(...chars), offset: offset + bytes + (4 - (bytes % 4)) % 4 };
}
