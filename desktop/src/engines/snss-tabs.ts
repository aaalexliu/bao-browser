/**
 * Chrome writes each profile's open tabs under Sessions/. Session_* is a command log with close commands.
 * Tabs_* is a snapshot with titles. One file is not enough: the newest snapshot can omit an open tab or keep a closed one.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface SavedTab {
  url: string;
  title: string;
}

export type SavedRead =
  | { ok: true; byDirectory: Record<string, SavedTab[]> }
  | { ok: false; reason: "denied" | "unreadable" };

const PROFILE_DIRECTORY = /^(?:Default|Profile \d+)$/;

export async function readSavedProfileTabs(root: string, directories: readonly string[]): Promise<SavedRead> {
  const byDirectory: Record<string, SavedTab[]> = {};
  for (const directory of directories) {
    if (!PROFILE_DIRECTORY.test(directory)) continue;
    try {
      byDirectory[directory] = await readProfileSession(path.join(root, directory));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { ok: false, reason: code === "EPERM" || code === "EACCES" ? "denied" : "unreadable" };
    }
  }
  return { ok: true, byDirectory };
}

async function readProfileSession(profileDir: string): Promise<SavedTab[]> {
  const files = await newestSessionFiles(profileDir);
  if (!files) return [];
  const session = files.session ? openTabsFromSnss(await readFile(files.session)) : undefined;
  if (files.session && !session) throw new Error("session file could not be read");
  const snapshot = files.tabs ? openTabsFromSnss(await readFile(files.tabs)) : undefined;
  if (!session && files.tabs && !snapshot) throw new Error("session file could not be read");
  const titles = new Map((snapshot ?? []).map((tab) => [tab.url, tab.title]));
  return (session ?? snapshot ?? []).map((tab) => ({ url: tab.url, title: titles.get(tab.url) || tab.title }));
}

async function newestSessionFiles(profileDir: string): Promise<{ session?: string; tabs?: string } | undefined> {
  const dir = path.join(profileDir, "Sessions");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return legacyFiles(profileDir);
    throw error;
  }
  const session = newest(names, "Session_");
  const tabs = newest(names, "Tabs_");
  if (!session && !tabs) return legacyFiles(profileDir);
  return {
    ...(session ? { session: path.join(dir, session) } : {}),
    ...(tabs ? { tabs: path.join(dir, tabs) } : {}),
  };
}

async function legacyFiles(profileDir: string): Promise<{ session?: string; tabs?: string } | undefined> {
  const session = path.join(profileDir, "Current Session");
  const tabs = path.join(profileDir, "Current Tabs");
  const found = {
    ...(await exists(session) ? { session } : {}),
    ...(await exists(tabs) ? { tabs } : {}),
  };
  return found.session || found.tabs ? found : undefined;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
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
 * Open tabs in one SNSS file. Undefined means the file is not a session file or a command is cut off.
 * Command 6 is a session navigation. Command 1 is the same pickle in a Tabs_ snapshot.
 */
export function openTabsFromSnss(buf: Buffer): SavedTab[] | undefined {
  if (buf.length < 8 || buf.subarray(0, 4).toString("latin1") !== "SNSS") return undefined;
  const version = buf.readUInt32LE(4);
  if (version !== 1 && version !== 3) return undefined;
  const tabs = new Map<number, TabState>();
  const closedWindows = new Set<number>();
  let offset = 8;
  while (offset + 3 <= buf.length) {
    const size = buf.readUInt16LE(offset);
    if (size < 1 || offset + 2 + size > buf.length) return undefined;
    const id = buf[offset + 2];
    const payload = buf.subarray(offset + 3, offset + 2 + size);
    offset += 2 + size;
    if ((id === 6 || id === 1) && payload.length >= 16) {
      const nav = readNavigation(payload);
      if (!nav) continue;
      const tab = state(tabs, nav.tab);
      tab.closed = false;
      tab.history.set(nav.index, { url: nav.url, title: nav.title });
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
    const index = tab.current ?? Math.max(...tab.history.keys());
    const entry = tab.history.get(index);
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
