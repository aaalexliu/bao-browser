# Proxy design

Bao's desktop app as the computer that a computer-use agent drives. The agent never gets a pipe to the machine. Bao executes each action, records what the agent saw and did, and turns that trace into a workflow the replayer can run without the model.

This pass is a design. No proxy code. It sits on the desktop spikes: an owned Chrome profile (`desktop/`, spike 1) and an AT-SPI helper for native dialogs (`desktop/os-helper/`, spike 2). The shared IR stays `Workflow` / `Step` in `src/types.ts`. Extension behavior does not change.

The constraints the shape has to honor:

- A version-2 workflow is the only thing replay runs. Vendor action JSON is an audit log, not a second program.
- Capture resolves a pixel to a selector or an accessibility target while the widget still exists. Replay does not re-guess from coordinates.
- Write steps do not run on replay until something other than the model allows them.
- A demo uses a throwaway profile. Capturing a person's real session requires consent that this design does not assume.

## Usage

A person installs the desktop app and points an agent at it. The agent still speaks its own computer-use protocol. Bao is the program that protocol already expects the integrator to write: execute actions, return a screenshot.

After the run, the app shows a workflow. Reads are assertions ("the heading was New Window"). Writes are the state changes (the checkbox, the upload, the save dialog) with the typed strings pulled out as variables. Replay runs that workflow in a fresh throwaway profile, or later in the app-owned profile, and does not call the model.

Two call sites, same executor:

```ts
// Vendor adapter. Parses one published action batch, does not store it as the workflow.
await executor.observe();                              // screenshot for the model
await executor.perform(vendorBatch);                  // resolves, acts, appends Steps

// Replay. No vendor types in this call.
await replay(workflow);                                // semantic steps only
```

## Where each agent plugs in

Schemas below are the ones the public docs actually publish. Where a vendor has no action schema, this doc says so and does not invent one.

### OpenAI computer tool

