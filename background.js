// Bao M0 — minimal service worker.
// M0 has no background logic; the record/replay core lives in content.js and is
// driven by the popup via chrome.tabs.sendMessage. This worker exists so the
// extension has a stable extension-context (used by the e2e harness to relay the
// same messages the popup sends) and as the seam for M1's SW re-injection work.
chrome.runtime.onInstalled.addListener(() => {
  console.log("[bao-m0] service worker installed");
});
