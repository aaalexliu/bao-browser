# Read-only MCP run viewer

Bao's local stdio MCP server can show run history and receipts in an MCP Apps host. The desktop app remains a full client. Its Library, Runs, Settings, recording, replay, and human handoffs do not change.

## Host contract

The host must advertise `io.modelcontextprotocol/ui` with `text/html;profile=mcp-app` in its initialize capabilities. Bao then lists and serves `ui://bao/runs/v1.html` through `resources/list` and `resources/read`.

- `agent_browser` shows an annotated page picture and a short caption in capable hosts. Its exact native stdout/stderr, snapshot refs, and thrown errors remain in `content` blocks after the caption. `structuredContent` also carries exact results, exit codes, and run identity.
- `get_run` keeps its existing text receipt and adds a compact viewer in capable hosts.
- `list_runs` adds the viewer to the [catalog history result](bao.md#mcp) and lets the app page through history.
- `inspect_run` reads one run's receipt and workflow steps, twenty steps per page. The host exposes this reader to the app, not the model.
- `open_browser_picture` fetches the card's picture after mount, with a 512 KiB cap and loading and unavailable states. The host exposes this reader to the app, not the model.
- `open_step_pictures` reads pictures only after the owner clicks **Open step pictures**. The host exposes this reader to the app, not the model.

Clients that do not negotiate the UI MIME type get the [standard MCP tools and Library identity](bao.md#mcp). These clients get plain text results without viewer metadata or resources and do not need an HTML renderer. This feature does not install or configure Claude Desktop, Codex Desktop, or ChatGPT, and it does not change tool approval settings. Support depends on the host and release; an MCP connection alone does not prove embedded UI support.

The viewer checks host capabilities for further reads, theme, locale, and full-screen mode. **Inspect receipt** requests full-screen mode only when the host offers it. Otherwise the receipt expands inline. The HTML bundles its code and styles and requests no external connections or resources.

Read errors keep the loaded receipt or history visible. For a failed read, try **Refresh**; if it keeps failing, open Bao desktop for local details. If the viewer cannot load, reopen it from the conversation. When the host cannot read more data or does not forward viewer data, use the text receipt or Bao desktop instead. Theme and size updates preserve keyboard focus and the open or closed state of **Workflow steps**.

## Browser tool cards

The same resource renders direct-browser results without changing native commands. Open, snapshot, tab, key, scroll, and screenshot calls show the recorded page with a page label. Click and fill try to capture the requested target and its rectangle before sending the command. Their card marks that target on the **Before click** or **Before fill** picture. This identifies the action; it does not claim that the site finished its work. Take a later snapshot to check the result.

Visual connections record JPEG page pictures. Run, step, phase, and target geometry go to the iframe in `_meta.baoToolCard`, without image bytes. After mount, the iframe calls the app-only `open_browser_picture` reader for one bounded picture. The original command output stays intact in `content` blocks after the caption and in `structuredContent.results`. It is not copied into the visible caption. Tool inspectors belong to the host and may still expose raw data.

**View run** calls Bao's existing read-only `inspect_run` tool with the exact run id. It does not ask the host for filesystem access. The existing receipt body shows capture sessions without requiring a workflow. Recording sessions report recording; finished sessions report their saved result. Capture receipts can open valid bounded step pictures and do not link to a nonexistent workflow. Workflow search and description still use their previous presentation.

An unavailable target picture does not prevent the native command. The card names missing evidence instead of guessing a target. Close, owner waits, and calls without their own picture show an unavailable-picture canvas, never an earlier call's picture. Waits do not take a new screenshot. Early returns keep the active session's run id. Command failures retain their exact diagnostic for the model and give the person a short recovery instruction.

Clients that do not negotiate MCP Apps keep their existing native-text browser results. Test the owner's actual host connection before claiming that host renders the rich card. A local stdio proof does not establish ChatGPT connectivity.

## Run evidence

The viewer reads the same Library files as Bao desktop. It has no second database. Run and workflow reads cap each record at 2 MiB. History pages cap run reads at five records. Detail pages cap run steps and workflow steps at twenty each. Unavailable or oversized history records consume a page slot and show a skipped-record count.

The projection omits the run's input fields, raw snapshots, native command arguments and output, dedicated local asset path fields, video, and resume tokens. Stored reasons, read-backs, and owner requests are not scrubbed and may contain input values or local paths. It shows model-call counts as unknown when a record does not track them. A recorded zero counts Bao model calls, not calls made by an external coding agent. Browser captures without a saved workflow still have a receipt with their stored step reasons and available pictures. Detailed evidence in Bao desktop also exposes native command arguments and output.

The stored run supplies step reasons, read-back receipts, and owner requests. The current workflow supplies optional labels, not evidence permissions. Editing or deleting a workflow does not hide a past run's evidence. Secret, file, sensitive, and unclassified steps use the same local evidence path as every other recorded step. Marketplace review uploads keep their existing step-crop exclusions. Bao cannot restore values or pictures that an older capture or save discarded.

Pictures load when the owner opens them, not with the initial receipt or history. Image bytes appear in tool-result `_meta`, which the host app renders. Picture reads require a step recorded in that run, not a current workflow definition. Bao reads stored or derived filenames within the run's picture directory and caps each picture at 512 KiB. A request returns at most two PNG/JPEG pictures. Missing, invalid, linked, or oversized pictures remain unavailable.

The viewer offers no run, resume, edit, approve, or browser-control action. In UI-capable connections, `list_runs`, `inspect_run`, and `open_step_pictures` are callable by the iframe; other tools are model-only. The host enforces tool visibility. This is not a new authorization scheme or a change to the model's existing tool permissions.

## Known gaps

- If a host advertises full-screen mode but the request fails, the receipt does not fall back to an expanded inline view. This remains deferred.

## Follow-ups

Workflow library browsing, editing, inline video, run and approve buttons, a remote relay or hosted plugin, and any change to the desktop app's role remain separate work. Desktop client setup is covered in [Add Bao to a desktop app](desktop-mcp-install.md).
