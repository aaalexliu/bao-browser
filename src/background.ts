// Bao M0 — service worker.
// The record/replay core lives in content.ts (one instance per frame, since the
// manifest injects with all_frames). This worker's job for cross-origin frames:
//  1) collect each frame's recorded steps (a parent content script can't read a
//     cross-origin child's DOM, but every frame can message the SW), and
//  2) at replay, route each step to the live frame it was recorded in — resolving
//     the recorded FrameRef (origin/url) to a current frameId via webNavigation.

import type { FrameRef, Msg, RecState, ReplayResponse, RunState, Step, StepResult } from "./types";

// The SW's harness-visible API: the e2e tests drive these via sw.evaluate, so they
// must live on the worker global under exactly these names.
declare global {
  var __baoSteps: Step[];
  var baoRecStart: (tabId: number) => Promise<{ ok: boolean }>;
  var baoRecStop: () => Promise<Step[]>;
  var baoRunStart: (tabId: number, steps: Step[]) => Promise<{ ok: boolean; runId: string }>;
  var baoRunStatus: () => Promise<RunState | null>;
  var baoRunContinue: () => Promise<{ ok: boolean }>;
  var baoDrainSteps: () => Step[];
  var baoSetForceOpen: (on: boolean) => Promise<{ ok: boolean; on?: boolean; error?: string }>;
  var baoReplayAcrossFrames: (tabId: number, steps: Step[]) => Promise<ReplayResponse>;
  var __baoRecentDownloads: { id: number; filename: string; ts: number }[];
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("[bao-m0] service worker installed");
});

// Cross-frame recording buffer. The e2e harness resets it before a run and reads it
// after, so it lives on `self` (the SW global) rather than in chrome.storage for M0.
self.__baoSteps = self.__baoSteps || [];

chrome.runtime.onMessage.addListener((msg: Msg | undefined, sender, sendResponse) => {
  if (!msg) return;
  if (msg.cmd === "bao-reset") { self.__baoSteps = []; return; }
  if (msg.cmd === "bao-frame-steps" && Array.isArray(msg.steps)) {
    // sender.frameId / sender.url are authoritative (the content script can lie about
    // neither); merge them onto the frame ref the content script reported.
    for (const step of msg.steps) {
      self.__baoSteps.push({
        ...step,
        frame: { ...(step.frame || {}), frameId: sender.frameId, url: sender.url, top: sender.frameId === 0 },
      });
    }
    return;
  }
  // ---- M1 messages (recording stream, boot handshake, popup controls) ----
  if (msg.cmd === "bao-step" && msg.step) { onRecStep(msg.step, sender); return; }
  if (msg.cmd === "bao-boot") { onBoot(sender).then(sendResponse); return true; }
  if (msg.cmd === "bao-rec-start") { baoRecStart(msg.tabId).then(sendResponse); return true; }
  if (msg.cmd === "bao-rec-stop") { baoRecStop().then((steps) => sendResponse({ steps })); return true; }
  if (msg.cmd === "bao-run-start") { baoRunStart(msg.tabId, msg.steps).then(sendResponse); return true; }
  if (msg.cmd === "bao-run-status") { getRun().then(sendResponse); return true; }
  if (msg.cmd === "bao-run-continue") { baoRunContinue().then(sendResponse); return true; }
});

// ============================ M1 — cross-navigation ============================
// Every full-document navigation destroys the content script, and MV3 kills this
// worker whenever it likes. So neither holds state: the recording trace lives in
// chrome.storage.session and the replay RunState in chrome.storage.local; both the
// SW and the content script rehydrate from storage on every wake (m1-design §0).
const REC_KEY = "baoRec";
const RUN_KEY = "baoRun";
const NAV_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

const basename = (p: string) => (p || "").split(/[\\/]/).pop() || "";
// The download's identity is its URL's last path segment (e.g. "report.csv"), NOT the
// on-disk filename — the latter is environment-specific (a random UUID under a managed
// downloads dir, "report (1).csv" on a name collision) and differs record-vs-replay.
const downloadName = (item: { finalUrl?: string; url?: string }) => {
  try { return basename(new URL(item.finalUrl || item.url || "").pathname); } catch { return ""; }
};
// A download that completed can beat the tick that transitions us into
// awaiting_download (click → download → complete, all within one SW turn). Keep the
// most-recent completions in SW memory so that transition can catch an already-done
// one. SW death loses this, but so does the in-flight download — the watchdog fails
// such a run honestly rather than hanging.
self.__baoRecentDownloads = self.__baoRecentDownloads || [];
const noteDownloadDone = (id: number, filename: string) => {
  self.__baoRecentDownloads.push({ id, filename, ts: Date.now() });
  if (self.__baoRecentDownloads.length > 20) self.__baoRecentDownloads.shift();
};

