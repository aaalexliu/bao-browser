# Trace view

The trace view is a debug view of one run, laid out like [Playwright's trace viewer](https://playwright.dev/docs/trace-viewer). It is a page of its own, `/trace?run=<runId>` on the app's port, and it does not replace the run receipt. A receipt with step records links to it with Open trace. `&step=<n>` opens a step; with none, the view opens on the first failed step, or the first step. The Run link goes back to the receipt (`/?run=<runId>`).

The view records nothing. It reads the run file, the step records, and the pictures and video that [agent_browser evidence](agent-browser-engine.md#evidence) describes. `desktop/src/app/trace-view.ts` builds the HTML, `desktop/src/app/trace-client.ts` is the page's script, and `desktop/src/app/public/trace.html` holds the styles.

## What each part reads

| Part | Shows | Reads |
| --- | --- | --- |
| Timeline | A time ruler, thumbnails, and one bar per step. Hover shows the frame at that time and the step then running. A click picks that step. | Step start and end times. Thumbnails are frames of `videos/<runId>` when the run has a video, else the newest step picture by each time. |
| Actions | Each step's sentence, how long it took, and its `why`. Up and Down move between steps. | The run file. |
| Metadata | Run id, task, status, the agent's report, start, length, browser route, step and record counts, `run.har`, video. | The run file and the record index. |
| Before, After | The page before or after the step. Screenshot is the stored picture; on Before it carries the target's box and its centre. Snapshot is the read's MHTML archive as a page, when that read kept one. | `shots/runs/<runId>/`, the step's `target`, and `<phase>.html`. |
| Call | Command and arguments, `why`, status, start, length, wait, page read times, target, and the command's output. A value typed into a field whose label names a secret reads Hidden, as in the receipt. | The run file and the step record. |
| Errors | The step's own error, page errors, and failed loads. | The step record. |
| Console | Console messages read at the end of the step. | The step record. |
| Network | The step's requests in the order they ran, with a text filter. A row opens its headers, query, and bodies. | The step record, then `request-<index>.json`. |
| Page | Title, address, viewport, and scroll of each read, the raw file downloads, the links and forms map, and the accessibility tree after the step. | The step record and `after.ax.json`. |
| Attachments | Files the step saved or attached, with path, size, and SHA-256. | The step's `transfer` in the run file. |

A step with no step record still shows its pictures, Call, and Attachments. The other tabs say Bao kept no step record for it.

## What Playwright shows that this view cannot

Each line names the evidence Bao does not record. None of it is recorded for this view.

- **A snapshot for every step.** Bao keeps an MHTML archive once per address, so a later read of the same page has a picture but no Snapshot. It keeps a Before picture only for a step that names a target.
- **The target inside the snapshot, and Pick locator.** The step keeps a ref, role, name, and box, not a selector or a DOM node id, so the view marks the target on the picture only.
- **Log.** agent-browser returns the command's result, not the waits and checks it made.
- **Source.** An agent run has no test file. The step's `why` is the nearest thing Bao keeps.
- **Console times and code locations.** agent-browser's console read has neither, and it is taken once at the end of the step.
- **Page errors of this step only.** Pinned agent-browser does not clear its error buffer, so each step lists every page error so far.
- **A film strip on every route.** Only a Running Chrome session over remote debugging keeps a tab video.
- **Why a request has no response.** The HAR keeps Chrome's error for a refused request, and nothing for one handed to a download or still running at export.
