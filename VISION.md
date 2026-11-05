# Vision

Bao exists so that a person's agent can use their signed-in Chrome without making them start over in a remote browser.
It serves the person who already has accounts, tabs, and work on their computer, and turns agent-driven browser work into a local record they can inspect and understand.
It owns exactly one thing: the local connection between an agent and the person's browser session, including the record that connection leaves.

## Preserve the person's browser context

The chosen Chrome profile, not an empty automation profile, supplies the working context.
A clearly marked private profile copy is the default; it preserves the login and tab state the task needs without writing back to the source profile.
When the copy does not work, attachment to running Chrome remains a valid fallback, including computer use to open its debugging connection.
Bao makes the active profile and the distinction between original and copy clear rather than asking the agent to infer them.
Adopting an existing original tab needs a concrete task that depends on its unsaved state, not a general promise to share every open tab with the agent.
Grounding: merged commits `d4e2969`, `b79ce15`, `3ca8f08`, and `c2ccde1`.

## Ask only for permissions the task needs

Chrome screenshots and video come from Chrome, not macOS screen capture.
Screen Recording is neither a prerequisite nor an onboarding request for driving Chrome.
Accessibility and Chrome Automation serve the connection when needed; a route that works without them does not ask for them.
An optional OS adapter is in scope when a concrete browser task needs a native dialog; system capture and coordinate control require an explicit opt-in, never a new default grant.
Grounding: merged commits `152d261`, `85ee0be`, and `3ca8f08`.

## Let the agent drive

Bao connects the person's chosen agent to browser actions; it does not take over the agent's judgment about the task.
The direct command route preserves native commands and results instead of inserting site-specific approvals or interpreting button labels as authority.
A final account-changing click is not, by itself, a reason for Bao to block an agent's command.
An explicit native request to read authentication cookies is within that direct contract, not a reason to add a hidden command filter.
A quiet session stays open without keep-alive work until the person or agent ends it, the owning client disconnects, or the browser ends.
Grounding: merged commits `261358d`, `811cb73`, and `c2ccde1`.

## Name meaningful work, not tool mechanics

The run's steps and the workflow's intent let a person understand the task without decoding an agent transcript.
A visible step names the action and the meaningful page element, such as clicking the Unfreeze button, not merely clicking ref 28.
Workflow intent states the person's goal, not a list of tool calls or a generic generated title.
Stable ids and refs remain under the hood for targeting and debugging; readable labels do not replace or silently rename them.
The full JSON of any saved workflow remains available for inspection alongside its readable presentation.
Grounding: merged commits `672e2fc`, `dd835ae`, and `d5734bc`.

## Keep an honest, useful local record

The person can open Bao's Library to see what the agent did, including a session that failed before its first page action.
Commands, results, step pictures, and failure reasons belong to the run they describe.
Recording, completed capture, and successful replay are different claims, and missing evidence carries an explicit reason rather than an invented score, empty inspector, or false success.
A recording warning does not change the native action result; an unrecoverable failure such as a full disk aborts plainly instead of creating a special read-only command mode.
An uncertain action does not become a silent second attempt, and a completed click does not by itself prove a durable site-side result.
Grounding: merged commits `dd835ae`, `1b1f1cb`, `d5734bc`, and `3ca8f08`.

## Treat local use and sharing as different boundaries

The browser session and its useful record remain usable locally without a cloud account or hosted execution service.
A local-only recording may retain typed credentials; perfect secret removal is not a prerequisite for a working local command path.
Secret cleanup does not change live typing or corrupt labels, selectors, templates, or sealed evidence.
The chosen agent can receive requested page text and screenshots, including credentials, through its normal model path without a second Bao consent step.
Publishing or syncing a saved record is a separate boundary from those tool replies; optional remote access does not give Bao's server direct access to Chrome's cookies.
Grounding: merged commits `c2ccde1`, `159b5fa`, `ac659c8`, and `5c44166`.

## Scope

Bao's focus is the direct agent-browser connection, meaningful run steps, clear workflow intent, and inspectable saved data.
Replay, Heals, and the separate Live interface are outside the current product scope; their presence in the repository does not make them product obligations.
Bao is not a replacement coding agent, a cloud-browser farm, a general-purpose desktop-control requirement, or a mandatory approval system for the person's own agent.
Bao does not own recurring-purchase budgets, substitution rules, or standing purchase authority, and off-device Library backup needs a concrete shared-workflow use rather than a hypothetical local-only need.
The Mac is the primary product surface, not an identity boundary; Windows and Linux support must serve the same signed-in-browser and local-record contract.
A command recording does not promise a replayable workflow, a profile copy does not promise every site's login, and local use does not require a shared-workflow threat model.

A change aligns when it lets the agent complete real browser work with the chosen profile and few unrelated permission gates, while letting the person understand the steps, inspect saved workflow JSON, and trust the record's claims.
A change should be resisted when it substitutes an empty or remote session for the person's context, blocks local commands to impose task judgment, or presents opaque refs, invented intent, or unsupported success as a useful record.
