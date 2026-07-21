# T16 - Full-page dashboard: manage, edit, and re-watch workflows + run history

> Parent docs: [[product-design-v1]] (UI, M3 audit trail), [[t15-sidepanel-design]] (the
> side panel this complements), [[m1-design]] (RunState machine).
> Status: T15 shipped the side panel as the live capture/replay surface. This adds a
> **full-page dashboard** as the management home, **light step editing**, and durable
> **run history with a record-vs-replay filmstrip**. No capture/replay semantics change.

## Why (the panel is the wrong surface for management)

The side panel is ~360px and window-scoped. It is the right home for the thing it does
well: recording next to the page and watching a run go green live. It is the wrong home for
browsing a growing library, editing a workflow's steps, or scrubbing through what a past run
actually did. Those want width, persistence, and a URL you can bookmark.

A full page is the standard extension answer: `chrome-extension://<id>/dashboard.html`
opened as a normal tab. It shares the extension origin with the SW, so it reads
`chrome.storage.local` and IndexedDB **directly** - no blob marshaling across messages.

## Decisions (made with the user, 2026-07-19)

| Question | Decision |
|---|---|
| Full page vs panel | **Complement.** Panel keeps live capture + quick-run (its strength). The dashboard is the library / edit / history home. Panel gets an "Open dashboard" link. |
| Edit depth | **Light.** Rename; delete + reorder steps; edit a step's `value` and `assert`. **No re-record, no selector hand-editing, no adding steps** - those reopen T14 id/selector invariants and belong with the M2 compiler. |
| Run history | **Full audit trail + screenshots.** Per run: outcome, timing, per-step results, and a replay-time screenshot per step (IndexedDB, mirroring golden frames). |
| "Watch" | **Re-watch past runs**, frame by frame, from stored screenshots. Live ✓/✗ theater stays in the panel; the dashboard is post-hoc playback. |

**No backend.** Everything here is client-side, reading the same profile-local storage.
A server enters scope only for cross-device sync / sharing / cloud replay - none of which
this ticket adds. Import/export JSON (T15 §6) remains the low-tech share/backup bridge.

## 1. Surface & bootstrap

New files: `dashboard.html` + `src/dashboard.ts`, bundled by `build.mjs` exactly like the
panel (add `src/dashboard.ts` to `entryPoints`). No framework - same vanilla-DOM house style.

Reachability (three doors, one page):
- `manifest.json`: `"options_page": "dashboard.html"` - gives a right-click "Options" entry
  and `chrome.runtime.openOptionsPage()`, and lists it on `chrome://extensions`.
- Panel header link: **⤢ Dashboard** → `chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") })`.
  If a dashboard tab is already open, focus it instead of spawning duplicates
  (`chrome.tabs.query` by url).
- No `web_accessible_resources` needed: the page is opened by the extension, not injected
  into web content.

**Read/write discipline.** The dashboard **reads** freely and directly (storage.local for
workflows, IndexedDB for frames - same origin as the SW). It **writes** only through SW
messages, so every mutation goes through the SW's existing `enqueue()` single-writer
serialization and no two surfaces race on `baoWorkflows`. Storage `onChanged` listeners keep
the dashboard, the panel, and multiple dashboard tabs consistent for free (the T15 trick).

## 2. Run history: the one new persistence layer

Today a run is a single `RunState` under `baoRun`, cleared on finish (`background.ts:126`).
History makes each finished run durable and self-contained.

### 2.1 Type (`types.ts`)

```ts
export type RunOutcome = "passed" | "failed";
export interface RunRecord {
  id: string;                 // "run-xxxx"
  workflowId: string;         // may dangle if the workflow is later deleted - fine
  workflowName: string;       // denormalized snapshot (survives rename/delete)
  startUrl: string;
  startedAt: number;
  finishedAt: number;
  outcome: RunOutcome;        // failed iff any step failed (asserts are non-fatal, reported)
  results: StepResult[];      // the per-step ✓/✗ + reason, as the run produced them
  steps: Step[];              // snapshot of the exact steps run (labels for the filmstrip)
  frames: (string | null)[];  // frames[i] = IndexedDB key of the replay-time shot, or null
}
```

Denormalizing `workflowName`/`steps` makes a `RunRecord` **self-contained**: history stays
readable after the workflow is edited or deleted. That is the whole point of an audit trail.

### 2.2 Storage: `bao-history` IndexedDB (mirror the golden pattern)

