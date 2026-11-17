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

Bao records none of the evidence below, and this view adds no recording. Sizes and times are from the six-step Robinhood run `run-fb3d9279` (19 MB on disk, 9 page reads) unless a line says otherwise.

| Evidence Bao could record | Why the view needs it | What it would unlock | Rough cost |
| --- | --- | --- | --- |
| An MHTML archive on every page read. Now: once per address. | Snapshot is Playwright's main pane. Only 3 of the run's 9 reads kept an archive. | Snapshot for Before and After of every step, with the whole page and not only the viewport. | 125 to 326 KB gzipped per read; 6 more reads is about 1.9 MB on this run. A read with an archive took 44 to 193 ms, one without 12 to 55 ms. |
| A picture before every step. Now: only a step that names a target. | Steps that read the page have no Before picture. | Before for every step, with no archive needed. | 167 to 281 KB per picture. Capture time not measured; assume 50 to 100 ms per step. |
| The target's DOM node id or selector. Now: ref, role, name, and box. | Playwright marks the target inside the snapshot. | The target marked in Snapshot, and a jump from a step to its node in the DOM and accessibility files. | About 100 bytes and one CDP call per step. |
| Console messages as they happen, with time and code location. Now: one read at the end of the step, text only. | Playwright's Console shows when and where each message fired. | Console lined up with the timeline and the requests; messages during an owner wait. | About 200 bytes per message. It needs a listener on Bao's own CDP socket or an agent-browser change, not a per-step call. |
| Page errors for one step. Now: every error so far, because pinned agent-browser does not clear its buffer. | Errors repeats old page errors on every step. | Errors with this step's page errors only. | No bytes. An agent-browser fix, or the same listener as the console. |
| A tab video on every route. Now: Running Chrome over remote debugging only. | The film strip and the hover frame come from the video. | A film strip on Bao-profile and copy runs, which now show step pictures. | 0.63 MB for 69.5 s on this run, about 0.54 MB a minute. |
| The accessibility tree before a step. Now: after only. | Page shows what the agent could read after the step, not before. | What the agent could read before it acted, and a before and after diff. | About 10 KB gzipped per read on this run. On a large page the call takes about as long as the step. |
| Why a request has no response. Now: Chrome's error, for a refused request only. | Network cannot tell a download from a cancelled or unfinished request. | "Handed to a download", "cancelled", or "still running" on the row. | Bytes. agent-browser's HAR drops these events, so it needs an agent-browser change or Bao's own listener. |

Four Playwright parts have no evidence to record:

- **Log.** agent-browser returns the command's result, not the waits and checks it made.
- **Source.** An agent run has no test file. The step's `why` is the nearest thing Bao keeps.
- **Pick locator.** It needs a selector engine over the snapshot, beyond the node id above.
- **A time-range filter, playback, and resource-type chips in Network.** No evidence is missing. They are left out to keep the view small.
