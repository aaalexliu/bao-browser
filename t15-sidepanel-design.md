# T15 — Side Panel: browse, name, and replay workflows

> Parent docs: [[product-design-v1]] (§UI, M3 line item), [[m1-design]] (RunState machine,
> `paused_for_user` → side-panel Continue), [[recording-gaps-and-app-universe]] (T14 workflows).
> Status: T14 shipped named workflows behind a 280px popup. This replaces the popup with
> Chrome's Side Panel and fixes the save flow. No changes to capture or replay semantics.

## Why (the popup is the wrong surface)

1. **Unsaved recordings are silently lost.** After Stop, the captured steps live in
   `pendingSteps`, a popup-local variable (`src/popup.ts:20`). Click anywhere on the
   page → popup closes → recording gone. This is a data-loss bug dressed as a UX flaw.
2. **You can't watch anything happen.** Record streams steps and replay advances a
   state machine, but the popup dies the moment you interact with the page — the one
   moment you'd want to see live progress.
3. **Naming is a gate.** Save requires typing a name into a bare 150px input that's
   easy to miss ("how do I name and save?" is a real user question we got).

The Side Panel (`chrome.sidePanel`, MV3) stays open alongside the page. It is the
natural surface for a record/replay tool: live step feed while recording, live ✓/✗
while replaying, and a persistent home for the workflow library.

## Decisions (made with the user, 2026-07-04)

| Question | Decision |
|---|---|
| Popup vs panel | **Side panel only.** Delete `popup.html`/`src/popup.ts`. Toolbar icon opens the panel. |
| Save flow | **Auto-save on Stop** with a generated name; inline rename focused immediately after. Naming becomes optional polish, never a gate. |
| Detail view depth | View steps (read-only) + rename + delete + run with live progress. **Step editing (delete/reorder/re-record) is explicitly out of scope** — it touches T14 id/index invariants and belongs with the M2 compiler work. |
| Organization | Search + **group by site** + **pin favorites** + **import/export JSON**. Flat recency sort within groups. |

## 1. Manifest & bootstrap

```jsonc
// manifest.json
{
  "permissions": [..., "sidePanel"],          // add
  "side_panel": { "default_path": "sidepanel.html" },
  "action": {}                                 // REMOVE default_popup
}
```

In `background.ts` (top-level, runs on every SW wake):

```ts
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
```

That one declarative call makes the toolbar icon toggle the panel — no
`action.onClicked` listener needed (and `chrome.sidePanel.open()` requires a user
gesture anyway, so the declarative route is strictly simpler).

New files: `sidepanel.html` + `src/sidepanel.ts`, bundled by the existing
`build.mjs` esbuild setup exactly like popup was. **No framework** — keep the
vanilla-DOM house style; this UI is small enough that a framework is pure weight.

Note: the panel is per-window but our state (recording, run, workflows) is global
(one recording, one run at a time — M1 invariant). Two windows showing the same
panel is fine: both render from the same storage and the storage listeners keep
them in sync for free.

## 2. Data & protocol changes (`src/types.ts`, `src/background.ts`)

### Workflow gains two fields

```ts
export interface Workflow {
  // ...existing...
  pinned?: boolean;      // T15: pin favorites to the top
  updatedAt?: number;    // T15: bumped on rename/pin; createdAt stays immutable
}
// WorkflowSummary mirrors both. The panel derives `domain` from startUrl itself
// (new URL(startUrl).hostname) — don't store what's derivable.
```

### New messages

```ts
// popup/harness → SW  (add to Msg union; keep every existing message working —
// the e2e harness calls self.baoSaveWorkflow / bao-wf-* directly)
| { cmd: "bao-wf-get"; id: string }                       // → Workflow | null (full steps, for detail view)
| { cmd: "bao-wf-update"; id: string; patch: { name?: string; pinned?: boolean } }  // → { ok }
| { cmd: "bao-wf-import"; workflow: Workflow }            // → { ok, id } (fresh id assigned; see §6)
```

All three are thin wrappers over the existing `getWorkflows()` map +
read-modify-write inside `enqueue()` (same serialization discipline as every other
storage transition, `background.ts:97`).

### `bao-rec-stop` auto-saves (the data-loss fix)

Change `baoRecStop()` from "return steps, hope someone saves them" to:

```
stop → if steps.length === 0: return { workflow: null }
     → else: build Workflow via makeWorkflow(autoName(steps), startUrlOf(steps), steps)
            (startUrlOf = first step with frame.url — same logic popup.ts:29 had, moved SW-side)
            persist it, return { workflow: WorkflowSummary }
```

`autoName(steps)`: `"{hostname} — {Mon D, h:mma}"` from `startUrl` + `Date.now()`,
e.g. **"substack.com — Jul 4, 2:15pm"**. Hostname unavailable → "Recording — {time}".
No collision handling needed (ids are the identity; duplicate names are harmless).

Keep `bao-wf-save` as-is for the harness (`test/workflows.mjs` uses it).

## 3. Panel UI — structure

