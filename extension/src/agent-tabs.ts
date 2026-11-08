// Bao's tabs in the owner's own Chrome. They open in the background, sit in one grey "Bao" group per window at the
// start of the strip, and stay collapsed unless the owner is on one of them or a handoff holds the group open.
// The desktop relay drives them through chrome.debugger. A tab the owner opened is never a Bao tab.

import type { RelayEvent } from "../../shared/agent-tabs";

const TITLE = "Bao";
const NONE = -1;
const STORE = "bao-agent-tabs";

interface Saved {
  /** windowId -> the window's Bao group. */
  groups: Record<string, number>;
  tabs: number[];
}

let saved: Saved = { groups: {}, tabs: [] };
const baoTabs = new Set<number>();
/** Tabs a handoff holds open: their group stays expanded until the handoff settles. */
const held = new Set<number>();
/** Tabs between tabs.create and joining the group, so their first group change is not read as the owner's move. */
const joining = new Set<number>();
/** Recent active tabs per window, newest last, to give the owner his tab back when a Bao page opens one in front. */
const activated = new Map<number, number[]>();
let emit: (event: RelayEvent) => void = () => undefined;

let queue: Promise<unknown> = Promise.resolve();
function serially<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

async function persist(): Promise<void> {
  saved.tabs = [...baoTabs];
  await chrome.storage.session.set({ [STORE]: saved });
}

function isBaoGroup(groupId: number): boolean {
  return groupId !== NONE && Object.values(saved.groups).includes(groupId);
}

async function isHeld(groupId: number): Promise<boolean> {
  if (!held.size) return false;
  const tabs = await chrome.tabs.query({ groupId }).catch(() => []);
  return tabs.some((tab) => tab.id !== undefined && held.has(tab.id));
}

/** Chrome switches the owner to another tab when it collapses a group that holds his active tab, so that group stays open. */
async function collapseUnlessActive(groupId: number): Promise<void> {
  const group = await chrome.tabGroups.get(groupId).catch(() => undefined);
  if (!group || group.collapsed) return;
  const [active] = await chrome.tabs.query({ active: true, windowId: group.windowId });
  if (active?.groupId === groupId || await isHeld(groupId)) return;
  await chrome.tabGroups.update(groupId, { collapsed: true }).catch(() => undefined);
}

async function foldAway(windowId: number): Promise<void> {
  const groupId = saved.groups[String(windowId)];
  if (groupId !== undefined) await collapseUnlessActive(groupId);
}

/** The group sits right after the pinned tabs, so it does not drift as the owner opens tabs at the end. */
async function keepFirst(windowId: number, groupId: number): Promise<void> {
  const tabs = await chrome.tabs.query({ windowId });
  const pinned = tabs.filter((tab) => tab.pinned).length;
  if (tabs.findIndex((tab) => tab.groupId === groupId) === pinned) return;
  await chrome.tabGroups.move(groupId, { index: pinned });
}

async function joinGroup(tabId: number, windowId: number): Promise<void> {
  const key = String(windowId);
  let groupId = saved.groups[key];
  const existing = groupId === undefined ? undefined : await chrome.tabGroups.get(groupId).catch(() => undefined);
  if (existing?.windowId === windowId) {
    await chrome.tabs.group({ groupId: existing.id, tabIds: [tabId] });
  } else {
    groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
    saved.groups[key] = groupId;
    await chrome.tabGroups.update(groupId, { title: TITLE, color: "grey", collapsed: true });
  }
  await persist();
  await keepFirst(windowId, groupId!);
  await collapseUnlessActive(groupId!);
}

async function targetIdOf(tabId: number): Promise<string> {
  const target = (await chrome.debugger.getTargets()).find((item) => item.tabId === tabId);
  if (!target) throw new Error(`no debugger target for tab ${tabId}`);
  return target.id;
}

async function adopt(tab: chrome.tabs.Tab): Promise<void> {
  const tabId = tab.id!;
  await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => undefined);
  const window = await chrome.windows.get(tab.windowId).catch(() => undefined);
  joining.add(tabId);
  try {
    if (window?.type === "normal") await serially(() => joinGroup(tabId, tab.windowId));
  } finally {
    joining.delete(tabId);
  }
  await chrome.debugger.attach({ tabId }, "1.3");
}