// All state transitions are read-modify-write on storage; serialize them so two
// events (boot ping + onCompleted, say) can't interleave and double-advance.
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch((e) => console.warn("[bao-m1]", e));
  return p;
}

const getRec = async (): Promise<RecState | null> =>
  ((await chrome.storage.session.get(REC_KEY))[REC_KEY] as RecState | undefined) || null;
const setRec = (rec: RecState | null) =>
  rec ? chrome.storage.session.set({ [REC_KEY]: rec }) : chrome.storage.session.remove(REC_KEY);
const getRun = async (): Promise<RunState | null> =>
  ((await chrome.storage.local.get(RUN_KEY))[RUN_KEY] as RunState | undefined) || null;
const setRun = (run: RunState | null) =>
  run ? chrome.storage.local.set({ [RUN_KEY]: run }) : chrome.storage.local.remove(RUN_KEY);

// Record-time id ≠ replay-time id: wildcard digit runs when matching URLs (same
// normalization the T7 soft-nav markers use).
function urlMatches(pattern: string, url: string): boolean {
  try { return new RegExp(`^${pattern}$`).test(url); } catch (_) { return false; }
}
const urlPatternOf = (u: string) => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\d+/g, "\\d+");

// ---- recording across navigations (T8 phase 1) ----
self.baoRecStart = async (tabId) => {
  await setRec({ tabId, steps: [] });
  // Arm content scripts already alive in the tab; documents created later re-arm
  // themselves via the boot handshake.
  try { await chrome.tabs.sendMessage(tabId, { cmd: "start-record" }); } catch (_) {}
  return { ok: true };
};
self.baoRecStop = async () => {
  const rec = await getRec();
  await setRec(null);
  if (!rec) return [];
  try { await chrome.tabs.sendMessage(rec.tabId, { cmd: "stop-record" }); } catch (_) {}
  return rec.steps.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
};
function onRecStep(step: Step, sender: chrome.runtime.MessageSender): void {
  enqueue(async () => {
    const rec = await getRec();
    if (!rec || !sender.tab || sender.tab.id !== rec.tabId) return;
    const merged: Step = {
      ...step,
      frame: { ...(step.frame || {}), frameId: sender.frameId, url: sender.url, top: sender.frameId === 0 },
    };
    const i = rec.steps.findIndex((s) => s.seq === step.seq);
    if (i >= 0) rec.steps[i] = merged; else rec.steps.push(merged);
    await setRec(rec);
  });
}

// ---- replay across navigations (T8 phase 2): the RunState machine ----
// phases: executing → (navigate step) awaiting_nav → executing … → done | failed,
// with paused_for_user as the resumable pause (T8 phase 3). Event-driven only:
// element waits live in the content script, navigation waits on webNavigation,
// timeouts on chrome.alarms — never a long timer in here.
self.baoRunStart = async (tabId, steps) => {
  const run: RunState = {
    runId: Math.random().toString(36).slice(2), tabId, steps,
    stepIndex: 0, phase: "executing", dispatched: false, results: [], lastError: null,
  };
  await setRun(run);
  tick();
  return { ok: true, runId: run.runId };
};
self.baoRunStatus = getRun;
self.baoRunContinue = async () => {
  const resumed = await enqueue(async () => {
    const run = await getRun();
    if (!run || run.phase !== "paused_for_user") return false;
    run.results.push({ i: run.stepIndex, ok: true, via: "waitForUser (user continued)" });
    run.stepIndex++; run.phase = "executing";
    await setRun(run);
    return true;
  });
  if (resumed) tick();
  return { ok: resumed };
};
async function fail(run: RunState, reason: string): Promise<void> {
  run.phase = "failed";
  run.lastError = { stepIndex: run.stepIndex, reason };
  await setRun(run);
}

type TickTodo = { kind: "check-nav" } | { kind: "dispatch"; run: RunState; step: Step } | null;