Guide: [Computer use](https://developers.openai.com/api/docs/guides/tools-computer-use). Handlers: [Computer use integration recipes](https://developers.openai.com/api/docs/guides/tools-computer-use-integration).

The Responses request enables the tool with `tools: [{ type: "computer" }]`. The model returns a `computer_call` with an ordered `actions` array. The guide's example batch is a `click` (`button`, `x`, `y`) followed by a `type` (`text`). The documented action types are `click`, `double_click`, `drag`, `move`, `scroll`, `keypress`, `type`, `wait`, and `screenshot`. `status: "completed"` means the model finished generating the call. The app still has to execute it.

The app answers with a `computer_call_output` whose `call_id` matches, carrying a `computer_screenshot` (`image_url`, `detail: "original"`), and continues with `previous_response_id`. If the app downscales the image, it has to map coordinates back before acting. The guide's preferred desktop resolutions when scaling are 1440×900 and 1600×900.

Bao's seat is that action handler. Not a CDP socket handed to the model. The integration recipes say the handler maps structured requests onto browser or OS input and keeps those details out of the rest of the loop. That handler is Bao.

Codex, as documented in [Sandbox](https://developers.openai.com/codex/concepts/sandboxing), is a different surface. Local Codex runs shell commands inside `read-only`, `workspace-write`, or `danger-full-access`, with an approval policy (`on-request` or `never`). That page does not publish a pixel action schema. A Codex session that uses the Responses computer tool is the computer tool above. A Codex session that only runs shell commands is not this proxy. This design does not invent a Codex-only click schema.

### Claude computer use

Guide: [Computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool). The tool index lists the type as a client toolset: [Tool reference](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference).

Current shape: one `{"type": "computer_toolset_20260801"}` entry. Claude emits `tool_use` blocks whose `name` is the member and which carry `"toolset_name": "computer"`. There is no `action` field. The guide lists 17 members:

| Member | Input the guide documents |
| --- | --- |
| `screenshot` | `{}` |
| `zoom` | `region: [x0, y0, x1, y1]` |
| `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click` | optional `coordinate: [x, y]`, optional modifier `text` |
| `left_click_drag` | `start_coordinate`, `coordinate`, optional modifier `text` |
| `mouse_move` | `coordinate` |
| `left_mouse_down`, `left_mouse_up`, `cursor_position` | none |
| `scroll` | `scroll_direction`, `scroll_amount`, optional `coordinate`, optional modifier `text` |
| `type` | `text` |
| `key` | `text`, optional `repeat` |
| `hold_key` | `text`, `duration` |
| `wait` | `duration` |

Coordinates are pixels of the full-display screenshots the app returns, origin top-left. A `zoom` image does not change that space. The toolset entry rejects `display_width_px`, `display_height_px`, and `display_number` from the older `computer_20251124` tool. Earlier dated versions (`computer_20251124` and the beta versions before it) keep a single `computer` tool with an `action` parameter. This design targets the toolset. An adapter for the older `action` field is a parser change, not a second executor.

The app returns one `tool_result` per `tool_use`, matched by `tool_use_id`, each echoing `toolset_name: "computer"`. `screenshot` and `zoom` return an image. Other members can return a short text such as `OK`. Batches run in order and stop at the first failure. Every block still needs a result.

The same guide says webpage tasks fit the browser use tool better, and that computer use and browser use are separate toolsets distinguished by `toolset_name`. This pass did not fetch the browser toolset's member list, so it does not name those members.

Bao's seat is the same as OpenAI's: the application that runs the calls. Claude does not receive CDP.

### Grok

Two public surfaces, neither of which is a pixel action schema.

The API tools overview ([Tools](https://docs.x.ai/developers/tools/overview)) lists server-side tools (web search, X search, code execution, image generation, collections) and client function calling. [Function calling](https://docs.x.ai/developers/tools/function-calling) is a tool you define: `name`, `description`, and a JSON Schema `parameters` object whose root is an object. The model returns a `tool_call`. The app executes it and sends the result back. There is no published `click` / `screenshot` enum.

Grok Bot ([Use the computer and apps](https://docs.x.ai/grok-bot/computer-and-apps)) runs a persistent cloud computer with a browser, terminal, and files. The preview shows clicks and typing. The enterprise page ([Grok Bot for teams and enterprises](https://docs.x.ai/grok-bot/teams-and-enterprises)) describes Action Recording: computer-use sessions store action counts, screenshot counts, and duration, and do not store the screenshots, the clicks, or the typed text. There is no documented local executor endpoint and no documented action payload a proxy could intercept.

So Bao cannot sit inside Grok Bot's computer from the published docs. The plug-in that does exist is function calling: Bao would publish semantic tools, and Grok would call those instead of driving a desktop. That is shape 2 below. It is not a shim in front of a pixel model.

## Design it twice

Two shapes that do not reduce to each other. A third, CDP passthrough, is recorded because it is the obvious shortcut and it loses.

### Shape A — screenshot and action shim

Bao owns the display (spike 1's Chrome, spike 2's AT-SPI session). A local executor accepts the vendor's native batch, in the vendor's JSON, and returns the vendor's native observation (`computer_call_output` or `tool_result`).

At each pixel action the executor hit-tests the live page or the accessibility tree, writes a `Step`, and performs the semantic action (CDP click, `setInputFiles`, AT-SPI `doAction`). The screenshot the model gets is taken after that action, from Bao's window only.

The vendor loop is unchanged. OpenAI and Claude computer-use models keep emitting the actions they were trained to emit. Bao is a conforming handler.

What it hides: selector ranking, focus tracking for `type` (neither vendor puts a coordinate on `type`), OS versus DOM, and the decision to refuse an unresolved click. What it shows the model: a screenshot, which is the whole interface those models have.

Red flags to keep out. The vendor action union must not leak into `Step`. Parsing happens in the adapter. The executor appends steps. The model loop does not. One writer.

### Shape B — semantic MCP (or function tools)

Bao publishes tools whose arguments are already the IR: a ranked selector or an `OsTarget`, a value, an upload basename. A click tool does not take `x` and `y`.

This matches xAI function calling, and it matches any agent that can call an MCP server. It does not match the OpenAI computer tool or the Claude computer toolset. Those models emit a fixed action list. Replacing `left_click` with a selector tool means you are not running their computer-use tool. You are running a different agent that happens to share a brand.

What it hides: pixels, hit-testing, the whole coordinate mess. What it shows the caller: the workflow vocabulary. The interface is small only if the tool list is the step actions and not a second copy of them.

Red flag if both shapes are live replay paths. Two ways to click, and the next agent copies whichever file it opens.

### CDP passthrough, rejected

Hand the model, or a Playwright script the model writes, the CDP connection to the owned Chrome. Desktop-design already refused attaching to a browser Bao did not start, and refused port 9222. A passthrough also gives two writers to the page (the model and the recorder). Pixel computer-use models do not speak CDP, so this shape does not plug in the agents above. It only fits an agent that already is Playwright. That agent is spike 1's harness, not a proxy.

### Synthesis

Shape A is the base. The agents that have a public computer-use schema only speak pixels, so the first integration has to accept pixels. Shape B is the same executor's other door, opened later for function-calling models (Grok's API, and any MCP client). It is not a second implementation of click.

Taken from A: the vendor loop stays outside, the adapter is a parser, unresolved pixels fail the capture rather than replaying as coordinates.

Taken from B: the stored program is semantic. Replay never sees `x` and `y`. The MCP tool list, when it exists, is generated from the step actions so there is one list.

Rejected: replaying the raw vendor trace, CDP passthrough, and a Grok Bot shim. The last one has nothing public to shim.

Interface depth. Callers of the executor use two operations, `observe` and `perform`. Adapters are not a layer the replayer imports. The workflow file is the contract between capture and replay. That is the whole public surface.

Tradeoffs accepted:

- We accept a pixel model that can click the wrong widget, in exchange for using the computer-use weights as published. Resolution at capture time is what makes the stored workflow not inherit that miss. If resolution fails, the run is not replayable.
- We accept that `type` has no coordinate in either schema, in exchange for not inventing a field. The executor binds `type` to the element focused by the previous resolved click. A `type` with no focus is unresolved.
- We accept that Grok Bot cannot be proxied yet, in exchange for not inventing an action enum from a product screenshot.
- We accept a scripted first spike instead of a live model, in exchange for a pass/fail that does not depend on an API key or a model choosing different coordinates every run.

## Mapping pixels onto the IR

Resolution runs at capture, before the action is performed, against the tree that is on screen.

| Vendor action | Resolved step | Notes |
| --- | --- | --- |
| OpenAI `click` / Claude `left_click` with a coordinate | `click` or `setChecked` or `osClick` | DOM: `elementFromPoint`, then the same ranking spike 1 uses. OS: AT-SPI hit-test, then role + name + path as in spike 2. The raw `x`,`y` stay on an audit record, not on the step the replayer reads |
| OpenAI `type` / Claude `type` | `input` or `osType` / `osSetValue` | Bound to the focused control. Value is the `text` argument |
| OpenAI `keypress` / Claude `key` | `keypress` or `osKey` | Only the keys the IR already allows become replayable. Anything else stays unresolved |
| `screenshot`, Claude `zoom`, `cursor_position`, `move`, `wait` | no step, or an `assert` if interpret keeps a read | These do not change the page. They are observations |
| `scroll`, `drag`, mouse-down/up, `hold_key` | unresolved until a later spike | The executor returns an error result to the model and does not invent a step |
| Upload via the OS dialog | `uploadFile` plus the spike 2 `osSetValue` / `osConfirm` pair | Basename only, as spike 1 already requires |

A click that does not resolve to exactly one DOM node or one accessibility node is unresolved. The batch stops, the same way Claude's guide says to stop a batch on the first failure. The workflow is marked not replayable. Bbox may be stored. It is not the replay strategy. Spike 2 already showed why: GTK 4 reported both the name field and OK at screen origin `(0, 0)`.

`type` into a field spike 1 would have masked (password, card, SSN) stores `sensitive: true` and drops the value, same rule as the extension. The audit log drops it too.

## Interpret

Interpret reads the trace once and writes one workflow. It is not a second store that stays in sync by hand.

Collapse:

- Consecutive screenshots, zooms, moves, and waits drop out.
- A click that did not change the DOM or the accessibility tree, followed by another click that did, drops the first. That is a retry.
- Exploration that returns to the start URL and never uses what it saw drops, unless a later step's value came from that page. Then the dropped page becomes an `assert` of the text that was used.

Label:

- A **read** is an observation the later write actually consumed: the heading text, the filename the dialog was about to save, the value copied into the next field. It becomes an `assert` (`textPresent` or `urlMatches`). A screenshot nobody's later step depends on is not a step.
- A **write** is a step that changes state: `setChecked`, `input` that is still in the field at the end, `uploadFile`, a click that submits, `osSetValue`, `osConfirm`, a file the OS helper created. Navigation is a write of the address only when the workflow continues from the new document. Otherwise it is how a read was reached.

Parameterize:

- The strings the agent typed, and the upload basename, become `variables` entries. The step keeps a reference, not a fresh copy of the literal, when the same string is used twice.
- Coordinates never become variables.

The output is a version-2 `Workflow`. `startUrl` is the first document. An OS-only tail (the save dialog) keeps `surface: "os"` steps after the DOM steps. The extension still does not run that workflow. Desktop-design's open question on version-2 in the side panel stays open.

## Safety

Writes are gated on replay. The replayer runs reads and non-submitting DOM setup only when the gate is closed. `uploadFile`, a submitting click, `osConfirm`, and any step interpret marked write-and-external (send, pay, delete) wait for an explicit allow on that run. The gate is not the model. The first spike's checkbox is a write of page state inside the throwaway profile. It is not an external write, and the spike allows it so the demo can finish. The gate's default for anything that leaves the profile is closed.

No capture of a real session without consent. The proxy launches the owned profile or a fresh temp profile. It does not attach to a running Chrome, does not open port 9222, and does not read the daily profile directory. Spike 1 already refuses those paths. The proxy uses that launch.

Screenshots returned to the model are cropped to Bao's window. A full-desktop grab can include a window the person did not hand to the agent. They are not uploaded anywhere by this design. Sensitive field values are not written into the trace.

A vendor `pending_safety_check` on an OpenAI computer call, if the API includes one, is surfaced to the person. This design does not auto-acknowledge it. The public guide points at safety checks on the computer call in the SDK types. This pass did not need that field for the first spike.

## First proxy spike

Scripted, no model. The driver speaks the OpenAI `computer_call` shape from the guide, because that batch is the smallest published pixel protocol and this VM can run it against spike 1's Chrome. Claude's 17-member toolset and Grok's missing schema are not this spike.

**Setup.** Throwaway Chrome profile, same launch as spike 1, public page `https://the-internet.herokuapp.com/checkboxes`. No daily profile, no port 9222.

**Driver.** A local executor, `POST` a `computer_call`:

1. `{ "type": "screenshot" }` returns a PNG of the page.
2. The driver reads the checkbox center from the page (the test knows the box; a model would have guessed it) and sends `{ "type": "click", "button": "left", "x": <n>, "y": <n> }`.

**Capture.** The executor hit-tests that point, stores a version-2 `click` or `setChecked` whose `target.selectors` is non-empty, performs the action, and returns a `computer_screenshot`. The stored step does not use `x` and `y` as the replay key.

**Replay.** A fresh profile loads the workflow and runs the semantic step. The checkbox matches. The replayer has no coordinate input.

**Pass.** Workflow version 2, a selector on the step, replay flips the same checkbox, profiles deleted, the executor's response is a `computer_call_output` with the matching `call_id`.

**Fail.** Replay clicks the stored coordinate. Resolution misses and the run still claims success. The driver needed a network call to OpenAI. The profile was not a temp dir.

Claude's adapter and a live model are the spike after this one, on the same executor. Grok waits until either xAI publishes a computer-use action schema or we deliberately expose shape B's function tools.

## Open questions

- Does interpret's "a read is whatever a later write consumed" miss reads a person still wants to see in the workflow, such as a price they only looked at?
- Is the write gate a per-step allow, or one allow for the whole replay? A per-step gate is safer and tedious. A whole-run allow will get clicked through.
- The spike 1 ranker is not `content.ts`. A proxy that stores selectors from the ranker will drift from the extension. Which ranker is the one the workflow is allowed to contain?
- Claude `zoom` and OpenAI downscaling both change what "the pixel" means. The first spike uses an unscaled screenshot. Who owns the scale factor when a live model forces a resize?
- Grok Bot's teach-by-demonstration ([Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)) records a browser workflow for up to ten minutes and drafts a skill. If that skill is ever exportable, it might be a second interpret input. Today the docs do not say the recording leaves the cloud computer.
