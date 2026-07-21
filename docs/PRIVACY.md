# Bao Privacy Policy

_Last updated: 2026-07-20_

**Short version: Bao runs entirely on your computer. It has no servers, sends nothing
over the network, and collects no analytics. Everything you record stays in your browser's
local storage on your machine, and you can delete it at any time.**

Bao is a Chrome extension that records a browser workflow once and replays it
deterministically. This policy describes exactly what data Bao touches and where it goes.
It is written to match the code - anyone can verify these claims by reading the source.

## What Bao stores, and where

When you record a workflow, Bao saves the following **locally, on your device only**:

- The **steps** of your workflow (clicks, typed values, navigations) as a readable list.
- **Selector metadata** for each target element (its accessible name, role, position, and
  a small structural snapshot) so replay can re-find the element if the page changes.
- **Screenshots** captured during recording and replay ("golden" frames and a run-history
  filmstrip), so you can review what happened.

This data is written to your browser's **local extension storage** (`chrome.storage.local`,
`chrome.storage.session`) and a **local IndexedDB database** for the screenshots. It never
leaves your computer. Bao does not use Chrome's *sync* storage, so your recordings are not
copied to your Google account or any other device.

## What Bao never does

- **No servers.** Bao has no backend. It makes no network requests to any Bao service -
  there is none. (The only `fetch()` calls in the code decode a screenshot that Chrome
  already captured locally; they never touch the network.)
- **No analytics or telemetry.** Bao does not track your usage, page visits, or behavior.
- **No selling or sharing.** Your data is never transmitted, sold, or shared with anyone.
- **No account.** You do not sign in. Bao does not know who you are.

## Sensitive data is never recorded

Bao actively refuses to capture secrets. Fields that are passwords, credit-card numbers,
CVV/security codes, SSNs, or one-time codes - detected by field type, autocomplete hint,
name/label, or value shape - are **masked at capture**: the value is never written to
storage, and the field's text and screenshot are dropped as well. During replay Bao simply
focuses the field and leaves it empty for you to fill in by hand. Your secrets are never
persisted anywhere, not even locally.

## Permissions, and why each is needed

Chrome shows a permission list when you install Bao. Here is what each one is for:

| Permission | Why Bao needs it |
|---|---|
| Read and change data on all sites (`<all_urls>`) | To record and replay your actions on whatever page you choose to automate. Bao only acts on a page while you are actively recording or replaying on it. |
| `scripting` | To run the recorder/replayer content script on the current page. |
| `webNavigation` | To follow your workflow across page navigations (e.g. after a login redirect). |
| `downloads` | To let a workflow that downloads a file (e.g. "download the CSV") complete. |
| `storage` | To save your workflows and screenshots locally, as described above. |
| `alarms` | Internal timing for the background service worker. |
| `sidePanel` | To show Bao's controls in the browser's side panel. |

Bao deliberately does **not** request the `debugger` permission or any host outside the
pages you drive.

## Retention and deletion

Your data stays on your device until you remove it. You can delete it at any time by:

- Deleting individual workflows or run history from within Bao, or
- Removing the extension from `chrome://extensions` (this clears all of Bao's local data).

Because nothing is stored off-device, uninstalling Bao leaves no data behind on any server.

## Changes to this policy

If this policy changes, the "Last updated" date above will change and the new version will
ship with the extension.

## Contact

Questions about this policy or Bao's data handling: **uilxela7@gmail.com**