// One turn of the machine. Reads state, acts on the current step, writes state.
// The actual dispatch (which can take seconds of in-page element waiting) happens
// OUTSIDE the serialized chain so wake events aren't blocked behind it.
async function tick(): Promise<void> {
  const todo = await enqueue<TickTodo>(async () => {
    const run = await getRun();
    if (!run || run.phase !== "executing") return null;
    if (run.stepIndex >= run.steps.length) {
      run.phase = "done"; await setRun(run); return null;
    }
    const step = run.steps[run.stepIndex];
    if (step.action === "navigate") {
      run.phase = "awaiting_nav";
      run.expectedNav = { pattern: urlPatternOf(step.url || ""), deadline: Date.now() + NAV_TIMEOUT_MS };
      await setRun(run);
      chrome.alarms.create("bao-run-watchdog", { when: Date.now() + NAV_TIMEOUT_MS });
      return { kind: "check-nav" }; // the nav may already have finished — check now
    }
    if (step.action === "waitForUser") {
      run.phase = "paused_for_user"; await setRun(run); return null;
    }
    run.dispatched = true; run.dispatchedAt = Date.now();
    await setRun(run);
    return { kind: "dispatch", run, step };
  });
  if (!todo) return;
  if (todo.kind === "check-nav") return maybeResumeAfterNav();

  const { run, step } = todo;
  let res: ReplayResponse | null = null;
  try {
    res = await chrome.tabs.sendMessage(run.tabId, { cmd: "replay", steps: [step] }, { frameId: 0 });
  } catch (_) { /* document torn down mid-step, or no content script yet */ }

  const proceed = await enqueue<"tick" | "await-download" | false>(async () => {
    const cur = await getRun();
    // The world may have moved while we were dispatching (SW respawn advanced the
    // run via boot ping). Only record a result if we're still on the same step.
    if (!cur || cur.runId !== run.runId || cur.stepIndex !== run.stepIndex || cur.phase !== "executing") return false;
    if (res && res.ok === true) {
      // The click fired; if it was tagged as producing a download (T10), don't advance
      // yet — park in awaiting_download until chrome.downloads reports completion.
      if (cur.steps[cur.stepIndex]?.download) {
        cur.phase = "awaiting_download";
        cur.expectedDownload = { deadline: Date.now() + DOWNLOAD_TIMEOUT_MS, filename: cur.steps[cur.stepIndex].download!.filename };
        await setRun(cur);
        chrome.alarms.create("bao-run-watchdog", { when: Date.now() + DOWNLOAD_TIMEOUT_MS });
        return "await-download";
      }
      cur.results.push({ i: cur.stepIndex, ok: true, via: res.results?.[0]?.via });
      cur.stepIndex++; cur.dispatched = false;
      await setRun(cur);
      return "tick";
    }
    // No response and the trace says this click navigates (the next step is its
    // navigate marker): the port died because the document did — that IS success.
    const next = cur.steps[cur.stepIndex + 1];
    if (!res && next && next.action === "navigate") {
      cur.results.push({ i: cur.stepIndex, ok: true, via: "assumed-nav" });
      cur.stepIndex++; cur.dispatched = false;
      await setRun(cur);
      return "tick";
    }
    await fail(cur, res ? (res.results?.[0]?.reason || "step failed") : "content script unreachable");
    return false;
  });
  if (proceed === "tick") tick();
  else if (proceed === "await-download") maybeCompleteDownload(); // catch a completion that beat us here
}

// Resume out of awaiting_nav once the destination document exists AND answers —
// reached either from the boot ping (readyState complete) or from
// webNavigation.onCompleted, whichever lands; the phase check makes it idempotent.
async function maybeResumeAfterNav(): Promise<void> {
  const run = await getRun();
  if (!run || run.phase !== "awaiting_nav") return;
  let url: string;
  try {
    const tab = await chrome.tabs.get(run.tabId);
    url = tab.url || "";
    if (!urlMatches(run.expectedNav!.pattern, url)) return;
    await chrome.tabs.sendMessage(run.tabId, { cmd: "status" }, { frameId: 0 });
  } catch (_) { return; } // not there yet — a later wake retries
  const resumed = await enqueue(async () => {
    const cur = await getRun();
    if (!cur || cur.phase !== "awaiting_nav") return false;
    cur.results.push({ i: cur.stepIndex, ok: true, via: "navigation", url });
    cur.stepIndex++; cur.phase = "executing"; cur.dispatched = false;
    delete cur.expectedNav;
    await setRun(cur);
    return true;
  });
  if (resumed) tick();
}

