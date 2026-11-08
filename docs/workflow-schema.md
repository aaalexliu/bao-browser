# Workflow schema v4

The contract is `schema/workflow.schema.json`, id `bao.workflow/v4`. `desktop/src/v1/schema.ts` `validateWorkflow` checks the same document the replayer reads. A file with another schema id is not loaded. Old workflows are not migrated.

## Document

`schema`, `id`, `name`, `startUrl`, `inputs`, `steps`, `createdAt`. There is no `version` field. Optional `heal` is `auto`, `ask`, or `never`. Optional `driver` is `playwright` or `extension`.

## Inputs

Collected before replay starts. Each input has `name`, `type`, `label`, and `supply`.

| type | meaning |
| --- | --- |
| `text` | Any string. |
| `secret` | A password. A local default may stay saved. An outbound copy drops that default and sets `supply` to `must`. |
| `number` | A number. |
| `choice` | One of `choices`. |
| `file` | A file the owner supplies. `supply` is `must`. |

`supply: "saved"` requires `default`. `supply: "must"` has no default. A step refers to an input with `text.input`, `file.input`, `date.input`, `selection.input`, or `dialog.input`, and with `{{name}}` in a caption, URL, or check.

## Steps

Every step has `id`, `index`, `action`, `caption`, and `timeoutMs`. `caption.text` is the sentence shown to the owner. `caption.citation` is a string taken from the HTML element, with `source` of `text`, `name`, `label`, `aria-label`, `placeholder`, `alt`, or `title`. Buttons and links cite visible text. A select, textarea, or input cites its label. `caption.targetBox` is the control's box in the recorded viewport.

`action` is `click`, `type`, `key`, `check`, `select`, `navigate`, `verify`, `handoff`, `upload`, `drop`, `extract`, `for_each`, `note`, `download`, `open`, `digits`, `pickDate`, `wait`, or `finish`.

A target is `{ locators, hint }`. Locators are `role`, `text`, `label`, `placeholder`, `testid`, `css`, or `xpath`. Replay does not invent a locator when the list is empty.

`check` is one of `settled`, `url`, `text`, `value`, `element`, `absent`, or `state`. A true check of those kinds passes. `extract`, `for_each`, `note`, `wait`, and `finish` have no check.

`handoff` has `reason`: `sign-in`, `code`, or `owner-press`. Replay does not click the control. A recorded confirm is `owner-press`, never sign-in. Resume with `confirmed`, or with no real check, ends the handoff. A code handoff asks for the code.

`navigate`, `open`, and `download` read their address from `url`, `open.url`, or `download.url`. A download may keep `target` when that target has locators or a hint.

`click` may set `selection`, `dialog`, and `optional: "dismiss"`.

## Known gaps

Step pictures stored by capture and by replay are element crops. The stored target box is not drawn on those crops. A full-viewport frame is not stored with the step yet, so the mark stays off.