async function open(url: string): Promise<{ tabId: number; targetId: string; url: string; title: string }> {
  const owner = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => undefined);
  let tab: chrome.tabs.Tab;
  if (owner?.id !== undefined) tab = await chrome.tabs.create({ windowId: owner.id, url: "about:blank", active: false });
  else {
    const window = await chrome.windows.create({ url: "about:blank", focused: false, type: "normal" });
    const first = window?.tabs?.[0];
    if (!first) throw new Error("Chrome did not open a window for Bao");
    tab = first;
  }
  const tabId = tab.id!;
  baoTabs.add(tabId);
  const [front] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (front?.id !== undefined) noteActive(tab.windowId, front.id);
  try {
    await adopt(tab);
    // A new background tab that never navigated can leave page commands such as Page.enable unanswered. One navigation,
    // even to about:blank, gives it a live document first.
    await chrome.debugger.sendCommand({ tabId }, "Page.navigate", { url: url || "about:blank" });
    return { tabId, targetId: await targetIdOf(tabId), url: url || "about:blank", title: "" };
  } catch (error) {
    await close([tabId]);
    throw error;
  }
}

async function forget(tabId: number): Promise<chrome.tabs.Tab | undefined> {
  baoTabs.delete(tabId);
  held.delete(tabId);
  await persist();
  await chrome.debugger.detach({ tabId }).catch(() => undefined);
  return chrome.tabs.get(tabId).catch(() => undefined);
}

/** Closes Bao's own tabs. Emptying a group by ungrouping deletes it; closing its last tab can leave a saved group. */
async function close(tabIds: number[]): Promise<void> {
  for (const tabId of tabIds.filter((id) => baoTabs.has(id))) {
    const tab = await forget(tabId);
    if (!tab) continue;
    if (isBaoGroup(tab.groupId) && (await chrome.tabs.query({ groupId: tab.groupId })).length === 1) {
      await chrome.tabs.ungroup(tabId).catch(() => undefined);
    }
    await chrome.tabs.remove(tabId).catch(() => undefined);
  }
}

/** Hands Bao tabs to the owner: the debugger lets go and the tabs leave the group, still open. */
async function release(tabIds: number[]): Promise<void> {
  for (const tabId of tabIds.filter((id) => baoTabs.has(id))) {
    const tab = await forget(tabId);
    if (tab && isBaoGroup(tab.groupId)) await chrome.tabs.ungroup(tabId).catch(() => undefined);
  }
}

/**
 * A handoff opens the group and holds it open, so the owner can see the tab that needs him. It never switches his
 * tab or raises his window; he clicks the tab when he is ready. `front` is for the owner's own request to see the tab.
 */
async function show(tabId: number, front: boolean): Promise<void> {
  if (!baoTabs.has(tabId)) throw new Error("not a Bao tab");
  const tab = await chrome.tabs.get(tabId);
  if (front) {
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
    return;
  }
  held.add(tabId);
  if (isBaoGroup(tab.groupId)) await chrome.tabGroups.update(tab.groupId, { collapsed: false });
}

