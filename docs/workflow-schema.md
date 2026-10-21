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

`action` is `click`, `type`, `key`, `upload`, `drop`, `digits`, or `check`. `surface` is `dom` or `os`.

`identity` is the recorded element. See `docs/element-identity.md`. There is no coordinate field on it. `provenance` may hold the pixel the vendor asked for, with `space` of `viewport`, `image`, or `screen`. Replay does not read it.

`selection` is optional: `{ "by": "name" | "title" | "text" | "value", "input": "row" }`. Candidates are filtered to that attribute before scoring, so a row click can mean "the row whose name is `{{row}}`" rather than the instance that was on screen.

`postcondition` is `url`, `text`, `value`, `element`, or `absent`, with `timeoutMs`. A `value` match of `{{a}}+{{b}}` is evaluated as arithmetic of number inputs and compared to the live text. Any other match is text, after `{{input}}` substitution. `timeoutMs` on the step is how long lookup polls. The postcondition has its own timeout.

`unresolved` steps are stored so the miss is visible. Replay stops on them instead of skipping.

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

## Interpret

`desktop/src/v1/interpret.ts` is deterministic. The same trail produces byte-identical JSON (`canonical`). It drops screenshot reads, moves, waits, and unresolved no-ops, merges consecutive typing into one field, and lifts every typed value into an input. A secret (password field, sensitive flag, or a known secret string) becomes a `secret` input with no default and no literal. A file event becomes a `file` input. A path on the trail is not copied. Consecutive digit presses on a calculator become one number input.

An optional model pass may later name the workflow and suggest selection rules. It is not required, and it is not implemented as a network call in the default path. The deterministic pass is the one the tests replay.
