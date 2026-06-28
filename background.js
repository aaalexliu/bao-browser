// Bao M0 — service worker.
// The record/replay core lives in content.js (one instance per frame, since the
// manifest injects with all_frames). This worker's job for cross-origin frames:
//  1) collect each frame's recorded steps (a parent content script can't read a
//     cross-origin child's DOM, but every frame can message the SW), and
//  2) at replay, route each step to the live frame it was recorded in — resolving
//     the recorded FrameRef (origin/url) to a current frameId via webNavigation.
chrome.runtime.onInstalled.addListener(() => {
  console.log("[bao-m0] service worker installed");
});

// Cross-frame recording buffer. The e2e harness resets it before a run and reads it
// after, so it lives on `self` (the SW global) rather than in chrome.storage for M0.
self.__baoSteps = self.__baoSteps || [];

chrome.runtime.onMessage.addListener((msg, sender) => {
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
  }
  // No async response needed.
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
        js: ["forceopen.js"],
        runAt: "document_start",
        world: "MAIN",
        allFrames: true,
      }]);
    } else if (!on && existing.length) {
      await chrome.scripting.unregisterContentScripts({ ids: [FORCE_OPEN_ID] });
    }
    return { ok: true, on: !!on };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
};

// Map a recorded FrameRef onto a live frameId. Prefer an exact URL match, fall back
// to same-origin (the cross-origin child case), then the top frame.
function pickFrameId(frames, ref) {
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
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const results = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const frameId = pickFrameId(frames, step.frame);
    if (frameId == null) {
      results.push({ i, ok: false, reason: `frame not found: ${step.frame && step.frame.origin}` });
      return { ok: false, failedAt: i, results };
    }
    let res;
    try {
      res = await chrome.tabs.sendMessage(tabId, { cmd: "replay", steps: [step] }, { frameId });
    } catch (e) {
      results.push({ i, ok: false, frameId, reason: String(e && e.message || e) });
      return { ok: false, failedAt: i, results };
    }
    const r0 = (res && res.results && res.results[0]) || {};
    results.push({ i, ok: res && res.ok === true, via: r0.via, frameId });
    if (!res || res.ok !== true) return { ok: false, failedAt: i, results };
  }
  return { ok: true, results };
};
