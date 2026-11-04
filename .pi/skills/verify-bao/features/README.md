# Bao verification map

This is the maintained source for verifying Bao's core workflow loop. Read the skill's safety boundary and Launch section first. All default recipes use a local fixture, temp `HOME` and Library, bundled Chromium, fresh profiles, and a private live lock. They need no model or macOS privacy grant.

## Conventions

- `verify.mjs run <new-absolute-evidence-dir>` establishes and cleans up the baseline in one foreground run. `verify.mjs` lives one directory above this file.
- Read-only doctor checks precede driving. After a failed action, check health and restore a known state before retrying.
- MCP `live_*` refs come only from the latest view. Browser handles come only from the latest `chrome-devtools-axi snapshot`.
- Save the command/action and result, a screenshot plus accessibility snapshot for UI claims, and an independent read of stored effects for mutations.
- Keep evidence after cleanup. Record feature ID and user entry point in the review. An untested alternate entry point is not verified by another path.
- The baseline covers the live MCP recording path, MCP replay, and Library/Runs overview states. Deeper UI entry points below need their own drive when affected. Do not claim the whole app from this map: Capture/Teach, extension install, Logins, Heals, sync, native packaging, and real sites are outside the seeded scope.

## Features

- [Live session and recording](live-session.md): start, snapshot, act, stop, and saved workflow through MCP.
- [Workflow replay](replay.md): MCP replay and the Library/detail/Replay UI entry points.
- [Library](library.md): empty and saved workflow states, search, and opening a workflow.
- [Runs](runs.md): empty state, run list, and opening a run receipt.

## Maintenance

Use `/skill:maintain-verification-skill` for a source and live pass over every file. Compare sibling files with this index. Add a feature only with a concrete user entry point and an observable proof recipe; remove stale paths rather than preserving them as guesses.
