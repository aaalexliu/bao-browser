# Workflow schema v4

The contract is `schema/workflow.schema.json`, id `bao.workflow/v4`. `desktop/src/v1/schema.ts` `validateWorkflow` checks the same document the replayer reads. The marketplace validates that same file. A file with another schema id is not loaded. Old workflows are not migrated. Run records use id `bao.run/v4`. A run file with another schema id is not loaded.

## Document

`schema`, `id`, `name`, `startUrl`, `inputs`, `steps`, `createdAt`. There is no `version` field. Optional document `heal` is `auto` or `approve`. A step `heal` is `auto`, `ask`, or `never`. Optional `driver` is `playwright` or `extension`. Optional `imported: true` means this copy was installed from someone else. Absent means the owner recorded it. An input's `ownerSaved: true` means the owner saved that value after import. Author defaults omit it.

`provenance: "fixture"` stays in Library and is left out of agent search. Search also leaves out a workflow the caller cannot replay for its driver or selected engine. Search and replay share that check. Relay search uses the current extension connection. The registry filters candidates before its five-hit limit.

## Inputs

Collected before replay starts. Each input has `name`, `type`, `label`, and `supply`.

| type | meaning |
| --- | --- |
| `text` | Any string. |
| `secret` | A password. A local default may stay saved. An outbound copy drops that default and sets `supply` to `must`. |
| `number` | A number. |
| `choice` | One of `choices`. |
| `file` | A file. `supply` is `must`. A step may bind `file.fromOutput` to an earlier download instead of asking the owner. |
| `date` | A date. Replay resolves `relative` or `default` in `zone`. |
| `table` | Rows for `extract` and `for_each`. |

`supply: "saved"` requires `default`. `supply: "must"` has no default. A step refers to an input with `text.input`, `file.input`, `date.input`, `selection.input`, or `dialog.input`, and with `{{name}}` in a caption, URL, or check.

## Steps

Every step has `id`, `index`, `action`, `caption`, and `timeoutMs`. `caption.text` is the sentence shown to the owner. `caption.citation` is a string taken from the HTML element, with `source` of `text`, `name`, `label`, `aria-label`, `placeholder`, `alt`, or `title`. Buttons and links cite visible text. A select, textarea, or input cites its label. `caption.targetBox` is the control's box in the recorded viewport.

`action` is `click`, `type`, `key`, `check`, `select`, `navigate`, `verify`, `handoff`, `upload`, `drop`, `extract`, `for_each`, `note`, `download`, `open`, `digits`, or `pickDate`.

Any step may also carry optional `when`, `heal`, and `readBack`. Each action adds its own fields below. `validateWorkflow` refuses any other key.

| action | fields |
| --- | --- |
| `click` | `target`, optional `check`, `optional`, `selection`, `dialog` |
| `type` | `target`, `text`, optional `sensitive`, `check` |
| `select` | `target`, `text`, optional `check` |
| `digits` | `text`, optional `target`, `check` |
| `key` | `key`, optional `target`, `check` |
| `check` | `target`, `checked`, optional `check` |
| `navigate` | `url`, optional `check` |
| `verify` | `check` |
| `handoff` | `reason`, optional `target`, `check` |
| `upload`, `drop` | `target`, `file`, optional `check` |
| `download` | `download`, optional `target`, `check` |
| `open` | `open`, optional `check` |
| `pickDate` | `date`, optional `target`, `check` |
| `extract` | `extract` |
| `for_each` | `forEach` |
| `note` | `text` as a string |

`text` is `{ input }` or `{ literal }`. `file` is `{ input }` or `{ fromOutput }`. Only a `type` step is `sensitive`.

A target is `{ locators, hint }`. Locators are `role`, `text`, `testid`, `css`, `xpath`, or `anchor`. Replay does not invent a locator when the list is empty. Replay tries the locators in order. When the locators do not find exactly one node, `targetQuery` in `desktop/src/v1/identity.ts` turns the locators and hint into the fields the scorer compares with live nodes.

`check` is one of `settled`, `url`, `text`, `value`, `element`, `absent`, or `state`. A true check of those kinds passes. `extract`, `for_each`, and `note` have no check.

`handoff` has `reason`: `sign-in`, `code`, or `owner-press`. Replay does not click the control. A recorded confirm is `owner-press`, never sign-in. Resume with `confirmed`, or with no real check, ends the handoff. A code handoff asks for the code.

`navigate`, `open`, and `download` read their address from `url`, `open.url`, or `download.url`. A download may keep `target` when that target has locators or a hint.

`click` may set `selection`, `dialog`, and `optional: "dismiss"`.

## Known gaps

Step pictures stored by capture and by replay are element crops. The stored target box is not drawn on those crops. A full-viewport frame is not stored with the step yet, so the mark stays off.
