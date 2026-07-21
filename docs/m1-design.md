# Bao Browser — M1 Design (cross-navigation, waitForUser, downloads)

> Parent doc: [[product-design-v1]] (architecture, IR, M0 detail).
> Status: M0 (capture + deterministic replay, 1 page, no LLM) works. This is M1.

## Goal

Replay a multi-page workflow that **survives full-document navigations**, can
**pause for a human**, and **captures downloads** — all deterministic, no LLM.

Acceptance flow: **login page → click through → report page → Download CSV**, where
steps 1, 3, and the download each live on a different document.

## Why M1 is its own milestone

Every navigation **destroys the content script**, and in MV3 the **service worker is
killed too**. M0 could keep all run state in page memory. M1 can't. The whole
milestone reduces to one idea:

> **Run state lives in `chrome.storage`, not in any JS context.** The SW and content
> script are both disposable; they rehydrate from storage on every wake.

## 1. The state machine (SW-owned, storage-backed)

```jsonc
RunState {                       // chrome.storage.local, single key per active run
  workflowId, runId, tabId,
  stepIndex,                     // the step we are ON
  phase: "idle" | "executing" | "awaiting_nav" | "awaiting_element"
       | "paused_for_user" | "done" | "failed",
  expectedNav?: { type:"load"|"urlMatch", value, deadline },
  dispatched?: boolean,          // step sent to content script, completion not yet confirmed
  lastError?: { stepIndex, reason }
}
```

| Phase | Meaning | Wakes on | → next |
|---|---|---|---|
| `executing` | step dispatched to content script | `onMessage` (step result) | advance, or `awaiting_nav` if step's `wait` says nav |
| `awaiting_nav` | clicked something that navigates | `webNavigation.onCompleted` (tabId, frameId 0) | re-inject → `executing` next step |
| `awaiting_element` | waiting for `waitFor: elementVisible` | `onMessage` from content-script poller | `executing` |
| `paused_for_user` | `waitForUser` step | side-panel "Continue" msg | `executing` next step |
| `done` / `failed` | terminal | — | write run history |

**The SW is event-driven, never timer-driven.** No long `setTimeout` in the SW (it
will be killed). Waiting is delegated:

- **Element waits** → the content script (alive on the page) polls and sends a
  message; `runtime.onMessage` wakes the SW.
- **Navigation waits** → `chrome.webNavigation.onCompleted` wakes the SW.
- **Timeouts** → `chrome.alarms` (survives SW death), **not** `setTimeout`.

## 2. Re-inject + resume handshake

Single source of truth for injection: **programmatic only**
(`chrome.scripting.executeScript`), no manifest-declared content script — otherwise
you double-inject. Guard with `if (window.__baoInjected) return; window.__baoInjected = true`.

**Replay, per navigation:**

```
webNavigation.onCommitted (tabId==run.tabId, frameId==0)
  → SW injects content script (runAt document_start)
content script boots → waits for document.readyState==="complete"
  → sends {type:"ready", url} to SW
SW reads RunState from storage, sees phase=awaiting_nav, stepIndex=N
  → advances to N (the step after the nav), phase=executing
  → sends {type:"execute", step} to content script
```

**Record, symmetric:** the recorder content script is also destroyed on nav. The SW
re-injects it after each load and the recorder keeps appending to the **same trace in
storage** (it streams each event to the SW rather than buffering in page memory). On
nav the SW writes a `navigate` + inferred `waitFor` into the trace.

## 3. `waitForUser`

The general pause primitive (login / 2FA / CAPTCHA / "pick a file"). At replay,
hitting a `waitForUser` step sets `phase=paused_for_user` and surfaces the step's
`label` in the **side panel** with a **Continue** button. Execution resumes only on
the user's click.

Because state is in storage, the SW can die during the pause and the user can take
five minutes — Continue's message wakes it and it rehydrates at the right step. Build
this once; it is also the graceful-degrade target for any capability the
content-script executor can't do (per the Executor seam in the parent doc).

## 4. Download capture

Downloads are SW-only (`chrome.downloads`), not reachable from the content script.

- **Record:** when a click is the active step, listen to `chrome.downloads.onCreated`.
  If a download fires within a short window of that click, tag the step
  `producesDownload:true` and capture `{suggestedFilename, mime}`.
- **Replay:** execute the click, then `phase` waits on `chrome.downloads.onCreated` →
  `onChanged(state:"complete")` before advancing. Record the resulting filename/path
  into run history. Timeout via alarm → clear failure report ("expected a download,
  none started").

## 5. The genuinely hard races

1. **Expected vs. unexpected navigation.** After a click, did the page navigate or
   not? Don't guess at replay time — the **recorded `wait` on the step** tells you.
   Step with `wait.type==="navigation"` → enter `awaiting_nav`; otherwise stay
   `executing`. This is exactly why M0 over-captures waits.
2. **SW killed mid-step → re-execution.** If the SW dies after dispatching a click but
   before recording its completion, on wake it must not fire the click twice.
   Mitigation: persist the `dispatched` marker; on wake, **if a navigation has since
   occurred** (URL changed from the step's record-time URL), treat the step as
   completed and advance. Idempotency for non-navigating steps is best-effort — this
   is the riskiest corner of M1.
3. **Re-injection timing.** Inject at `onCommitted` with `runAt:document_start`, but
   **act only after `readyState==="complete"`** (or a `waitFor` element). Acting too
   early misses not-yet-rendered targets.
4. **Wrong-frame navigation.** Filter `webNavigation` to `frameId===0` and
   `tabId===run.tabId`. Sub-frame and background-tab navs must not trigger top-level
   resume.
5. **`history.pushState` SPA "navigations."** No document teardown, so the content
   script survives — but `onCompleted` won't fire either. Listen to
   `webNavigation.onHistoryStateUpdated` and treat it as a soft nav (no re-inject,
   just a `urlMatches` wait).

## 6. IR / storage additions

- `Step.action`: add `"download"`; `Step.wait` now actively used
  (`navigation` | `elementVisible` | `urlMatches`).
- `Step.producesDownload?`, `Step.downloadMeta?`.
- New persisted `RunState` key (above).
- Run history gains the **filmstrip of actual frames per step** across pages (capture
  at each step boundary survives nav since it's SW-driven `captureVisibleTab`).

## 7. Acceptance / out of scope

**Done when:** the 3-document login→report→download flow replays end-to-end from a
cold start (SW asleep), survives a forced SW kill mid-run
(`chrome://serviceworker-internals` → Stop), and a `waitForUser` pause resumes
correctly after 60s.

**Explicitly not M1:** the backend LLM compiler (M2), readable-label polish (M2),
self-healing (M4), multi-tab, cross-origin iframes, file *upload*
(waitForUser-degrade only).
