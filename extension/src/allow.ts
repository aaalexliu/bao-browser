// Runtime host permission. Each button is a user gesture.
// The query string may name one origin. It cannot grant every site.
// Allow all sites is the default. It requests the optional host permissions itself.

import { ALL_SITE_ORIGINS, specificOrigins } from "./host-grant";

export {};

const allButton = document.getElementById("allow-all");
const siteButton = document.getElementById("allow");
const note = document.getElementById("note");

function wanted(): string[] {
  return specificOrigins(new URLSearchParams(location.search).get("origins"));
}

function tell(granted: boolean, origins: string[], scope: "all" | "site"): void {
  document.body.dataset.scope = scope;
  try {
    void chrome.runtime.sendMessage({ source: "bao-allow", granted, origins, scope }).catch(() => undefined);
  } catch {
    /* the service worker may already have seen the grant */
  }
}

function finish(granted: boolean, origins: string[], scope: "all" | "site", detail: string): void {
  document.body.dataset.granted = String(granted);
  document.body.dataset.asking = "false";
  if (note) note.textContent = detail;
  tell(granted, origins, scope);
}

allButton?.addEventListener("click", async () => {
  if (document.body.dataset.asking === "true") return;
  document.body.dataset.asking = "true";
  const origins = [...ALL_SITE_ORIGINS];
  try {
    const granted = await chrome.permissions.request({ origins });
    finish(
      granted,
      origins,
      "all",
      granted ? "Allowed all sites. You can revoke this in Settings." : "Chrome did not grant all sites.",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    document.body.dataset.granted = "false";
    document.body.dataset.asking = "false";
    document.body.dataset.error = message;
    if (note) note.textContent = message;
    tell(false, origins, "all");
  }
});

siteButton?.addEventListener("click", async () => {
  if (document.body.dataset.asking === "true") return;
  const origins = wanted();
  if (!origins.length) {
    if (note) note.textContent = "No site was requested.";
    document.body.dataset.granted = "false";
    document.body.dataset.scope = "site";
    return;
  }
  document.body.dataset.asking = "true";
  try {
    const granted = await chrome.permissions.request({ origins });
    finish(
      granted,
      origins,
      "site",
      granted ? `Allowed ${origins.join(", ")}.` : "Chrome did not grant this site.",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    document.body.dataset.granted = "false";
    document.body.dataset.asking = "false";
    document.body.dataset.error = message;
    if (note) note.textContent = message;
    tell(false, origins, "site");
  }
});

const origins = wanted();
if (siteButton instanceof HTMLButtonElement && !origins.length) siteButton.disabled = true;
if (note) {
  note.textContent = origins.length
    ? `Only this site asks for ${origins.join(", ")}.`
    : "Only this site is unavailable because no site was requested.";
}
document.body.dataset.ready = "true";