Reuse the exact shape of `goldenDB/goldenPut/goldenGet` (`background.ts:584-613`):

- DB `bao-history`, two stores:
  - `runs` - `RunRecord` objects keyed by `run.id` (small JSON).
  - `frames` - jpeg `Blob`s keyed by `${runId}:${stepIndex}`.
- **Retention cap** to bound disk: keep the most recent **N=50** runs globally (and prune
  their frames). Enforced on write - list `runs` by `finishedAt`, delete the overflow +
  their frame keys. Cheap and predictable; no user-facing setting yet.

`RunRecord` metadata is small enough for `storage.local`, but it *references* frames in
IndexedDB anyway, so keeping both in one DB keeps the audit trail atomic and lets the
dashboard open one DB to render a run.

### 2.3 Capturing replay frames

Replay advances step-by-step through the RunState machine (`background.ts:344-455`). After a
step resolves and before advancing `stepIndex`, capture the visible tab keyed
`${runId}:${i}`. Chrome throttles `captureVisibleTab` to 2/s - reuse the golden coalescer
(`scheduleGolden`, `lastCaptureAt`) so replay never stalls on the throttle; a missed frame
is `null`, not a failure. This runs only while a run is active, so cost is bounded by run
length, not library size.

### 2.4 Writing the record on finalize

The two finalize points - `run.phase = "failed"` (`:329`) and `"done"` (`:344`) - are where
we assemble and persist the `RunRecord` (outcome, `finishedAt`, `results`, `steps` snapshot,
collected `frames`) before `setRun(null)`. A `paused_for_user` run is not yet finished - no
record until it resolves to done/failed.

### 2.5 SW read/delete handlers (for the harness; dashboard reads direct)

```
self.baoListRuns  = (workflowId?) => RunRecord[] (metadata; frames omitted or key-only)
self.baoGetRun    = (id) => RunRecord | null
self.baoDeleteRun = (id) => { ok }        // + its frames
self.baoClearRuns = (workflowId?) => { ok }
```

## 3. Light step editing

New SW command - the only mutation that touches a workflow's `steps`:

```ts
| { cmd: "bao-wf-update-steps"; id: string; steps: Step[] }   // → { ok } | { ok:false, error }
```

Invariant-preserving contract (enforced in the SW, never trusted from the client):

1. **Ids are identity.** Every incoming `step.id` MUST already exist in the stored
   workflow. The new list must be a **subset** of existing ids (deletions allowed, **no
   additions, no id reuse**). Reject otherwise - this is what keeps T14's IR stable and
   walls off "re-record" without the M2 versioning story.
2. **Index is position.** Re-derive `index = 0..N-1` from array order (the reorder).
3. **Field edits are whitelisted.** Only `value` (input/contenteditable steps) and
   `assert.value`/`assert.kind` may differ from the stored step. `action`, `target`,
   `selectors`, `frame` are copied from the stored step, not the payload - the editor
   cannot silently rewrite how a step resolves.
4. Bump `version`, set `updatedAt`. `createdAt` stays immutable.

UI (workflow detail, edit mode): step rows get a drag handle (or ▲▼), a ✕ delete, and inline
fields for value/assert where applicable. **Save** sends the whole ordered subset; **Cancel**
reverts. Deleting the last step is allowed (empty workflow) but flagged with a confirm.
Editing is explicitly modal (an "Edit" toggle) so the detail view's normal state stays a
clean read-only + run surface.

## 4. Dashboard views

