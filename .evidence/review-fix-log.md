# Review fix round

## Census and invariants

All four findings are legitimate shared-boundary defects, not isolated bad call sites.

- Readiness: `readLivePage` produces `panel`; `readyRead` compares and stabilizes it, stores `pendingPanel` and `viewReadiness`, and `look` emits the result. Cached `live_snapshot` pages reuse `viewReadiness`. Title, headings, and body breadcrumbs must not settle an unchanged main panel. Removed the title/headings signature and body-text fallback; excluded headings from panel content. Tests cover delayed content, title/heading changes with unchanged content, empty main with changed outer breadcrumbs, fresh reads, and cached reads on both engines.
- View timing: all action, navigation, screenshot, and fresh snapshot views converge on `look` and `record`. `record` writes audit `ms`; correlated tool spans separately track wait, snapshot, image, persistence, action, and finalization. Audit view time now uses the snapshot-span delta for that view, not elapsed readiness time. Delayed route and transitional refresh cases assert persisted audit timing and whole-tool correlation.
- Blocker text: both `clickLive` and `selectLive` call `coverageRefusal`; it alone filters diagnosis text. Field snapshots separately call `safeFieldValue`, which remains unchanged. Diagnosis now replaces secret-shaped substrings before truncation, preserving ordinary credential words and project numbers. Both action paths test each supported token prefix and preserved prose.
- Dismiss refs: `readLiveBlocker` alone selects candidates; `coverageRefusal` resolves the candidate identity into a fresh epoch. Both click and select consume it. Removed OK, Got it, and open-ended prefixes; allowed exact Close/Dismiss, notice-style suffixes, and bare x/×. Existing disabled, duplicate, covered, shifted-index, dismissal, and retry cases remain. A shared behavioral table adds accepted and rejected names for both engines and both actions.

## Post-edit trace

A pushState with an early title or heading change keeps the original panel signature. An empty main stays empty despite changed body text. The bounded loop returns transitional, retaining its pending baseline for fresh reads and its marker for cached reads. Changed content must remain stable for 150ms before ready. Ordinary careful-mode reads still use `reread`; ordinary YOLO reads without pending navigation remain ready when document readiness allows it.

Every `look` caller captures only that view's snapshot-span delta for the audit row. Tool timing still spans the complete handler, including readiness sleeps and image/persistence/finalization work.

Covered click/select dispatch still stops before touching the underlying control. Diagnosis redacts tokens without applying field-label rejection. Exact dismiss candidates still require uniqueness, visibility, enabled state, hit-testing, and fresh identity resolution. No automatic dismissal or synthetic target dispatch was added. Saved-workflow secret handling is unchanged.

## Focused verification

The single focused build-and-test attempt stopped at `npm run build:desktop`: `tsc: command not found`. This checkout has no `node_modules`. The OAuth regression file did not execute on either engine. The command cleared all five model keys, set `BAO_HEAL_CURSOR_ACCOUNT=0`, and used a disposable HOME. Output is in `.evidence/review-focused-verification.log`. No full test, lint, push, PR, or CI phase ran.
