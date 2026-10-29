# Run output

Files in this directory are local run output. They are not source.

`desktop/src/cdp-live/session.ts` writes `session-workflow.json` and `unfreeze-workflow.json` on a live run. Nothing in the tests or the docs reads those files. `docs/cdp-live-chrome.md` says the workflow draft stays in this directory and is not part of the tree. Git ignores both files.

Git also ignores these paths:

- `frames/`
- `bao-home/`
- `session-inbox.txt`
- `cdp-live-ax.jsonl`

A file here is a fixture only when a test or a doc names that file.