```
┌─ Bao ───────────────────────────────── [Import] [＋ Record opens the panel] ─┐
│  🔎 search            LIBRARY                                                 │
│  ── pinned ──                                                                 │
│   ★ Publish a post          substack.com   12 steps   ▶ Run  ⋯               │
│  ── substack.com ──                                                           │
│     Comment on note          6 steps   Jul 18   ▶ Run  ⋯                      │
│  ── news.ycombinator.com ──                                                   │
│     Upvote story             2 steps   Jul 17   ▶ Run  ⋯                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Library** - the T15 home view at full width: search, group-by-host, pins, recency sort.
  The grouping/sorting logic is identical to `sidepanel.ts` §4; factor the shared bits into a
  small module both bundles import rather than forking it.
- **Workflow detail** - read-only step list (with the T15 "↦ Start at {url}" lead row), an
  **Edit** toggle (§3), **▶ Run** (dispatches to the active tab; live progress shows in the
  panel), and a **Run history** section: a reverse-chron list of that workflow's `RunRecord`s
  (outcome dot, timestamp, duration, "9/12 steps").
- **Run detail (the filmstrip)** - open a `RunRecord`:

```
│  Publish a post · Jul 19 2:14pm · ✓ passed · 4.1s                            │
│  ◀ ▮▮▮▮▯▯▯▯▯▯▯▯ ▶     step 3 / 12                                            │
│  ┌── recorded ──┐   ┌── replayed ──┐                                          │
│  │  (golden)    │   │  (run frame) │   ✓ 3. Click "Comment"  via=aria         │
│  └──────────────┘   └──────────────┘                                          │
```

  A scrubber over the steps. Left = the record-time golden frame
  (`step.meta.goldenScreenshotRef` from `bao-golden`); right = the replay frame
  (`frames[i]` from `bao-history`). Both read **directly** from IndexedDB →
  `URL.createObjectURL(blob)` → `<img>` (revoke on teardown). Under them: the step label +
  `via`/`reason` from `results[i]`. This is the "watch a past run" experience: step through
  what the replay saw against what recording expected. Missing frame → a "no frame" placeholder.

## 5. Protocol additions (summary)

```ts
// dashboard → SW (writes)
| { cmd: "bao-wf-update-steps"; id; steps }
| { cmd: "bao-run-delete"; id }
| { cmd: "bao-runs-clear"; workflowId? }
// reads used by the harness (dashboard reads storage/IDB direct)
self.baoListRuns / baoGetRun / baoDeleteRun / baoClearRuns
```

Existing `bao-wf-list/get/update/delete/import/run` are reused unchanged.

## 6. Out of scope (explicit)

- Re-recording a step, adding steps, hand-editing selectors - M2 compiler.
- Live run progress *in the dashboard* - it stays in the panel (this ticket = post-hoc
  playback). The dashboard may show a run's results updating if open, but the filmstrip is
  the headline.
- Variables/parameterization UI - M4.
- Cross-device sync / sharing / cloud replay - needs a backend, separate initiative.
- Diffing golden vs replay pixels (visual regression) - the filmstrip shows both; automated
  diff is a later pass.
- History search/filter, per-workflow retention settings, CSV export of runs.

## 7. Test plan

- **`test/workflows.mjs` (extend)**:
  - `bao-wf-update-steps`: reorder preserves ids + re-derives index; delete produces a
    subset; a fabricated/duplicate id is rejected; a `value` edit persists; an attempt to
    change `action`/`target` is ignored (copied from stored).
  - run history: run the 2-step fixture workflow to completion → assert one `RunRecord`
    persisted with `outcome:"passed"`, `results.length===2`, `frames.length===2`; force a
    failing step → `outcome:"failed"`; retention cap prunes beyond N.
- **`test/dashboard.mjs` (new)**: open `chrome-extension://{id}/dashboard.html` as a page,
  seed 2 workflows + 1 `RunRecord` via the SW. Assert: cards render grouped by host; search
  filters; entering edit mode, reordering + deleting a step, saving persists (re-read via
  `bao-wf-get`); opening the seeded run renders the filmstrip with both frames and scrubs.
- **Manual**: README update; verify the panel "⤢ Dashboard" link and the record→run→history
  round-trip against `test/fixture.html`.

## 8. Work breakdown (in order, each lands green)

1. **History persistence (SW only, no UI).** `RunRecord` type; `bao-history` IndexedDB
   (runs + frames) mirroring golden; capture a replay frame per step via the golden
   coalescer; write the record at both finalize points; retention cap;
   `baoListRuns/GetRun/DeleteRun/ClearRuns` + `bao-run-delete`/`bao-runs-clear`. Extend
   `test/workflows.mjs`. *(Panel/dashboard untouched - tree stays green and featureful.)*
2. **Dashboard skeleton.** `dashboard.html`/`src/dashboard.ts` + build entry +
   `options_page` + panel "⤢ Dashboard" link (focus-existing-tab). Library view (shared
   group/sort module) + read-only workflow detail with run-history list. `test/dashboard.mjs`.
3. **Light step editing.** Edit toggle; reorder/delete/value+assert edit; `bao-wf-update-steps`
   with the id-subset + index-rederive + field-whitelist contract; confirm on last-step
   delete. Extend both tests.
4. **Filmstrip player.** Run-detail view: scrubber, record-vs-replay panes reading
   `bao-golden` + `bao-history` blobs directly, per-step result line, delete/clear history.
   README §"Try it" update. Extend `test/dashboard.mjs`.