// Resume out of awaiting_download once a download reports state:complete — reached
// from chrome.downloads.onChanged, or from the dispatch tick catching a completion
// that finished before we transitioned (the recent-downloads buffer). The phase check
// makes it idempotent against both firing.
async function maybeCompleteDownload(done?: { id: number; filename: string }): Promise<void> {
  const run = await getRun();
  if (!run || run.phase !== "awaiting_download") return;
  // Prefer the completion we were handed; else the newest one seen since we dispatched.
  const hit = done || self.__baoRecentDownloads
    .filter((d) => d.ts >= (run.dispatchedAt || 0) - 500)
    .sort((a, b) => b.ts - a.ts)[0];
  if (!hit) return; // not done yet — a later onChanged will call us again
  const got = basename(hit.filename);
  const want = run.expectedDownload?.filename ? basename(run.expectedDownload.filename) : "";
  // Chrome dedups filename collisions as "report (1).csv"; treat that as the same file.
  const canon = (n: string) => n.replace(/ \(\d+\)(\.[^.]*)?$/, "$1");
  const matched = !want || got === want || canon(got) === want;
  const advanced = await enqueue(async () => {
    const cur = await getRun();
    if (!cur || cur.phase !== "awaiting_download") return false;
    if (!matched) { await fail(cur, `download completed as "${got}", expected "${want}"`); return false; }
    cur.results.push({ i: cur.stepIndex, ok: true, via: "download", filename: got });
    cur.stepIndex++; cur.phase = "executing"; cur.dispatched = false;
    delete cur.expectedDownload;
    await setRun(cur);
    return true;
  });
  if (advanced) tick();
}

// Boot handshake from every fresh document (content.ts sends it at readyState
// complete). Recording: tell the new document to re-arm. Replay: this is the
// primary awaiting_nav wake, and the re-execution guard for the riskiest race —
// SW killed after dispatching a click, before its completion was recorded.
async function onBoot(sender: chrome.runtime.MessageSender): Promise<{ record?: boolean }> {
  if (!sender.tab) return {};
  const rec = await getRec();
  if (rec && sender.tab.id === rec.tabId) return { record: true };
  const run = await getRun();
  if (run && sender.tab.id === run.tabId && sender.frameId === 0) {
    if (run.phase === "awaiting_nav") maybeResumeAfterNav();
    else if (run.phase === "executing" && run.dispatched) {
      // Dispatched but never confirmed, and the document has since been replaced.
      // If the trace expected this step to navigate, treat it as completed.
      const advanced = await enqueue(async () => {
        const cur = await getRun();
        if (!cur || cur.phase !== "executing" || !cur.dispatched) return false;
        const next = cur.steps[cur.stepIndex + 1];
        const stepUrl = cur.steps[cur.stepIndex]?.frame?.url;
        if (next && next.action === "navigate" && sender.url !== stepUrl) {
          cur.results.push({ i: cur.stepIndex, ok: true, via: "assumed-nav (SW respawn)" });
          cur.stepIndex++; cur.dispatched = false;
          await setRun(cur);
          return true;
        }
        return false;
      });
      if (advanced) tick();
    }
  }
  return {};
}

chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  // Recording: a full-document nav in the recorded tab becomes a navigate step the
  // replay state machine will wait on (the recorder itself dies with the document).
  const rec = await getRec();
  if (rec && d.tabId === rec.tabId) {
    enqueue(async () => {
      const cur = await getRec();
      if (!cur || d.tabId !== cur.tabId) return;
      cur.steps.push({
        action: "navigate", label: `Navigate to ${d.url}`, url: d.url,
        wait: { type: "navigation" }, ts: Date.now(), seq: `nav-${Date.now()}`,
        frame: { url: d.url, top: true },
      });
      await setRec(cur);
    });
  }
  // Replay: make sure the fresh document gets a content script early (the manifest
  // injects at document_idle anyway; this is belt-and-braces, and idempotent).
  const run = await getRun();
  if (run && d.tabId === run.tabId && !["done", "failed"].includes(run.phase)) {
    try { await chrome.scripting.executeScript({ target: { tabId: d.tabId }, files: ["dist/content.js"] }); } catch (_) {}
  }
});
chrome.webNavigation.onCompleted.addListener((d) => {
  if (d.frameId === 0) maybeResumeAfterNav();
});

