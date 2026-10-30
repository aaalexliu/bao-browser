# Workflow schema v2

The contract is `schema/workflow-v2.schema.json`, id `bao.workflow/v2`. A document validates against that file, and `desktop/src/v1/schema.ts` `validateWorkflow` checks the same rules the replayer depends on. Extension workflows stay version 1. `migrate()` is the door from those, and from the spike version-2 steps, into this shape.

## Document

`schema`, `version` (2), `id`, `name`, `startUrl`, `inputs`, `steps`, `createdAt`. Optional `heal`: `auto` or `approve`. Absent means the global setting, whose default is `auto`.

## Inputs

Collected before replay starts. The CLI and MCP pass the same JSON object the form edits.

| type | meaning |
| --- | --- |
| `text` | Any string. The form uses a multiline field. |
| `secret` | Masked. No `default`. The value is never in the file. |
| `number` | A number. Calculator digits use this. |
| `choice` | One of `choices`. |
| `file` | One file, or many when `multiple` is set. The workflow stores the input name, not a path. |

A step refers to an input with `input` and a template `value` such as `"{{username}}"`. `subst` replaces those tokens at replay.

## Steps

`action` is `click`, `type`, `key`, `upload`, `drop`, `digits`, `check`, `confirm`, `login`, or `verify`. `surface` is `dom` or `os`. A `confirm` or `login` step waits for the person. Replay does not click or type it. A `verify` step has no target. It re-reads an `expect` after the earlier steps.

`identity` is the recorded element. See `docs/element-identity.md`. There is no coordinate field on it. `provenance` may hold the pixel the vendor asked for, with `space` of `viewport`, `image`, or `screen`. Replay does not read it.

`selection` is optional: `{ "by": "name" | "title" | "text" | "value", "input": "row" }`. Candidates are filtered to that attribute before scoring, so a row click can mean "the row whose name is `{{row}}`" rather than the instance that was on screen.

`postcondition` is `url`, `text`, `value`, `element`, or `absent`, with `timeoutMs`. A `value` match of `{{a}}+{{b}}` is evaluated as arithmetic of number inputs and compared to the live text. Any other match is text, after `{{input}}` substitution. `timeoutMs` on the step is how long lookup polls. The postcondition has its own timeout.

`expect` is read after the action, and again by a trailing `verify` step. `kind` is `text`, `url`, or `state` (`checked`, `unchecked`, `enabled`, `disabled`, `visible`). A miss stops in a named phase: `wait_for`, `find`, `action`, `expect`, or `auth`. `waitFor` is a check that must become true before find. `gone` is a check that must be absent after the action, and a miss is still phase `expect`. `intent` is the recorded phrase cheap repairs match. `anchor` is `{ identity, relation }` with `relation` of `below`, `above`, `right`, or `left`.

A workflow can declare `precondition` `{ "kind": "url", "match", "phase": "auth" }`. Replay compares the pathname, so a `next` query is not the page. A redirect to `/login` is phase `auth` and is not sent to a model. When the password argument is present, replay fills the masked field. When it is absent, replay shows "Sign in on the site window" and waits. A `confirm` step with no postcondition stops the run and leaves the banner up. Replay does not click Apply on that workflow unless the trail already has a human confirm event.

`reveal` is a locator for a control that unhides the target. Replay clicks it only when the recorded target is a 0×0 or hidden box, and logs a `reveal` repair. If `reveal` is absent, replay can discover one visible search toggle in a search landmark. `readBack` on a step or on the workflow re-reads `text`, `url`, `value`, or a throwaway `file` after the action. The run appends a hashed receipt (expected, actual, pass, previous hash) and does not rewrite earlier lines. A file read-back names an input; the path is supplied at runtime and must sit under the temp directory. The same shape is what a later "verify freeze status after Apply" step uses: source `text`, match `Status: Frozen`. The local credit-freeze fixture is not a credit bureau.

`locators` is an ordered list tried after a known overlay is closed and before label, anchor, and wait repairs. Each item is `role` (role plus accessible name), `text`, `testid`, `css`, `xpath`, or `anchor`. A locator is used only when exactly one node matches and that node still has a box. The hit is logged. `primary` replay tries the first locator only. `identity.xpath` is stored for that locator and is not a score. An unnamed text view may use a role locator whose name is empty, which means the only unnamed control of that role. One-way export to Chrome DevTools Recorder JSON is `toPuppeteerReplay`. Anchor locators are omitted. Click steps set `offsetX` and `offsetY` to 1 because `@puppeteer/replay` 4.0.2 forwards a missing offset as `undefined`, and Puppeteer 25 then waits until timeout.

`unresolved` steps are stored so the miss is visible. Replay stops on them instead of skipping.

`when` is optional and has one of three shapes. With `{ "input": "route", "value": "Save the note" }`, the input is a `choice`, and replay runs the step only when that choice equals `value`. Teach uses this when two demonstrations of the same task diverge. With `{ "present": "text" }`, replay runs the step only while the page shows that text, or a control with that name. With `{ "absent": "text" }`, replay runs the step only while the page does not. A live session saves this on a cart add, so an item already in the cart is not added again. Steps in a row with the same `present` or `absent` are decided once, on the first of them. Steps without `when` run on every take.

## Example

This is the login step from `examples/workflows/browser-form.json`, captured from the local fixture page (username, secret, file input, drop). The password string is not in the file.

```json
{
  "action": "type",
  "input": "password",
  "value": "{{password}}",
  "label": "Type secret",
  "surface": "dom",
  "sensitive": true,
  "identity": {
    "surface": "dom",
    "role": "input",
    "id": "password",
    "nameAttr": "password",
    "tag": "input",
    "path": []
  },
  "postcondition": { "kind": "element", "timeoutMs": 4000 },
  "timeoutMs": 8000
}
```

`examples/workflows/calculator.json` is the GTK calculator capture. Digit presses collapsed into `digits` steps with number inputs `a` and `b`. The equals step's postcondition is `{{a}}+{{b}}`.

`examples/workflows/live-login.json` and `examples/workflows/live-upload.json` are interpret output from MCP trails whose `source.agent` is `live-model`. The login secret has no default. The upload step's value is `{{file}}`, not a path. Provenance coordinates are recorded and replay does not read them.

`examples/workflows/browser-form.json` expects the URL `/secure` after Log in, then a `verify` step reads that URL again. `examples/workflows/credit-freeze.json` is the local fixture at `/freeze`. A missing or expired session cookie redirects to `/login` (username, then a `type=password` field, and a "Verify it's you" code step only when `verify=1`). Replay signs in or waits, clicks Frozen, re-reads `Status: none`, and stops at the confirm step. Bao does not press Apply. The page is fake. It is not a credit bureau.

## Interpret

`desktop/src/v1/interpret.ts` is deterministic. The same trail produces byte-identical JSON (`canonical`). It drops screenshot reads, moves, waits, and unresolved no-ops, merges consecutive typing into one field, and lifts every typed value into an input. A secret (password field, sensitive flag, or a known secret string) becomes a `secret` input with no default and no literal. A file event becomes a `file` input. A path on the trail is not copied. Consecutive digit presses on a calculator become one number input.

An optional model pass may later name the workflow and suggest selection rules. It is not required, and it is not implemented as a network call in the default path. The deterministic pass is the one the tests replay.