async function settle(tabId: number): Promise<void> {
  held.delete(tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (tab && isBaoGroup(tab.groupId)) await collapseUnlessActive(tab.groupId);
}

async function info(tabIds: number[]): Promise<{ tabId: number; url: string; title: string }[]> {
  const tabs = await Promise.all(tabIds.filter((id) => baoTabs.has(id)).map((id) => chrome.tabs.get(id).catch(() => undefined)));
  return tabs.flatMap((tab) => tab?.id === undefined ? [] : [{ tabId: tab.id, url: tab.url || tab.pendingUrl || "", title: tab.title || "" }]);
}

function tabIdsOf(cmd: Record<string, unknown>): number[] {
  return Array.isArray(cmd.tabIds) ? cmd.tabIds.map(Number) : [];
}

export async function performRelay(cmd: Record<string, unknown>): Promise<unknown> {
  const tabId = Number(cmd.tabId);
  switch (cmd.op) {
    case "version": return { userAgent: navigator.userAgent };
    case "open": return open(String(cmd.url || ""));
    case "send": {
      if (!baoTabs.has(tabId)) throw new Error("not a Bao tab");
      const target: chrome.debugger.DebuggerSession = { tabId, ...(typeof cmd.sessionId === "string" ? { sessionId: cmd.sessionId } : {}) };
      return await chrome.debugger.sendCommand(target, String(cmd.method), (cmd.params || {}) as Record<string, unknown>) ?? {};
    }
    case "info": return info(tabIdsOf(cmd));
    case "show": return show(tabId, cmd.front === true).then(() => ({}));
    case "settle": return settle(tabId).then(() => ({}));
    case "close": return serially(() => close(tabIdsOf(cmd))).then(() => ({}));
    case "release": return serially(() => release(tabIdsOf(cmd))).then(() => ({}));
    default: throw new Error(`unknown relay op ${String(cmd.op)}`);
  }
}

/** No relay survives the native port, so tabs from before are handed to the owner. */
export async function releaseAll(): Promise<void> {
  await serially(() => release([...baoTabs]));
}

export async function startAgentTabs(post: (event: RelayEvent) => void): Promise<void> {
  emit = post;
  saved = ((await chrome.storage.session.get(STORE))[STORE] as Saved | undefined) ?? { groups: {}, tabs: [] };
  for (const tabId of saved.tabs) baoTabs.add(tabId);
  await releaseAll();
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined || !baoTabs.has(source.tabId)) return;
  emit({ kind: "cdp", tabId: source.tabId, ...(source.sessionId ? { sessionId: source.sessionId } : {}), method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (tabId === undefined || !baoTabs.has(tabId)) return;
  if (reason === "target_closed") return;
  // Cancel on Chrome's debugging bar: the owner stopped Bao. The tab is his now.
  void serially(() => release([tabId])).then(() => emit({ kind: "detached", tabId, reason }));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!baoTabs.has(tabId)) return;
  baoTabs.delete(tabId);
  held.delete(tabId);
  void persist();
  emit({ kind: "removed", tabId });
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!baoTabs.has(tabId)) return;
  const left = change.pinned === true || (change.groupId !== undefined && !joining.has(tabId) && !isBaoGroup(tab.groupId));
  if (left) {
    // The owner pinned the tab or moved it out of the group. It is his now.
    void serially(() => release([tabId])).then(() => emit({ kind: "removed", tabId }));
    return;
  }
  if (change.url !== undefined || change.title !== undefined) emit({ kind: "info", tabId, url: tab.url || "", title: tab.title || "" });
});

function noteActive(windowId: number, tabId: number): void {
  const recent = (activated.get(windowId) ?? []).filter((id) => id !== tabId);
  activated.set(windowId, [...recent, tabId].slice(-8));
}

// tabs.onCreated names the owner's active tab as the opener of a link a background tab opened, so the source comes from here.
chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId }) => {
  if (!baoTabs.has(sourceTabId) || baoTabs.has(tabId)) return;
  baoTabs.add(tabId);
  void (async () => {
    // A page in a Bao tab opened this one. It joins the group, and the owner keeps the tab he was on.
    const tab = await chrome.tabs.get(tabId);
    const back = (activated.get(tab.windowId) ?? []).filter((id) => !baoTabs.has(id)).at(-1);
    if (tab.active && back !== undefined) await chrome.tabs.update(back, { active: true }).catch(() => undefined);
    await adopt(tab);
    emit({ kind: "opened", tabId, openerTabId: sourceTabId, targetId: await targetIdOf(tabId), url: tab.url || tab.pendingUrl || "", title: tab.title || "" });
  })().catch(() => {
    void serially(() => release([tabId]));
  });
});

// Focus emulation keeps a folded page painting, running timers, and taking input. Sent to a fresh background about:blank
// tab, it leaves the first navigation stuck, so each page gets it once it commits.
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0 || !baoTabs.has(tabId) || url === "about:blank") return;
  void chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  noteActive(windowId, tabId);
  void foldAway(windowId);
});

chrome.tabGroups.onRemoved.addListener((group) => {
  for (const [windowId, groupId] of Object.entries(saved.groups)) if (groupId === group.id) delete saved.groups[windowId];
  void persist();
});