// ---- downloads (T10): correlate at record, wait for completion at replay ----
chrome.downloads.onCreated.addListener((item) => {
  // Record: tag the click that just fired as download-producing. onCreated's filename
  // is often empty; the URL is enough for a first guess, backfilled on completion.
  getRec().then((rec) => {
    if (!rec) return;
    enqueue(async () => {
      const cur = await getRec();
      if (!cur) return;
      const now = Date.now();
      for (let i = cur.steps.length - 1; i >= 0; i--) {
        const s = cur.steps[i];
        if (now - (s.ts || 0) > 3000) break; // correlation window (m1-design §5.1)
        if (s.action === "click") {
          s.download = { id: item.id, filename: downloadName(item) || undefined };
          await setRec(cur);
          return;
        }
      }
    });
  });
});
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current !== "complete") return;
  chrome.downloads.search({ id: delta.id }).then((items) => {
    const filename = downloadName(items[0] || {});
    noteDownloadDone(delta.id, filename);
    // Record: backfill the now-known name onto the step tagged at onCreated (onCreated's
    // finalUrl can lag behind the original url).
    getRec().then((rec) => {
      if (!rec || !filename) return;
      enqueue(async () => {
        const cur = await getRec();
        const s = cur?.steps.find((st) => st.download?.id === delta.id);
        if (s) { s.download!.filename = filename; await setRec(cur!); }
      });
    });
    // Replay: advance if the run is parked waiting on this download.
    maybeCompleteDownload({ id: delta.id, filename });
  });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "bao-run-watchdog") return;
  await enqueue(async () => {
    const run = await getRun();
    if (run?.phase === "awaiting_nav") {
      if (Date.now() < (run.expectedNav?.deadline || 0)) return;
      await fail(run, `expected navigation to ${run.steps[run.stepIndex]?.url} never completed`);
    } else if (run?.phase === "awaiting_download") {
      if (Date.now() < (run.expectedDownload?.deadline || 0)) return;
      await fail(run, `expected download never completed: ${run.steps[run.stepIndex]?.label}`);
    }
  });
});

// The merged, time-ordered recording across all frames.
self.baoDrainSteps = () => self.__baoSteps.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));

// Tier-C item 6: opt-in "aggressive capture" — dynamically register a MAIN-world,
// document_start script that forces closed shadow roots open so Tier-A piercing can
// reach inside (e.g. salesforce.com's closed <cs-native-frame-holder>). Off by
// default; applies to navigations after it's enabled (reload to take effect).
const FORCE_OPEN_ID = "bao-forceopen";
self.baoSetForceOpen = async (on) => {
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [FORCE_OPEN_ID] });
    if (on && !existing.length) {
      await chrome.scripting.registerContentScripts([{
        id: FORCE_OPEN_ID,
        matches: ["<all_urls>"],
        js: ["dist/forceopen.js"],
        runAt: "document_start",
        world: "MAIN",
        allFrames: true,
      }]);
    } else if (!on && existing.length) {
      await chrome.scripting.unregisterContentScripts({ ids: [FORCE_OPEN_ID] });
    }
    return { ok: true, on: !!on };
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) };
  }
};

// Map a recorded FrameRef onto a live frameId. Prefer an exact URL match, fall back
// to same-origin (the cross-origin child case), then the top frame.
function pickFrameId(frames: chrome.webNavigation.GetAllFrameResultDetails[], ref: FrameRef | undefined): number | null {
  if (!ref) return 0;
  let f = frames.find((fr) => fr.url === ref.url);
  if (!f && ref.origin) f = frames.find((fr) => { try { return new URL(fr.url).origin === ref.origin; } catch { return false; } });
  if (!f && ref.top) f = frames.find((fr) => fr.frameId === 0);
  return f ? f.frameId : null;
}

// Replay a recording that may span frames: send each step to the one frame it belongs
// to (chrome.tabs.sendMessage with an explicit frameId), in order. Callable from the
// harness via sw.evaluate.
self.baoReplayAcrossFrames = async (tabId, steps) => {
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  const results: StepResult[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const frameId = pickFrameId(frames, step.frame);
    if (frameId == null) {
      results.push({ i, ok: false, reason: `frame not found: ${step.frame && step.frame.origin}` });
      return { ok: false, failedAt: i, results };
    }
    let res: ReplayResponse | undefined;
    try {
      res = await chrome.tabs.sendMessage(tabId, { cmd: "replay", steps: [step] }, { frameId });
    } catch (e) {
      results.push({ i, ok: false, frameId, reason: String(e instanceof Error ? e.message : e) });
      return { ok: false, failedAt: i, results };
    }
    const r0 = (res && res.results && res.results[0]) || ({} as StepResult);
    results.push({ i, ok: !!res && res.ok === true, via: r0.via, frameId });
    if (!res || res.ok !== true) return { ok: false, failedAt: i, results };
  }
  return { ok: true, results };
};
