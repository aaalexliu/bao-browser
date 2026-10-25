// Runtime host permission. The button is a user gesture. The proof passes ?origins=.
// Broad patterns are dropped here so this page can never grant every site.

import { specificHost } from "./host-grant";

export {};

const button = document.getElementById("allow");
const note = document.getElementById("note");

function wanted(): string[] {
  const params = new URLSearchParams(location.search);
  const listed = params.get("origins");
  if (!listed) return [];
  return listed.split(",").map((item) => item.trim()).filter((item) => specificHost(item));
}

function tell(granted: boolean, origins: string[]): void {
  try {
    void chrome.runtime.sendMessage({ source: "bao-allow", granted, origins }).catch(() => undefined);
  } catch {
    /* the service worker may already have seen the grant */
  }
}

button?.addEventListener("click", async () => {
  const origins = wanted();
  if (!origins.length) {
    if (note) note.textContent = "No origins were requested.";
    document.body.dataset.granted = "false";
    return;
  }
  document.body.dataset.asking = "true";
  try {
    const granted = await chrome.permissions.request({ origins });
    document.body.dataset.granted = String(granted);
    document.body.dataset.asking = "false";
    if (note) note.textContent = granted ? `Allowed ${origins.length} origins.` : "Chrome did not grant those origins.";
    tell(granted, origins);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    document.body.dataset.granted = "false";
    document.body.dataset.asking = "false";
    document.body.dataset.error = message;
    if (note) note.textContent = message;
    tell(false, origins);
  }
});

const origins = wanted();
if (note && origins.length) note.textContent = origins.join(", ");
document.body.dataset.ready = "true";
