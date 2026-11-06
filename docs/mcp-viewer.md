# Read-only MCP run viewer

Bao's local stdio MCP server can show run history and receipts in an MCP Apps host. The desktop app remains a full client. Its Library, Runs, Settings, recording, replay, and human handoffs do not change.

## Host contract

The host must advertise `io.modelcontextprotocol/ui` with `text/html;profile=mcp-app` in its initialize capabilities. Bao then lists and serves `ui://bao/runs/v1.html` through `resources/list` and `resources/read`.

- `get_run` keeps its existing text receipt and adds a compact viewer in capable hosts.
- `list_runs` shows five recently updated runs per page, with a useful text result.
- `inspect_run` reads one run's receipt and workflow steps, twenty steps per page. The host exposes this reader to the app, not the model.
- `open_step_pictures` reads pictures only after the owner clicks **Open step pictures**. The host exposes this reader to the app, not the model.

Clients that do not negotiate the UI MIME type see exactly the previous tools and results. They do not need an HTML renderer. This feature does not install or configure Claude Desktop, Codex Desktop, or ChatGPT, and it does not change tool approval settings. Support depends on the host and release; an MCP connection alone does not prove embedded UI support.

The viewer checks host capabilities for further reads, theme, locale, and full-screen mode. **Inspect receipt** requests full-screen mode only when the host offers it. Otherwise the receipt expands inline. The HTML bundles its code and styles and requests no external connections or resources.

Read errors keep the loaded receipt or history visible. For a failed read, try **Refresh**; if it keeps failing, open Bao desktop for local details. If the viewer cannot load, reopen it from the conversation. When the host cannot read more data or does not forward viewer data, use the text receipt or Bao desktop instead. Theme and size updates preserve keyboard focus and the open or closed state of **Workflow steps**.

## Data and privacy

The viewer reads the same Library files as Bao desktop. It has no second database. Run and workflow reads cap each record at 2 MiB. History pages cap run reads at five records. Detail pages cap run steps and workflow steps at twenty each. Unavailable or oversized history records consume a page slot and show a skipped-record count.

The projection omits input values, raw snapshots, native command arguments and output, dedicated local asset path fields, video, and resume tokens. Ordinary step text may contain local paths. It shows model-call counts as unknown when a record does not track them. A recorded zero counts Bao model calls, not calls made by an external coding agent. Browser captures without a saved workflow still have a receipt; their detailed evidence stays in Bao desktop.

Pictures never load with the initial receipt or history. Opening a step's pictures sends those pictures from the Mac to the host app. The host may retain them under its own data policy. Image bytes appear only in tool-result `_meta`, not in the model-visible `content` or `structuredContent`.

Picture reads use the same sensitive-step and secret-input exclusion policy as Bao's shared evidence export. Unknown steps and captures without a workflow cannot share pictures. Bao derives filenames on the server, refuses linked files and directories within the Library, and caps each picture at 512 KiB. A request returns at most two PNG/JPEG pictures. Missing, invalid, linked, private, or oversized pictures stay local. This policy does not guarantee that every visible pixel is free of other private page content.

The viewer offers no run, resume, edit, approve, or browser-control action. In UI-capable connections, existing tools are model-only; only the new reader tools are callable by the iframe. The host enforces tool visibility. This is not a new authorization scheme or a change to the model's existing tool permissions.

## Known gaps

- If a host advertises full-screen mode but the request fails, the receipt does not fall back to an expanded inline view. This remains deferred.
- Runs of a workflow edited after the run withhold step evidence and pictures in MCP Apps hosts. Missing workflows and unknown start or file times also withhold that evidence. Run summaries, step labels and statuses, and available workflow steps remain visible. The viewer compares a checked workflow-file snapshot with the existing recording-start timestamp, which must precede the first step and save time. Runs without that timing withhold the same evidence; `run.at` is a save time, not a start time. Durable per-run privacy marks remain a possible follow-up.

## Follow-ups

Workflow library browsing, editing, inline video, run and approve buttons, a remote relay or hosted plugin, and any change to the desktop app's role remain separate work. Desktop client setup is covered in [Add Bao to a desktop app](desktop-mcp-install.md).
