# Run output

Files in this directory are local run output. They are not source.

`desktop/src/cdp-live/session.ts` writes `session-run.json`, `session-workflow.json`, and `unfreeze-workflow.json` on a live run. `desktop/src/cdp-live/run.ts` writes `cdp-live-run.json`. `desktop/src/cdp-live/instacart-run.ts` writes `instacart-once.json` and `instacart-once-state.json`. `desktop/src/cdp-live/login-diff.ts` writes `login-diff.json`. Nothing in the tests or the docs reads those files. `docs/cdp-live-chrome.md` says the workflow draft stays in this directory and is not part of the tree. Git ignores them.

`git rm --cached` keeps a working copy of the two workflow drafts only in the checkout that ran the removal. A fast-forward deletes them from a checkout that still has them tracked. `git merge --ff-only` fails when `session-workflow.json` has local edits. `session.ts` writes both files again on a live run.

Git also ignores these paths:

- `frames/`
- `bao-home/`
- `session-inbox.txt`
- `cdp-live-ax.jsonl`
- `session-run.json`
- `cdp-live-run.json`
- `instacart-once.json`
- `instacart-once-state.json`
- `login-diff.json`
- `session-workflow.json`
- `unfreeze-workflow.json`

A file here is a fixture only when a test or a doc names that file.