One HTML file, three views, view switching = toggling `hidden` on three `<section>`s.
State machine in `sidepanel.ts`: `view: "home" | "recording" | "detail"`. (Replay
progress is not a separate view — it renders inside detail, or inline on home for a
quick ▶ Run from a card.)

```
┌──────────────────────────────┐
│ Bao                ● Record  │ ← header, always visible. Record disabled with
├──────────────────────────────┤   tooltip when contentAlive() fails (chrome:// etc.)
│ 🔍 search                    │
│                              │
│ 📌 PINNED                    │ ← section present only if any pinned
│  ┌─────────────────────────┐ │
│  │ Comment on latest post  │ │
│  │ 8 steps · 2d ago  ▶  ⋯ │ │
│  └─────────────────────────┘ │
│                              │
│ ▾ substack.com (3)           │ ← site groups, newest-first inside;
│  ┌─────────────────────────┐ │   groups ordered by most recent workflow.
│  │ substack.com — Jul 4,…  │ │   Collapse state in-memory only (resets on
│  │ 8 steps · just now ▶ ⋯ │ │   panel reopen — not worth persisting).
│  └─────────────────────────┘ │
│ ▸ news.ycombinator.com (1)   │
│                              │
│ ⤓ Import workflow…           │ ← footer
└──────────────────────────────┘
```

**Card**: name (1 line, ellipsized), meta line `{count} steps · {relative time}`,
**▶ Run**, and a **⋯ menu** (Rename / Pin·Unpin / Export JSON / Delete). Clicking the
card body (not the buttons) opens the detail view.

**Search**: plain substring filter over `name + domain`, case-insensitive, filters
across all groups (a group with 0 matches disappears). No fuzzy matching, no index —
this is a `<input>` + `Array.filter` over the summaries.

**Delete**: no `confirm()` dialog (blocks the whole browser event loop from an
extension page context — and it's hostile anyway). Instead: card is removed
optimistically, a toast with **Undo** shows for 5s; actual `bao-wf-delete` fires
when the toast expires or the panel closes. Undo just cancels the timer.

### Recording view

Entered on ● Record (after `contentAlive()` check + `bao-rec-start`, same guards as
`popup.ts:33`). Header swaps to `● Recording… ■ Stop` (red pulse on the dot).

```
│ ● Recording…          ■ Stop │
├──────────────────────────────┤
│ 1. Click "Comment"           │ ← steps appear LIVE as you interact
│ 2. Type "Great post" in …    │
│ 3. Click "Post"              │
│ ▊                            │ ← cursor row implies "still listening"
```

**Live feed mechanism**: the recording trace already lands in
`chrome.storage.session` under `baoRec` on every step (`background.ts:74,106`). The
panel is an extension page → trusted context → it can read session storage and
subscribe:

```ts
chrome.storage.session.onChanged.addListener((ch) => {
  if (ch.baoRec) renderRecFeed(ch.baoRec.newValue?.steps ?? []);
});
```

Zero new plumbing; the SW doesn't even know the panel is watching.

**■ Stop** → `bao-rec-stop` → SW auto-saves (§2) → switch to **detail view of the
new workflow with the name in inline-edit mode, text pre-selected** so typing
replaces the generated name; Enter/blur commits via `bao-wf-update`. Escape keeps
the generated name. Zero-step stop → back to home with a "Nothing captured" toast.

**Panel opened mid-recording** (or reopened after being closed — recording state is
SW-owned and doesn't care): the boot sequence (§5) sees `baoRec` non-null and lands
directly in the recording view with the feed backfilled. This replaces the popup's
fragile `st.recording` ping (`popup.ts:143`).

### Detail view

```
│ ← Back                       │
│ Comment on latest post    ✏️ │ ← name; ✏️ or click-to-edit = inline rename
│ substack.com · 8 steps ·     │
│ created Jul 4                │
│ [▶ Run]  [📌 Pin]  [⤓ Export]│
│ [🗑 Delete]                   │
├──────────────────────────────┤
│ 1. Click "Comment"           │ ← read-only step list from bao-wf-get,
│ 2. Click "p"                 │   same label rendering as recording feed
│ 3. …                         │
```

**▶ Run** → `bao-wf-run` with the active tab id → the step list becomes the live
progress surface:

```
│ ✓ 1. Click "Comment"         │
│ ✓ 2. Click "p"               │
│ ▶ 3. Click "div"        ⟳    │ ← current step, spinner
│   4. …                       │ ← pending, dimmed
```

- `paused_for_user` → current step row shows **⏸ {label}** + a **Continue** button
  inline (finally in the surface `m1-design.md:42` designed it for). Continue →
  `bao-run-continue`, resume watching.
- `failed` → step row gets **✗ {reason}**, stays rendered (this is the failure
  report; don't toast-and-vanish it).
- `done` → all ✓ + "Replayed N steps" summary line.

**Progress mechanism**: RunState lives in `chrome.storage.local` under `baoRun`
(`background.ts:75`) — same trick as the recording feed:

```ts
chrome.storage.local.onChanged.addListener((ch) => {
  if (ch.baoRun) renderRun(ch.baoRun.newValue ?? null);
});
```

This **replaces popup.ts's 400ms `pollRun()` loop entirely** — event-driven, no
timers in the panel, and it degrades gracefully: if the panel was closed during a
run, reopening it reads `baoRun` once at boot and resumes rendering mid-run.

Run from a **home-view card** (without opening detail): navigate to the detail view
first, then run — one codepath for progress rendering, and the user always sees
what's happening.

## 4. Home-view data flow

- Boot + after any mutation: `bao-wf-list` → summaries.
- Group: `Map<hostname, WorkflowSummary[]>` from `new URL(startUrl).hostname`
  (fallback bucket "other" for unparseable/empty startUrl).
- Order: pinned section first (recency-sorted), then groups by `max(createdAt)`
  desc, items within a group by `createdAt` desc.
- Re-render list on `chrome.storage.local.onChanged` for the `baoWorkflows` key too
  — keeps multiple windows' panels consistent without any message fan-out.

## 5. Panel boot sequence

```
1. wire storage listeners (session:baoRec, local:baoRun, local:baoWorkflows)
2. rec = read baoRec        → non-null? enter recording view (backfilled feed)
3. run = read baoRun        → active phase? enter detail view of that run's steps
   (RunState.steps is embedded — no workflow lookup needed) with progress rendered
4. else home view: bao-wf-list → render
```

(2 beats 3 if both somehow exist; recording and running are mutually exclusive by
M1 invariant anyway.)

## 6. Import / export JSON

**Export** (card ⋯ menu or detail button): `bao-wf-get` → pretty-printed JSON blob →
anchor-download `bao-{slugified name}.json`. The file is exactly the `Workflow`
shape — which means it's directly usable by the existing harness tooling
(`test/run.mjs` consumes `steps`), a deliberate bridge.

**Import** (home footer): `<input type="file" accept=".json">` → parse → validate
minimally (`name: string`, `steps: Array` with each step having `action` + `label`;
reject otherwise with a toast — no silent partial imports) → `bao-wf-import`. The SW
**assigns a fresh id and createdAt** (never trust/collide on the file's id — importing
the same file twice should yield two workflows) and strips `pinned`.

## 7. Deletions

- `popup.html`, `src/popup.ts` — gone. `manifest.json` drops `default_popup`.
- `pollRun()` pattern — gone (storage listeners, §3).
- Grep check: nothing in `test/` references popup (the harness drives the SW
  directly), but verify `build.mjs` entrypoints and README §"Try it" get updated.

## 8. Out of scope (explicit, so agents don't wander)

- Step editing / partial re-record — needs T14 versioning story, goes with M2.
- Run history / audit trail — M3's other half, separate ticket.
- Variables/parameterization UI — M4.
- Persisting group collapse state, drag-reorder of pins, tags/folders.
- Any framework, bundler change, or CSS library.

## 9. Test plan

- **`test/workflows.mjs` (extend)**: `bao-wf-update` rename + pin round-trip;
  `bao-wf-get` returns full steps; `bao-wf-import` assigns fresh id (import same
  payload twice → two ids); auto-save on `bao-rec-stop` (record 2 steps on the
  fixture, stop, assert a workflow exists with generated name + correct startUrl);
  zero-step stop saves nothing.
- **UI smoke (new, `test/sidepanel.mjs`)**: Playwright can open
  `chrome-extension://{id}/sidepanel.html` as a regular page. Seed 2 workflows via
  the SW, assert: cards render grouped by domain, search filters, rename persists,
  delete+undo keeps the workflow, delete+expiry removes it. Live-feed/progress
  rendering is covered implicitly by opening the page during a scripted record/run.
- **Manual**: the README §"Try it" flow, updated for the panel; verify the
  `paused_for_user` Continue button in the panel against `test/fixture-nav-a.html`.

## 10. Work breakdown (for implementing agents — in order, each lands green)

1. **SW/protocol** — types.ts additions, `bao-wf-get/update/import`, auto-save in
   `baoRecStop`, `setPanelBehavior`, manifest (`sidePanel` permission,
   `side_panel.default_path`, drop popup). Extend `test/workflows.mjs`. *(No UI yet;
   popup can stay one commit longer so the tree is never featureless.)*
2. **Panel skeleton** — `sidepanel.html`/`src/sidepanel.ts` + build entry; home view:
   list, groups, pins, search, card actions (run w/ progress happens in step 3 —
   here ▶ can keep the old status-line behavior), delete+undo toast. Delete popup.
3. **Live surfaces** — recording view with session-storage feed; stop→auto-save→
   inline-rename handoff; detail view with step list + storage-driven run progress,
   Continue, failure rendering. Add `test/sidepanel.mjs`.
4. **Import/export + polish** — export/import per §6; README §"Load it"/"Try it"
   update; empty states ("No workflows yet — hit ● Record"), relative timestamps.
